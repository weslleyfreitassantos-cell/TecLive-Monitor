'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const SEGMENT_EXT = '.segment';
const PART_EXT = '.part';
const META_EXT = '.meta.json';

const HTTP_AGENT = new http.Agent({ keepAlive: true, maxSockets: 50, maxFreeSockets: 10, timeout: 30000 });
const HTTPS_AGENT = new https.Agent({ keepAlive: true, maxSockets: 50, maxFreeSockets: 10, timeout: 30000 });

const COMPAT_WINDOW_SECONDS = 25;
const COMPAT_MIN_ANNOUNCE_MARGIN_MS = 30000;
const COMPAT_EFFECTIVE_TD = 5;

class HlsSegmentCache {
  static shouldApplyTargetDurationCompat(userAgent) {
    if (!userAgent) return false;
    if (/ExoPlayerLib\/2\.(0|[0-9])\./.test(userAgent)) return true;
    if (/ExoMedia/.test(userAgent)) return true;
    if (/NeoNews/.test(userAgent)) return true;
    if (/Izy\s*Stick|IzyStick/i.test(userAgent)) return true;
    return false;
  }

  constructor(options = {}) {
    this.cacheDir = options.cacheDir || '/var/cache/livemonitor/hls-segments';
    this.ttlMs = Math.max(30000, options.ttlMs || 120000);
    this.allowUnsafeTestLimits = options.allowUnsafeTestLimits === true;
    const byteLimit = this.allowUnsafeTestLimits ? 1 : 1048576;
    const fileLimit = this.allowUnsafeTestLimits ? 1 : 100;
    this.maxBytes = Math.max(byteLimit, options.maxBytes || 1073741824);
    this.maxFiles = Math.max(fileLimit, options.maxFiles || 5000);
    this.prefetchConcurrency = Math.max(1, options.prefetchConcurrency || 4);
    this.prefetchTimeoutMs = Math.max(5000, options.prefetchTimeoutMs || 10000);
    this.prefetchPlaylistWaitMs = Math.max(1000, options.prefetchPlaylistWaitMs || 2000);
    this.minReady = Math.max(1, options.minReady || 3);
    this.prefetchEnabled = options.prefetchEnabled !== false;
    this.forceIPv4 = options.forceIPv4 === true;
    this.diagnostic = options.diagnostic === true;
    this.playbackSessions = options.playbackSessions || null;
    this._allowlistConfigured = options.allowedVideoIds !== undefined;
    this.allowedVideoIds = new Set(
      (options.allowedVideoIds || []).filter(id => /^[0-9A-Za-z_-]{11}$/.test(id))
    );

    this.entries = new Map();
    this.inFlight = new Map();
    this.streamGens = new Map();

    this.prefetchQueue = [];
    this.activeDownloads = 0;
    this.processingQueue = false;
    this.destroyed = false;
    this.pruneTimer = null;

    this.metrics = {
      hits: 0, misses: 0, prefetchSuccess: 0, prefetchFailure: 0,
      upstream404: 0, servedFromCache: 0, currentBytes: 0, currentFiles: 0,
      evictions: 0, playlistNotReady: 0, invariantViolations: 0,
      restartRecoveredFiles: 0, orphanPartRemoved: 0, prefetchDiscarded: 0,
      recoveredSegments: 0, cacheIdMismatch: 0,
      compatTdApplied: 0, compatWindowExpanded: 0
    };

    this._log = this.diagnostic ? console.log.bind(console, '[HLS-CACHE]') : () => {};
    this._segDiagWindowMs = 60000;
    this._segDiagLog = new Map();
  }

