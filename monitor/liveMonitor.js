// monitor/liveMonitor.js - Versão com ABR (master artificial) e suporte a maxHeight por requisição
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const CookieRotator = require('../cookieRotator');

// ============================================================
// ✅ AGENTES HTTP COM KEEPALIVE E MAX SOCKETS ALTO
// ============================================================
const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 30000
});
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 30000
});

// ============================================================

let systemState = null;
try { systemState = require('../systemState'); } catch(e) {}

// ========== CONSTANTES GLOBAIS ==========
const YTDLP_TIMEOUT = 180000; // 3 minutos (ajustado)
const METADATA_TTL = 15000;
const LIVE_STALL_TIME = 60000;

const LiveState = {
    ONLINE: 'online',
    DEGRADED: 'degraded',
    OFFLINE: 'offline',
    ENDED: 'ended'
};

const ComponentStatus = {
    OK: 'ok',
    WARNING: 'warning',
    ERROR: 'error',
    CRITICAL: 'critical'
};

class LiveMonitor {
    constructor(youtubeUrl, emailAlerts, activeMonitorsMap = null, scheduler = null, cookieRotator = null, onEnd = null) {
        this.youtubeUrl = youtubeUrl;
        this.emailAlerts = emailAlerts;
        this.videoId = this.extractVideoId(youtubeUrl); // ✅ agora o método existe
        this.m3u8Url = null;
        this.isLive = false;
        this.intervalMs = 8000;
        this.maxStallTimeMs = LIVE_STALL_TIME;
        
        this._activeMonitors = activeMonitorsMap;
        this._scheduler = scheduler;
        this._cookieRotator = cookieRotator;
        this._onEnd = onEnd;
        
        this.metadataFails = 0;
        this.segmentFails = 0;
        this.urlFails = 0;
        this.networkFailCount = 0;
        this.consecutiveUnknownFails = 0;
        this.maxFails = 5;
        this.maxNetworkWarnings = 3;
        this.maxNetworkErrors = 10;
        this.maxUnknownFails = 10;
        
        this.cookiesDir = path.join(__dirname, '../cookies');
        this.lastSuccessTime = null;
        this.lastError = null;
        this.liveState = LiveState.ONLINE;
        
        this._criticalSent = false;
        this._failoverSent = false;
        this._backupExpiredSent = false;
        this._recoverySent = false;
        this._mainMissingSent = false;
        this._mainRestoredSent = false;
        
        this.lastMediaSequence = null;
        this.stalledCount = 0;
        this.maxSegmentRepeats = this.calculateMaxRepeats();
        
        this.health = {
            network: { status: ComponentStatus.OK, lastCheck: null, message: '', failCount: 0 },
            metadata: { status: ComponentStatus.OK, lastCheck: null, message: '', failCount: 0 },
            playlist: { status: ComponentStatus.OK, lastCheck: null, message: '', failCount: 0 },
            cookies: { status: ComponentStatus.OK, lastCheck: null, message: '', failCount: 0 }
        };
        
        this._monitorStopped = false;
        this._liveEnded = false;
        this._liveEndedAt = null;
        this._stableCycles = 0;
        this._currentIntervalMs = this.intervalMs;
        
        this._cachedMetadata = null;
        this._metadataCacheTime = 0;
        this._metadataTTL = METADATA_TTL;
        
        if (!this._cookieRotator) {
            this._cookieRotator = new CookieRotator(this.cookiesDir);
        }
        
        this.needsRefresh = false;
        this.refreshPromise = null;
        this.lastRefreshReq = null;
        this._liveEndedFirstDetection = null;
        this.lastRefreshFailedAt = 0;
        
        // ✅ Armazenar URLs das playlists de qualidade (altura -> URL)
        this._playlistUrls = {};
        // Armazenar master artificial (se gerado)
        this._masterContent = null;
    }

    // ✅ MÉTODO CORRIGIDO (estava faltando)
    extractVideoId(url) {
        const match = url.match(/(?:v=|\/)([0-9A-Za-z_-]{11})(?:[?&]|$)/);
        return match ? match[1] : 'url_invalida';
    }

    calculateMaxRepeats() {
        return Math.max(6, Math.ceil(this.maxStallTimeMs / this.intervalMs));
    }

    getCookiePath() {
        const cookiePath = this._cookieRotator.getNextCookiePath();
        if (cookiePath) return cookiePath;
        return this._cookieRotator.getFallbackCookiePath();
    }

