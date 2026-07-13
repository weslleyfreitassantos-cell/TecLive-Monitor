const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
    CLASSIFICATION,
    classifyYtdlpError
} = require('../services/ytdlpStreamSelector');
const {
    buildCookieAttemptOrder,
    computeBackoffSeconds,
    applyExtractionFailure,
    resetExtractionBackoff,
    getBackoffDelayMs,
    createExtractionBackoffState
} = require('../services/extractionRetryPolicy');
const GlobalScheduler = require('../globalScheduler');

function hlsMetadata(height = 720) {
    return {
        live_status: 'is_live',
        is_live: true,
        formats: [{
            format_id: `hls-${height}`,
            protocol: 'm3u8_native',
            ext: 'mp4',
            url: `https://video.example.test/hls/${height}/index?token=secret`,
            height,
            width: Math.round(height * 16 / 9),
            vcodec: 'avc1',
            acodec: 'mp4a',
            fps: 30
        }]
    };
}

function captureConsole() {
    const original = {
        log: console.log,
        warn: console.warn,
        error: console.error
    };
    const lines = [];
    console.log = (...args) => lines.push(args.join(' '));
    console.warn = (...args) => lines.push(args.join(' '));
    console.error = (...args) => lines.push(args.join(' '));
    return {
        lines,
        restore() {
            console.log = original.log;
            console.warn = original.warn;
            console.error = original.error;
        }
    };
}

function installConvertFakes() {
    const fakeCalls = [];
    const instances = [];

    class FakeCookieRotator {
        constructor() {
            this.nextCookie = 'cookie1.txt';
            this.calls = fakeCalls;
            instances.push(this);
        }

        setEmailAlerts() {}

        getNextCookiePath() {
            return path.join(process.cwd(), 'cookies', this.nextCookie);
        }

        getFallbackCookiePath() {
            return null;
        }

        isCookieAuthError(message) {
            return /(sign in|login required|authentication required|invalid cookie|cookie file)/i.test(String(message || ''));
        }

        markFailure(file, message, videoId) {
            fakeCalls.push({ op: 'failure', file, message: String(message || ''), videoId });
            return true;
        }

        markSuccess(file) {
            fakeCalls.push({ op: 'success', file });
            return true;
        }
    }

    const cookieRotatorPath = require.resolve('../cookieRotator');
    require.cache[cookieRotatorPath] = {
        id: cookieRotatorPath,
        filename: cookieRotatorPath,
        loaded: true,
        exports: FakeCookieRotator
    };

    const LiveMonitor = require('../monitor/liveMonitor');
    const originalStartMonitoring = LiveMonitor.prototype.startMonitoring;
    LiveMonitor.prototype.startMonitoring = function startMonitoringStub(intervalSeconds) {
        this.startedWithInterval = intervalSeconds;
        this.liveState = 'online';
    };

    delete require.cache[require.resolve('../api/convert')];
    const ConvertAPI = require('../api/convert');

    const originalExistsSync = fs.existsSync;
    fs.existsSync = function existsSyncStub(target) {
        if (/[\\/]cookies[\\/]cookie[123]\.txt$/i.test(String(target || ''))) return true;
        return originalExistsSync.apply(this, arguments);
    };

    return {
        ConvertAPI,
        fakeCalls,
        instances,
        cleanup() {
            fs.existsSync = originalExistsSync;
            LiveMonitor.prototype.startMonitoring = originalStartMonitoring;
        }
    };
}

function cookieFromArgs(args) {
    const index = args.indexOf('--cookies');
    return index === -1 ? null : path.basename(args[index + 1]);
}

