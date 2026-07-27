'use strict';

const crypto = require('crypto');

function getShortHash(value, length = 12) {
    return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, length);
}

function parseCanaryVideoIds(raw) {
    const value = String(raw || '').trim();
    if (!value) return new Set();
    const ids = value.split(',').map(id => id.trim()).filter(id => id.length > 0);
    return new Set(ids);
}

const VALID_SCOPES = new Set(['disabled', 'canary', 'short-segments']);

function normalizeScope(raw) {
    const val = String(raw || '').trim().toLowerCase();
    if (VALID_SCOPES.has(val)) return val;
    if (val) {
        console.error(`[HLS-RECOVERY] invalid scope "${raw}" fallback to canary`);
    }
    return 'canary';
}

class PlaylistStuckTracker {
    constructor(options = {}) {
        this._enabled = options.enabled === true;
        this._scope = normalizeScope(options.scope);
        this._canaryIds = options.canaryIds instanceof Set ? options.canaryIds : parseCanaryVideoIds(options.canaryIds);
        this._stuckThresholdMs = Number.isFinite(options.stuckThresholdMs) && options.stuckThresholdMs > 0 ? options.stuckThresholdMs : 8000;
        this._maxExtinfSeconds = Number.isFinite(options.maxExtinfSeconds) && options.maxExtinfSeconds > 0 ? options.maxExtinfSeconds : 3;
        this._cooldownMs = Number.isFinite(options.cooldownMs) && options.cooldownMs > 0 ? options.cooldownMs : 30000;
        this._refreshCooldownMs = Number.isFinite(options.refreshCooldownMs) && options.refreshCooldownMs > 0 ? options.refreshCooldownMs : 30000;
        this._maxAttemptsPerWindow = Number.isFinite(options.maxAttemptsPerWindow) && options.maxAttemptsPerWindow > 0 ? options.maxAttemptsPerWindow : 3;
        this._attemptWindowMs = Number.isFinite(options.attemptWindowMs) && options.attemptWindowMs > 0 ? options.attemptWindowMs : 300000;
        this._state = new Map();
        this._refreshState = new Map();
    }

    _key(videoId, quality) {
        return `${videoId}:${quality}`;
    }

    isEnabledFor(videoId, maxExtinf) {
        if (!this._enabled) return false;
        if (this._scope === 'disabled') return false;
        if (this._scope === 'canary') {
            return !!(videoId && this._canaryIds.has(videoId));
        }
        if (this._scope === 'short-segments') {
            if (!videoId) return false;
            if (Number.isFinite(maxExtinf) && maxExtinf > this._maxExtinfSeconds) return false;
            return true;
        }
        return false;
    }

    _computeThresholdMs(maxExtinfSeconds) {
        const extinf = Number.isFinite(maxExtinfSeconds) && maxExtinfSeconds > 0 ? maxExtinfSeconds : 0;
        const dynamicMs = Math.round(extinf * 1000 * 4);
        return Math.max(this._stuckThresholdMs, dynamicMs);
    }

    _isEligible(videoId, quality, options) {
        if (!this._enabled || this._scope === 'disabled') return { eligible: false, reason: 'disabled' };
        if (options && options.isMaster) return { eligible: false, reason: 'master_playlist' };
        if (options && options.isLive === false) return { eligible: false, reason: 'live_offline' };
        if (options && options.httpStatus !== undefined && options.httpStatus !== 200) return { eligible: false, reason: `http_${options.httpStatus}` };
        if (options && options.hasSegments === false) return { eligible: false, reason: 'no_segments' };
        if (!videoId) return { eligible: false, reason: 'no_video_id' };
        if (this._scope === 'canary' && !this._canaryIds.has(videoId)) return { eligible: false, reason: 'not_in_canary' };
        return { eligible: true };
    }