    // ============================================================
    // _runYtdlp (mantido igual)
    // ============================================================
    _runYtdlp(args, timeout = YTDLP_TIMEOUT) {
        return new Promise(async (resolve, reject) => {
            const filteredArgs = args.filter((arg, index) => {
                if (arg === '-f' || arg === '--format') return false;
                if (index > 0 && (args[index-1] === '-f' || args[index-1] === '--format')) return false;
                return true;
            });

            const isMetadataCall = filteredArgs.includes('--dump-json') && 
                                  filteredArgs.some(a => a.includes('youtube.com/watch') || a.includes('youtube.com/live'));
            let finalArgs = [...filteredArgs];
            if (isMetadataCall) {
                if (!finalArgs.includes('--flat-playlist')) finalArgs.push('--flat-playlist');
                if (!finalArgs.includes('--playlist-end')) finalArgs.push('--playlist-end', '1');
            }

            let cookieIndex = finalArgs.indexOf('--cookies');
            let cookiePath = null;
            if (cookieIndex !== -1 && finalArgs.length > cookieIndex + 1) {
                cookiePath = finalArgs[cookieIndex + 1];
            }
            if (!cookiePath) {
                const defaultCookie = path.join(this.cookiesDir, 'cookie1.txt');
                if (fs.existsSync(defaultCookie)) {
                    finalArgs.unshift('--cookies', defaultCookie);
                    cookiePath = defaultCookie;
                }
            }

            console.log(`🔧 _runYtdlp args: ${finalArgs.join(' ')}`);

            const ytCmd = process.platform === 'win32' ? '.\\yt-dlp.exe' : 'yt-dlp';
            const cookieName = cookiePath ? path.basename(cookiePath) : null;

            const execWithCookie = (cookieFile) => {
                return new Promise((resolveExec, rejectExec) => {
                    const argsWithCookie = [...finalArgs];
                    const idx = argsWithCookie.indexOf('--cookies');
                    if (idx !== -1) argsWithCookie.splice(idx, 2);
                    argsWithCookie.unshift('--cookies', cookieFile);

                    const child = spawn(ytCmd, argsWithCookie);
                    let stdout = '', stderr = '';
                    let timedOut = false;
                    let killTimeoutId = null;
                    const timeoutId = setTimeout(() => {
                        timedOut = true;
                        child.kill('SIGTERM');
                        killTimeoutId = setTimeout(() => {
                            if (!child.killed) {
                                console.warn(`⚠️ yt-dlp (pid ${child.pid}) não respondeu a SIGTERM, forçando SIGKILL`);
                                try { child.kill('SIGKILL'); } catch (e) {}
                            }
                        }, 5000);
                        rejectExec(new Error(`Timeout após ${timeout}ms`));
                    }, timeout);

                    child.stdout.on('data', (data) => { stdout += data.toString(); });
                    child.stderr.on('data', (data) => { stderr += data.toString(); });
                    child.on('close', (code) => {
                        clearTimeout(timeoutId);
                        if (killTimeoutId) clearTimeout(killTimeoutId);
                        if (timedOut) return;
                        if (code === 0) {
                            resolveExec({ stdout: stdout.trim(), stderr: stderr.trim() });
                        } else {
                            const errorMsg = stderr.trim() || `Código de saída: ${code}`;
                            rejectExec(new Error(errorMsg));
                        }
                    });
                    child.on('error', (err) => {
                        clearTimeout(timeoutId);
                        if (killTimeoutId) clearTimeout(killTimeoutId);
                        rejectExec(err);
                    });
                });
            };

            try {
                const result = await execWithCookie(cookiePath);
                if (this._cookieRotator && cookieName) {
                    this._cookieRotator.markSuccess(cookieName);
                }
                resolve(result.stdout);
            } catch (err) {
                const errorMsg = err.message || '';
                const isNoFormats = errorMsg.includes('No video formats found');
                const isAuth = errorMsg.includes('403') || errorMsg.includes('401') || errorMsg.includes('sign in') || errorMsg.includes('cookies');

                if ((isNoFormats || isAuth) && this._cookieRotator && cookieName) {
                    console.log(`🔴 Marcando falha para ${cookieName}: ${errorMsg.slice(0, 100)}`);
                    this._cookieRotator.markFailure(cookieName, errorMsg, this.videoId);
                }

                if (isNoFormats) {
                    console.log(`⚠️ Falha com cookie ${cookieName}, tentando alternativos...`);
                    const cookieFiles = ['cookie1.txt', 'cookie2.txt', 'cookie3.txt'];
                    let tried = false;
                    for (const file of cookieFiles) {
                        const fullPath = path.join(this.cookiesDir, file);
                        if (fullPath === cookiePath || !fs.existsSync(fullPath)) continue;
                        try {
                            console.log(`🔄 Tentando com ${file}...`);
                            const result = await execWithCookie(fullPath);
                            console.log(`✅ Sucesso com ${file}`);
                            if (this._cookieRotator) {
                                this._cookieRotator.markSuccess(file);
                            }
                            resolve(result.stdout);
                            tried = true;
                            break;
                        } catch (innerErr) {
                            const innerMsg = innerErr.message || '';
                            const isInnerNoFormats = innerMsg.includes('No video formats found');
                            if (isInnerNoFormats || innerMsg.includes('403') || innerMsg.includes('401')) {
                                console.log(`❌ ${file} também falhou.`);
                                if (this._cookieRotator) {
                                    this._cookieRotator.markFailure(file, innerMsg, this.videoId);
                                }
                            } else {
                                throw innerErr;
                            }
                        }
                    }
                    if (!tried) {
                        reject(new Error('Todos os cookies falharam com No video formats found'));
                    }
                } else {
                    reject(err);
                }
            }
        });
    }