function testCookieAttemptOrder() {
    const order = buildCookieAttemptOrder({
        lastSuccessfulCookie: 'cookie2.txt',
        selectedCookiePath: path.join('cookies', 'cookie2.txt'),
        cookieFiles: ['cookie1.txt', 'cookie2.txt', 'cookie3.txt'],
        cookieExists: () => true
    });
    assert.deepEqual(order, ['cookie2.txt', 'cookie1.txt', 'cookie3.txt']);

    const selectedThenRest = buildCookieAttemptOrder({
        lastSuccessfulCookie: null,
        selectedCookiePath: path.join('cookies', 'cookie3.txt'),
        cookieFiles: ['cookie1.txt', 'cookie2.txt', 'cookie3.txt'],
        cookieExists: cookie => cookie !== 'cookie2.txt'
    });
    assert.deepEqual(selectedThenRest, ['cookie3.txt', 'cookie1.txt']);

    const duplicates = buildCookieAttemptOrder({
        lastSuccessfulCookie: 'cookie1.txt',
        selectedCookiePath: path.join('cookies', 'cookie1.txt'),
        cookieFiles: ['cookie1.txt', 'cookie2.txt', 'cookie1.txt', 'cookie3.txt'],
        cookieExists: () => true
    });
    assert.deepEqual(duplicates, ['cookie1.txt', 'cookie2.txt', 'cookie3.txt']);

    const unavailableLastSuccess = buildCookieAttemptOrder({
        lastSuccessfulCookie: 'cookie2.txt',
        selectedCookiePath: path.join('cookies', 'cookie3.txt'),
        cookieFiles: ['cookie1.txt', 'cookie2.txt', 'cookie3.txt'],
        cookieExists: cookie => cookie !== 'cookie2.txt'
    });
    assert.deepEqual(unavailableLastSuccess, ['cookie3.txt', 'cookie1.txt']);
}

function testBackoffPolicy() {
    assert.equal(computeBackoffSeconds(CLASSIFICATION.NO_FORMATS, 1), 30);
    assert.equal(computeBackoffSeconds(CLASSIFICATION.NO_FORMATS, 2), 60);
    assert.equal(computeBackoffSeconds(CLASSIFICATION.NO_FORMATS, 3), 120);
    assert.equal(computeBackoffSeconds(CLASSIFICATION.NO_FORMATS, 4), 300);
    assert.equal(computeBackoffSeconds(CLASSIFICATION.NO_FORMATS, 5), 600);
    assert.equal(computeBackoffSeconds(CLASSIFICATION.NO_FORMATS, 9), 600);
    assert.equal(computeBackoffSeconds(CLASSIFICATION.RATE_LIMIT, 1), 60);
    assert.equal(computeBackoffSeconds(CLASSIFICATION.RATE_LIMIT, 4, { rateLimitMaxSeconds: 300 }), 300);
    assert.equal(computeBackoffSeconds(CLASSIFICATION.NETWORK, 1), 15);
    assert.equal(computeBackoffSeconds(CLASSIFICATION.TIMEOUT, 2), 30);
    assert.equal(computeBackoffSeconds(CLASSIFICATION.SERVER_5XX, 9), 300);
    assert.equal(computeBackoffSeconds(CLASSIFICATION.LIVE_ENDED, 1), 600);
    assert.equal(computeBackoffSeconds(CLASSIFICATION.LIVE_ENDED, 1, { terminalBackoffSeconds: 120 }), 120);
    assert.equal(computeBackoffSeconds(CLASSIFICATION.AUTH_COOKIE, 1), 0);
    assert.equal(classifyYtdlpError('HTTP Error 503: Service Unavailable'), CLASSIFICATION.SERVER_5XX);

    const originalRateLimitMax = process.env.YTDLP_RATE_LIMIT_BACKOFF_MAX_SECONDS;
    try {
        process.env.YTDLP_RATE_LIMIT_BACKOFF_MAX_SECONDS = 'not-a-number';
        assert.equal(computeBackoffSeconds(CLASSIFICATION.RATE_LIMIT, 4), 600);
        process.env.YTDLP_RATE_LIMIT_BACKOFF_MAX_SECONDS = '-1';
        assert.equal(computeBackoffSeconds(CLASSIFICATION.RATE_LIMIT, 4), 600);
    } finally {
        if (originalRateLimitMax === undefined) {
            delete process.env.YTDLP_RATE_LIMIT_BACKOFF_MAX_SECONDS;
        } else {
            process.env.YTDLP_RATE_LIMIT_BACKOFF_MAX_SECONDS = originalRateLimitMax;
        }
    }
}

