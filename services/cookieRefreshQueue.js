const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ALLOWED_COOKIES = new Set(['cookie1', 'cookie2', 'cookie3']);
const ACTIVE_STATUSES = new Set(['pending', 'claimed', 'running']);
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);
const VALID_STATUSES = new Set([...ACTIVE_STATUSES, ...TERMINAL_STATUSES]);

class CookieRefreshQueue {
    constructor(options = {}) {
        this.filePath = options.filePath || path.join(__dirname, '..', 'data', 'cookie-refresh-jobs.json');
        this.leaseMs = Number(options.leaseMs || process.env.COOKIE_REFRESH_LEASE_MS || (10 * 60 * 1000));
        this.maxAttempts = Number(options.maxAttempts || process.env.COOKIE_REFRESH_MAX_ATTEMPTS || 3);
        this.cooldownMs = Number(options.cooldownMs || process.env.COOKIE_REFRESH_COOLDOWN_MS || (10 * 60 * 1000));
        this.maxHistory = Number(options.maxHistory || process.env.COOKIE_REFRESH_MAX_HISTORY || 200);
        this.maxTextLength = Number(options.maxTextLength || 500);
        this._ensureStore();
    }

    _now() {
        return new Date().toISOString();
    }

    _shortText(value, limit = this.maxTextLength) {
        return this._redactSensitiveText(value)
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, limit);
    }

    _redactSensitiveText(value) {
        return String(value || '')
            .replace(/(Authorization:\s*Bearer\s+)[^\s]+/ig, '$1[redacted]')
            .replace(/(token["':=\s]+)[^"',\s]+/ig, '$1[redacted]')
            .replace(/# Netscape HTTP Cookie File[\s\S]*/ig, '[cookie content redacted]')
            .replace(/[A-Za-z]:\\[^\s"'<>|]+/g, '[path]')
            .replace(/\/(?:var|home|root|etc|opt)\/[^\s"'<>]+/g, '[path]');
    }

    _normalizeCookie(cookie) {
        const normalized = String(cookie || '').replace(/\.txt$/i, '').trim();
        if (!ALLOWED_COOKIES.has(normalized)) {
            throw new Error('cookie invalido');
        }
        return normalized;
    }

    _defaultStore() {
        return {
            version: 1,
            jobs: [],
            agents: {}
        };
    }

    _ensureStore() {
        const dir = path.dirname(this.filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        if (!fs.existsSync(this.filePath)) {
            this._writeStore(this._defaultStore());
        }
    }

    _readStore() {
        this._ensureStore();
        try {
            const data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
            if (!Array.isArray(data.jobs)) data.jobs = [];
            if (!data.agents || typeof data.agents !== 'object') data.agents = {};
            return data;
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
        const payload = JSON.stringify(store, null, 2);
        fs.writeFileSync(tmpPath, payload, 'utf8');
        fs.renameSync(tmpPath, this.filePath);
    }

    _activeJobForCookie(store, cookie) {
        return store.jobs.find(job => job.cookie === cookie && ACTIVE_STATUSES.has(job.status));
    }

    _trimHistory(store) {
        const active = store.jobs.filter(job => ACTIVE_STATUSES.has(job.status));
        const completed = store.jobs
            .filter(job => TERMINAL_STATUSES.has(job.status))
            .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
            .slice(0, this.maxHistory);
        store.jobs = [...active, ...completed].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    }

    recoverExpiredClaims() {
        const store = this._readStore();
        const now = Date.now();
        let changed = false;
        for (const job of store.jobs) {
            if ((job.status === 'claimed' || job.status === 'running') &&
                job.claimExpiresAt &&
                Date.parse(job.claimExpiresAt) <= now) {
                job.status = 'pending';
                job.agentId = null;
                job.claimedAt = null;
                job.claimExpiresAt = null;
                job.updatedAt = this._now();
                job.result = null;
                changed = true;
            }
        }
        if (changed) this._writeStore(store);
        return changed;
    }

    enqueue(cookie, source = 'api', reason = '', meta = {}) {
        const normalizedCookie = this._normalizeCookie(cookie);
        const store = this._readStore();
        this._recoverExpiredClaimsInStore(store);
        const existing = this._activeJobForCookie(store, normalizedCookie);
        if (existing) {
            this._writeStore(store);
            return { created: false, job: existing };
        }

        const now = this._now();
        const job = {
            id: crypto.randomUUID(),
            cookie: normalizedCookie,
            status: 'pending',
            source: ['automatic', 'dashboard', 'api'].includes(source) ? source : 'api',
            reason: this._shortText(reason),
            createdAt: now,
            updatedAt: now,
            claimedAt: null,
            claimExpiresAt: null,
            completedAt: null,
            attempts: 0,
            lastError: null,
            result: null,
            agentId: null,
            nextAttemptAt: null,
            requestedBy: this._shortText(meta.requestedBy, 120) || null
        };
        store.jobs.unshift(job);
        this._trimHistory(store);
        this._writeStore(store);
        return { created: true, job };
    }

    _recoverExpiredClaimsInStore(store) {
        const now = Date.now();
        let changed = false;
        for (const job of store.jobs) {
            if ((job.status === 'claimed' || job.status === 'running') &&
                job.claimExpiresAt &&
                Date.parse(job.claimExpiresAt) <= now) {
                job.status = 'pending';
                job.agentId = null;
                job.claimedAt = null;
                job.claimExpiresAt = null;
                job.updatedAt = this._now();
                changed = true;
            }
        }
        return changed;
    }

    getNextPending() {
        const store = this._readStore();
        const changed = this._recoverExpiredClaimsInStore(store);
        const now = Date.now();
        const job = store.jobs
            .filter(item => item.status === 'pending')
            .filter(item => !item.nextAttemptAt || Date.parse(item.nextAttemptAt) <= now)
            .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')))[0] || null;
        if (changed) this._writeStore(store);
        return job;
    }

    claim(jobId, agentId) {
        const store = this._readStore();
        this._recoverExpiredClaimsInStore(store);
        const job = store.jobs.find(item => item.id === jobId);
        if (!job) return { ok: false, code: 'not_found' };
        if (job.status !== 'pending') return { ok: false, code: 'conflict', job };
        if (job.nextAttemptAt && Date.parse(job.nextAttemptAt) > Date.now()) {
            return { ok: false, code: 'cooldown', job };
        }

        job.status = 'claimed';
        job.agentId = this._shortText(agentId, 120);
        job.claimedAt = this._now();
        job.claimExpiresAt = new Date(Date.now() + this.leaseMs).toISOString();
        job.updatedAt = this._now();
        job.attempts = Number(job.attempts || 0) + 1;
        this._writeStore(store);
        return { ok: true, job };
    }

    markRunning(jobId, agentId) {
        const store = this._readStore();
        const job = store.jobs.find(item => item.id === jobId);
        if (!job) return { ok: false, code: 'not_found' };
        if (job.agentId !== agentId) return { ok: false, code: 'forbidden', job };
        if (!['claimed', 'running'].includes(job.status)) return { ok: false, code: 'invalid_status', job };
        job.status = 'running';
        job.updatedAt = this._now();
        job.claimExpiresAt = new Date(Date.now() + this.leaseMs).toISOString();
        this._writeStore(store);
        return { ok: true, job };
    }

    complete(jobId, agentId, result = {}) {
        const store = this._readStore();
        const job = store.jobs.find(item => item.id === jobId);
        if (!job) return { ok: false, code: 'not_found' };
        if (job.status === 'succeeded' && job.agentId === agentId) return { ok: true, idempotent: true, job };
        if (job.agentId !== agentId) return { ok: false, code: 'forbidden', job };
        if (!['claimed', 'running'].includes(job.status)) return { ok: false, code: 'invalid_status', job };

        job.status = 'succeeded';
        job.updatedAt = this._now();
        job.completedAt = this._now();
        job.claimExpiresAt = null;
        job.lastError = null;
        job.result = this._safeResult(result);
        this._trimHistory(store);
        this._writeStore(store);
        return { ok: true, job };
    }

    fail(jobId, agentId, error = '') {
        const store = this._readStore();
        const job = store.jobs.find(item => item.id === jobId);
        if (!job) return { ok: false, code: 'not_found' };
        if (job.status === 'failed' && job.agentId === agentId) return { ok: true, idempotent: true, job };
        if (job.agentId !== agentId) return { ok: false, code: 'forbidden', job };
        if (!['claimed', 'running'].includes(job.status)) return { ok: false, code: 'invalid_status', job };

        job.updatedAt = this._now();
        job.lastError = this._shortText(error);
        job.claimExpiresAt = null;
        job.result = null;
        if (Number(job.attempts || 0) >= this.maxAttempts) {
            job.status = 'failed';
            job.completedAt = this._now();
        } else {
            job.status = 'pending';
            job.agentId = null;
            job.claimedAt = null;
            job.nextAttemptAt = new Date(Date.now() + this.cooldownMs).toISOString();
        }
        this._trimHistory(store);
        this._writeStore(store);
        return { ok: true, job };
    }

    cancel(jobId, reason = 'cancelado') {
        const store = this._readStore();
        const job = store.jobs.find(item => item.id === jobId);
        if (!job) return { ok: false, code: 'not_found' };
        if (job.status === 'cancelled') return { ok: true, idempotent: true, job };
        if (job.status === 'claimed' || job.status === 'running') return { ok: false, code: 'running', job };
        if (job.status !== 'pending') return { ok: false, code: 'invalid_status', job };
        job.status = 'cancelled';
        job.lastError = this._shortText(reason);
        job.updatedAt = this._now();
        job.completedAt = this._now();
        job.claimExpiresAt = null;
        this._trimHistory(store);
        this._writeStore(store);
        return { ok: true, job };
    }

    cancelPendingForCookie(cookie, reason = 'cookie revalidado antes da execução') {
        const normalizedCookie = this._normalizeCookie(cookie);
        const store = this._readStore();
        const cancelled = [];
        for (const job of store.jobs) {
            if (job.cookie === normalizedCookie && job.status === 'pending') {
                job.status = 'cancelled';
                job.lastError = this._shortText(reason);
                job.updatedAt = this._now();
                job.completedAt = this._now();
                job.claimExpiresAt = null;
                cancelled.push(job);
            }
        }
        if (cancelled.length > 0) {
            this._trimHistory(store);
            this._writeStore(store);
        }
        return cancelled;
    }

    list(filters = {}) {
        const store = this._readStore();
        let jobs = [...store.jobs];
        if (filters.cookie) jobs = jobs.filter(job => job.cookie === this._normalizeCookie(filters.cookie));
        if (filters.status) jobs = jobs.filter(job => job.status === filters.status);
        const limit = Math.max(1, Math.min(Number(filters.limit || 100), 200));
        return jobs.slice(0, limit);
    }

    getStatus() {
        const store = this._readStore();
        const counts = {};
        for (const status of VALID_STATUSES) counts[status] = 0;
        for (const job of store.jobs) {
            if (VALID_STATUSES.has(job.status)) counts[job.status] += 1;
        }
        return {
            enabled: true,
            counts,
            activeJobs: store.jobs.filter(job => ACTIVE_STATUSES.has(job.status)),
            recentJobs: store.jobs.slice(0, 25),
            agents: this.getAgents()
        };
    }

    recordHeartbeat(agentId, data = {}) {
        const store = this._readStore();
        const id = this._shortText(agentId, 120);
        if (!id) throw new Error('agentId ausente');
        store.agents[id] = {
            agentId: id,
            hostname: this._shortText(data.hostname, 120),
            version: this._shortText(data.version, 60),
            status: this._shortText(data.status || 'online', 80),
            lastSeen: this._now()
        };
        this._writeStore(store);
        return store.agents[id];
    }

    getAgents() {
        const store = this._readStore();
        return Object.values(store.agents || {})
            .sort((a, b) => String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')));
    }

    _safeResult(result) {
        if (!result || typeof result !== 'object') {
            return { message: this._shortText(result) };
        }
        return {
            message: this._shortText(result.message),
            exitCode: Number.isFinite(Number(result.exitCode)) ? Number(result.exitCode) : null,
            durationMs: Number.isFinite(Number(result.durationMs)) ? Number(result.durationMs) : null
        };
    }
}

module.exports = CookieRefreshQueue;