    async getLiveMetadata(force = false) {
        const agora = Date.now();
        if (!force && this._cachedMetadata && (agora - this._metadataCacheTime) < this._metadataTTL) {
            console.log(`[${this.videoId}] 📦 Usando cache de metadados (${((agora - this._metadataCacheTime)/1000).toFixed(1)}s)`);
            return { success: true, metadata: this._cachedMetadata };
        }
        try {
            const cookiePath = this.getCookiePath();
            const args = ['--dump-json', '--flat-playlist', '--playlist-end', '1', this.youtubeUrl];
            if (cookiePath) args.unshift('--cookies', cookiePath);
            const stdout = await this._runYtdlp(args, YTDLP_TIMEOUT);
            const metadata = JSON.parse(stdout);
            this._cachedMetadata = metadata;
            this._metadataCacheTime = agora;
            this.updateHealthComponent('metadata', ComponentStatus.OK, 'Metadados obtidos com sucesso');
            this.metadataFails = 0;
            if (cookiePath) this.updateHealthComponent('cookies', ComponentStatus.OK, 'Cookie funcionando');
            
            if (this._cookieRotator && cookiePath) {
                const cookieName = path.basename(cookiePath);
                this._cookieRotator.markSuccess(cookieName);
            }
            
            return { success: true, metadata };
        } catch (error) {
            console.error(`[${this.videoId}] ❌ Erro spawn: ${error.message}`);
            const errorMsg = error.message.toLowerCase();
            const isLiveEnded = errorMsg.includes('video unavailable') || 
                               errorMsg.includes('not available') || 
                               errorMsg.includes('recording is not available') ||
                               errorMsg.includes('this live event has ended');
            
            if (errorMsg.includes('403') || errorMsg.includes('401') || errorMsg.includes('sign in')) {
                const cookieUsed = this.getCookiePath();
                if (this._cookieRotator && cookieUsed) {
                    const cookieName = path.basename(cookieUsed);
                    this._cookieRotator.markFailure(cookieName, error.message, this.videoId);
                }
                this.updateHealthComponent('cookies', ComponentStatus.ERROR, 'Cookie inválido');
                this.updateHealthComponent('metadata', ComponentStatus.WARNING, 'Erro de autenticação');
            } else if (isLiveEnded) {
                this.updateHealthComponent('metadata', ComponentStatus.CRITICAL, 'Live encerrada');
            } else if (errorMsg.includes('timeout')) {
                this.updateHealthComponent('metadata', ComponentStatus.WARNING, 'Timeout');
            } else {
                this.updateHealthComponent('metadata', ComponentStatus.WARNING, `Erro: ${error.message}`);
            }
            
            this.metadataFails++;
            return { success: false, error: error.message, isLiveEnded };
        }
    }