  async init() {
    await fs.promises.mkdir(this.cacheDir, { recursive: true, mode: 0o750 });

    const files = await fs.promises.readdir(this.cacheDir);
    const segFiles = new Set(files.filter(f => f.endsWith(SEGMENT_EXT)));
    const partFiles = files.filter(f => f.endsWith(PART_EXT));
    const metaFiles = new Set(files.filter(f => f.endsWith(META_EXT)));

    for (const pf of partFiles) {
      const base = pf.slice(0, -PART_EXT.length);
      if (!segFiles.has(base + SEGMENT_EXT)) {
        await fs.promises.unlink(path.join(this.cacheDir, pf)).catch(() => {});
        this.metrics.orphanPartRemoved++;
      }
    }

    for (const sf of segFiles) {
      const cacheId = sf.slice(0, -SEGMENT_EXT.length);
      const metaName = cacheId + META_EXT;
      let meta = null;
      if (metaFiles.has(metaName)) {
        try {
          meta = JSON.parse(await fs.promises.readFile(path.join(this.cacheDir, metaName), 'utf8'));
        } catch (_) {}
      }
      try {
        const stat = await fs.promises.stat(path.join(this.cacheDir, sf));
        if (meta) {
          meta.filePath = path.join(this.cacheDir, sf);
          meta.size = stat.size;
          meta.status = 'ready';
          meta.lastAccessAt = stat.mtimeMs;
          this.entries.set(cacheId, meta);
          this.metrics.currentBytes += stat.size;
          this.metrics.currentFiles++;
          this.metrics.restartRecoveredFiles++;
        } else {
          this.entries.set(cacheId, {
            cacheId, filePath: path.join(this.cacheDir, sf),
            size: stat.size, videoId: '', quality: 0, sequence: 0, duration: 0,
            contentType: 'application/octet-stream', upstreamHash: '',
            createdAt: stat.birthtimeMs || stat.mtimeMs, lastAccessAt: stat.mtimeMs,
            expiresAt: stat.mtimeMs + this.ttlMs, status: 'ready', restored: true
          });
          this.metrics.currentBytes += stat.size;
          this.metrics.currentFiles++;
          this.metrics.restartRecoveredFiles++;
        }
      } catch (_) {}
    }

    for (const mf of metaFiles) {
      const base = mf.slice(0, -META_EXT.length);
      if (!segFiles.has(base + SEGMENT_EXT)) {
        await fs.promises.unlink(path.join(this.cacheDir, mf)).catch(() => {});
      }
    }

    this.pruneTimer = setInterval(() => this._prune(), 30000);
    if (this.pruneTimer.unref) this.pruneTimer.unref();

    this._log(`init completed dir=${this.cacheDir} files=${this.metrics.currentFiles} bytes=${this.metrics.currentBytes} orphans=${this.metrics.orphanPartRemoved} recovered=${this.metrics.restartRecoveredFiles}`);
  }

  // -- cache identity --

  buildCacheId(videoId, quality, streamGen, mediaSeq, discontinuitySeq) {
    const key = `${videoId}:${quality}:${streamGen}:${mediaSeq}:${discontinuitySeq || 0}`;
    return crypto.createHash('sha256').update(key).digest('hex').slice(0, 48);
  }

  getOrCreateStreamGen(videoId, quality) {
    const k = `${videoId}:${quality}`;
    if (!this.streamGens.has(k)) this.streamGens.set(k, Date.now().toString(36));
    return this.streamGens.get(k);
  }

  updateStreamGen(videoId, quality) {
    this.streamGens.set(`${videoId}:${quality}`, Date.now().toString(36));
  }

  // -- playlist processing --

  isVideoAllowed(videoId) {
    if (!this._allowlistConfigured) return true;
    if (this.allowedVideoIds.size === 0) return false;
    return this.allowedVideoIds.has(videoId);
  }

