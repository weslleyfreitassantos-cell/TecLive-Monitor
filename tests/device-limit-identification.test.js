const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const {
    PlaybackSessionStore,
    sessionPreview,
    safeText
} = require('../services/playbackSessionStore');

const APP_PATH = path.join(__dirname, '..', 'app.js');
const OWNER = 'filipe';
const VIDEO_ID = 'j6Df-EzdfbQ';
const TOKEN_SCOPE = 'token-a';
const IP = '187.40.208.118';
const USER_AGENT = 'ExoMedia 4.3.0 / Android 14 / Stick HD';
const NOW = Date.parse('2026-07-12T20:30:00.000Z');

function tempFile() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'playback-sessions-'));
    return path.join(dir, 'sessions.json');
}

function createStore(options = {}) {
    return new PlaybackSessionStore({
        filePath: tempFile(),
        ttlMs: options.ttlMs || 90000,
        reuseRecentWindowMs: options.reuseRecentWindowMs === undefined ? 0 : options.reuseRecentWindowMs,
        reuseStaleAfterMs: options.reuseStaleAfterMs,
        reuseExpiredGraceMs: options.reuseExpiredGraceMs,
        reopenReuseMs: options.reopenReuseMs === undefined ? 0 : options.reopenReuseMs,
        reopenReuseMinAgeMs: options.reopenReuseMinAgeMs
    });
}

function create(store, overrides = {}, nowMs = NOW) {
    return store.createSession({
        owner: OWNER,
        videoId: VIDEO_ID,
        tokenScope: TOKEN_SCOPE,
        limit: 3,
        publicIp: IP,
        userAgent: USER_AGENT,
        source: 'hls',
        ...overrides
    }, nowMs);
}

function touchVariant(store, session, nowMs = NOW + 2000) {
    return store.touchSession({
        sessionId: session.sessionId,
        owner: session.owner || OWNER,
        videoId: session.videoId || VIDEO_ID,
        tokenScope: session.tokenScope || TOKEN_SCOPE,
        publicIp: session.publicIp || IP,
        userAgent: session.userAgent || USER_AGENT,
        hlsActivity: 'variant'
    }, nowMs);
}

function testSameIpAndUserAgentFourthIsBlocked() {
    const store = createStore();
    const results = [create(store), create(store), create(store), create(store)];

    assert.deepEqual(results.map(result => result.ok), [true, true, true, false]);
    assert.equal(results[3].code, 'limit_exceeded');
    assert.equal(results[3].active, 3);
    assert.equal(store.countActive({ owner: OWNER, videoId: VIDEO_ID }, NOW), 3);
}

function testDifferentIpsFourthIsBlocked() {
    const store = createStore();
    const results = [
        create(store, { publicIp: '187.40.208.118' }),
        create(store, { publicIp: '187.40.208.119' }),
        create(store, { publicIp: '187.40.208.120' }),
        create(store, { publicIp: '187.40.208.121' })
    ];

    assert.deepEqual(results.map(result => result.ok), [true, true, true, false]);
    assert.equal(store.countActive({ owner: OWNER, videoId: VIDEO_ID }, NOW), 3);
}

function testLimitsOneTwoAndInvalid() {
    const one = createStore();
    assert.equal(create(one, { limit: 1 }).ok, true);
    assert.equal(create(one, { limit: 1 }).code, 'limit_exceeded');
    assert.equal(one.countActive({ owner: OWNER, videoId: VIDEO_ID }, NOW), 1);

    const two = createStore();
    assert.deepEqual([
        create(two, { limit: 2 }).ok,
        create(two, { limit: 2 }).ok,
        create(two, { limit: 2 }).code
    ], [true, true, 'limit_exceeded']);
    assert.equal(two.countActive({ owner: OWNER, videoId: VIDEO_ID }, NOW), 2);

    const zero = createStore();
    assert.equal(create(zero, { limit: 0 }).code, 'limit_unavailable');
    assert.equal(zero.countActive({ owner: OWNER, videoId: VIDEO_ID }, NOW), 0);

    const invalid = createStore();
    assert.equal(create(invalid, { limit: 'not-a-number' }).code, 'limit_unavailable');
    assert.equal(invalid.countActive({ owner: OWNER, videoId: VIDEO_ID }, NOW), 0);
}

function testIdenticalDevicesReceiveDifferentSessionIds() {
    const store = createStore();
    const first = create(store);
    const second = create(store);

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.notEqual(first.session.sessionId, second.session.sessionId);
    assert.equal(first.session.publicIp, IP);
    assert.equal(first.session.userAgent, USER_AGENT);
}

function testFreshIdenticalClientStillCountsAsSeparateDevice() {
    const store = createStore({ reuseStaleAfterMs: 45000 });
    const first = create(store, {}, NOW);
    const second = create(store, {}, NOW + 10000);

    assert.equal(first.ok, true);
    assert.equal(first.code, 'created');
    assert.equal(second.ok, true);
    assert.equal(second.code, 'created');
    assert.notEqual(first.session.sessionId, second.session.sessionId);
    assert.equal(store.countActive({ owner: OWNER, videoId: VIDEO_ID }, NOW + 10000), 2);
}

function testRecentIdenticalClientReusesSession() {
    const store = createStore({ reuseRecentWindowMs: 90000, reuseStaleAfterMs: 45000 });
    const first = create(store, { fingerprint: 'localIp:192.168.0.10' }, NOW);
    const reopened = create(store, { fingerprint: 'localIp:192.168.0.10' }, NOW + 10000);

    assert.equal(first.ok, true);
    assert.equal(reopened.ok, true);
    assert.equal(reopened.code, 'reused_recent');
    assert.equal(reopened.session.sessionId, first.session.sessionId);
    assert.equal(store.countActive({ owner: OWNER, videoId: VIDEO_ID }, NOW + 10000), 1);
}

function testRecentIdenticalClientWithoutFingerprintDoesNotReuseSession() {
    const store = createStore({ reuseRecentWindowMs: 90000, reuseStaleAfterMs: 45000 });
    const first = create(store, {}, NOW);
    const second = create(store, {}, NOW + 10000);

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(second.code, 'created');
    assert.notEqual(second.session.sessionId, first.session.sessionId);
    assert.equal(store.countActive({ owner: OWNER, videoId: VIDEO_ID }, NOW + 10000), 2);
}

function testLimitOneFastNeoNewsReopenReusesSession() {
    const store = createStore({ reopenReuseMs: 20000, reopenReuseMinAgeMs: 1000 });
    const first = create(store, { limit: 1 }, NOW);
    const variant = touchVariant(store, first.session, NOW + 2000);
    const reopened = create(store, { limit: 1 }, NOW + 5000);

    assert.equal(first.ok, true);
    assert.equal(variant.ok, true);
    assert.equal(first.code, 'created');
    assert.equal(reopened.ok, true);
    assert.equal(reopened.code, 'reused_reopen');
    assert.equal(reopened.session.sessionId, first.session.sessionId);
    assert.equal(store.countActive({ owner: OWNER, videoId: VIDEO_ID }, NOW + 5000), 1);
}