    validateMetadata(metadata) {
        const liveStatus = metadata.live_status;
        const wasLive = metadata.was_live === true;
        const isLive = metadata.is_live === true;
        console.log(`[${this.videoId}] 📊 Status:`, { live_status: liveStatus, is_live: isLive, was_live: wasLive, availability: metadata.availability });
        if (liveStatus === 'was_live' || liveStatus === 'post_live' || liveStatus === 'not_live') {
            this.updateHealthComponent('metadata', ComponentStatus.CRITICAL, `Live encerrada: ${liveStatus}`);
            return false;
        }
        if (wasLive && !isLive) {
            this.updateHealthComponent('metadata', ComponentStatus.CRITICAL, 'Live encerrada: was_live=true, is_live=false');
            return false;
        }
        if (liveStatus === 'is_live' || isLive) {
            this.updateHealthComponent('metadata', ComponentStatus.OK, `Live ativa: ${liveStatus}`);
            return true;
        }
        this.updateHealthComponent('metadata', ComponentStatus.WARNING, `Status desconhecido: ${liveStatus}`);
        this.consecutiveUnknownFails++;
        if (this.consecutiveUnknownFails >= this.maxUnknownFails) {
            this.updateHealthComponent('metadata', ComponentStatus.ERROR, `${this.consecutiveUnknownFails} status desconhecidos consecutivos`);
        }
        return null;
    }

    // ============================================================
    // extractHlsUrl – recebe maxHeight por parâmetro (não armazena)
    // ============================================================
    extractHlsUrl(metadata, maxHeight = null) {
        if (!metadata.formats || !Array.isArray(metadata.formats)) return null;

        const effectiveMax = maxHeight !== null ? maxHeight : parseInt(process.env.VIDEO_MAX_HEIGHT, 10) || 1080;
        const forceArtificial = (maxHeight !== null);

        // 1. Tenta usar master original (se existir) APENAS se não for forçado
        if (!forceArtificial) {
            const masterFormat = metadata.formats.find(f =>
                f.protocol === 'm3u8_native' &&
                f.url &&
                !f.height &&
                f.format_note && f.format_note.toLowerCase().includes('master')
            );
            if (masterFormat) {
                this._masterContent = null;
                console.log(`[${this.videoId}] 📺 Usando master original do YouTube.`);
                this._populatePlaylistUrls(metadata.formats);
                return masterFormat.url;
            }
        } else {
            console.log(`[${this.videoId}] 📺 Forçando construção artificial devido ao parâmetro max.`);
        }

        // 2. Construir master artificial a partir das variantes
        let hlsFormats = metadata.formats.filter(f => 
            (f.protocol === 'm3u8_native' || (f.url && f.url.includes('.m3u8'))) && 
            f.vcodec !== 'none' && 
            f.acodec !== 'none' &&
            f.height
        );

        if (hlsFormats.length === 0) return null;

        hlsFormats = hlsFormats.filter(f => (f.height || 0) <= effectiveMax);
        if (hlsFormats.length === 0) {
            hlsFormats = metadata.formats.filter(f => 
                (f.protocol === 'm3u8_native' || (f.url && f.url.includes('.m3u8'))) && 
                f.vcodec !== 'none' && 
                f.acodec !== 'none' &&
                f.height
            );
            hlsFormats.sort((a, b) => (a.height || 0) - (b.height || 0));
            const fallback = hlsFormats[0];
            console.log(`[${this.videoId}] ⚠️ Nenhum formato ≤ ${effectiveMax}p, usando fallback ${fallback.height}p.`);
            this._masterContent = null;
            this._populatePlaylistUrls(hlsFormats);
            return fallback.url;
        }

        hlsFormats.sort((a, b) => (a.height || 0) - (b.height || 0));

        console.log(`[${this.videoId}] 🛠️ Construindo manifesto master artificial com ${hlsFormats.length} qualidades (max ${effectiveMax}p).`);

        // Preencher playlistUrls
        const playlistUrls = {};
        hlsFormats.forEach(f => {
            const height = f.height || 360;
            playlistUrls[height] = f.url;
        });
        this._playlistUrls = playlistUrls;

        const bestVariant = hlsFormats[hlsFormats.length - 1];
        const bestUrl = bestVariant.url;

        const masterLines = hlsFormats.map(f => {
            const height = f.height || 360;
            const width = f.width || Math.round(height * 16/9);
            const fps = f.fps || 30;
            let bandwidth = 0;
            if (height <= 240) bandwidth = 300000;
            else if (height <= 360) bandwidth = 600000;
            else if (height <= 480) bandwidth = 1200000;
            else if (height <= 720) bandwidth = 2500000;
            else if (height <= 1080) bandwidth = 5000000;
            else bandwidth = 8000000;
            return `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${width}x${height},FRAME-RATE=${fps}\n${f.url}`;
        });

        const masterContent = '#EXTM3U\n' + masterLines.join('\n');

        this._masterContent = {
            isMaster: true,
            content: masterContent,
            urls: hlsFormats.map(f => f.url)
        };

        return bestUrl;
    }