  async processPlaylist({ videoId, quality, playlistContent, playlistUrl, sessionId, baseUrl, token, waitMs, minReady, userAgent, owner, registerSegmentProxy }) {
    if (!this.isVideoAllowed(videoId)) return { content: null, passthrough: true };
    const parsed = this._parsePlaylist(playlistContent);
    if (!parsed || parsed.segments.length === 0 || parsed.unsupported) {
      if (parsed && parsed.unsupported) {
        this._log(`unsupported playlist videoId=${videoId} quality=${quality} map=${parsed.hasMap} key=${parsed.hasKey} byterange=${parsed.hasByteRange}`);
      }
      return { content: playlistContent, passthrough: true };
    }

    const streamGen = this.getOrCreateStreamGen(videoId, quality);
    const pendingIds = [];

    for (const seg of parsed.segments) {
      const cid = this.buildCacheId(videoId, quality, streamGen, seg.sequence, seg.discontinuitySequence);
      seg._cacheId = cid;

      const existing = this.entries.get(cid);
      if (existing && existing.status === 'ready') { seg._ready = true; continue; }

      if (!existing) {
        this.entries.set(cid, {
          cacheId: cid, videoId, quality, sequence: seg.sequence, duration: seg.duration,
          contentType: seg.contentType || 'video/MP2T', size: 0,
          filePath: path.join(this.cacheDir, cid + SEGMENT_EXT),
          createdAt: Date.now(), lastAccessAt: Date.now(),
          expiresAt: Date.now() + this.ttlMs,
          upstreamHash: this._hashUrl(seg.uri), status: 'fetching', sessionId
        });
      }

      if (!this.inFlight.has(cid) && this.prefetchEnabled) {
        this._enqueuePrefetch(cid, seg.uri, videoId, quality);
      }
      seg._ready = false;
      pendingIds.push(cid);
    }

    this._processQueue();

    const deadline = Date.now() + (waitMs || this.prefetchPlaylistWaitMs);
    const r = this._findContiguousReady(parsed.segments, videoId, quality, streamGen);

    if (r.count < (minReady || this.minReady) && pendingIds.length > 0) {
      while (Date.now() < deadline) {
        const r2 = this._findContiguousReady(parsed.segments, videoId, quality, streamGen);
        if (r2.count >= (minReady || this.minReady)) break;
        await new Promise(res => setTimeout(res, 100));
      }
    }

    const ready = this._findContiguousReady(parsed.segments, videoId, quality, streamGen);
    if (ready.count < (minReady || this.minReady)) {
      this.metrics.playlistNotReady++;
      this._log(`playlist-not-ready videoId=${videoId} quality=${quality} ready=${ready.count} min=${minReady || this.minReady} total=${parsed.segments.length}`);
      return { notReady: true };
    }

    const applyTdCompat = HlsSegmentCache.shouldApplyTargetDurationCompat(userAgent);

    const servableSegs = ready.segments.filter(seg => this._playlistServable(this.entries.get(seg._cacheId), applyTdCompat));
    if (servableSegs.length < (minReady || this.minReady)) {
      this.metrics.playlistNotReady++;
      this._log(`playlist-not-ready videoId=${videoId} quality=${quality} servable=${servableSegs.length} ready=${ready.count} total=${parsed.segments.length}`);
      return { notReady: true };
    }

    const maxExtInf = Math.ceil(parsed.segments.reduce((mx, s) => Math.max(mx, s.duration), 0));
    let effectiveTd = parsed.targetDuration;
    let finalSegments = servableSegs;

    if (applyTdCompat) {
      effectiveTd = Math.max(parsed.targetDuration, COMPAT_EFFECTIVE_TD, maxExtInf);
      if (effectiveTd !== parsed.targetDuration) {
        this.metrics.compatTdApplied++;
        this._log(`compat-td videoId=${videoId} quality=${quality} origTd=${parsed.targetDuration} effectiveTd=${effectiveTd} maxExtInf=${maxExtInf}`);
      }
    }

    const hasStateTags = parsed.hasMap || parsed.hasKey || parsed.hasByteRange || parsed.hasDiscontinuity;
    if (!hasStateTags) {
      const expanded = this._expandContiguousWindow(videoId, quality, streamGen, servableSegs);
      if (expanded.length > servableSegs.length) {
        finalSegments = expanded;
        this.metrics.compatWindowExpanded++;
        const windowSec = expanded.reduce((s, seg) => {
          const e = this.entries.get(seg._cacheId);
          return s + (e ? e.duration : 0);
        }, 0);
        this._log(`window-expanded videoId=${videoId} quality=${quality} before=${servableSegs.length} after=${expanded.length} windowSec=${windowSec.toFixed(1)}`);
      }
    } else {
      this._log(`window-expand-skipped videoId=${videoId} quality=${quality} reason=stateTags map=${parsed.hasMap} key=${parsed.hasKey} byterange=${parsed.hasByteRange} discontinuity=${parsed.hasDiscontinuity}`);
    }

    const playlist = this._buildPlaylist(parsed, { segments: finalSegments }, videoId, quality, streamGen, baseUrl, sessionId, effectiveTd, owner, registerSegmentProxy);
    this._log(`playlist-ready videoId=${videoId} quality=${quality} segments=${finalSegments.length} seq=${finalSegments[0].sequence} td=${effectiveTd} compat=${applyTdCompat}`);
    return { content: playlist };
  }

  _expandContiguousWindow(videoId, quality, streamGen, currentSegments) {
    if (!currentSegments || currentSegments.length === 0) return currentSegments;

    const firstSeq = currentSegments[0].sequence;
    const maxWindowDurationMs = COMPAT_WINDOW_SECONDS * 1000;
    let windowDuration = 0;
    const result = [];

    for (const seg of currentSegments) {
      const entry = this.entries.get(seg._cacheId);
      if (!entry) break;
      windowDuration += (entry.duration * 1000) || 1000;
      result.push(seg);
    }

    if (windowDuration >= maxWindowDurationMs) return result;

    let scanSeq = firstSeq - 1;
    while (windowDuration < maxWindowDurationMs) {
      const cid = this.buildCacheId(videoId, quality, streamGen, scanSeq, 0);
      const entry = this.entries.get(cid);
      if (!entry || entry.status !== 'ready') break;
      if (entry.videoId !== videoId) break;
      if (entry.quality !== quality) break;
      if (!this._playlistServable(entry, false)) break;

      const seg = {
        sequence: entry.sequence,
        duration: entry.duration || 1,
        discontinuitySequence: 0,
        discontinuity: false,
        programDateTime: null,
        uri: '',
        _cacheId: cid,
        _ready: true
      };

      windowDuration += (entry.duration * 1000) || 1000;
      result.unshift(seg);
      scanSeq--;
    }

    return result;
  }