function testLimitOneFastNeoNewsReopenWithoutVariantEvidenceIsBlocked() {
    const store = createStore({ reopenReuseMs: 20000, reopenReuseMinAgeMs: 1000 });
    const first = create(store, { limit: 1 }, NOW);
    const reopened = create(store, { limit: 1 }, NOW + 5000);

    assert.equal(first.ok, true);
    assert.equal(reopened.ok, false);
    assert.equal(reopened.code, 'limit_exceeded');
    assert.equal(store.countActive({ owner: OWNER, videoId: VIDEO_ID }, NOW + 5000), 1);
}

function testFastNeoNewsOpeningWithoutVariantEvidenceCreatesWhenLimitAllows() {
    const store = createStore({ reopenReuseMs: 20000, reopenReuseMinAgeMs: 1000 });
    const first = create(store, { limit: 2 }, NOW);
    const second = create(store, { limit: 2 }, NOW + 5000);

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(second.code, 'created');
    assert.notEqual(second.session.sessionId, first.session.sessionId);
    assert.equal(store.countActive({ owner: OWNER, videoId: VIDEO_ID }, NOW + 5000), 2);
}

function testLimitOneSimultaneousIdenticalNeoNewsOpeningIsBlocked() {
    const store = createStore({ reopenReuseMs: 20000, reopenReuseMinAgeMs: 1000 });
    const first = create(store, { limit: 1 }, NOW);
    const second = create(store, { limit: 1 }, NOW);

    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    assert.equal(second.code, 'limit_exceeded');
    assert.equal(store.countActive({ owner: OWNER, videoId: VIDEO_ID }, NOW), 1);
}

function testGenericUserAgentDoesNotUseReopenReuse() {
    const store = createStore({ reopenReuseMs: 20000, reopenReuseMinAgeMs: 1000 });
    const first = create(store, { limit: 2, userAgent: 'VLC/3.0.21 LibVLC/3.0.21' }, NOW);
    const second = create(store, { limit: 2, userAgent: 'VLC/3.0.21 LibVLC/3.0.21' }, NOW + 5000);

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(second.code, 'created');
    assert.notEqual(second.session.sessionId, first.session.sessionId);
    assert.equal(store.countActive({ owner: OWNER, videoId: VIDEO_ID }, NOW + 5000), 2);
}

function testReopenAfterWindowIsSubjectToLimit() {
    const store = createStore({ reopenReuseMs: 20000, reopenReuseMinAgeMs: 1000 });
    const first = create(store, { limit: 1 }, NOW);
    const variant = touchVariant(store, first.session, NOW + 2000);
    const reopened = create(store, { limit: 1 }, NOW + 30000);

    assert.equal(first.ok, true);
    assert.equal(variant.ok, true);
    assert.equal(reopened.ok, false);
    assert.equal(reopened.code, 'limit_exceeded');
    assert.equal(store.countActive({ owner: OWNER, videoId: VIDEO_ID }, NOW + 30000), 1);
}

function testReopenAfterWindowCreatesWhenLimitAllows() {
    const store = createStore({ reopenReuseMs: 20000, reopenReuseMinAgeMs: 1000 });
    const first = create(store, { limit: 2 }, NOW);
    const variant = touchVariant(store, first.session, NOW + 2000);
    const reopened = create(store, { limit: 2 }, NOW + 30000);

    assert.equal(first.ok, true);
    assert.equal(variant.ok, true);
    assert.equal(reopened.ok, true);
    assert.equal(reopened.code, 'created');
    assert.notEqual(reopened.session.sessionId, first.session.sessionId);
    assert.equal(store.countActive({ owner: OWNER, videoId: VIDEO_ID }, NOW + 30000), 2);
}

function testReopenReuseIsScopedByTokenOwnerAndVideo() {
    const store = createStore({ reopenReuseMs: 20000, reopenReuseMinAgeMs: 1000 });
    const first = create(store, { limit: 4 }, NOW);
    const variant = touchVariant(store, first.session, NOW + 2000);
    const differentToken = create(store, { limit: 4, tokenScope: 'token-b' }, NOW + 5000);
    const differentVideo = create(store, { limit: 4, videoId: 'outroVideo01' }, NOW + 6000);
    const differentOwner = create(store, { limit: 4, owner: 'outro-owner' }, NOW + 7000);

    assert.equal(first.ok, true);
    assert.equal(variant.ok, true);
    assert.equal(differentToken.ok, true);
    assert.equal(differentToken.code, 'created');
    assert.equal(differentVideo.ok, true);
    assert.equal(differentVideo.code, 'created');
    assert.equal(differentOwner.ok, true);
    assert.equal(differentOwner.code, 'created');
    assert.notEqual(differentToken.session.sessionId, first.session.sessionId);
    assert.notEqual(differentVideo.session.sessionId, first.session.sessionId);
    assert.notEqual(differentOwner.session.sessionId, first.session.sessionId);
}

function testExpiredSessionIsNotReusedByReopenWindow() {
    const store = createStore({ ttlMs: 1000, reopenReuseMs: 20000, reopenReuseMinAgeMs: 1000 });
    const first = create(store, { limit: 1 }, NOW);
    const variant = touchVariant(store, first.session, NOW + 500);
    const reopened = create(store, { limit: 1 }, NOW + 2000);

    assert.equal(first.ok, true);
    assert.equal(variant.ok, true);
    assert.equal(reopened.ok, true);
    assert.equal(reopened.code, 'created');
    assert.notEqual(reopened.session.sessionId, first.session.sessionId);
    assert.equal(store.countActive({ owner: OWNER, videoId: VIDEO_ID }, NOW + 2000), 1);
}

function testReopenEvidenceIsConsumedOnceUntilNextVariant() {
    const store = createStore({ reopenReuseMs: 20000, reopenReuseMinAgeMs: 1000 });
    const first = create(store, { limit: 1 }, NOW);
    touchVariant(store, first.session, NOW + 2000);
    const reopened = create(store, { limit: 1 }, NOW + 5000);
    const secondReopen = create(store, { limit: 1 }, NOW + 7000);
    touchVariant(store, first.session, NOW + 8000);
    const thirdReopen = create(store, { limit: 1 }, NOW + 10000);

    assert.equal(first.ok, true);
    assert.equal(reopened.ok, true);
    assert.equal(reopened.code, 'reused_reopen');
    assert.equal(secondReopen.ok, false);
    assert.equal(secondReopen.code, 'limit_exceeded');
    assert.equal(thirdReopen.ok, true);
    assert.equal(thirdReopen.code, 'reused_reopen');
    assert.equal(store.countActive({ owner: OWNER, videoId: VIDEO_ID }, NOW + 10000), 1);
}

