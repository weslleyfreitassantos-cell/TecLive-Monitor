'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const {
    SessionPlaylistStuckGuard,
    shouldRepinSessionPlaylist,
    promoteValidatedPlaylistCache
} = require('../services/sessionPlaylistStuckGuard');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

function functionSource(name) {
    const marker = `function ${name}(`;
    const start = appSource.indexOf(marker);
    assert.notEqual(start, -1, `function ${name} not found in app.js`);
    const bodyStart = appSource.indexOf('{', start);
    let depth = 0;
    for (let index = bodyStart; index < appSource.length; index += 1) {
        if (appSource[index] === '{') depth += 1;
        if (appSource[index] === '}') depth -= 1;
        if (depth === 0) return appSource.slice(start, index + 1);
    }
    throw new Error(`unterminated function ${name}`);
}

function loadPlaylistFunctions() {
    const context = { require, URL, crypto: require('crypto') };
    vm.createContext(context);
    vm.runInContext(`
        ${functionSource('getShortHash')}
        ${functionSource('getSegmentIdentity')}
        ${functionSource('parseM3u8Info')}
        ${functionSource('parseMediaPlaylistWindow')}
        ${functionSource('getPlaylistSnapshot')}
        ${functionSource('playlistsHaveSegmentIdentityOverlap')}
        ${functionSource('playlistSequenceRangesOverlap')}
        ${functionSource('playlistsHaveOverlap')}
        globalThis.hooks = { getPlaylistSnapshot, playlistsHaveOverlap };
    `, context);
    return context.hooks;
}

const { getPlaylistSnapshot, playlistsHaveOverlap } = loadPlaylistFunctions();

function mediaPlaylist(sequence, names, targetDuration = 5) {
    const lines = [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        `#EXT-X-TARGETDURATION:${targetDuration}`,
        `#EXT-X-MEDIA-SEQUENCE:${sequence}`
    ];
    for (const name of names) {
        lines.push('#EXTINF:5.000,', `https://media.example.test/${name}.ts?signature=redacted`);
    }
    return `${lines.join('\n')}\n`;
}

class RecoveryHarness {
    constructor({ enabled = true } = {}) {
        this.guard = new SessionPlaylistStuckGuard({ enabled, maxSameSeqHits: 3, maxAgeMs: 6000 });
        this.pins = new Map();
        this.cache = new Map();
        this.probes = 0;
    }

    async request({ key, pinned, current, now, probeError = null }) {
        const pinnedSnapshot = getPlaylistSnapshot(pinned.content, pinned.url);
        const observation = this.guard.observe(key, pinnedSnapshot.mediaSequence, now);
        if (!observation.shouldProbe) {
            this.pins.set(key, pinned.url);
            return pinnedSnapshot.mediaSequence;
        }

        this.guard.markProbe(key, now);
        this.probes += 1;
        if (probeError) throw probeError;

        const currentSnapshot = getPlaylistSnapshot(current.content, current.url);
        const continuity = playlistsHaveOverlap(pinnedSnapshot, currentSnapshot);
        if (!shouldRepinSessionPlaylist(
            pinnedSnapshot.mediaSequence,
            currentSnapshot.mediaSequence,
            continuity
        )) {
            return pinnedSnapshot.mediaSequence;
        }

        const cacheKey = `${current.videoId}:${current.quality}:${current.upstreamHash}`;
        assert.equal(promoteValidatedPlaylistCache({
            cache: this.cache,
            cacheKey,
            sourceUrl: current.url,
            content: current.content,
            snapshot: currentSnapshot,
            now
        }), true);
        this.pins.set(key, current.url);
        this.guard.markRecovered(key, currentSnapshot.mediaSequence, now);
        return currentSnapshot.mediaSequence;
    }
}

const upstreamA = {
    videoId: 'IaAUo-xAYnc', quality: 480, upstreamHash: 'upstream-a',
    url: 'https://manifest.example.test/upstream-a.m3u8',
    content: mediaPlaylist(1174, ['1174', '1175', '1176', '1177', '1178', '1179'])
};
const upstreamB = {
    videoId: 'IaAUo-xAYnc', quality: 480, upstreamHash: 'upstream-b',
    url: 'https://manifest.example.test/upstream-b.m3u8',
    content: mediaPlaylist(1183, ['1178', '1179', '1180', '1181', '1182', '1183'])
};