function testBackoffStateReset() {
    const state = createExtractionBackoffState();
    const expected = [30, 60, 120, 300, 600, 600];
    let now = 1000;
    for (let i = 0; i < expected.length; i += 1) {
        applyExtractionFailure(state, CLASSIFICATION.NO_FORMATS, now);
        assert.equal(state.consecutiveExtractionFailures, i + 1);
        assert.equal(state.backoffSeconds, expected[i]);
        assert.equal(state.nextRetryAt, now + expected[i] * 1000);
        now = state.nextRetryAt + 1;
    }

    const retryAt = state.nextRetryAt;
    assert.equal(getBackoffDelayMs(state, retryAt - 1), 1);
    assert.equal(getBackoffDelayMs(state, retryAt), 0);
    assert.equal(getBackoffDelayMs(state, retryAt + 1), 0);

    const authState = createExtractionBackoffState();
    applyExtractionFailure(authState, CLASSIFICATION.AUTH_COOKIE, 5000);
    assert.equal(authState.consecutiveExtractionFailures, 0);
    assert.equal(authState.nextRetryAt, 0);

    const recovered = resetExtractionBackoff(state, 'cookie2.txt', retryAt + 1000);
    assert.equal(recovered, true);
    assert.equal(state.consecutiveExtractionFailures, 0);
    assert.equal(state.nextRetryAt, 0);
    assert.equal(state.backoffSeconds, 0);
    assert.equal(state.lastFailureClassification, null);
    assert.equal(state.lastSuccessfulCookie, 'cookie2.txt');
    assert.equal(state.lastExtractionSuccessAt, retryAt + 1000);
}

async function testConvertBackoffAndIsolation() {
    const fakes = installConvertFakes();
    const capture = captureConsole();
    try {
        const api = new fakes.ConvertAPI(null, null);
        api._getVideoMetadata = async () => ({ title: 'Local', channel: 'Test' });
        api._persistMapping = () => {};

        const attempts = [];
        api._runYtdlp = async (args) => {
            attempts.push({ owner: 'a', cookie: cookieFromArgs(args) });
            throw new Error('No video formats found at https://manifest.googlevideo.com/api/manifest/hls_variant/expire/1783885887/sig/secret/file/index.m3u8?token=secret Authorization: Bearer secret-token');
        };

        const fail = await api.convert('https://www.youtube.com/watch?v=LIVEAAAAAA1', 'http://127.0.0.1', 'live-a');
        assert.equal(fail.success, false);
        assert.equal(fail.classification, CLASSIFICATION.NO_FORMATS);
        assert.deepEqual(attempts.map(item => item.cookie), ['cookie1.txt', 'cookie2.txt', 'cookie3.txt', null]);
        assert.equal(new Set(attempts.map(item => item.cookie).filter(Boolean)).size, 3);
        assert.equal(attempts.filter(item => item.cookie === null).length, 1);
        assert.equal(fakes.fakeCalls.filter(call => call.op === 'failure').length, 0);

        const keyA = api._getCompositeKey('LIVEAAAAAA1', 'live-a');
        const stateA = api._getExtractionState(keyA);
        assert.equal(stateA.consecutiveExtractionFailures, 1);
        assert.equal(stateA.backoffSeconds, 30);
        assert.ok(stateA.nextRetryAt > Date.now());

        const beforeBackoffAttempts = attempts.length;
        const suppressed = await api.convert('https://www.youtube.com/watch?v=LIVEAAAAAA1', 'http://127.0.0.1', 'live-a');
        assert.equal(suppressed.success, false);
        assert.equal(suppressed.classification, CLASSIFICATION.NO_FORMATS);
        assert.equal(attempts.length, beforeBackoffAttempts);

        api._runYtdlp = async (args) => {
            attempts.push({ owner: 'b', cookie: cookieFromArgs(args) });
            return JSON.stringify(hlsMetadata(720));
        };
        const liveB = await api.convert('https://www.youtube.com/watch?v=LIVEBBBBBB2', 'http://127.0.0.1', 'live-b');
        assert.equal(liveB.success, true);
        assert.equal(api._getExtractionState(api._getCompositeKey('LIVEBBBBBB2', 'live-b')).consecutiveExtractionFailures, 0);

        stateA.nextRetryAt = Date.now() - 1;
        api._runYtdlp = async (args) => {
            const cookie = cookieFromArgs(args);
            attempts.push({ owner: 'a-retry', cookie });
            if (cookie === 'cookie2.txt') return JSON.stringify(hlsMetadata(480));
            throw new Error('No video formats found');
        };
        const recovered = await api.convert('https://www.youtube.com/watch?v=LIVEAAAAAA1', 'http://127.0.0.1', 'live-a');
        assert.equal(recovered.success, true);
        assert.equal(api._getExtractionState(keyA).consecutiveExtractionFailures, 0);
        assert.equal(api._getExtractionState(keyA).lastSuccessfulCookie, 'cookie2.txt');

        const logText = capture.lines.join('\n');
        assert.ok(!logText.includes('token=secret'));
        assert.ok(!logText.includes('/sig/secret'));
        assert.ok(!logText.includes('secret-token'));
        assert.ok(!logText.includes('Authorization: Bearer secret'));
    } finally {
        capture.restore();
        fakes.cleanup();
    }
}