function testRecentWindowDoesNotCollapseIndependentOpeningsWithoutFingerprint() {
    const store = createStore({ reuseRecentWindowMs: 90000, reuseStaleAfterMs: 45000 });
    const results = [
        create(store, {}, NOW),
        create(store, {}, NOW + 1000),
        create(store, {}, NOW + 2000),
        create(store, {}, NOW + 3000)
    ];

    assert.deepEqual(results.map(result => result.ok), [true, true, true, false]);
    assert.equal(results[3].code, 'limit_exceeded');
    assert.equal(store.countActive({ owner: OWNER, videoId: VIDEO_ID }, NOW + 3000), 3);
}

function testRecentReuseCollapsesDuplicateClientSessions() {
    const store = createStore({ reuseRecentWindowMs: 0, reuseStaleAfterMs: 0 });
    const first = create(store, { fingerprint: 'localIp:192.168.0.10' }, NOW);
    const second = create(store, { fingerprint: 'localIp:192.168.0.10' }, NOW + 10000);

    store.reuseRecentWindowMs = 90000;
    const reopened = create(store, { fingerprint: 'localIp:192.168.0.10' }, NOW + 20000);

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.notEqual(first.session.sessionId, second.session.sessionId);
    assert.equal(reopened.ok, true);
    assert.equal(reopened.code, 'reused_recent');
    assert.equal(reopened.session.sessionId, second.session.sessionId);
    assert.equal(store.countActive({ owner: OWNER, videoId: VIDEO_ID }, NOW + 20000), 1);
}

function testDuplicateCleanupRequiresFingerprint() {
    const store = createStore({ reuseRecentWindowMs: 0, reuseStaleAfterMs: 0 });
    const first = create(store, {}, NOW);
    const second = create(store, {}, NOW + 10000);

    store.reuseRecentWindowMs = 90000;
    const third = create(store, {}, NOW + 20000);

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(third.ok, true);
    assert.equal(third.code, 'created');
    assert.equal(store.countActive({ owner: OWNER, videoId: VIDEO_ID }, NOW + 20000), 3);
}

function testStaleIdenticalClientReusesSession() {
    const store = createStore({ reuseStaleAfterMs: 45000 });
    const first = create(store, { fingerprint: 'localIp:192.168.0.10' }, NOW);
    const reopened = create(store, { fingerprint: 'localIp:192.168.0.10' }, NOW + 46000);

    assert.equal(first.ok, true);
    assert.equal(reopened.ok, true);
    assert.equal(reopened.code, 'reused_stale');
    assert.equal(reopened.session.sessionId, first.session.sessionId);
    assert.equal(store.countActive({ owner: OWNER, videoId: VIDEO_ID }, NOW + 46000), 1);
}

function testStaleIdenticalClientWithoutFingerprintDoesNotReuseSession() {
    const store = createStore({ reuseStaleAfterMs: 45000 });
    const first = create(store, {}, NOW);
    const reopened = create(store, {}, NOW + 46000);

    assert.equal(first.ok, true);
    assert.equal(reopened.ok, true);
    assert.equal(reopened.code, 'created');
    assert.notEqual(reopened.session.sessionId, first.session.sessionId);
    assert.equal(store.countActive({ owner: OWNER, videoId: VIDEO_ID }, NOW + 46000), 2);
}

function testStaleReuseCanAvoidFalseLimitExceeded() {
    const store = createStore({ reuseStaleAfterMs: 45000 });
    const first = create(store, { fingerprint: 'localIp:192.168.0.10' }, NOW);
    create(store, { publicIp: '187.40.208.119' }, NOW);
    create(store, { publicIp: '187.40.208.120' }, NOW);

    const reopened = create(store, { fingerprint: 'localIp:192.168.0.10' }, NOW + 46000);

    assert.equal(first.ok, true);
    assert.equal(reopened.ok, true);
    assert.equal(reopened.code, 'reused_stale');
    assert.equal(reopened.session.sessionId, first.session.sessionId);
    assert.equal(store.countActive({ owner: OWNER, videoId: VIDEO_ID }, NOW + 46000), 3);
}

function testStaleDifferentClientDoesNotReuseSession() {
    const store = createStore({ reuseStaleAfterMs: 45000 });
    const first = create(store, {}, NOW);
    const second = create(store, { userAgent: 'ExoMedia 4.3.0 / Android 14 / Another Stick' }, NOW + 46000);

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(second.code, 'created');
    assert.notEqual(first.session.sessionId, second.session.sessionId);
    assert.equal(store.countActive({ owner: OWNER, videoId: VIDEO_ID }, NOW + 46000), 2);
}

function testFingerprintPreventsStaleReuseAcrossDifferentLocalIdentity() {
    const store = createStore({ reuseStaleAfterMs: 45000 });
    const first = create(store, { fingerprint: 'localIp:192.168.0.10' }, NOW);
    const second = create(store, { fingerprint: 'localIp:192.168.0.11' }, NOW + 46000);

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(second.code, 'created');
    assert.notEqual(first.session.sessionId, second.session.sessionId);
    assert.equal(store.countActive({ owner: OWNER, videoId: VIDEO_ID }, NOW + 46000), 2);
}

function testPlaylistRefreshKeepsSameSession() {
    const store = createStore();
    const first = create(store);
    const sessionId = first.session.sessionId;
    const touched = store.touchSession({
        sessionId,
        owner: OWNER,
        videoId: VIDEO_ID,
        publicIp: IP,
        userAgent: USER_AGENT
    }, Date.parse('2026-07-12T20:30:30.000Z'));

    assert.equal(touched.ok, true);
    assert.equal(touched.session.sessionId, sessionId);
    assert.equal(store.countActive({ owner: OWNER, videoId: VIDEO_ID }, NOW), 1);
}

function testExpiredSessionFreesSlot() {
    const store = createStore({ ttlMs: 1000 });
    const now = NOW;
    create(store, {}, now);
    create(store, {}, now);
    create(store, {}, now);

    assert.equal(store.countActive({ owner: OWNER, videoId: VIDEO_ID }, now), 3);
    const afterTtl = now + 2000;
    assert.equal(store.countActive({ owner: OWNER, videoId: VIDEO_ID }, afterTtl), 0);
    const created = create(store, {}, afterTtl);
    assert.equal(created.ok, true);
    assert.equal(store.countActive({ owner: OWNER, videoId: VIDEO_ID }, afterTtl), 1);
}

function testExpiredSameClientReusesWithinGrace() {
    const store = createStore({
        ttlMs: 1000,
        reuseStaleAfterMs: 500,
        reuseExpiredGraceMs: 10000
    });
    const first = create(store, { fingerprint: 'localIp:192.168.0.10' }, NOW);
    const afterTtl = NOW + 2000;

    assert.equal(store.countActive({ owner: OWNER, videoId: VIDEO_ID }, afterTtl), 0);

    const reopened = create(store, { fingerprint: 'localIp:192.168.0.10' }, afterTtl);
    assert.equal(reopened.ok, true);
    assert.equal(reopened.code, 'reused_expired');
    assert.equal(reopened.session.sessionId, first.session.sessionId);
    assert.equal(store.countActive({ owner: OWNER, videoId: VIDEO_ID }, afterTtl), 1);
}