  _playlistServable(entry, strictMode) {
    if (!entry || entry.status !== 'ready') return false;
    const margin = strictMode ? COMPAT_MIN_ANNOUNCE_MARGIN_MS : 2000;
    if (entry.expiresAt <= Date.now() + margin) return false;
    try { return fs.existsSync(entry.filePath); } catch (_) { return false; }
  }

  _findContiguousReady(segments, videoId, quality, streamGen) {
    let bestStart = -1, bestCount = 0;
    for (let i = segments.length - 1; i >= 0; i--) {
      let count = 0;
      for (let j = i; j >= 0; j--) {
        const cid = this.buildCacheId(videoId, quality, streamGen, segments[j].sequence, segments[j].discontinuitySequence);
        const e = this.entries.get(cid);
        if (e && e.status === 'ready') { count++; } else break;
      }
      if (count >= bestCount) { bestCount = count; bestStart = i - count + 1; }
    }
    if (bestCount === 0) return { start: -1, count: 0, segments: [] };
    return { start: bestStart, count: bestCount, segments: segments.slice(bestStart, bestStart + bestCount) };
  }

  _buildPlaylist(parsed, ready, videoId, quality, streamGen, baseUrl, sessionId, effectiveTd, owner, registerSegmentProxy) {
    const segs = ready.segments;
    const firstSeq = segs[0].sequence;
    const td = (effectiveTd && effectiveTd >= parsed.targetDuration) ? effectiveTd : parsed.targetDuration;

    const lines = [
      '#EXTM3U', '#EXT-X-VERSION:3',
      `#EXT-X-TARGETDURATION:${td}`,
      `#EXT-X-MEDIA-SEQUENCE:${firstSeq}`
    ];

    if (parsed.discontinuitySequence !== undefined) {
      lines.push(`#EXT-X-DISCONTINUITY-SEQUENCE:${parsed.discontinuitySequence}`);
    }

    for (const seg of segs) {
      if (seg.discontinuity) lines.push('#EXT-X-DISCONTINUITY');
      if (seg.programDateTime) lines.push(`#EXT-X-PROGRAM-DATE-TIME:${seg.programDateTime}`);
      lines.push(`#EXTINF:${seg.duration.toFixed(3)},`);
      const proxyId = registerSegmentProxy
        ? registerSegmentProxy({ url: seg.uri, videoId, owner, sessionId })
        : seg._cacheId;
      lines.push(`/neonews/seg/${encodeURIComponent(proxyId)}.ts`);
    }

    return lines.join('\n') + '\n';
  }