async function testAuthCookieStillMarksFailure() {
    const fakes = installConvertFakes();
    const capture = captureConsole();
    try {
        const api = new fakes.ConvertAPI(null, null);
        api._getVideoMetadata = async () => ({ title: 'Auth', channel: 'Test' });
        api._persistMapping = () => {};
        api._runYtdlp = async () => {
            throw new Error('Sign in to confirm you are not a bot');
        };

        const result = await api.convert('https://www.youtube.com/watch?v=AUTHCOOKIE1', 'http://127.0.0.1', 'auth');
        assert.equal(result.success, false);
        assert.equal(result.classification, CLASSIFICATION.AUTH_COOKIE);
        assert.equal(fakes.fakeCalls.filter(call => call.op === 'failure').length, 3);
        const state = api._getExtractionState(api._getCompositeKey('AUTHCOOKIE1', 'auth'));
        assert.equal(state.nextRetryAt, 0);
        assert.equal(state.consecutiveExtractionFailures, 0);
    } finally {
        capture.restore();
        fakes.cleanup();
    }
}

async function testGlobalExtractionOutageBackoff() {
    const fakes = installConvertFakes();
    const capture = captureConsole();
    const previousGlobalBackoffMax = process.env.YTDLP_GLOBAL_EXTRACTION_BACKOFF_MAX_SECONDS;
    try {
        const api = new fakes.ConvertAPI(null, null);
        api._getVideoMetadata = async () => ({ title: 'Global outage', channel: 'Test' });
        api._persistMapping = () => {};

        const attempts = [];
        api._runYtdlp = async (args) => {
            const cookie = cookieFromArgs(args);
            attempts.push(cookie);
            if (cookie === null) {
                throw new Error('Sign in to confirm you are not a bot');
            }
            throw new Error('No video formats found');
        };

        const result = await api.convert('https://www.youtube.com/watch?v=GLOBALFAIL1', 'http://127.0.0.1', 'owner-a');
        assert.equal(result.success, false);
        assert.equal(result.classification, CLASSIFICATION.NO_FORMATS);
        assert.equal(result.globalExtractionCritical, true);
        assert.ok(result.error.includes('Não foi possível extrair'));
        assert.deepEqual(attempts, ['cookie1.txt', 'cookie2.txt', 'cookie3.txt', null]);
        assert.equal(fakes.fakeCalls.filter(call => call.op === 'failure').length, 0);
        assert.equal(api.globalExtractionCritical, true);
        assert.equal(api.globalExtractionBackoff.lastFailureClassification, CLASSIFICATION.NO_FORMATS);
        assert.ok(api.globalExtractionBackoff.nextRetryAt > Date.now());

        const before = attempts.length;
        const suppressed = await api.convert('https://www.youtube.com/watch?v=GLOBALFAIL2', 'http://127.0.0.1', 'owner-b', { automatic: true });
        assert.equal(suppressed.success, false);
        assert.equal(suppressed.globalExtractionCritical, true);
        assert.equal(attempts.length, before);

        api.globalExtractionBackoff.nextRetryAt = Date.now() - 1;
        const manual = await api.convert('https://www.youtube.com/watch?v=GLOBALFAIL2', 'http://127.0.0.1', 'owner-b', { manual: true });
        assert.equal(manual.success, false);
        assert.ok(attempts.length > before);

        process.env.YTDLP_GLOBAL_EXTRACTION_BACKOFF_MAX_SECONDS = '-1';
        const invalidEnvApi = new fakes.ConvertAPI(null, null);
        for (let i = 0; i < 8; i += 1) {
            invalidEnvApi._recordGlobalExtractionFailure(`ENVFAIL${i}`, CLASSIFICATION.NO_FORMATS, 1000 + i);
        }
        assert.equal(invalidEnvApi.globalExtractionBackoff.backoffSeconds, 300);
    } finally {
        if (previousGlobalBackoffMax === undefined) {
            delete process.env.YTDLP_GLOBAL_EXTRACTION_BACKOFF_MAX_SECONDS;
        } else {
            process.env.YTDLP_GLOBAL_EXTRACTION_BACKOFF_MAX_SECONDS = previousGlobalBackoffMax;
        }
        capture.restore();
        fakes.cleanup();
    }
}