function testExpiredSameClientDoesNotBypassFullLimit() {
    const store = createStore({
        ttlMs: 1000,
        reuseStaleAfterMs: 500,
        reuseExpiredGraceMs: 10000
    });
    create(store, {}, NOW);
    const afterTtl = NOW + 2000;

    create(store, { publicIp: '187.40.208.119', userAgent: 'Player A' }, afterTtl);
    create(store, { publicIp: '187.40.208.120', userAgent: 'Player B' }, afterTtl);
    create(store, { publicIp: '187.40.208.121', userAgent: 'Player C' }, afterTtl);

    const reopened = create(store, {}, afterTtl);
    assert.equal(reopened.ok, false);
    assert.equal(reopened.code, 'limit_exceeded');
    assert.equal(store.countActive({ owner: OWNER, videoId: VIDEO_ID }, afterTtl), 3);
}

function testExpiredSessionRemovedAfterReuseGrace() {
    const store = createStore({
        ttlMs: 1000,
        reuseExpiredGraceMs: 5000
    });
    create(store, {}, NOW);
    const afterGrace = NOW + 7000;

    assert.equal(store.countActive({ owner: OWNER, videoId: VIDEO_ID }, afterGrace), 0);
    const raw = JSON.parse(fs.readFileSync(store.filePath, 'utf8'));
    assert.equal(Object.keys(raw.sessions).length, 0);
}

function testExpiredSessionIsRejectedOnRefresh() {
    const store = createStore({ ttlMs: 1000 });
    const created = create(store, {}, NOW);
    const touched = store.touchSession({
        sessionId: created.session.sessionId,
        owner: OWNER,
        videoId: VIDEO_ID,
        publicIp: IP,
        userAgent: USER_AGENT
    }, NOW + 2000);
    assert.equal(touched.ok, false);
    assert.equal(touched.code, 'expired');
    assert.equal(store.countActive({ owner: OWNER, videoId: VIDEO_ID }, NOW + 2000), 0);
}

async function testConcurrentCreationDoesNotExceedLimit() {
    const store = createStore();
    const results = await Promise.all([0, 1, 2, 3].map(() => Promise.resolve().then(() => create(store))));
    assert.equal(results.filter(result => result.ok).length, 3);
    assert.equal(results.filter(result => result.code === 'limit_exceeded').length, 1);
    assert.equal(store.countActive({ owner: OWNER, videoId: VIDEO_ID }, NOW), 3);
}

async function testConcurrentCreationWithoutFingerprintDoesNotReuseRecentSession() {
    const store = createStore({ reuseRecentWindowMs: 90000, reuseStaleAfterMs: 45000 });
    const results = await Promise.all([0, 1, 2, 3].map(() => Promise.resolve().then(() => create(store))));
    assert.equal(results.filter(result => result.ok).length, 3);
    assert.equal(results.filter(result => result.code === 'limit_exceeded').length, 1);
    assert.equal(store.countActive({ owner: OWNER, videoId: VIDEO_ID }, NOW), 3);
}

function testSessionScopeValidation() {
    const store = createStore();
    const session = create(store).session;

    assert.equal(store.touchSession({
        sessionId: session.sessionId,
        owner: 'outro-owner',
        videoId: VIDEO_ID,
        publicIp: IP,
        userAgent: USER_AGENT
    }, NOW).code, 'owner_mismatch');

    assert.equal(store.touchSession({
        sessionId: session.sessionId,
        owner: OWNER,
        videoId: 'outroVideo01',
        publicIp: IP,
        userAgent: USER_AGENT
    }, NOW).code, 'video_mismatch');

    assert.equal(store.touchSession({
        sessionId: session.sessionId,
        owner: OWNER,
        videoId: VIDEO_ID,
        tokenScope: 'token-b',
        publicIp: IP,
        userAgent: USER_AGENT
    }, NOW).code, 'token_mismatch');

    assert.equal(store.touchSession({
        sessionId: 'inventada',
        owner: OWNER,
        videoId: VIDEO_ID,
        publicIp: IP,
        userAgent: USER_AGENT
    }, NOW).code, 'not_found');
}

function testLiveEndedCleanupRemovesSessions() {
    const store = createStore();
    create(store);
    create(store);
    assert.equal(store.removeForLive(OWNER, VIDEO_ID), 2);
    assert.equal(store.countActive({ owner: OWNER, videoId: VIDEO_ID }, NOW), 0);
}

function testOwnerCleanupRemovesOnlyThatOwner() {
    const store = createStore();
    create(store);
    create(store, { owner: 'outro-owner' });
    assert.equal(store.removeForOwner(OWNER), 1);
    assert.equal(store.countActive({ owner: OWNER }, NOW), 0);
    assert.equal(store.countActive({ owner: 'outro-owner' }, NOW), 1);
}

function testSessionPreviewCanRemoveWithoutExposingFullId() {
    const store = createStore();
    const created = create(store);
    assert.equal(created.ok, true);
    const preview = sessionPreview(created.session.sessionId);
    assert.equal(store.removeSession(preview, { owner: OWNER, videoId: VIDEO_ID }), true);
    assert.equal(store.countActive({ owner: OWNER, videoId: VIDEO_ID }, NOW), 0);
}

function testPersistenceAcrossRestartWithinTtl() {
    const filePath = tempFile();
    const firstStore = new PlaybackSessionStore({ filePath, ttlMs: 90000 });
    const created = firstStore.createSession({
        owner: OWNER,
        videoId: VIDEO_ID,
        limit: 3,
        publicIp: IP,
        userAgent: USER_AGENT
    }, NOW);
    assert.equal(created.ok, true);

    const secondStore = new PlaybackSessionStore({ filePath, ttlMs: 90000 });
    assert.equal(secondStore.countActive({ owner: OWNER, videoId: VIDEO_ID }, NOW), 1);
    assert.equal(secondStore.touchSession({
        sessionId: created.session.sessionId,
        owner: OWNER,
        videoId: VIDEO_ID,
        publicIp: IP,
        userAgent: USER_AGENT
    }, NOW).ok, true);
}

function testRestartRemovesExpiredSession() {
    const filePath = tempFile();
    const firstStore = new PlaybackSessionStore({ filePath, ttlMs: 1000, reuseExpiredGraceMs: 0 });
    const created = firstStore.createSession({
        owner: OWNER,
        videoId: VIDEO_ID,
        limit: 3,
        publicIp: IP,
        userAgent: USER_AGENT
    }, NOW);
    assert.equal(created.ok, true);

    const secondStore = new PlaybackSessionStore({ filePath, ttlMs: 1000, reuseExpiredGraceMs: 0 });
    assert.equal(secondStore.countActive({ owner: OWNER, videoId: VIDEO_ID }, NOW + 2000), 0);
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(Object.keys(raw.sessions).length, 0);
}

