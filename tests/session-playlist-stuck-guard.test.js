'use strict';

const assert = require('assert');
const {
    SessionPlaylistStuckGuard,
    shouldRepinSessionPlaylist,
    promoteValidatedPlaylistCache
} = require('../services/sessionPlaylistStuckGuard');

const disabled = new SessionPlaylistStuckGuard({ enabled: false });
assert.equal(disabled.observe('session-a:480', 100, 0).shouldProbe, false);
assert.equal(disabled.states.size, 0);

const enabled = new SessionPlaylistStuckGuard({
    enabled: true,
    maxSameSeqHits: 3,
    maxAgeMs: 6000
});
assert.equal(enabled.observe('session-a:480', 100, 0).shouldProbe, false);
assert.equal(enabled.observe('session-a:480', 100, 2000).shouldProbe, false);
assert.equal(enabled.observe('session-a:480', 100, 4000).shouldProbe, false);
assert.equal(enabled.observe('session-a:480', 100, 6000).shouldProbe, true);
assert.equal(enabled.observe('session-b:480', 100, 6000).shouldProbe, false);
assert.equal(enabled.observe('session-a:720', 100, 6000).shouldProbe, false);

assert.equal(shouldRepinSessionPlaylist(100, 101, true), true);
assert.equal(shouldRepinSessionPlaylist(100, 100, true), false);
assert.equal(shouldRepinSessionPlaylist(100, 101, false), false);

const cache = new Map();
assert.equal(promoteValidatedPlaylistCache({
    cache,
    cacheKey: 'video:480:upstream',
    sourceUrl: 'https://example.test/media.m3u8',
    content: '#EXTM3U\n',
    snapshot: { mediaSequence: 101, lastSequence: 103 },
    now: 1234
}), true);
assert.equal(cache.get('video:480:upstream').mediaSequence, 101);

console.log('Session playlist stuck guard tests OK');