  _parsePlaylist(content) {
    const lines = content.split(/\r?\n/);
    const segments = [];
    let targetDuration = 0, discontinuitySequence = 0, sequence = 0;
    let hasMap = false, hasKey = false, hasByteRange = false;
    let curDiscontinuity = false, curDuration = 0, curPdt = null;

    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;

      if (line.startsWith('#EXT-X-TARGETDURATION:')) {
        targetDuration = parseFloat(line.split(':')[1]) || 0;
      } else if (line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE:')) {
        discontinuitySequence = parseInt(line.split(':')[1], 10) || 0;
      } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
        sequence = parseInt(line.split(':')[1], 10) || 0;
      } else if (line === '#EXT-X-DISCONTINUITY') {
        curDiscontinuity = true;
      } else if (line.startsWith('#EXTINF:')) {
        const m = line.match(/#EXTINF:\s*([\d.]+)/);
        curDuration = m ? parseFloat(m[1]) : 0;
      } else if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
        curPdt = line.slice(line.indexOf(':') + 1).trim();
      } else if (line.startsWith('#EXT-X-MAP')) {
        hasMap = true;
      } else if (line.startsWith('#EXT-X-KEY')) {
        hasKey = true;
      } else if (line.startsWith('#EXT-X-BYTERANGE')) {
        hasByteRange = true;
      } else if (!line.startsWith('#') && curDuration > 0) {
        segments.push({
          uri: line, duration: curDuration, sequence,
          discontinuitySequence, discontinuity: curDiscontinuity,
          programDateTime: curPdt
        });
        sequence++;
        curDuration = 0; curDiscontinuity = false; curPdt = null;
      }
    }

    const unsupported = hasMap || hasKey || hasByteRange;
    const hasDiscontinuity = segments.some(s => s.discontinuity);
    return { segments, targetDuration, discontinuitySequence, hasMap, hasKey, hasByteRange, unsupported, hasDiscontinuity };
  }

  // -- prefetch --

  _enqueuePrefetch(cacheId, upstreamUrl, videoId, quality) {
    this.prefetchQueue.push({ cacheId, upstreamUrl, videoId, quality, enqueuedAt: Date.now() });
  }

  _processQueue() {
    if (this.processingQueue || this.destroyed) return;
    this.processingQueue = true;

    const next = () => {
      if (this.destroyed) { this.processingQueue = false; return; }
      while (this.activeDownloads < this.prefetchConcurrency && this.prefetchQueue.length > 0) {
        const item = this.prefetchQueue.shift();
        const e = this.entries.get(item.cacheId);
        if (!e || e.status === 'ready' || this.inFlight.has(item.cacheId)) continue;
        if (e.createdAt && (Date.now() - e.createdAt) > this.ttlMs) {
          this.metrics.prefetchDiscarded++;
          this.entries.delete(item.cacheId);
          continue;
        }

        this.activeDownloads++;
        const prom = this._download(item.cacheId, item.upstreamUrl).then(() => {
          this.activeDownloads--;
          this.inFlight.delete(item.cacheId);
          this.metrics.prefetchSuccess++;
          next();
        }).catch(err => {
          this.activeDownloads--;
          this.inFlight.delete(item.cacheId);
          this.metrics.prefetchFailure++;
          const en = this.entries.get(item.cacheId);
          if (en) en.status = 'failed';
          this._log(`prefetch-error cacheId=${item.cacheId.slice(0, 12)} error=${err.message}`);
          next();
        });
        this.inFlight.set(item.cacheId, prom);
      }
      if (this.activeDownloads === 0 && this.prefetchQueue.length === 0) this.processingQueue = false;
    };
    next();
  }

  _download(cacheId, upstreamUrl) {
    const tmp = path.join(this.cacheDir, cacheId + PART_EXT);
    const fin = path.join(this.cacheDir, cacheId + SEGMENT_EXT);
    const entry = this.entries.get(cacheId);
    if (!entry) return Promise.reject(new Error('entry_not_found'));

    this._log(`prefetch-start cacheId=${cacheId.slice(0, 12)} sequence=${entry.sequence}`);

    return new Promise((resolve, reject) => {
      const proto = upstreamUrl.startsWith('https:') ? https : http;
      const agent = upstreamUrl.startsWith('https:') ? HTTPS_AGENT : HTTP_AGENT;
      const opts = { agent, headers: { 'User-Agent': 'Mozilla/5.0' } };
      if (this.forceIPv4) opts.family = 4;

      const ws = fs.createWriteStream(tmp);
      let received = 0;

      const cleanup = () => { try { ws.close(); fs.unlink(tmp, () => {}); } catch (_) {} };

      const req = proto.get(upstreamUrl, opts, res => {
        if (res.statusCode !== 200 && res.statusCode !== 206) {
          res.resume(); cleanup();
          if (res.statusCode === 404) this.metrics.upstream404++;
          return reject(new Error(`upstream_${res.statusCode}`));
        }
        res.pipe(ws);
        res.on('data', c => { received += c.length; });
        res.on('end', () => {
          ws.close(() => {
            if (received === 0) { cleanup(); return reject(new Error('empty')); }
            try {
              fs.renameSync(tmp, fin);
              entry.size = received;
              entry.lastAccessAt = Date.now();
              entry.expiresAt = Date.now() + this.ttlMs;
              entry.status = 'ready';
              entry.filePath = fin;
              this.metrics.currentBytes += received;
              this.metrics.currentFiles++;
              this._writeMeta(cacheId, entry).catch(() => {});
              this._log(`prefetch-ready cacheId=${cacheId.slice(0, 12)} sequence=${entry.sequence} bytes=${received} elapsed=${Date.now() - entry.createdAt}ms`);
              resolve();
            } catch (e) { cleanup(); reject(e); }
          });
        });
      });

      req.on('error', err => { cleanup(); reject(err); });
      req.setTimeout(this.prefetchTimeoutMs, () => { req.destroy(); cleanup(); reject(new Error('timeout')); });
    });
  }

  async _writeMeta(cacheId, entry) {
    const meta = {
      cacheId: entry.cacheId, videoId: entry.videoId, quality: entry.quality,
      sequence: entry.sequence, duration: entry.duration,
      contentType: entry.contentType, upstreamHash: entry.upstreamHash,
      createdAt: entry.createdAt, expiresAt: entry.expiresAt
    };
    const p = path.join(this.cacheDir, cacheId + META_EXT + PART_EXT);
    const f = path.join(this.cacheDir, cacheId + META_EXT);
    await fs.promises.writeFile(p, JSON.stringify(meta), 'utf8');
    fs.renameSync(p, f);
  }

  // -- segment diagnostics + safe disk recovery --

  _segDiag(classification, cacheId, extra) {
    const key = `${classification}:${String(cacheId).slice(0, 12)}`;
    const now = Date.now();
    const last = this._segDiagLog.get(key) || 0;
    if (now - last < this._segDiagWindowMs) return;
    this._segDiagLog.set(key, now);
    console.log(`[HLS-CACHE] seg-diag class=${classification} cacheId=${String(cacheId).slice(0, 12)} ${extra || ''}`);
  }

  _safeCachePath(cacheId) {
    if (!/^[a-f0-9]{48}$/i.test(cacheId)) return null;
    const p = path.join(this.cacheDir, cacheId + SEGMENT_EXT);
    if (path.dirname(p) !== this.cacheDir) return null;
    return p;
  }

  _classifySegmentState(cacheId) {
    if (!/^[a-f0-9]{48}$/i.test(cacheId)) return 'invalid_cache_id';
    const entry = this.entries.get(cacheId);
    if (entry) {
      if (entry.status !== 'ready') return 'not_ready';
      if (entry.expiresAt < Date.now()) return 'expired';
      return 'ready';
    }
    const segPath = path.join(this.cacheDir, cacheId + SEGMENT_EXT);
    const metaPath = path.join(this.cacheDir, cacheId + META_EXT);
    if (!fs.existsSync(segPath)) return 'file_missing';
    if (!fs.existsSync(metaPath)) return 'metadata_missing';
    let meta;
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); }
    catch (_) { return 'metadata_invalid'; }
    if (!meta || meta.cacheId !== cacheId) return 'metadata_mismatch';
    if (typeof meta.expiresAt !== 'number' || meta.expiresAt < Date.now()) return 'expired';
    if (meta.status !== 'ready') return 'not_ready';
    return 'recoverable';
  }

  async _recoverEntryFromDisk(cacheId) {
    if (!/^[a-f0-9]{48}$/i.test(cacheId)) return { ok: false, classification: 'invalid_cache_id' };
    const segPath = path.join(this.cacheDir, cacheId + SEGMENT_EXT);
    const metaPath = path.join(this.cacheDir, cacheId + META_EXT);

    let stat;
    try { stat = fs.statSync(segPath); } catch (_) { return { ok: false, classification: 'file_missing' }; }
    if (!stat.isFile() || stat.size === 0) return { ok: false, classification: 'file_missing' };

    let metaRaw;
    try { metaRaw = fs.readFileSync(metaPath, 'utf8'); } catch (_) { return { ok: false, classification: 'metadata_missing' }; }
    let meta;
    try { meta = JSON.parse(metaRaw); } catch (_) { return { ok: false, classification: 'metadata_invalid' }; }
    if (!meta || meta.cacheId !== cacheId) return { ok: false, classification: 'metadata_mismatch' };
    if (meta.status !== 'ready') return { ok: false, classification: 'not_ready' };
    if (typeof meta.expiresAt !== 'number') return { ok: false, classification: 'metadata_invalid' };
    if (meta.expiresAt <= Date.now() + 1000) return { ok: false, classification: 'expired' };
    if (this.allowedVideoIds.size > 0 && (!meta.videoId || !this.allowedVideoIds.has(meta.videoId))) {
      return { ok: false, classification: 'metadata_mismatch' };
    }
    if (meta.filePath && meta.filePath !== segPath) return { ok: false, classification: 'metadata_mismatch' };

    const existing = this.entries.get(cacheId);
    if (existing) return { ok: true, entry: existing, classification: 'ready' };

    if (typeof this.buildCacheId === 'function' && meta.videoId && meta.quality && typeof meta.streamGen === 'number' && typeof meta.sequence === 'number') {
      const rebuilt = this.buildCacheId(meta.videoId, meta.quality, meta.streamGen, meta.sequence, meta.discontinuitySequence || 0);
      if (rebuilt !== cacheId) {
        this.metrics.cacheIdMismatch++;
        console.log(`[HLS-CACHE] seg-diag cacheId-mismatch announced=${cacheId.slice(0, 12)} rebuilt=${rebuilt.slice(0, 12)}`);
      }
    }

    const entry = {
      cacheId,
      videoId: meta.videoId,
      quality: meta.quality,
      sequence: meta.sequence,
      duration: meta.duration || 0,
      contentType: meta.contentType || 'video/MP2T',
      size: stat.size,
      filePath: segPath,
      createdAt: meta.createdAt || Date.now(),
      lastAccessAt: Date.now(),
      expiresAt: meta.expiresAt,
      upstreamHash: meta.upstreamHash || null,
      status: 'ready',
      recovered: true
    };
    this.entries.set(cacheId, entry);
    this.metrics.recoveredSegments++;
    this.metrics.currentFiles = this.entries.size;
    this.metrics.currentBytes += stat.size;
    this._log(`recovered-from-disk cacheId=${cacheId.slice(0, 12)} size=${stat.size}`);
    return { ok: true, entry, classification: 'ready' };
  }

  async _resolveSegmentEntry(cacheId) {
    if (!/^[a-f0-9]{48}$/i.test(cacheId)) {
      this._segDiag('invalid_cache_id', cacheId);
      return { entry: null, classification: 'invalid_cache_id' };
    }
    const entry = this.entries.get(cacheId);
    if (entry) {
      if (entry.status !== 'ready') {
        this._segDiag('not_ready', cacheId, `status=${entry.status}`);
        return { entry: null, classification: 'not_ready' };
      }
      if (entry.expiresAt < Date.now()) {
        this.entries.delete(cacheId);
        this._removeFiles(cacheId).catch(() => {});
        this._segDiag('expired', cacheId);
        return { entry: null, classification: 'expired' };
      }
      try { await fs.promises.stat(entry.filePath); }
      catch (_) {
        this.entries.delete(cacheId);
        this.metrics.invariantViolations++;
        this._segDiag('file_missing', cacheId, 'orphan-entry');
        return { entry: null, classification: 'file_missing' };
      }
      return { entry, classification: 'ready' };
    }
    const rec = await this._recoverEntryFromDisk(cacheId);
    if (rec.ok) {
      this._segDiag('ready', cacheId, 'recovered');
      return { entry: rec.entry, classification: 'ready', recovered: true };
    }
    this._segDiag(rec.classification, cacheId, 'no-entry');
    return { entry: null, classification: rec.classification };
  }

  _lookupSessionForTouch(sessionId) {
    if (!this.playbackSessions || typeof this.playbackSessions.listActive !== 'function') return null;
    try {
      const all = this.playbackSessions.listActive({}) || [];
      return all.find(s => (s.sessionId || s.id) === sessionId) || null;
    } catch (_) { return null; }
  }

  _streamSegment(entry, req, res) {
    this.metrics.hits++;
    this.metrics.servedFromCache++;
    entry.lastAccessAt = Date.now();

    try {
      const stat = fs.statSync(entry.filePath);
      const range = req.headers.range;

      const baseHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'private, no-store',
        'X-Cache': 'HIT',
        'Accept-Ranges': 'bytes',
        'Content-Type': entry.contentType || 'video/MP2T'
      };

      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
        const len = end - start + 1;
        res.writeHead(206, Object.assign({}, baseHeaders, {
          'Content-Length': len, 'Content-Range': `bytes ${start}-${end}/${stat.size}`
        }));
        fs.createReadStream(entry.filePath, { start, end }).pipe(res);
      } else {
        res.writeHead(200, Object.assign({}, baseHeaders, { 'Content-Length': stat.size }));
        fs.createReadStream(entry.filePath).pipe(res);
      }
      return true;
    } catch (err) {
      this.entries.delete(entry.cacheId);
      this.metrics.invariantViolations++;
      this._segDiag('file_missing', entry.cacheId, 'stream-fail');
      return false;
    }
  }

  // -- serve segment --

  async serveSegment(cacheId, sessionId, req, res) {
    if (!/^[a-f0-9]{48}$/i.test(cacheId)) return false;

    const pre = this.entries.get(cacheId);
    if (pre && pre.status === 'fetching') {
      const prom = this.inFlight.get(cacheId);
      if (prom) {
        try {
          await Promise.race([prom, new Promise((_, rj) => setTimeout(() => rj(new Error('timeout')), this.prefetchTimeoutMs))]);
        } catch (_) { this.metrics.misses++; return false; }
      }
    }

    const { entry } = await this._resolveSegmentEntry(cacheId);
    if (!entry) { this.metrics.misses++; return false; }

    if (this.allowedVideoIds.size > 0 && !this.allowedVideoIds.has(entry.videoId)) {
      this.metrics.misses++;
      return false;
    }

    if (this.playbackSessions && sessionId) {
      const sess = this._lookupSessionForTouch(sessionId);
      const touched = this.playbackSessions.touchSession({
        sessionId,
        owner: sess ? sess.owner : undefined,
        videoId: sess ? sess.videoId : undefined,
        tokenScope: sess ? sess.tokenScope : undefined,
        publicIp: req.ip || req.connection?.remoteAddress || '',
        userAgent: req.headers['user-agent'] || '', hlsActivity: 'segment'
      });
      if (!touched || !touched.ok) {
        this.metrics.misses++;
        this._segDiag('touch_failed', cacheId, (touched && touched.code) || 'no-touch');
        return false;
      }
    }

    return this._streamSegment(entry, req, res);
  }

  getSegment(cacheId) {
    if (!/^[a-f0-9]{48}$/i.test(cacheId)) return null;
    const entry = this.entries.get(cacheId);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this.entries.delete(cacheId);
      this._removeFiles(cacheId).catch(() => {});
      return null;
    }
    if (entry.status !== 'ready') return null;
    entry.lastAccessAt = Date.now();
    return entry;
  }

  async serveSegmentHead(cacheId, req, res) {
    if (!/^[a-f0-9]{48}$/i.test(cacheId)) return false;
    const sessionId = (req && req.params && req.params.sessionId) || null;
    if (this.playbackSessions && sessionId) {
      const sess = this._lookupSessionForTouch(sessionId);
      const touched = this.playbackSessions.touchSession({
        sessionId,
        owner: sess ? sess.owner : undefined,
        videoId: sess ? sess.videoId : undefined,
        tokenScope: sess ? sess.tokenScope : undefined,
        publicIp: req.ip || req.connection?.remoteAddress || '',
        userAgent: req.headers['user-agent'] || '', hlsActivity: 'segment'
      });
      if (!touched || !touched.ok) {
        this.metrics.misses++;
        this._segDiag('touch_failed', cacheId, (touched && touched.code) || 'no-touch');
        return false;
      }
    }
    const { entry } = await this._resolveSegmentEntry(cacheId);
    if (!entry) return false;
    try {
      const stat = await fs.promises.stat(entry.filePath);
      res.writeHead(200, {
        'Content-Type': entry.contentType || 'video/MP2T',
        'Content-Length': stat.size, 'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*', 'X-Cache': 'HIT'
      });
      res.end();
      return true;
    } catch (_) {
      this._segDiag('file_missing', cacheId, 'head-stat-fail');
      return false;
    }
  }

  // -- prune / cleanup --

  _prune() {
    if (this.destroyed) return;
    const now = Date.now();

    for (const [cid, e] of this.entries) {
      if (e.status !== 'fetching' && e.expiresAt < now) this._removeEntry(cid, 'ttl');
    }

    if (this.metrics.currentBytes > this.maxBytes) {
      const sorted = [...this.entries].filter(([, e]) => e.status !== 'fetching')
        .sort(([, a], [, b]) => a.lastAccessAt - b.lastAccessAt);
      for (const [cid] of sorted) {
        if (this.metrics.currentBytes <= this.maxBytes) break;
        this._removeEntry(cid, 'size');
      }
    }

    if (this.metrics.currentFiles > this.maxFiles) {
      const sorted = [...this.entries].filter(([, e]) => e.status !== 'fetching')
        .sort(([, a], [, b]) => a.lastAccessAt - b.lastAccessAt);
      for (const [cid] of sorted) {
        if (this.metrics.currentFiles <= this.maxFiles) break;
        this._removeEntry(cid, 'count');
      }
    }
  }

  async _removeEntry(cacheId, reason) {
    const e = this.entries.get(cacheId);
    if (!e) return;
    this.entries.delete(cacheId);
    this.metrics.evictions++;
    this.metrics.currentBytes -= e.size || 0;
    if (e.status === 'ready') this.metrics.currentFiles--;
    this._log(`evicted cacheId=${cacheId.slice(0, 12)} reason=${reason}`);
    await this._removeFiles(cacheId).catch(() => {});
  }

  async _removeFiles(cacheId) {
    const dir = this.cacheDir;
    await Promise.all([
      fs.promises.unlink(path.join(dir, cacheId + SEGMENT_EXT)).catch(() => {}),
      fs.promises.unlink(path.join(dir, cacheId + META_EXT)).catch(() => {}),
      fs.promises.unlink(path.join(dir, cacheId + PART_EXT)).catch(() => {}),
      fs.promises.unlink(path.join(dir, cacheId + META_EXT + PART_EXT)).catch(() => {})
    ]);
  }

  // -- helpers --

  _hashUrl(url) {
    return crypto.createHash('sha256').update(String(url || '')).digest('hex').slice(0, 8);
  }

  getStats() {
    return Object.assign({}, this.metrics, {
      prefetchQueueLength: this.prefetchQueue.length,
      activeDownloads: this.activeDownloads,
      inflightCount: this.inFlight.size,
      entriesInMemory: this.entries.size,
      streamGenerations: this.streamGens.size
    });
  }

  shutdown() {
    this.destroyed = true;
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.prefetchQueue.length = 0;
    this.processingQueue = false;
    this._log('shutdown');
  }
}

module.exports = { HlsSegmentCache };