function testInvalidJsonDoesNotCrashAndIsArchived() {
    const filePath = tempFile();
    const dir = path.dirname(filePath);
    fs.writeFileSync(filePath, '{ invalid json', 'utf8');

    const store = new PlaybackSessionStore({ filePath, ttlMs: 90000 });
    assert.deepEqual(store.listActive({}, NOW), []);
    assert.ok(fs.readdirSync(dir).some(name => name.includes('.corrupt-')));
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

function testAtomicWriteUsesTempThenRenameAndNoSensitivePayload() {
    const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'playbackSessionStore.js'), 'utf8');
    assert.ok(source.includes('tmpPath'));
    assert.ok(source.includes('fs.renameSync(tmpPath, this.filePath)'));

    const filePath = tempFile();
    const store = new PlaybackSessionStore({ filePath, ttlMs: 90000 });
    store.createSession({
        owner: OWNER,
        videoId: VIDEO_ID,
        limit: 3,
        publicIp: IP,
        userAgent: 'Authorization: Bearer secret Cookie: SID=secretcookie https://manifest.googlevideo.com/a C:\\Users\\Weslley\\cookie.txt',
        fingerprint: '/var/www/livemonitor/cookies/cookie1.txt'
    }, NOW);
    const raw = fs.readFileSync(filePath, 'utf8');
    assert.ok(!raw.includes('secret'));
    assert.ok(!raw.includes('secretcookie'));
    assert.ok(!raw.includes('manifest.googlevideo.com'));
    assert.ok(!raw.includes('C:\\Users'));
    assert.ok(!raw.includes('/var/www'));
    assert.ok(!raw.includes('Cookie:'));
}

function testDashboardCountsSessions() {
    const store = createStore();
    create(store);
    create(store, { videoId: 'outraLive01' });
    assert.equal(store.countActive({ owner: OWNER }, NOW), 2);
    assert.equal(store.countActive({ owner: OWNER, videoId: VIDEO_ID }, NOW), 1);
}

function testSanitizationAndPreview() {
    const unsafe = safeText('Authorization: Bearer secret https://manifest.googlevideo.com/a C:\\Users\\Weslley\\cookie.txt /var/www/livemonitor/app.js');
    assert.ok(!unsafe.includes('secret'));
    assert.ok(!unsafe.includes('manifest.googlevideo.com'));
    assert.ok(!unsafe.includes('C:\\Users'));
    assert.ok(!unsafe.includes('/var/www'));

    const preview = sessionPreview('1234567890abcdef');
    assert.equal(preview, '12345678...');
}

function sliceBetween(source, startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start);
    assert.ok(start >= 0, `missing start marker: ${startMarker}`);
    assert.ok(end > start, `missing end marker: ${endMarker}`);
    return source.slice(start, end);
}

function loadHlsContinuityHooks() {
    const app = fs.readFileSync(APP_PATH, 'utf8');
    const helperCore = sliceBetween(app, 'function normalizeHlsStateKeyPart', 'async function fetchM3u8WithCache');
    const parserCore = sliceBetween(app, 'function parseM3u8Info', 'function rebuildMediaPlaylistWindow');
    const masterCore = sliceBetween(app, 'function makeBandwidthForHeight', 'function isTruthyQueryValue');
    const capturedLogs = [];
    const context = {
        require,
        crypto: require('crypto'),
        URL,
        URLSearchParams,
        encodeURIComponent,
        process: { env: {} },
        console: {
            log: (...args) => capturedLogs.push(args.join(' ')),
            warn: (...args) => capturedLogs.push(args.join(' ')),
            error: (...args) => capturedLogs.push(args.join(' '))
        },
        capturedLogs,
        activeSessions: []
    };
    vm.createContext(context);
    vm.runInContext(`
        const DEFAULT_PUBLIC_HLS_BASE_URL = 'https://livemonitor.vps-kinghost.net';
        const HLS_SESSION_UPSTREAM_STUCK_MS = 45000;
        const HLS_SESSION_DISCONTINUITY_RESET_MS = 12000;
        const HLS_EXOMEDIA_SINGLE_VARIANT_MASTER = true;
        const HLS_EXOMEDIA_SINGLE_VARIANT_HEIGHT = 720;
        const STALE_SERVE_MAX_AGE_MS = 60000;
        const playbackVariantUrlPins = new Map();
        const hlsSessionVariantState = new Map();
        const hlsSessionVariantPins = new Map();
        const m3u8CacheContent = new Map();
        const m3u8CachePromises = new Map();
        const lastServedSequence = new Map();
        const lastGoodM3u8 = new Map();
        const hlsMediaPlaylistHistory = new Map();
        const playbackSessions = {
            listActive(filters) {
                return activeSessions.filter(session => (
                    (!filters.owner || session.owner === filters.owner) &&
                    (!filters.videoId || session.videoId === filters.videoId)
                ));
            }
        };
        function sessionPreview(sessionId) {
            const value = String(sessionId || '');
            return value.length > 8 ? value.slice(0, 8) + '...' : value || 'n/a';
        }
        ${helperCore}
        ${parserCore}
        ${masterCore}
        globalThis.__hooks = {
            capturedLogs,
            setActiveSessions(value) { activeSessions = value; },
            getPlaybackVariantPinKey,
            rememberSessionVariantPin,
            getSessionVariantPinnedUrl,
            markSessionVariantRefreshRejected,
            clearSessionVariantState,
            clearHlsSessionVariantStateFor,
            pruneHlsSessionVariantState,
            updateSessionVariantState,
            getPlaylistSnapshot,
            playlistsHaveOverlap,
            shouldRefreshStuckSessionVariant,
            buildPlaybackSessionMaster,
            isExoCompatibleUserAgent,
            shouldUseSingleVariantMaster,
            logVariantSessionSnapshot,
            hlsSessionVariantState,
            hlsSessionVariantPins
        };
    `, context);
    return context.__hooks;
}

function mediaPlaylist(sequence, segmentNames, options = {}) {
    const lines = [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        `#EXT-X-TARGETDURATION:${options.targetDuration || 6}`,
        `#EXT-X-MEDIA-SEQUENCE:${sequence}`
    ];
    segmentNames.forEach((name, index) => {
        if (options.discontinuityAt === index) lines.push('#EXT-X-DISCONTINUITY');
        lines.push('#EXTINF:6.000,', `https://media.example.test/${name}.ts?sig=secret-${name}`);
    });
    return `${lines.join('\n')}\n`;
}

