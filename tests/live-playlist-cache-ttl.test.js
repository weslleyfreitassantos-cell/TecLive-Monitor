'use strict';

const assert = require('assert');
const {
    createLivePlaylistTtlConfig,
    getPlaylistCacheMetadata,
    calculateEffectivePlaylistCacheTtl,
    decoratePlaylistCacheEntry,
    getEffectivePlaylistCacheTtl
} = require('../services/livePlaylistCacheTtl');

function mediaPlaylist({ targetDuration, sequence = 100, segments = 3, endList = false }) {
    const lines = [
        '#EXTM3U',
        `#EXT-X-TARGETDURATION:${targetDuration}`,
        `#EXT-X-MEDIA-SEQUENCE:${sequence}`
    ];
    for (let index = 0; index < segments; index += 1) {
        lines.push(`#EXTINF:${targetDuration},`, `segment-${sequence + index}.ts`);
    }
    if (endList) lines.push('#EXT-X-ENDLIST');
    return `${lines.join('\n')}\n`;
}

const enabled = createLivePlaylistTtlConfig({
    PLAYBACK_DYNAMIC_LIVE_PLAYLIST_TTL: 'true',
    PLAYBACK_LIVE_TTL_FACTOR: '0.5',
    PLAYBACK_LIVE_TTL_MIN_MS: '500',
    PLAYBACK_LIVE_TTL_MAX_MS: '3000'
}, 15000);

for (const [targetDuration, expectedTtl] of [[1, 500], [2, 1000], [5, 2500], [6, 3000]]) {
    const metadata = getPlaylistCacheMetadata(mediaPlaylist({ targetDuration }));
    assert.equal(calculateEffectivePlaylistCacheTtl(metadata, enabled), expectedTtl);
}

const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nvariant.m3u8\n';
assert.equal(calculateEffectivePlaylistCacheTtl(getPlaylistCacheMetadata(master), enabled), 15000);
assert.equal(
    calculateEffectivePlaylistCacheTtl(
        getPlaylistCacheMetadata(mediaPlaylist({ targetDuration: 2, endList: true })),
        enabled
    ),
    15000
);

const disabled = createLivePlaylistTtlConfig({}, 15000);
assert.equal(
    calculateEffectivePlaylistCacheTtl(getPlaylistCacheMetadata(mediaPlaylist({ targetDuration: 2 })), disabled),
    15000
);

const cache480 = decoratePlaylistCacheEntry(
    { sourceUrl: 'https://example.test/480.m3u8', fetchedAt: 0 },
    mediaPlaylist({ targetDuration: 2, sequence: 200 }),
    enabled
);
const cache720 = decoratePlaylistCacheEntry(
    { sourceUrl: 'https://example.test/720.m3u8', fetchedAt: 0 },
    mediaPlaylist({ targetDuration: 5, sequence: 900 }),
    enabled
);
assert.equal(cache480.mediaSequence, 200);
assert.equal(cache720.mediaSequence, 900);
assert.equal(getEffectivePlaylistCacheTtl(cache480, enabled), 1000);
assert.equal(getEffectivePlaylistCacheTtl(cache720, enabled), 2500);

// Reproduz o incidente: o TTL antigo de 15s ainda estaria valido quando o
// ExoPlayer atingisse 6s; o TTL dinamico exige um novo fetch apos 1s.
assert.equal(6000 < disabled.configuredTtlMs, true);
assert.equal(6000 < getEffectivePlaylistCacheTtl(cache480, enabled), false);

console.log('Live playlist cache TTL tests OK');