async function main() {
    const key = 'IaAUo-xAYnc:owner:token:480:session-stick-27';
    const harness = new RecoveryHarness();
    harness.pins.set(key, upstreamA.url);

    assert.equal(await harness.request({ key, pinned: upstreamA, current: upstreamB, now: 0 }), 1174);
    assert.equal(await harness.request({ key, pinned: upstreamA, current: upstreamB, now: 2000 }), 1174);
    assert.equal(await harness.request({ key, pinned: upstreamA, current: upstreamB, now: 4000 }), 1174);
    assert.equal(await harness.request({ key, pinned: upstreamA, current: upstreamB, now: 6000 }), 1183);
    assert.equal(harness.pins.get(key), upstreamB.url);
    assert.equal(harness.cache.get('IaAUo-xAYnc:480:upstream-b').mediaSequence, 1183);

    const nextB = { ...upstreamB, content: mediaPlaylist(1184, ['1179', '1180', '1181', '1182', '1183', '1184']) };
    assert.equal(await harness.request({ key, pinned: upstreamB, current: nextB, now: 8000 }), 1183);
    assert.equal(await harness.request({ key, pinned: nextB, current: nextB, now: 10000 }), 1184);
    assert.notEqual(harness.pins.get(key), upstreamA.url);

    const sameUrl = new RecoveryHarness();
    for (const now of [0, 2000, 4000, 6000]) {
        await sameUrl.request({ key: 'same-url', pinned: upstreamA, current: upstreamA, now });
    }
    assert.equal(sameUrl.probes, 1);
    assert.equal(sameUrl.pins.get('same-url'), upstreamA.url);

    for (const candidate of [
        { ...upstreamB, content: mediaPlaylist(1174, ['1174', '1175', '1176']) },
        { ...upstreamB, content: mediaPlaylist(1170, ['1170', '1171', '1172']) },
        { ...upstreamB, content: mediaPlaylist(1183, ['x', 'y', 'z']) }
    ]) {
        const isolated = new RecoveryHarness();
        let result;
        for (const now of [0, 2000, 4000, 6000]) {
            result = await isolated.request({ key: `reject-${candidate.content}`, pinned: upstreamA, current: candidate, now });
        }
        assert.equal(result, 1174);
        assert.equal(isolated.cache.size, 0);
    }

    for (const invalid of [
        '', '# not m3u8', '#EXTM3U\n#EXT-X-TARGETDURATION:5\n', '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:1183\n'
    ]) {
        const snapshot = getPlaylistSnapshot(invalid, upstreamB.url);
        assert.equal(shouldRepinSessionPlaylist(1174, snapshot.mediaSequence, false), false);
    }

    const disabled = new RecoveryHarness({ enabled: false });
    for (const now of [0, 2000, 4000, 6000, 10000]) {
        assert.equal(await disabled.request({ key: 'disabled', pinned: upstreamA, current: upstreamB, now }), 1174);
    }
    assert.equal(disabled.probes, 0);

    const cooldown = new RecoveryHarness();
    for (const now of [0, 2000, 4000, 6000]) {
        try {
            await cooldown.request({ key: 'cooldown', pinned: upstreamA, current: upstreamB, now, probeError: now === 6000 ? new Error('timeout') : null });
        } catch (error) {
            assert.equal(error.message, 'timeout');
        }
    }
    await cooldown.request({ key: 'cooldown', pinned: upstreamA, current: upstreamB, now: 7000 });
    assert.equal(cooldown.probes, 1);

    const concurrentGuard = new SessionPlaylistStuckGuard({ enabled: true, maxSameSeqHits: 3, maxAgeMs: 6000 });
    concurrentGuard.observe('concurrent', 1174, 0);
    concurrentGuard.observe('concurrent', 1174, 2000);
    concurrentGuard.observe('concurrent', 1174, 4000);
    const first = concurrentGuard.observe('concurrent', 1174, 6000);
    assert.equal(first.shouldProbe, true);
    concurrentGuard.markProbe('concurrent', 6000);
    assert.equal(concurrentGuard.observe('concurrent', 1174, 6000).shouldProbe, false);

    assert.equal(harness.guard.states.has('other-session'), false);
    assert.equal(harness.pins.has('other-live:480:session'), false);
    assert.equal(harness.cache.has('IaAUo-xAYnc:720:upstream-b'), false);

    for (const status of [403, 404, 410, 500, 'ETIMEDOUT']) {
        const errors = new RecoveryHarness();
        for (const now of [0, 2000, 4000]) {
            await errors.request({ key: `error-${status}`, pinned: upstreamA, current: upstreamB, now });
        }
        await assert.rejects(
            errors.request({ key: `error-${status}`, pinned: upstreamA, current: upstreamB, now: 6000, probeError: Object.assign(new Error(String(status)), { status }) })
        );
        assert.equal(errors.pins.get(`error-${status}`), upstreamA.url);
        assert.equal(errors.cache.size, 0);
    }

    assert.match(appSource, /HLS_SESSION_UPSTREAM_STUCK_MS[^\n]*45000/);
    assert.match(appSource, /HLS_EXOMEDIA_ANDROID_MAX_FPS[^\n]*30/);
    assert.match(appSource, /HLS_EXOMEDIA_ANDROID_FALLBACK_HEIGHT[^\n]*480/);
    assert.match(appSource, /HLS_EXOMEDIA_STEADY_LIVE_EDGE_OFFSET_SEGMENTS[^\n]*2/);
    assert.match(appSource, /HLS_EXOMEDIA_SINGLE_VARIANT_MASTER/);
    assert.match(appSource, /segmentProxy = false/);
    assert.match(appSource, /req\.query\.max/);

    console.log('Fast HLS session upstream recovery tests OK');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