    update(videoId, quality, mseq, upstreamHash, options = {}) {
        const now = Date.now();
        const maxExtinf = Number.isFinite(options.maxExtinf) ? options.maxExtinf : null;

        const eligible = this._isEligible(videoId, quality, options);
        if (!eligible.eligible) {
            return { stuckDetected: false, recoveryNeeded: false, reason: eligible.reason };
        }

        const enabledForId = this.isEnabledFor(videoId, maxExtinf);
        if (!enabledForId) {
            return { stuckDetected: false, recoveryNeeded: false, reason: 'not_enabled' };
        }

        if (mseq === null || mseq === undefined || mseq === '?') {
            return { stuckDetected: false, recoveryNeeded: false, reason: 'invalid_mseq' };
        }

        const seqNum = Number(mseq);
        if (!Number.isFinite(seqNum)) {
            return { stuckDetected: false, recoveryNeeded: false, reason: 'invalid_mseq' };
        }

        const key = this._key(videoId, quality);
        let entry = this._state.get(key);
        if (!entry) {
            entry = {
                lastMseq: seqNum,
                lastAdvanceAt: now,
                lastSeenAt: now,
                lastUpstreamHash: upstreamHash || null,
                recoveryInFlight: false,
                lastRecoveryAt: 0,
                recoveryCount: 0,
                recoveryTimestamps: []
            };
            this._state.set(key, entry);
            return { stuckDetected: false, recoveryNeeded: false, reason: 'first_seen' };
        }

        entry.lastSeenAt = now;

        if (seqNum > entry.lastMseq) {
            entry.lastMseq = seqNum;
            entry.lastAdvanceAt = now;
            entry.lastUpstreamHash = upstreamHash || entry.lastUpstreamHash;
            return { stuckDetected: false, recoveryNeeded: false, reason: 'advanced', stuckMs: 0 };
        }

        if (seqNum < entry.lastMseq) {
            entry.lastMseq = seqNum;
            entry.lastAdvanceAt = now;
            entry.lastUpstreamHash = upstreamHash || entry.lastUpstreamHash;
            entry.recoveryInFlight = false;
            return { stuckDetected: false, recoveryNeeded: false, reason: 'mseq_decreased_reset', stuckMs: 0 };
        }

        const thresholdMs = this._computeThresholdMs(maxExtinf);
        const stuckMs = now - entry.lastAdvanceAt;
        const stuckDetected = stuckMs >= thresholdMs;

        if (!stuckDetected) {
            return { stuckDetected: false, recoveryNeeded: false, reason: 'below_threshold', stuckMs, thresholdMs };
        }

        if (entry.recoveryInFlight) {
            return { stuckDetected: true, recoveryNeeded: false, reason: 'already_in_flight', stuckMs, thresholdMs };
        }

        const cooldownRemaining = (entry.lastRecoveryAt + this._cooldownMs) - now;
        if (cooldownRemaining > 0) {
            return { stuckDetected: true, recoveryNeeded: false, reason: 'cooldown', stuckMs, cooldownRemaining, thresholdMs };
        }

        const refreshState = this._getRefreshState(videoId);
        const refreshCooldownRemaining = (refreshState.lastRefreshAt + this._refreshCooldownMs) - now;
        if (refreshCooldownRemaining > 0) {
            return { stuckDetected: true, recoveryNeeded: false, reason: 'refresh_cooldown', stuckMs, refreshCooldownRemaining, thresholdMs };
        }

        const recentCount = this._countRecentAttempts(entry);
        if (recentCount >= this._maxAttemptsPerWindow) {
            return { stuckDetected: true, recoveryNeeded: false, reason: 'attempt_limit', stuckMs, attemptCount: recentCount, maxAttempts: this._maxAttemptsPerWindow, thresholdMs };
        }

        return { stuckDetected: true, recoveryNeeded: true, reason: 'threshold_exceeded', stuckMs, thresholdMs };
    }