    _populatePlaylistUrls(formats) {
        const playlistUrls = {};
        (formats || []).forEach(f => {
            if (f.url && (f.protocol === 'm3u8_native' || f.url.includes('.m3u8')) && f.height) {
                const height = f.height || 360;
                playlistUrls[height] = f.url;
            }
        });
        this._playlistUrls = playlistUrls;
    }

    // ============================================================
    // extractMediaSequence (com agentes)
    // ============================================================
    async extractMediaSequence(m3u8Url) {
        if (!m3u8Url) return null;
        return new Promise((resolve) => {
            let resolved = false;
            let timeoutId = null;
            const finish = (v) => { if(resolved) return; resolved=true; if(timeoutId) clearTimeout(timeoutId); resolve(v); };
            const urlObj = new URL(m3u8Url);
            const protocol = urlObj.protocol === 'https:' ? https : http;
            const request = protocol.get(m3u8Url, {
                agent: urlObj.protocol === 'https:' ? httpsAgent : httpAgent
            }, (res) => {
                if(res.statusCode !== 200) { finish(null); return; }
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    const seqMatch = data.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/);
                    if(seqMatch) finish(parseInt(seqMatch[1]));
                    else {
                        const lines = data.split('\n');
                        let lastTs = null;
                        for(let i=lines.length-1;i>=0;i--) {
                            const line = lines[i].trim();
                            if(line && !line.startsWith('#') && (line.endsWith('.ts') || line.includes('.ts?'))) { lastTs = line; break; }
                        }
                        finish(lastTs);
                    }
                });
            });
            timeoutId = setTimeout(() => { request.destroy(); finish(null); }, 10000);
            request.on('error', () => finish(null));
        });
    }

    async checkPlaylistProgress(m3u8Url) {
        if (!m3u8Url) {
            this.updateHealthComponent('playlist', ComponentStatus.ERROR, 'URL vazia');
            return false;
        }
        const currentSequence = await this.extractMediaSequence(m3u8Url);
        if (currentSequence === null) {
            this.stalledCount = 0;
            this.updateHealthComponent('playlist', ComponentStatus.ERROR, 'Não foi possível obter sequência');
            return false;
        }
        if (this.lastMediaSequence === null) {
            this.lastMediaSequence = currentSequence;
            this.updateHealthComponent('playlist', ComponentStatus.OK, `Primeira sequência: ${currentSequence}`);
            return true;
        }
        if (typeof currentSequence === 'number' && typeof this.lastMediaSequence === 'number') {
            if (currentSequence > this.lastMediaSequence) {
                this.stalledCount = 0;
                this.lastMediaSequence = currentSequence;
                this.updateHealthComponent('playlist', ComponentStatus.OK, `Avançou: ${currentSequence}`);
                return true;
            } else if (currentSequence === this.lastMediaSequence) {
                if (currentSequence === 0) {
                    console.log(`[${this.videoId}] ℹ️ MEDIA-SEQUENCE = 0 (playlist master) – ignorando, mantendo status OK`);
                    return true;
                }
                this.stalledCount++;
                console.log(`[${this.videoId}] 📊 Media sequence parado: ${currentSequence} (${this.stalledCount}/${this.maxSegmentRepeats})`);
                if (this.stalledCount >= this.maxSegmentRepeats) {
                    this.updateHealthComponent('playlist', ComponentStatus.CRITICAL, `Stream congelado após ${this.stalledCount} verificações`);
                    return false;
                }
                this.updateHealthComponent('playlist', ComponentStatus.WARNING, `Sequence parado (${this.stalledCount}/${this.maxSegmentRepeats})`);
                return true;
            }
        }
        if (currentSequence === this.lastMediaSequence) {
            if (currentSequence === 0) return true;
            this.stalledCount++;
            if (this.stalledCount >= this.maxSegmentRepeats) {
                this.updateHealthComponent('playlist', ComponentStatus.CRITICAL, 'Segmentos congelados');
                return false;
            }
            return true;
        } else {
            this.stalledCount = 0;
            this.lastMediaSequence = currentSequence;
            return true;
        }
    }

    updateHealthComponent(component, status, message='') {
        if(this.health[component]) {
            const old = this.health[component].status;
            this.health[component] = { status, lastCheck: new Date(), message, failCount: status===ComponentStatus.OK?0:(this.health[component].failCount||0)+1 };
            if(old !== status) console.log(`[${this.videoId}] 🔄 Health[${component}]: ${old} → ${status} (${message})`);
        }
    }

    updateNetworkHealth(isSuccess) {
        if(isSuccess) { if(this.networkFailCount>0) console.log(`[${this.videoId}] 🌐 Rede recuperada`); this.networkFailCount=0; this.updateHealthComponent('network',ComponentStatus.OK,'Conectividade normal'); return; }
        this.networkFailCount++;
        if(this.networkFailCount >= this.maxNetworkErrors) this.updateHealthComponent('network',ComponentStatus.ERROR,`${this.networkFailCount} falhas`);
        else if(this.networkFailCount >= this.maxNetworkWarnings) this.updateHealthComponent('network',ComponentStatus.WARNING,`${this.networkFailCount} falhas`);
        else this.updateHealthComponent('network',ComponentStatus.OK,`${this.networkFailCount} falhas, ainda tolerável`);
    }

    deriveLiveState() {
        const n = this.health.network.status, m = this.health.metadata.status, p = this.health.playlist.status;
        if(m === ComponentStatus.CRITICAL) return LiveState.ENDED;
        if(p === ComponentStatus.CRITICAL) return LiveState.DEGRADED;
        if(n === ComponentStatus.ERROR || m === ComponentStatus.ERROR || p === ComponentStatus.ERROR) return LiveState.OFFLINE;
        if(n === ComponentStatus.WARNING || m === ComponentStatus.WARNING || p === ComponentStatus.WARNING) return LiveState.DEGRADED;
        return LiveState.ONLINE;
    }

    applyDerivedState() {
        const newState = this.deriveLiveState();
        if(this.liveState !== newState) {
            console.log(`[${this.videoId}] 🔄 Estado alterado: ${this.liveState} → ${newState}`);
            this.liveState = newState;
            if(newState === LiveState.ENDED) {
                console.log(`[${this.videoId}] 🛑 Live encerrada, parando monitor`);
                this._liveEnded = true;
                this._liveEndedAt = Date.now();
            }
        }
        this.isLive = this.liveState === LiveState.ONLINE;
        return newState;
    }

    static REFRESH_RETRY_BACKOFF_MS = 1500;

    async requestRefresh() {
        if (this.refreshPromise) return this.refreshPromise;

        const sinceLastFailure = Date.now() - (this.lastRefreshFailedAt || 0);
        if (this.lastRefreshFailedAt && sinceLastFailure < LiveMonitor.REFRESH_RETRY_BACKOFF_MS) {
            const waitMs = LiveMonitor.REFRESH_RETRY_BACKOFF_MS - sinceLastFailure;
            console.log(`[${this.videoId}] ⏳ Renovação falhou há pouco, aguardando ${waitMs}ms antes de tentar de novo...`);
            await new Promise(resolve => setTimeout(resolve, waitMs));
        }

        this.lastRefreshReq = Date.now();
        this.refreshPromise = this._forceRenew().finally(() => {
            this.refreshPromise = null;
            this.needsRefresh = false;
        });
        return this.refreshPromise;
    }

    async _forceRenew() {
        console.log(`[${this.videoId}] 🔄 Forçando renovação da URL HLS...`);
        try {
            const metadataResult = await this.getLiveMetadata(true);
            if (!metadataResult.success) throw new Error(metadataResult.error);
            const newUrl = this.extractHlsUrl(metadataResult.metadata, null);
            if (!newUrl) throw new Error('Nova URL não encontrada');
            if (newUrl !== this.m3u8Url) {
                this.m3u8Url = newUrl;
                console.log(`[${this.videoId}] ✅ URL HLS forçada: ${newUrl.substring(0, 100)}...`);
            }
            this.lastRefreshFailedAt = 0;
            return true;
        } catch (err) {
            console.error(`[${this.videoId}] ❌ Falha na renovação forçada:`, err.message);
            this.lastRefreshFailedAt = Date.now();
            return false;
        }
    }

    _isUrlNearExpiry(url) {
        if (!url) return true;
        const match = url.match(/expire=(\d+)/);
        if (!match) return false;
        const expireTimestamp = parseInt(match[1]) * 1000;
        const tenMinutes = 10 * 60 * 1000;
        return (expireTimestamp - Date.now()) < tenMinutes;
    }

    async checkAndRenew() {
        if (this._monitorStopped || this._liveEnded) return;
        
        if (this.m3u8Url && this._isUrlNearExpiry(this.m3u8Url)) {
            console.log(`[${this.videoId}] ⏰ URL próxima do vencimento, invalidando cache e renovando...`);
            this._cachedMetadata = null;
            this._metadataCacheTime = 0;
            await this._forceRenew();
        }
        
        if (this.needsRefresh) {
            this.needsRefresh = false;
            this._cachedMetadata = null;
            this._metadataCacheTime = 0;
            await this._forceRenew();
        }

        console.log(`[${this.videoId}] 🔍 Ciclo de verificação (spawn)...`);
        const metadataResult = await this.getLiveMetadata();
        if (!metadataResult.success) {
            if (metadataResult.isLiveEnded) {
                if (!this._liveEndedFirstDetection) {
                    this._liveEndedFirstDetection = Date.now();
                    console.log(`[${this.videoId}] ⏳ Live possivelmente encerrada. Aguardando 2min para confirmar...`);
                    this.updateHealthComponent('metadata', ComponentStatus.WARNING, 'Live possivelmente encerrada (aguardando confirmação 2min)');
                    this.liveState = LiveState.DEGRADED;
                    return;
                }
                const minutesWaiting = (Date.now() - this._liveEndedFirstDetection) / 60000;
                if (minutesWaiting < 2) {
                    console.log(`[${this.videoId}] ⏳ Confirmando encerramento... (${minutesWaiting.toFixed(1)}/2 min)`);
                    if (this.m3u8Url) {
                        await this._forceRenew().catch(() => {});
                    }
                    this.updateHealthComponent('metadata', ComponentStatus.WARNING, `Confirmando encerramento (${minutesWaiting.toFixed(1)}/2min)`);
                    this.liveState = LiveState.DEGRADED;
                    return;
                }
                console.log(`[${this.videoId}] 🛑 Live encerrada confirmada após 2min. Parando monitor.`);
                this.updateHealthComponent('metadata', ComponentStatus.CRITICAL, 'Live encerrada (confirmado)');
                this.applyDerivedState();
                if (this._onEnd) {
                    this._onEnd(this.videoId, this.owner);
                }
                return;
            }
            this._liveEndedFirstDetection = null;
            if (metadataResult.errorType !== 'network') this.updateNetworkHealth(true);
            this.applyDerivedState();
            return;
        }
        
        this._liveEndedFirstDetection = null;
        this.updateNetworkHealth(true);
        
        const metadata = metadataResult.metadata;
        const isValid = this.validateMetadata(metadata);
        if (isValid === false) {
            this.applyDerivedState();
            if (this.liveState === LiveState.ENDED && this._onEnd) {
                this._onEnd(this.videoId, this.owner);
            }
            return;
        }
        const newUrl = this.extractHlsUrl(metadata, null);
        if (!newUrl) {
            console.log(`[${this.videoId}] ⚠️ URL HLS não encontrada`);
            this.urlFails++;
            this.updateHealthComponent('playlist', ComponentStatus.WARNING, 'URL não encontrada');
            if (this.urlFails >= this.maxFails) this.updateHealthComponent('playlist', ComponentStatus.ERROR, `${this.urlFails} falhas consecutivas`);
            this.applyDerivedState();
            return;
        }
        this.urlFails = 0;
        if (newUrl !== this.m3u8Url) {
            this.m3u8Url = newUrl;
            console.log(`[${this.videoId}] ✅ URL HLS atualizada (spawn)`);
        }
        const isPlaylistAdvancing = await this.checkPlaylistProgress(this.m3u8Url);
        if (!isPlaylistAdvancing) {
            console.log(`[${this.videoId}] ⚠️ Playlist não avança`);
            const stillLive = (metadata.live_status === 'is_live' || metadata.is_live === true);
            if (stillLive) {
                console.log(`[${this.videoId}] ⚠️ Playlist parada, mas YouTube confirma live ativa. Mantendo DEGRADED.`);
                this.updateHealthComponent('playlist', ComponentStatus.WARNING, 'Playlist congelada temporariamente');
                this.liveState = LiveState.DEGRADED;
                this.applyDerivedState();
                return;
            }
            this.segmentFails++;
            if (this.segmentFails >= this.maxFails) this.updateHealthComponent('playlist', ComponentStatus.ERROR, `${this.segmentFails} falhas consecutivas`);
            this.applyDerivedState();
            return;
        }
        this.segmentFails = 0;
        this.consecutiveUnknownFails = 0;
        this.applyDerivedState();
        
        if (this.stalledCount >= this.maxSegmentRepeats) {
            console.log(`[${this.videoId}] 🔄 Playlist parada por ${this.stalledCount} ciclos, forçando renovação da URL...`);
            await this._forceRenew();
            const newSeq = await this.extractMediaSequence(this.m3u8Url);
            if (newSeq !== null && (this.lastMediaSequence === null || newSeq > this.lastMediaSequence)) {
                this.lastMediaSequence = newSeq;
                this.stalledCount = 0;
                this.updateHealthComponent('playlist', ComponentStatus.OK, 'Recuperado após renovação forçada');
                console.log(`[${this.videoId}] ✅ Playlist recuperada após renovação (nova seq: ${newSeq})`);
            } else {
                console.log(`[${this.videoId}] ⚠️ Mesmo após renovação, playlist não avançou.`);
                this.updateHealthComponent('playlist', ComponentStatus.WARNING, 'Playlist congelada mesmo após renovação');
                this.liveState = LiveState.DEGRADED;
            }
        }

        if (this.liveState === LiveState.ONLINE) {
            this._stableCycles++;
            if (this._stableCycles > 3) {
                const newInterval = Math.min(45000, this.intervalMs + 5000);
                if (newInterval !== this._currentIntervalMs) {
                    this._currentIntervalMs = newInterval;
                    console.log(`[${this.videoId}] 📈 Live estável, aumentando intervalo para ${(newInterval/1000).toFixed(0)}s`);
                }
            }
        } else {
            if (this._stableCycles > 0) {
                this._stableCycles = 0;
                this._currentIntervalMs = this.intervalMs;
                console.log(`[${this.videoId}] 🔄 Live instável, resetando intervalo para ${(this.intervalMs/1000).toFixed(0)}s`);
            }
        }
        this.lastError = null;
        this.lastSuccessTime = new Date();
        if (systemState) systemState.registerSuccess();
        this.checkCookieRedundancy();
        console.log(`[${this.videoId}] ✅ Estado: ${this.liveState} | Health:`, {
            network: this.health.network.status,
            metadata: this.health.metadata.status,
            playlist: this.health.playlist.status,
            cookies: this.health.cookies.status
        });
    }

    checkCookieRedundancy() {
        const cookiesDir = this.cookiesDir;
        const MIN_SIZE = 5000;
        let anyCookieValid = false;
        let mainValid = false;
        let backupValid = false;
        try {
            const files = fs.readdirSync(cookiesDir);
            const cookieFiles = files.filter(f => f.startsWith('cookie') && f.endsWith('.txt'));
            for (const file of cookieFiles) {
                const fullPath = path.join(cookiesDir, file);
                if (fs.existsSync(fullPath) && fs.statSync(fullPath).size > MIN_SIZE) {
                    anyCookieValid = true;
                    break;
                }
            }
        } catch (err) {}
        const mainPath = path.join(cookiesDir, 'main.txt');
        const backupPath = path.join(cookiesDir, 'backup.txt');
        if (fs.existsSync(mainPath) && fs.statSync(mainPath).size > MIN_SIZE) mainValid = true;
        if (fs.existsSync(backupPath) && fs.statSync(backupPath).size > MIN_SIZE) backupValid = true;
        const hasValidCookie = anyCookieValid || mainValid || backupValid;
        if (hasValidCookie) {
            this.updateHealthComponent('cookies', ComponentStatus.OK, 'Pelo menos um cookie válido');
        } else {
            this.updateHealthComponent('cookies', ComponentStatus.ERROR, 'Nenhum cookie válido');
        }
        const liveCount = this._activeMonitors?.size || 0;
        if (!mainValid && !backupValid && !anyCookieValid && !this._criticalSent) {
            if (this.emailAlerts) this.emailAlerts.sendCriticalAlert(liveCount);
            this._criticalSent = true;
        } else if (!mainValid && backupValid && !this._failoverSent) {
            if (this.emailAlerts) this.emailAlerts.sendFailoverAlert(liveCount);
            this._failoverSent = true;
        }
    }

    startMonitoring(intervalSeconds=8) {
        this.maxSegmentRepeats = this.calculateMaxRepeats();
        this._monitorStopped = false;
        this._liveEnded = false;
        
        if (this._scheduler && this.videoId) {
            this._scheduler.register(this);
        }
        
        console.log(`🔄 Monitor iniciado para ${this.videoId}${this.owner ? ':' + this.owner : ''} (scheduler global)`);
    }

    stopMonitoring() {
        this._monitorStopped = true;
        if (this._scheduler) {
            this._scheduler.unregister(this.videoId, this.owner);
        }
        console.log(`⏹️ Monitor parado para ${this.videoId}${this.owner ? ':' + this.owner : ''}`);
    }
}

module.exports = LiveMonitor;