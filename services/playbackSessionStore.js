const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_TTL_MS = 90000;
const DEFAULT_REUSE_STALE_AFTER_MS = 45000;

function safeText(value, limit = 300) {
    return String(value || '')
        .replace(/Authorization:\s*Bearer\s+[^\s]+/ig, '[redacted-header]')
        .replace(/Cookie:\s*[^"'<>]+/ig, '[redacted-header]')
        .replace(/(token["':=\s]+)[^"',\s]+/ig, '$1[redacted]')
        .replace(/https?:\/\/[^\s"'<>]+/ig, '[url-redacted]')
        .replace(/[A-Za-z]:\\[^\s"'<>|]+/g, '[path]')
        .replace(/\/(?:var|home|root|etc|opt)\/[^\s"'<>]+/g, '[path]')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, limit);
}

function sessionPreview(sessionId) {
    const value = String(sessionId || '');
    if (value.length <= 8) return value || 'n/a';
    return `${value.slice(0, 8)}...`;
}

class PlaybackSessionStore {
    constructor(options = {}) {
        this.filePath = options.filePath || path.join(__dirname, '..', 'data', 'playback-sessions.json');
        const configuredTtl = Number(options.ttlMs || process.env.PLAYBACK_SESSION_TTL_MS);
        this.ttlMs = Number.isFinite(configuredTtl) && configuredTtl > 0 ? configuredTtl : DEFAULT_TTL_MS;
        const configuredReuseStaleAfter = Number(
            options.reuseStaleAfterMs !== undefined
                ? options.reuseStaleAfterMs
                : process.env.PLAYBACK_SESSION_REUSE_STALE_AFTER_MS
        );
        this.reuseStaleAfterMs = Number.isFinite(configuredReuseStaleAfter) && configuredReuseStaleAfter >= 0
            ? configuredReuseStaleAfter
            : DEFAULT_REUSE_STALE_AFTER_MS;
        this.maxUserAgentLength = Number(options.maxUserAgentLength || 240);
        this._ensureStore();
    }

    _nowIso(nowMs = Date.now()) {
        return new Date(nowMs).toISOString();
    }

    _newSessionId() {
        return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
    }

    _defaultStore() {
        return {
            version: 1,
            sessions: {}
        };
    }

    _ensureShape(store) {
        if (!store || typeof store !== 'object') store = this._defaultStore();
        if (!store.sessions || typeof store.sessions !== 'object') store.sessions = {};
        return store;
    }

    _ensureStore() {
        const dir = path.dirname(this.filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        if (!fs.existsSync(this.filePath)) this._writeStore(this._defaultStore());
    }

    _readStore() {
        this._ensureStore();
        try {
            return this._ensureShape(JSON.parse(fs.readFileSync(this.filePath, 'utf8')));
        } catch (err) {
            const corruptPath = `${this.filePath}.corrupt-${Date.now()}`;
            try { fs.copyFileSync(this.filePath, corruptPath); } catch (_) {}
            const store = this._defaultStore();
            this._writeStore(store);
            return store;
        }
    }

    _writeStore(store) {
        const dir = path.dirname(this.filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const tmpPath = path.join(dir, `.${path.basename(this.filePath)}.${process.pid}.${Date.now()}.tmp`);
        fs.writeFileSync(tmpPath, JSON.stringify(this._ensureShape(store), null, 2), 'utf8');
        fs.renameSync(tmpPath, this.filePath);
    }

    _isExpired(session, nowMs = Date.now()) {
        const lastSeen = Date.parse(session?.lastSeenAt || session?.createdAt || '');
        if (!Number.isFinite(lastSeen)) return true;
        return nowMs - lastSeen > this.ttlMs;
    }

    _pruneExpiredInStore(store, nowMs = Date.now()) {
        let removed = 0;
        for (const [sessionId, session] of Object.entries(store.sessions)) {
            if (this._isExpired(session, nowMs)) {
                delete store.sessions[sessionId];
                removed += 1;
            }
        }
        return removed;
    }

    _matches(session, owner, videoId) {
        if (owner !== undefined && session.owner !== owner) return false;
        if (videoId !== undefined && session.videoId !== videoId) return false;
        return true;
    }

    _activeSessionsInStore(store, filters = {}, nowMs = Date.now()) {
        return Object.values(store.sessions)
            .filter(session => !this._isExpired(session, nowMs))
            .filter(session => this._matches(session, filters.owner, filters.videoId));
    }

    _lastSeenMs(session) {
        const parsed = Date.parse(session?.lastSeenAt || session?.createdAt || '');
        return Number.isFinite(parsed) ? parsed : 0;
    }

    _matchesClient(session, { publicIp, userAgent, fingerprint }) {
        const normalizedPublicIp = safeText(publicIp, 80);
        const normalizedUserAgent = safeText(userAgent, this.maxUserAgentLength);
        if (!normalizedPublicIp || !normalizedUserAgent) return false;
        if (session.publicIp !== normalizedPublicIp || session.userAgent !== normalizedUserAgent) return false;

        const normalizedFingerprint = fingerprint ? safeText(fingerprint, 240) : null;
        const sessionFingerprint = session.fingerprint || null;
        if (normalizedFingerprint || sessionFingerprint) {
            return normalizedFingerprint === sessionFingerprint;
        }
        return true;
    }

    _findReusableStaleSession(store, { owner, videoId, publicIp, userAgent, fingerprint } = {}, nowMs = Date.now()) {
        if (!this.reuseStaleAfterMs) return null;
        const candidates = Object.entries(store.sessions)
            .filter(([, session]) => this._matches(session, owner, videoId))
            .filter(([, session]) => !this._isExpired(session, nowMs))
            .filter(([, session]) => this._matchesClient(session, { publicIp, userAgent, fingerprint }))
            .filter(([, session]) => nowMs - this._lastSeenMs(session) >= this.reuseStaleAfterMs)
            .sort(([, a], [, b]) => this._lastSeenMs(b) - this._lastSeenMs(a));
        if (candidates.length === 0) return null;
        return {
            sessionId: candidates[0][0],
            session: candidates[0][1]
        };
    }

    createSession({ owner, videoId, limit = 0, publicIp = '', userAgent = '', source = 'hls', fingerprint = null } = {}, nowMs = Date.now()) {
        const normalizedOwner = safeText(owner, 120);
        const normalizedVideoId = safeText(videoId, 40);
        if (!normalizedOwner || !normalizedVideoId) return { ok: false, code: 'invalid_scope' };
        const store = this._readStore();
        const changed = this._pruneExpiredInStore(store, nowMs);
        const active = this._activeSessionsInStore(store, {
            owner: normalizedOwner,
            videoId: normalizedVideoId
        }, nowMs);
        const parsedLimit = Number(limit);
        const numericLimit = Number.isFinite(parsedLimit) ? Math.floor(parsedLimit) : 0;

        if (numericLimit <= 0) {
            if (changed) this._writeStore(store);
            return {
                ok: false,
                code: 'limit_unavailable',
                active: active.length,
                limit: numericLimit
            };
        }

        const reusable = this._findReusableStaleSession(store, {
            owner: normalizedOwner,
            videoId: normalizedVideoId,
            publicIp,
            userAgent,
            fingerprint
        }, nowMs);
        if (reusable) {
            const nowIso = this._nowIso(nowMs);
            reusable.session.lastSeenAt = nowIso;
            reusable.session.publicIp = safeText(publicIp, 80);
            reusable.session.userAgent = safeText(userAgent, this.maxUserAgentLength);
            reusable.session.status = 'active';
            reusable.session.source = safeText(source, 80);
            reusable.session.fingerprint = fingerprint ? safeText(fingerprint, 240) : null;
            this._writeStore(store);
            return {
                ok: true,
                code: 'reused_stale',
                session: reusable.session,
                active: active.length,
                limit: numericLimit
            };
        }

        if (active.length >= numericLimit) {
            if (changed) this._writeStore(store);
            return {
                ok: false,
                code: 'limit_exceeded',
                active: active.length,
                limit: numericLimit
            };
        }

        let sessionId = this._newSessionId();
        while (store.sessions[sessionId]) sessionId = this._newSessionId();

        const nowIso = this._nowIso(nowMs);
        const session = {
            sessionId,
            owner: normalizedOwner,
            videoId: normalizedVideoId,
            createdAt: nowIso,
            lastSeenAt: nowIso,
            publicIp: safeText(publicIp, 80),
            userAgent: safeText(userAgent, this.maxUserAgentLength),
            status: 'active',
            source: safeText(source, 80),
            fingerprint: fingerprint ? safeText(fingerprint, 240) : null
        };

        store.sessions[sessionId] = session;
        this._writeStore(store);
        return {
            ok: true,
            code: 'created',
            session,
            active: active.length + 1,
            limit: numericLimit
        };
    }

    touchSession({ sessionId, owner, videoId, publicIp = '', userAgent = '' } = {}, nowMs = Date.now()) {
        const id = String(sessionId || '').trim();
        if (!id) return { ok: false, code: 'missing_session' };
        const store = this._readStore();
        const session = store.sessions[id];

        if (!session) {
            const changed = this._pruneExpiredInStore(store, nowMs);
            if (changed) this._writeStore(store);
            return { ok: false, code: 'not_found' };
        }
        if (session.owner !== owner) return { ok: false, code: 'owner_mismatch', session };
        if (session.videoId !== videoId) return { ok: false, code: 'video_mismatch', session };
        if (this._isExpired(session, nowMs)) {
            delete store.sessions[id];
            this._pruneExpiredInStore(store, nowMs);
            this._writeStore(store);
            return { ok: false, code: 'expired' };
        }

        this._pruneExpiredInStore(store, nowMs);
        session.lastSeenAt = this._nowIso(nowMs);
        session.publicIp = safeText(publicIp, 80);
        session.userAgent = safeText(userAgent, this.maxUserAgentLength);
        session.status = 'active';
        this._writeStore(store);
        return { ok: true, code: 'touched', session };
    }

    listActive(filters = {}, nowMs = Date.now()) {
        const store = this._readStore();
        const changed = this._pruneExpiredInStore(store, nowMs);
        if (changed) this._writeStore(store);
        return this._activeSessionsInStore(store, filters, nowMs)
            .sort((a, b) => String(b.lastSeenAt || '').localeCompare(String(a.lastSeenAt || '')));
    }

    countActive(filters = {}, nowMs = Date.now()) {
        return this.listActive(filters, nowMs).length;
    }

    removeForLive(owner, videoId) {
        const store = this._readStore();
        let removed = 0;
        for (const [sessionId, session] of Object.entries(store.sessions)) {
            if (session.owner === owner && session.videoId === videoId) {
                delete store.sessions[sessionId];
                removed += 1;
            }
        }
        if (removed) this._writeStore(store);
        return removed;
    }

    removeSession(sessionId, filters = {}) {
        const id = String(sessionId || '').trim();
        if (!id) return false;
        const store = this._readStore();
        let session = store.sessions[id];
        let resolvedId = id;
        if (!session && id.endsWith('...')) {
            const matches = Object.entries(store.sessions)
                .filter(([candidateId]) => sessionPreview(candidateId) === id);
            if (matches.length === 1) {
                resolvedId = matches[0][0];
                session = matches[0][1];
            }
        }
        if (!session) return false;
        if (filters.owner && session.owner !== filters.owner) return false;
        if (filters.videoId && session.videoId !== filters.videoId) return false;
        delete store.sessions[resolvedId];
        this._writeStore(store);
        return true;
    }

    removeForOwner(owner) {
        const store = this._readStore();
        let removed = 0;
        for (const [sessionId, session] of Object.entries(store.sessions)) {
            if (session.owner === owner) {
                delete store.sessions[sessionId];
                removed += 1;
            }
        }
        if (removed) this._writeStore(store);
        return removed;
    }

    pruneExpired(nowMs = Date.now()) {
        const store = this._readStore();
        const removed = this._pruneExpiredInStore(store, nowMs);
        if (removed) this._writeStore(store);
        return removed;
    }
}

module.exports = {
    PlaybackSessionStore,
    sessionPreview,
    safeText
};