    _getRefreshState(videoId) {
        let state = this._refreshState.get(videoId);
        if (!state) {
            state = { lastRefreshAt: 0 };
            this._refreshState.set(videoId, state);
        }
        return state;
    }

    _countRecentAttempts(entry) {
        const now = Date.now();
        const cutoff = now - this._attemptWindowMs;
        const recent = (entry.recoveryTimestamps || []).filter(ts => ts > cutoff);
        return recent.length;
    }

    markRecoveryStarted(videoId, quality) {
        const key = this._key(videoId, quality);
        const entry = this._state.get(key);
        if (entry) {
            const now = Date.now();
            entry.recoveryInFlight = true;
            entry.lastRecoveryAt = now;
            entry.recoveryCount = (entry.recoveryCount || 0) + 1;
            if (!entry.recoveryTimestamps) entry.recoveryTimestamps = [];
            entry.recoveryTimestamps.push(now);
            const cutoff = now - this._attemptWindowMs;
            entry.recoveryTimestamps = entry.recoveryTimestamps.filter(ts => ts > cutoff);
        }
    }

    markRecoveryComplete(videoId, quality, newMseq) {
        const key = this._key(videoId, quality);
        const entry = this._state.get(key);
        if (entry) {
            entry.recoveryInFlight = false;
            if (newMseq !== undefined && newMseq !== null) {
                const seqNum = Number(newMseq);
                if (Number.isFinite(seqNum) && seqNum > entry.lastMseq) {
                    entry.lastMseq = seqNum;
                    entry.lastAdvanceAt = Date.now();
                }
            }
        }
    }

    markRefreshDone(videoId) {
        const state = this._getRefreshState(videoId);
        state.lastRefreshAt = Date.now();
    }

    isRefreshCooldownExpired(videoId) {
        const state = this._refreshState.get(videoId);
        if (!state) return true;
        return (Date.now() - state.lastRefreshAt) >= this._refreshCooldownMs;
    }

    getState(videoId, quality) {
        const key = this._key(videoId, quality);
        return this._state.get(key) || null;
    }

    getRecoveryCount(videoId, quality) {
        const entry = this.getState(videoId, quality);
        return entry ? (entry.recoveryCount || 0) : 0;
    }

    isRecoveryInFlight(videoId, quality) {
        const entry = this.getState(videoId, quality);
        return entry ? entry.recoveryInFlight : false;
    }

    reset(videoId, quality) {
        const key = this._key(videoId, quality);
        this._state.delete(key);
    }

    clear() {
        this._state.clear();
        this._refreshState.clear();
    }

    get diagnostics() {
        const entries = [];
        for (const [key, state] of this._state.entries()) {
            entries.push({
                key,
                lastMseq: state.lastMseq,
                stuckMs: Date.now() - state.lastAdvanceAt,
                recoveryInFlight: state.recoveryInFlight,
                recoveryCount: state.recoveryCount,
                lastRecoveryAt: state.lastRecoveryAt,
                recentAttempts: this._countRecentAttempts(state)
            });
        }
        return {
            enabled: this._enabled,
            scope: this._scope,
            maxExtinfSeconds: this._maxExtinfSeconds,
            stuckThresholdMs: this._stuckThresholdMs,
            cooldownMs: this._cooldownMs,
            refreshCooldownMs: this._refreshCooldownMs,
            maxAttemptsPerWindow: this._maxAttemptsPerWindow,
            attemptWindowMs: this._attemptWindowMs,
            canaryIds: [...this._canaryIds],
            variantEntries: entries,
            refreshEntries: [...this._refreshState.entries()].map(([id, s]) => ({
                videoId: id,
                lastRefreshAt: s.lastRefreshAt,
                cooldownRemaining: Math.max(0, this._refreshCooldownMs - (Date.now() - s.lastRefreshAt))
            }))
        };
    }
}

module.exports = {
    PlaylistStuckTracker,
    parseCanaryVideoIds,
    getShortHash,
    normalizeScope
};