function countVariants(master) {
    return (String(master).match(/#EXT-X-STREAM-INF/g) || []).length;
}

function testHlsContinuityExecutableChecks() {
    const hls = loadHlsContinuityHooks();
    const first = mediaPlaylist(10, ['a', 'b', 'c']);
    const overlap = mediaPlaylist(12, ['c', 'd', 'e']);
    const continuous = mediaPlaylist(13, ['d', 'e', 'f']);
    const regression = mediaPlaylist(9, ['x', 'y']);
    const jump = mediaPlaylist(30, ['z', 'w']);
    const discontinuity = mediaPlaylist(13, ['d', 'e'], { discontinuityAt: 0 });
    const firstSnapshot = hls.getPlaylistSnapshot(first, 'https://upstream-a.example.test/live.m3u8?sig=secret');

    const key720 = hls.getPlaybackVariantPinKey('VID123', 720, 'session-a', 'owner-a', 'token-a');
    const key720Again = hls.getPlaybackVariantPinKey('VID123', 720, 'session-a', 'owner-a', 'token-a');
    const key720OtherSession = hls.getPlaybackVariantPinKey('VID123', 720, 'session-b', 'owner-a', 'token-a');
    const key480 = hls.getPlaybackVariantPinKey('VID123', 480, 'session-a', 'owner-a', 'token-a');
    const keyOtherOwner = hls.getPlaybackVariantPinKey('VID123', 720, 'session-a', 'owner-b', 'token-a');
    const keyOtherToken = hls.getPlaybackVariantPinKey('VID123', 720, 'session-a', 'owner-a', 'token-b');
    assert.equal(key720, key720Again);
    assert.notEqual(key720, key720OtherSession);
    assert.notEqual(key720, key480);
    assert.notEqual(key720, keyOtherOwner);
    assert.notEqual(key720, keyOtherToken);

    hls.rememberSessionVariantPin(key720, 'https://manifest.googlevideo.com/a.m3u8?sig=secret', {
        videoId: 'VID123',
        owner: 'owner-a',
        token: 'token-a',
        quality: 720,
        sessionId: 'session-a'
    });
    assert.equal(hls.getSessionVariantPinnedUrl(key720), 'https://manifest.googlevideo.com/a.m3u8?sig=secret');

    hls.updateSessionVariantState(key720, {
        videoId: 'VID123',
        owner: 'owner-a',
        token: 'token-a',
        quality: 720,
        sessionId: 'session-a',
        upstreamUrl: 'https://manifest.googlevideo.com/a.m3u8?sig=secret',
        snapshot: firstSnapshot,
        source: 'current'
    });
    const stored = hls.hlsSessionVariantState.get(key720);
    assert.equal(stored.upstreamIdentityHash.length, 12);
    assert.equal(stored.lastServedSequence, 10);
    assert.equal(stored.targetDuration, 6);
    assert.ok(!Object.prototype.hasOwnProperty.call(stored, 'upstreamUrl'));
    assert.ok(!Object.prototype.hasOwnProperty.call(stored, 'sessionId'));

    assert.equal(hls.playlistsHaveOverlap(firstSnapshot, hls.getPlaylistSnapshot(overlap, 'https://upstream-a.example.test/live.m3u8')), true);
    assert.equal(hls.playlistsHaveOverlap(firstSnapshot, hls.getPlaylistSnapshot(continuous, 'https://upstream-a.example.test/live.m3u8')), true);
    assert.equal(hls.playlistsHaveOverlap(firstSnapshot, hls.getPlaylistSnapshot(regression, 'https://upstream-a.example.test/live.m3u8')), false);
    assert.equal(hls.playlistsHaveOverlap(firstSnapshot, hls.getPlaylistSnapshot(jump, 'https://upstream-b.example.test/live.m3u8')), false);
    assert.equal(hls.getPlaylistSnapshot(discontinuity, 'https://upstream-a.example.test/live.m3u8').hasDiscontinuity, true);

    const beforeRejectedPin = hls.getSessionVariantPinnedUrl(key720);
    hls.markSessionVariantRefreshRejected(key720, Date.parse('2026-07-15T12:00:00.000Z'));
    assert.equal(hls.getSessionVariantPinnedUrl(key720), beforeRejectedPin);
    assert.ok(hls.hlsSessionVariantPins.get(key720).discontinuityUntil > Date.parse('2026-07-15T12:00:00.000Z'));

    hls.clearSessionVariantState(key720);
    assert.equal(hls.getSessionVariantPinnedUrl(key720), null);
    hls.rememberSessionVariantPin(key720, 'https://manifest.googlevideo.com/b.m3u8?sig=secret', {
        videoId: 'VID123',
        owner: 'owner-a',
        token: 'token-a',
        quality: 720,
        sessionId: 'session-a'
    });
    assert.equal(hls.getSessionVariantPinnedUrl(key720), 'https://manifest.googlevideo.com/b.m3u8?sig=secret');

    hls.updateSessionVariantState(key720, {
        videoId: 'VID123',
        owner: 'owner-a',
        token: 'token-a',
        quality: 720,
        sessionId: 'session-a',
        upstreamUrl: 'https://manifest.googlevideo.com/b.m3u8?sig=secret',
        snapshot: firstSnapshot,
        source: 'current'
    });
    hls.setActiveSessions([{ sessionId: 'session-a', owner: 'owner-a', videoId: 'VID123' }]);
    assert.equal(hls.pruneHlsSessionVariantState(Date.now()), 0);
    hls.setActiveSessions([]);
    assert.ok(hls.pruneHlsSessionVariantState(Date.now()) >= 1);
    assert.equal(hls.hlsSessionVariantState.has(key720), false);

    hls.rememberSessionVariantPin(key720, 'https://manifest.googlevideo.com/c.m3u8?sig=secret', {
        videoId: 'VID123',
        owner: 'owner-a',
        token: 'token-a',
        quality: 720,
        sessionId: 'session-a'
    });
    hls.updateSessionVariantState(key720, {
        videoId: 'VID123',
        owner: 'owner-a',
        token: 'token-a',
        quality: 720,
        sessionId: 'session-a',
        upstreamUrl: 'https://manifest.googlevideo.com/c.m3u8?sig=secret',
        snapshot: firstSnapshot,
        source: 'current'
    });
    hls.clearHlsSessionVariantStateFor({ owner: 'owner-a', videoId: 'VID123', token: 'token-a' });
    assert.equal(hls.hlsSessionVariantState.has(key720), false);
    assert.equal(hls.getSessionVariantPinnedUrl(key720), null);

    hls.updateSessionVariantState(key480, {
        videoId: 'VID123',
        owner: 'owner-a',
        token: 'token-a',
        quality: 480,
        sessionId: 'session-a',
        upstreamUrl: 'https://manifest.googlevideo.com/480.m3u8?sig=secret',
        snapshot: firstSnapshot,
        source: 'current'
    });
    hls.clearHlsSessionVariantStateFor({ owner: 'owner-a', videoId: 'VID123' });
    assert.equal(hls.hlsSessionVariantState.has(key480), false);

    const monitor = {
        _playlistUrls: {
            720: 'https://video.example.test/720.m3u8',
            480: 'https://video.example.test/480.m3u8',
            360: 'https://video.example.test/360.m3u8'
        }
    };
    const neoNewsReq = { headers: { 'user-agent': 'NeoNews ExoMedia 4.3.0 / Android 14' } };
    const lowercaseReq = { headers: { 'user-agent': 'exomedia stick hd' } };
    const vlcReq = { headers: { 'user-agent': 'VLC/3.0.21 LibVLC/3.0.21' } };
    assert.equal(hls.shouldUseSingleVariantMaster(neoNewsReq), true);
    assert.equal(hls.shouldUseSingleVariantMaster(lowercaseReq), true);
    assert.equal(hls.shouldUseSingleVariantMaster(vlcReq), false);
    const single720 = hls.buildPlaybackSessionMaster(monitor, {
        token: 'token-a',
        videoId: 'VID123',
        owner: 'owner-a',
        sessionId: 'session-a',
        requestedMaxHeight: null,
        fallbackMaxHeight: 720,
        baseUrl: 'https://livemonitor.example.test',
        singleVariant: true
    });
    assert.equal(countVariants(single720), 1);
    assert.ok(single720.includes('max=720'));
    const single480 = hls.buildPlaybackSessionMaster(monitor, {
        token: 'token-a',
        videoId: 'VID123',
        owner: 'owner-a',
        sessionId: 'session-a',
        requestedMaxHeight: 480,
        fallbackMaxHeight: 720,
        baseUrl: 'https://livemonitor.example.test',
        singleVariant: true
    });
    assert.equal(countVariants(single480), 1);
    assert.ok(single480.includes('max=480'));
    const adaptive = hls.buildPlaybackSessionMaster(monitor, {
        token: 'token-a',
        videoId: 'VID123',
        owner: 'owner-a',
        sessionId: 'session-a',
        requestedMaxHeight: null,
        fallbackMaxHeight: 720,
        baseUrl: 'https://livemonitor.example.test',
        singleVariant: false
    });
    assert.equal(countVariants(adaptive), 3);

    hls.logVariantSessionSnapshot('VID123', {
        owner: 'owner-a',
        sessionId: 'session-a-secret',
        quality: 720,
        upstreamUrl: 'https://manifest.googlevideo.com/api/manifest/hls_playlist/secret?sig=signed-token',
        snapshot: firstSnapshot,
        source: 'current'
    });
    const logOutput = hls.capturedLogs.join('\n');
    assert.ok(!logOutput.includes('signed-token'));
    assert.ok(!logOutput.includes('manifest.googlevideo.com'));
    assert.ok(!logOutput.includes('session-a-secret'));
}

function testAppIntegrationStaticChecks() {
    const app = fs.readFileSync(APP_PATH, 'utf8');
    const storeSource = fs.readFileSync(path.join(__dirname, '..', 'services', 'playbackSessionStore.js'), 'utf8');
    assert.ok(app.includes("require('./services/playbackSessionStore')"));
    assert.ok(app.includes('playbackSessions.createSession'));
    assert.ok(app.includes('playbackSessions.touchSession'));
    assert.ok(app.includes("created.code === 'reused_recent'"));
    assert.ok(app.includes("created.code === 'reused_stale'"));
    assert.ok(app.includes("created.code === 'reused_expired'"));
    assert.ok(app.includes('buildPlaybackSessionMaster'));
    assert.ok(app.includes('TOKEN_TOMBSTONE_TTL_MS'));
    assert.ok(app.includes('pruneTokenTombstones(tokenMap)'));
    assert.ok(storeSource.includes('_canReuseClientSession(fingerprint)'));
    assert.ok(storeSource.includes('HLS_SESSION_REOPEN_REUSE_MS'));
    assert.ok(storeSource.includes("code: code || (reusable.expired ? 'reused_expired' : 'reused_stale')"));
    assert.ok(app.includes('function getPlaybackSessionTokenScope(token)'));
    assert.ok(app.includes('tokenScope: playbackSessionTokenScope'));
    assert.ok(app.includes("'Cache-Control': 'private, no-store'"));
    assert.ok(app.includes("'Vary': 'User-Agent'"));
    assert.ok(app.includes('playbackSessions.countActive({ owner, videoId })'));
    assert.ok(app.includes('playbackSessions.removeForLive'));
    assert.ok(app.includes('playbackSessions.removeForOwner(owner)'));
    assert.ok(app.includes('removedPlaybackSessionsOnStartup'));
    assert.ok(app.includes("params.set('session', sessionId)"));
    assert.ok(app.includes("params.set('max', String(maxHeight))"));
    assert.ok(!app.includes('playlistUrl.searchParams.set'));
    assert.ok(!app.includes('manifest.googlevideo.com') || app.includes('/[stream-url-redacted]'));
    assert.ok(!app.includes('sessionId: session.sessionId'));
    assert.ok(!app.includes('deviceId: session.sessionId'));
    assert.ok(!app.includes('const isAlreadyActive = isIpActiveForOwnerAndVideo(trackingOwner, videoId, clientIp, userAgent);'));
    assert.ok(!app.includes('primeiros 200 chars'));
}

function testHlsPlaybackCompatibilityStaticChecks() {
    const app = fs.readFileSync(APP_PATH, 'utf8');
    assert.ok(app.includes('function getPlaybackManifestBaseUrl(req)'));
    assert.ok(app.includes('function normalizeManifestBaseUrl(value)'));
    assert.ok(app.includes('DEFAULT_PUBLIC_HLS_BASE_URL'));
    assert.ok(app.includes('process.env.HLS_PUBLIC_BASE_URL'));
    assert.ok(app.includes("parsed.protocol = 'https:'"));
    assert.ok(app.includes('baseUrl: playbackManifestBaseUrl'));
    assert.ok(app.includes('PLAYBACK_VARIANT_PIN_TTL_MS'));
    assert.ok(app.includes('HLS_EXTENDED_WINDOW_SEGMENTS'));
    assert.ok(app.includes('HLS_SESSION_UPSTREAM_STUCK_MS'));
    assert.ok(app.includes('HLS_EXOMEDIA_SINGLE_VARIANT_MASTER'));
    assert.ok(app.includes('HLS_EXOMEDIA_SINGLE_VARIANT_HEIGHT'));
    assert.ok(app.includes('hlsMediaPlaylistHistory'));
    assert.ok(app.includes('hlsSessionVariantState'));
    assert.ok(app.includes('function getPlaylistSnapshot(content, sourceUrl)'));
    assert.ok(app.includes('function playlistsHaveOverlap(previousSnapshot, nextSnapshot)'));
    assert.ok(app.includes('function updateSessionVariantState(stateKey'));
    assert.ok(app.includes('function isExoCompatibleUserAgent(req)'));
    assert.ok(app.includes('function shouldUseSingleVariantMaster(req)'));
    assert.ok(app.includes('singleVariant: singleVariantMaster'));
    assert.ok(app.includes('extendLiveMediaPlaylistWindow(logVideoId, stabilityKey, contentToServe)'));
    assert.ok(app.includes('Sem stale seguro; servindo playlist real sem forçar MEDIA-SEQUENCE.'));
    assert.ok(app.includes('const M3U8_CACHE_TTL = parseInt(process.env.M3U8_CACHE_TTL) || 2000;'));
    assert.ok(app.includes('const PLAYBACK_VARIANT_PIN_TTL_MS = parseInt(process.env.PLAYBACK_VARIANT_PIN_TTL_MS, 10) || 0;'));
    assert.ok(app.includes('if (!PLAYBACK_VARIANT_PIN_TTL_MS) return currentUrl;'));
    assert.ok(app.includes('getPlaybackVariantPinKey(videoId, urlMaxHeight, activePlaybackSessionId, trackingOwner, routeContext.token || null)'));
    assert.ok(app.includes('hlsSessionVariantPins'));
    assert.ok(app.includes('markSessionVariantRefreshRejected(pinKey)'));
    assert.ok(app.includes('clearHlsSessionVariantStateFor({ owner, videoId })'));
    assert.ok(app.includes('getPinnedVariantUrl(pinKey, playlistUrl)'));
    assert.ok(app.includes('stabilizeMediaPlaylist(videoId, stabilityKey, variant.result.content, monitor.lastMediaSequence)'));
    assert.ok(app.includes('logProxyAccess(stabilityKey, {'));
    assert.ok(app.includes("source: 'refresh-rejected'"));
    assert.ok(app.includes("reason: 'no_overlap'"));
    assert.ok(app.includes('getUpstreamIdentityHash(sourceUrl)'));
    assert.ok(app.includes('sessionPreview(sessionId)'));
    const variantBlock = app.slice(
        app.indexOf('if (urlMaxHeight && monitor._playlistUrls && monitor._playlistUrls[urlMaxHeight])'),
        app.indexOf('// Se não for requisição de qualidade, verifica se é o master')
    );
    assert.ok(!variantBlock.includes('runYtdlp'));
    assert.ok(!variantBlock.includes('converter.convert'));
    assert.ok(!variantBlock.includes('fs.writeFileSync'));
    assert.ok(app.includes("return sendHlsError(res, 503, 'stream_temporarily_unavailable'"));
    assert.ok(app.includes("return sendHlsError(res, 410, 'token_gone')"));
    assert.ok(app.includes('isRevokedTokenInfo(info)'));
    assert.ok(app.includes('function shouldProxyHlsSegments(req)'));
    assert.ok(app.includes('HLS_SEGMENT_PROXY_MODE'));
    assert.ok(app.includes("params.set('segmentProxy', '1')"));
    assert.ok(app.includes('rewriteHlsSegmentUrls(content'));
    assert.ok(app.includes("app.get('/neonews/seg/:segmentId.ts', handleHlsSegmentProxy)"));
    assert.ok(app.includes('createHmac'));
    assert.ok(app.includes('segment_unavailable'));
    assert.ok(app.includes('function sendHlsError(res, statusCode, message'));
    assert.ok(app.includes("'Cache-Control': 'private, no-store, no-cache'"));
    assert.ok(app.includes("app.head('/neonews/t/:token.m3u8'"));
    assert.ok(app.includes("app.head('/neonews/:videoId.m3u8'"));
    assert.ok(app.includes("return sendHlsError(res, 429, 'limit_exceeded')"));
    assert.ok(app.includes("return sendHlsError(res, 429, 'session_rate_limited'"));
    assert.ok(app.includes("return sendHlsError(res, 404, 'token_not_found')"));
    assert.ok(!app.includes("req.headers['x-forwarded-host']"));
    assert.ok(!app.includes("req.get('host')"));
    assert.ok(!app.includes('`#EXT-X-MEDIA-SEQUENCE:${prev.sequence + 1}`'));
    assert.ok(!app.includes("res.status(429).json({\n                        error: 'Limite de dispositivos excedido'"));
    assert.ok(!app.includes("res.status(429).json({\n                        error: 'Muitas tentativas de sessão'"));
}

async function main() {
    testSameIpAndUserAgentFourthIsBlocked();
    testDifferentIpsFourthIsBlocked();
    testLimitsOneTwoAndInvalid();
    testIdenticalDevicesReceiveDifferentSessionIds();
    testFreshIdenticalClientStillCountsAsSeparateDevice();
    testRecentIdenticalClientReusesSession();
    testRecentIdenticalClientWithoutFingerprintDoesNotReuseSession();
    testLimitOneFastNeoNewsReopenReusesSession();
    testLimitOneFastNeoNewsReopenWithoutVariantEvidenceIsBlocked();
    testFastNeoNewsOpeningWithoutVariantEvidenceCreatesWhenLimitAllows();
    testLimitOneSimultaneousIdenticalNeoNewsOpeningIsBlocked();
    testGenericUserAgentDoesNotUseReopenReuse();
    testReopenAfterWindowIsSubjectToLimit();
    testReopenAfterWindowCreatesWhenLimitAllows();
    testReopenReuseIsScopedByTokenOwnerAndVideo();
    testExpiredSessionIsNotReusedByReopenWindow();
    testReopenEvidenceIsConsumedOnceUntilNextVariant();
    testRecentWindowDoesNotCollapseIndependentOpeningsWithoutFingerprint();
    testRecentReuseCollapsesDuplicateClientSessions();
    testDuplicateCleanupRequiresFingerprint();
    testStaleIdenticalClientReusesSession();
    testStaleIdenticalClientWithoutFingerprintDoesNotReuseSession();
    testStaleReuseCanAvoidFalseLimitExceeded();
    testStaleDifferentClientDoesNotReuseSession();
    testFingerprintPreventsStaleReuseAcrossDifferentLocalIdentity();
    testPlaylistRefreshKeepsSameSession();
    testExpiredSessionFreesSlot();
    testExpiredSameClientReusesWithinGrace();
    testExpiredSameClientDoesNotBypassFullLimit();
    testExpiredSessionRemovedAfterReuseGrace();
    testExpiredSessionIsRejectedOnRefresh();
    await testConcurrentCreationDoesNotExceedLimit();
    await testConcurrentCreationWithoutFingerprintDoesNotReuseRecentSession();
    testSessionScopeValidation();
    testLiveEndedCleanupRemovesSessions();
    testOwnerCleanupRemovesOnlyThatOwner();
    testSessionPreviewCanRemoveWithoutExposingFullId();
    testPersistenceAcrossRestartWithinTtl();
    testRestartRemovesExpiredSession();
    testInvalidJsonDoesNotCrashAndIsArchived();
    testAtomicWriteUsesTempThenRenameAndNoSensitivePayload();
    testDashboardCountsSessions();
    testSanitizationAndPreview();
    testHlsContinuityExecutableChecks();
    testAppIntegrationStaticChecks();
    testHlsPlaybackCompatibilityStaticChecks();
    console.log('Device limit identification tests OK');
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
