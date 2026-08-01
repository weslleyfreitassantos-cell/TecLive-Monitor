'use strict';

const DEFAULTS = Object.freeze({
    factor: 0.5,
    minTtlMs: 500,
    maxTtlMs: 3000
});

function parsePositiveNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function createLivePlaylistTtlConfig(env, configuredTtlMs) {
    const source = env || {};
    let factor = parsePositiveNumber(source.PLAYBACK_LIVE_TTL_FACTOR, DEFAULTS.factor);
    let minTtlMs = parsePositiveNumber(source.PLAYBACK_LIVE_TTL_MIN_MS, DEFAULTS.minTtlMs);
    let maxTtlMs = parsePositiveNumber(source.PLAYBACK_LIVE_TTL_MAX_MS, DEFAULTS.maxTtlMs);
    if (minTtlMs > maxTtlMs) {
        factor = DEFAULTS.factor;
        minTtlMs = DEFAULTS.minTtlMs;
        maxTtlMs = DEFAULTS.maxTtlMs;
    }
    return {
        enabled: String(source.PLAYBACK_DYNAMIC_LIVE_PLAYLIST_TTL || '').toLowerCase() === 'true',
        configuredTtlMs: parsePositiveNumber(configuredTtlMs, 2000),
        factor,
        minTtlMs,
        maxTtlMs
    };
}

function getPlaylistCacheMetadata(content) {
    const text = String(content || '');
    const isValidM3u8 = /^\s*#EXTM3U\b/m.test(text);
    const isMasterPlaylist = isValidM3u8 && /^#EXT-X-STREAM-INF:/mi.test(text);
    const hasEndList = /^#EXT-X-ENDLIST\b/mi.test(text);
    const targetMatch = text.match(/^#EXT-X-TARGETDURATION:(\d+(?:\.\d+)?)/mi);
    const sequenceMatch = text.match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/mi);
    const targetDuration = targetMatch ? Number(targetMatch[1]) : null;
    const mediaSequence = sequenceMatch ? Number(sequenceMatch[1]) : null;
    const segmentCount = (text.match(/^#EXTINF:/gmi) || []).length;
    const isMediaPlaylist = isValidM3u8 && !isMasterPlaylist && segmentCount > 0;
    const isLivePlaylist = isMediaPlaylist &&
        !hasEndList &&
        Number.isFinite(targetDuration) &&
        targetDuration > 0 &&
        Number.isFinite(mediaSequence);

    return {
        isValidM3u8,
        isMasterPlaylist,
        isMediaPlaylist,
        isLivePlaylist,
        hasEndList,
        targetDuration: Number.isFinite(targetDuration) && targetDuration > 0 ? targetDuration : null,
        mediaSequence: Number.isFinite(mediaSequence) ? mediaSequence : null,
        lastSequence: Number.isFinite(mediaSequence) && segmentCount > 0
            ? mediaSequence + segmentCount - 1
            : null
    };
}

function calculateEffectivePlaylistCacheTtl(metadata, config) {
    if (!config?.enabled || !metadata?.isMediaPlaylist || !metadata?.isLivePlaylist) {
        return config.configuredTtlMs;
    }
    const calculated = metadata.targetDuration * 1000 * config.factor;
    const clamped = Math.min(config.maxTtlMs, Math.max(config.minTtlMs, calculated));
    return Math.min(config.configuredTtlMs, clamped);
}

function decoratePlaylistCacheEntry(entry, content, config) {
    const metadata = getPlaylistCacheMetadata(content);
    return Object.assign(entry, metadata, {
        effectiveTtlMs: calculateEffectivePlaylistCacheTtl(metadata, config)
    });
}

function getEffectivePlaylistCacheTtl(entry, config) {
    if (!config.enabled) return config.configuredTtlMs;
    if (!entry || entry.isMediaPlaylist === undefined || entry.isLivePlaylist === undefined) {
        decoratePlaylistCacheEntry(entry, entry?.content, config);
    }
    return calculateEffectivePlaylistCacheTtl(entry, config);
}

module.exports = {
    DEFAULTS,
    createLivePlaylistTtlConfig,
    getPlaylistCacheMetadata,
    calculateEffectivePlaylistCacheTtl,
    decoratePlaylistCacheEntry,
    getEffectivePlaylistCacheTtl
};
