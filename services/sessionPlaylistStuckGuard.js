'use strict';

class SessionPlaylistStuckGuard {
    constructor(options = {}) {
        this.enabled = options.enabled === true;
        this.maxSameSeqHits = Number.isFinite(options.maxSameSeqHits) && options.maxSameSeqHits >= 1
            ? Math.floor(options.maxSameSeqHits)
            : 3;
        this.maxAgeMs = Number.isFinite(options.maxAgeMs) && options.maxAgeMs >= 1
            ? Math.floor(options.maxAgeMs)
            : 6000;
        this.states = new Map();
    }

    observe(key, sequence, now = Date.now()) {
        const seq = Number(sequence);
        if (!this.enabled || !key || !Number.isFinite(seq)) {
            return { shouldProbe: false, reason: this.enabled ? 'invalid_input' : 'disabled' };
        }

        const existing = this.states.get(key);
        if (!existing || existing.sequence !== seq) {
            const state = {
                sequence: seq,
                sameHits: 1,
                firstSeenAt: now,
                lastSeenAt: now,
                lastProbeAt: 0
            };
            this.states.set(key, state);
            return { shouldProbe: false, reason: existing ? 'sequence_changed' : 'first_seen', ...state, ageMs: 0 };
        }

        existing.sameHits += 1;
        existing.lastSeenAt = now;
        const ageMs = Math.max(0, now - existing.firstSeenAt);
        const overHitLimit = existing.sameHits > this.maxSameSeqHits;
        const oldEnough = ageMs >= this.maxAgeMs;
        const probeCooldownElapsed = !existing.lastProbeAt || now - existing.lastProbeAt >= this.maxAgeMs;
        return {
            shouldProbe: overHitLimit && oldEnough && probeCooldownElapsed,
            reason: overHitLimit && oldEnough ? (probeCooldownElapsed ? 'stuck_candidate' : 'probe_cooldown') : 'below_threshold',
            ...existing,
            ageMs
        };
    }

    markProbe(key, now = Date.now()) {
        const state = this.states.get(key);
        if (state) state.lastProbeAt = now;
    }

    markRecovered(key, sequence, now = Date.now()) {
        const seq = Number(sequence);
        if (!key || !Number.isFinite(seq)) return;
        this.states.set(key, {
            sequence: seq,
            sameHits: 1,
            firstSeenAt: now,
            lastSeenAt: now,
            lastProbeAt: 0
        });
    }

    clear(key) {
        if (key) this.states.delete(key);
    }

    prune(maxIdleMs, now = Date.now()) {
        const ttl = Number.isFinite(maxIdleMs) && maxIdleMs > 0 ? maxIdleMs : 5 * 60 * 1000;
        for (const [key, state] of this.states.entries()) {
            if (!state || now - (Number(state.lastSeenAt) || 0) > ttl) {
                this.states.delete(key);
            }
        }
    }
}

function shouldRepinSessionPlaylist(currentSequence, newerSequence, hasContinuity) {
    const current = Number(currentSequence);
    const newer = Number(newerSequence);
    return Number.isFinite(current) &&
        Number.isFinite(newer) &&
        newer > current &&
        hasContinuity === true;
}

function promoteValidatedPlaylistCache({
    cache,
    cacheKey,
    sourceUrl,
    content,
    snapshot,
    now = Date.now()
}) {
    if (!(cache instanceof Map) || !cacheKey || !sourceUrl || typeof content !== 'string') {
        return false;
    }

    if (snapshot?.mediaSequence === null || snapshot?.mediaSequence === undefined ||
        snapshot?.lastSequence === null || snapshot?.lastSequence === undefined) {
        return false;
    }
    const mediaSequence = Number(snapshot.mediaSequence);
    const lastSequence = Number(snapshot.lastSequence);
    if (!Number.isFinite(mediaSequence) || !Number.isFinite(lastSequence) || lastSequence < mediaSequence) {
        return false;
    }

    cache.set(cacheKey, {
        content,
        fetchedAt: now,
        sourceUrl,
        mediaSequence,
        lastSequence
    });
    return true;
}

module.exports = {
    SessionPlaylistStuckGuard,
    shouldRepinSessionPlaylist,
    promoteValidatedPlaylistCache
};