async function testOwnersAndRemovalCleanup() {
    const fakes = installConvertFakes();
    const capture = captureConsole();
    try {
        const api = new fakes.ConvertAPI(null, null);
        const keyA = api._getCompositeKey('SAMEVIDEO01', 'owner-a');
        const keyB = api._getCompositeKey('SAMEVIDEO01', 'owner-b');
        applyExtractionFailure(api._getExtractionState(keyA), CLASSIFICATION.NO_FORMATS, 1000);
        assert.equal(api._getExtractionState(keyA).consecutiveExtractionFailures, 1);
        assert.equal(api._getExtractionState(keyB).consecutiveExtractionFailures, 0);

        let stopped = false;
        api.activeMonitors.set(keyA, { stopMonitoring: () => { stopped = true; } });
        assert.equal(api.removeMonitor('SAMEVIDEO01', 'owner-a'), true);
        assert.equal(stopped, true);
        assert.equal(api.extractionBackoff.has(keyA), false);
        assert.equal(api.extractionBackoff.has(keyB), true);
    } finally {
        capture.restore();
        fakes.cleanup();
    }
}

async function testSchedulerRespectsBackoff() {
    const scheduler = new GlobalScheduler(1000, 1, null);
    let poolRuns = 0;
    let suppressedLogs = 0;
    let healthyRuns = 0;
    const now = Date.now();
    const monitor = {
        videoId: 'BACKOFFLIVE',
        owner: null,
        nextCheck: now - 1000,
        _running: false,
        _monitorStopped: false,
        _liveEnded: false,
        nextRetryAt: now + 90000,
        getExtractionBackoffDelayMs(currentNow) {
            return Math.max(0, this.nextRetryAt - currentNow);
        },
        logExtractionBackoffSuppressed() {
            suppressedLogs += 1;
            return true;
        },
        checkAndRenew() {
            throw new Error('should not run');
        }
    };
    const healthyMonitor = {
        videoId: 'HEALTHYLIVE',
        owner: null,
        nextCheck: now - 1000,
        _running: false,
        _monitorStopped: false,
        _liveEnded: false,
        liveState: 'online',
        intervalMs: 8000,
        getExtractionBackoffDelayMs() {
            return 0;
        },
        async checkAndRenew() {
            healthyRuns += 1;
        }
    };

    scheduler.pool.run = async (task) => {
        poolRuns += 1;
        await task();
    };
    scheduler.monitors.set('BACKOFFLIVE', monitor);
    scheduler.monitors.set('HEALTHYLIVE', healthyMonitor);
    await scheduler._tick();

    assert.equal(poolRuns, 1);
    assert.equal(healthyRuns, 1);
    assert.equal(suppressedLogs, 1);
    assert.ok(monitor.nextCheck >= now + 89000);
    assert.ok(healthyMonitor.nextCheck > now);
}

async function testForcedRenewStopsCurrentRound() {
    const LiveMonitor = require('../monitor/liveMonitor');
    const capture = captureConsole();
    try {
        const monitor = new LiveMonitor(
            'https://www.youtube.com/watch?v=FORCERENEW1',
            null,
            null,
            null,
            {
                getNextCookiePath: () => null,
                getFallbackCookiePath: () => null,
                isCookieAuthError: () => false,
                markFailure: () => false,
                markSuccess: () => true
            }
        );
        monitor.m3u8Url = `https://video.example.test/live/index.m3u8?expire=${Math.floor(Date.now() / 1000) + 60}`;
        let forceRenewCalls = 0;
        let metadataCalls = 0;
        monitor._forceRenew = async () => {
            forceRenewCalls += 1;
            applyExtractionFailure(monitor.extractionBackoff, CLASSIFICATION.NO_FORMATS, Date.now());
            monitor._syncExtractionBackoffFields();
            return false;
        };
        monitor.getLiveMetadata = async () => {
            metadataCalls += 1;
            return { success: true, metadata: hlsMetadata() };
        };

        await monitor.checkAndRenew();

        assert.equal(forceRenewCalls, 1);
        assert.equal(metadataCalls, 0);
        assert.equal(monitor.consecutiveExtractionFailures, 1);
    } finally {
        capture.restore();
    }
}

async function main() {
    testCookieAttemptOrder();
    testBackoffPolicy();
    testBackoffStateReset();
    await testConvertBackoffAndIsolation();
    await testAuthCookieStillMarksFailure();
    await testGlobalExtractionOutageBackoff();
    await testOwnersAndRemovalCleanup();
    await testSchedulerRespectsBackoff();
    await testForcedRenewStopsCurrentRound();
    console.log('Phase 3 extraction backoff tests OK');
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
