const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    PlaybackSessionStore,
    sessionPreview,
    safeText
} = require('../services/playbackSessionStore');

const APP_PATH = path.join(__dirname, '..', 'app.js');
const OWNER = 'filipe';
const VIDEO_ID = 'j6Df-EzdfbQ';
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
        reuseStaleAfterMs: options.reuseStaleAfterMs,
        reuseExpiredGraceMs: options.reuseExpiredGraceMs
    });
}

function create(store, overrides = {}, nowMs = NOW) {
    return store.createSession({
        owner: OWNER,
        videoId: VIDEO_ID,
        limit: 3,
        publicIp: IP,
        userAgent: USER_AGENT,
        source: 'hls',
        ...overrides
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

function testStaleIdenticalClientReusesSession() {
    const store = createStore({ reuseStaleAfterMs: 45000 });
    const first = create(store, {}, NOW);
    const reopened = create(store, {}, NOW + 46000);

    assert.equal(first.ok, true);
    assert.equal(reopened.ok, true);
    assert.equal(reopened.code, 'reused_stale');
    assert.equal(reopened.session.sessionId, first.session.sessionId);
    assert.equal(store.countActive({ owner: OWNER, videoId: VIDEO_ID }, NOW + 46000), 1);
}

function testStaleReuseCanAvoidFalseLimitExceeded() {
    const store = createStore({ reuseStaleAfterMs: 45000 });
    const first = create(store, {}, NOW);
    create(store, { publicIp: '187.40.208.119' }, NOW);
    create(store, { publicIp: '187.40.208.120' }, NOW);

    const reopened = create(store, {}, NOW + 46000);

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
    const first = create(store, {}, NOW);
    const afterTtl = NOW + 2000;

    assert.equal(store.countActive({ owner: OWNER, videoId: VIDEO_ID }, afterTtl), 0);

    const reopened = create(store, {}, afterTtl);
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

function testAppIntegrationStaticChecks() {
    const app = fs.readFileSync(APP_PATH, 'utf8');
    assert.ok(app.includes("require('./services/playbackSessionStore')"));
    assert.ok(app.includes('playbackSessions.createSession'));
    assert.ok(app.includes('playbackSessions.touchSession'));
    assert.ok(app.includes("created.code === 'reused_stale'"));
    assert.ok(app.includes("created.code === 'reused_expired'"));
    assert.ok(app.includes('buildPlaybackSessionMaster'));
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
    assert.ok(app.includes('function sendHlsError(res, statusCode, message'));
    assert.ok(app.includes("'Cache-Control': 'private, no-store, no-cache'"));
    assert.ok(app.includes("app.head('/neonews/t/:token.m3u8'"));
    assert.ok(app.includes("app.head('/neonews/:videoId.m3u8'"));
    assert.ok(app.includes("return sendHlsError(res, 429, 'limit_exceeded')"));
    assert.ok(app.includes("return sendHlsError(res, 429, 'session_rate_limited'"));
    assert.ok(app.includes("return sendHlsError(res, 404, 'token_not_found')"));
    assert.ok(!app.includes("req.headers['x-forwarded-host']"));
    assert.ok(!app.includes("req.get('host')"));
    assert.ok(!app.includes("res.status(429).json({\n                        error: 'Limite de dispositivos excedido'"));
    assert.ok(!app.includes("res.status(429).json({\n                        error: 'Muitas tentativas de sessão'"));
}

async function main() {
    testSameIpAndUserAgentFourthIsBlocked();
    testDifferentIpsFourthIsBlocked();
    testLimitsOneTwoAndInvalid();
    testIdenticalDevicesReceiveDifferentSessionIds();
    testFreshIdenticalClientStillCountsAsSeparateDevice();
    testStaleIdenticalClientReusesSession();
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
    testAppIntegrationStaticChecks();
    testHlsPlaybackCompatibilityStaticChecks();
    console.log('Device limit identification tests OK');
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
