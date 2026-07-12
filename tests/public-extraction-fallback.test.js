const assert = require('assert');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');

const {
    CLASSIFICATION,
    classifyYtdlpError,
    shouldAttemptPublicFallback
} = require('../services/ytdlpStreamSelector');

function hlsMetadata(height = 720) {
    return {
        live_status: 'is_live',
        is_live: true,
        formats: [{
            format_id: `hls-${height}`,
            protocol: 'm3u8_native',
            ext: 'mp4',
            url: `https://manifest.googlevideo.com/api/manifest/hls_variant/expire/1783885887/sig/secret/${height}/index.m3u8?token=secret`,
            height,
            width: Math.round(height * 16 / 9),
            vcodec: 'avc1',
            acodec: 'mp4a',
            fps: 30
        }]
    };
}

function cookieFromArgs(args) {
    const index = args.indexOf('--cookies');
    return index === -1 ? null : path.basename(args[index + 1]);
}

function captureConsole() {
    const original = { log: console.log, warn: console.warn, error: console.error };
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

function installConvertFakes(selectedCookie = 'cookie2.txt') {
    const calls = [];

    class FakeCookieRotator {
        constructor() {
            this.nextCookie = selectedCookie;
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
            calls.push({ op: 'failure', file, message: String(message || ''), videoId });
            return true;
        }

        markSuccess(file) {
            calls.push({ op: 'success', file });
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
        calls,
        cleanup() {
            fs.existsSync = originalExistsSync;
            LiveMonitor.prototype.startMonitoring = originalStartMonitoring;
        }
    };
}

async function testPolicy() {
    assert.equal(shouldAttemptPublicFallback([
        { classification: CLASSIFICATION.NO_FORMATS },
        { classification: CLASSIFICATION.INVALID_HLS }
    ]), true);
    assert.equal(shouldAttemptPublicFallback([
        { classification: CLASSIFICATION.AUTH_COOKIE }
    ]), false);
    assert.equal(shouldAttemptPublicFallback([
        { classification: CLASSIFICATION.AUTH_COOKIE },
        { classification: CLASSIFICATION.NO_FORMATS }
    ]), true);
    assert.equal(shouldAttemptPublicFallback([
        { classification: CLASSIFICATION.NO_FORMATS },
        { classification: CLASSIFICATION.VIDEO_PRIVATE }
    ]), false);
    assert.equal(classifyYtdlpError('Sign in to confirm your age'), CLASSIFICATION.AGE_RESTRICTED);
    assert.equal(classifyYtdlpError('members-only content'), CLASSIFICATION.MEMBERS_ONLY);
    assert.equal(classifyYtdlpError('not available in your country'), CLASSIFICATION.GEO_RESTRICTED);
}

async function testConvertPublicFallbackSuccess() {
    const fakes = installConvertFakes('cookie2.txt');
    const capture = captureConsole();
    try {
        const api = new fakes.ConvertAPI(null, null);
        api._getVideoMetadata = async () => ({ title: 'Public live', channel: 'Test' });
        api._persistMapping = () => {};

        const attempts = [];
        api._runYtdlp = async (args) => {
            const cookie = cookieFromArgs(args);
            attempts.push(cookie || 'public');
            if (cookie) {
                throw new Error('No video formats found at https://manifest.googlevideo.com/api/manifest/hls_variant/expire/1783885887/sig/secret/file/index.m3u8?token=secret Authorization: Bearer secret-token');
            }
            return JSON.stringify(hlsMetadata(720));
        };

        const result = await api.convert('https://www.youtube.com/watch?v=PUBLICOK001', 'http://127.0.0.1', 'owner-a');
        assert.equal(result.success, true);
        assert.equal(result.extractionSource, 'public');
        assert.deepEqual(attempts, ['cookie2.txt', 'cookie1.txt', 'cookie3.txt', 'public']);
        assert.equal(fakes.calls.filter(call => call.op === 'success').length, 0);
        assert.equal(fakes.calls.filter(call => call.op === 'failure').length, 0);

        const key = api._getCompositeKey('PUBLICOK001', 'owner-a');
        const monitor = api.activeMonitors.get(key);
        assert.ok(monitor);
        assert.equal(monitor.lastSuccessfulCookie, null);
        assert.equal(monitor.lastSuccessfulExtractionSource, 'public');
        assert.ok(monitor.lastExtractionSuccessAt);
        assert.ok(monitor.m3u8Url);
        assert.equal(api._getExtractionState(key).consecutiveExtractionFailures, 0);
        assert.equal(api._getExtractionState(key).lastSuccessfulExtractionSource, 'public');

        const logs = capture.lines.join('\n');
        assert.ok(logs.includes('tentando extracao publica sem cookie'));
        assert.ok(logs.includes('sucesso publico: HLS'));
        assert.ok(!logs.includes('token=secret'));
        assert.ok(!logs.includes('/sig/secret'));
        assert.ok(!logs.includes('secret-token'));
        assert.ok(!logs.includes('/var/www'));
        assert.ok(!logs.includes('C:\\Users'));
    } finally {
        capture.restore();
        fakes.cleanup();
    }
}

async function testConvertCookieSuccessDoesNotUsePublicFallback() {
    const fakes = installConvertFakes('cookie1.txt');
    const capture = captureConsole();
    try {
        const api = new fakes.ConvertAPI(null, null);
        api._getVideoMetadata = async () => ({ title: 'Cookie live', channel: 'Test' });
        api._persistMapping = () => {};

        const attempts = [];
        api._runYtdlp = async (args) => {
            attempts.push(cookieFromArgs(args) || 'public');
            return JSON.stringify(hlsMetadata(480));
        };

        const result = await api.convert('https://www.youtube.com/watch?v=COOKIEOK01A', 'http://127.0.0.1', 'owner-a');
        assert.equal(result.success, true);
        assert.equal(result.extractionSource, 'cookie1');
        assert.deepEqual(attempts, ['cookie1.txt']);
        assert.deepEqual(fakes.calls.filter(call => call.op === 'success').map(call => call.file), ['cookie1.txt']);
    } finally {
        capture.restore();
        fakes.cleanup();
    }
}

async function testConvertAllPathsFailBackoff() {
    const fakes = installConvertFakes('cookie1.txt');
    const capture = captureConsole();
    try {
        const api = new fakes.ConvertAPI(null, null);
        api._getVideoMetadata = async () => ({ title: 'Broken live', channel: 'Test' });
        api._persistMapping = () => {};

        const attempts = [];
        api._runYtdlp = async (args) => {
            attempts.push(cookieFromArgs(args) || 'public');
            throw new Error('No video formats found');
        };

        const result = await api.convert('https://www.youtube.com/watch?v=PUBLICBAD01', 'http://127.0.0.1', 'owner-a');
        assert.equal(result.success, false);
        assert.equal(result.classification, CLASSIFICATION.NO_FORMATS);
        assert.equal(result.publicFallback.classification, CLASSIFICATION.NO_FORMATS);
        assert.deepEqual(attempts, ['cookie1.txt', 'cookie2.txt', 'cookie3.txt', 'public']);
        assert.equal(fakes.calls.length, 0);

        const state = api._getExtractionState(api._getCompositeKey('PUBLICBAD01', 'owner-a'));
        assert.equal(state.consecutiveExtractionFailures, 1);
        assert.equal(state.backoffSeconds, 30);
    } finally {
        capture.restore();
        fakes.cleanup();
    }
}

async function testAuthOnlyDoesNotUsePublicFallback() {
    const fakes = installConvertFakes('cookie1.txt');
    const capture = captureConsole();
    try {
        const api = new fakes.ConvertAPI(null, null);
        api._getVideoMetadata = async () => ({ title: 'Private live', channel: 'Test' });
        api._persistMapping = () => {};

        const attempts = [];
        api._runYtdlp = async (args) => {
            attempts.push(cookieFromArgs(args) || 'public');
            throw new Error('Sign in to confirm you are not a bot');
        };

        const result = await api.convert('https://www.youtube.com/watch?v=AUTHONLY01A', 'http://127.0.0.1', 'owner-a');
        assert.equal(result.success, false);
        assert.equal(result.classification, CLASSIFICATION.AUTH_COOKIE);
        assert.deepEqual(attempts, ['cookie1.txt', 'cookie2.txt', 'cookie3.txt']);
        assert.equal(fakes.calls.filter(call => call.op === 'failure').length, 3);
        assert.equal(api._getExtractionState(api._getCompositeKey('AUTHONLY01A', 'owner-a')).nextRetryAt, 0);
    } finally {
        capture.restore();
        fakes.cleanup();
    }
}

async function testPrivateDoesNotUsePublicFallback() {
    const fakes = installConvertFakes('cookie1.txt');
    const capture = captureConsole();
    try {
        const api = new fakes.ConvertAPI(null, null);
        api._getVideoMetadata = async () => ({ title: 'Private live', channel: 'Test' });
        api._persistMapping = () => {};

        const attempts = [];
        api._runYtdlp = async (args) => {
            attempts.push(cookieFromArgs(args) || 'public');
            throw new Error('This video is private');
        };

        const result = await api.convert('https://www.youtube.com/watch?v=PRIVATE001A', 'http://127.0.0.1', 'owner-a');
        assert.equal(result.success, false);
        assert.equal(result.classification, CLASSIFICATION.VIDEO_PRIVATE);
        assert.deepEqual(attempts, ['cookie1.txt', 'cookie2.txt', 'cookie3.txt']);
        assert.equal(fakes.calls.length, 0);
    } finally {
        capture.restore();
        fakes.cleanup();
    }
}

async function testMixedAuthAndExtractionCanUsePublicFallback() {
    const fakes = installConvertFakes('cookie1.txt');
    const capture = captureConsole();
    try {
        const api = new fakes.ConvertAPI(null, null);
        api._getVideoMetadata = async () => ({ title: 'Mixed live', channel: 'Test' });
        api._persistMapping = () => {};

        const attempts = [];
        api._runYtdlp = async (args) => {
            const cookie = cookieFromArgs(args);
            attempts.push(cookie || 'public');
            if (cookie === 'cookie1.txt') throw new Error('Sign in to confirm you are not a bot');
            if (cookie) throw new Error('No video formats found');
            return JSON.stringify(hlsMetadata(360));
        };

        const result = await api.convert('https://www.youtube.com/watch?v=MIXEDPUB01A', 'http://127.0.0.1', 'owner-a');
        assert.equal(result.success, true);
        assert.equal(result.extractionSource, 'public');
        assert.deepEqual(attempts, ['cookie1.txt', 'cookie2.txt', 'cookie3.txt', 'public']);
        assert.equal(fakes.calls.filter(call => call.op === 'failure').length, 1);
        assert.equal(fakes.calls.filter(call => call.op === 'success').length, 0);
    } finally {
        capture.restore();
        fakes.cleanup();
    }
}

async function testTwoLivesPublicFallbackAreIsolated() {
    const fakes = installConvertFakes('cookie1.txt');
    const capture = captureConsole();
    try {
        const api = new fakes.ConvertAPI(null, null);
        api._getVideoMetadata = async () => ({ title: 'Public live', channel: 'Test' });
        api._persistMapping = () => {};

        api._runYtdlp = async (args) => {
            const cookie = cookieFromArgs(args);
            if (cookie) throw new Error('No video formats found');
            return JSON.stringify(hlsMetadata(720));
        };

        const first = await api.convert('https://www.youtube.com/watch?v=ISOLATED001', 'http://127.0.0.1', 'owner-a');
        const second = await api.convert('https://www.youtube.com/watch?v=ISOLATED002', 'http://127.0.0.1', 'owner-b');

        assert.equal(first.success, true);
        assert.equal(second.success, true);
        assert.equal(first.extractionSource, 'public');
        assert.equal(second.extractionSource, 'public');
        assert.notEqual(api._getCompositeKey('ISOLATED001', 'owner-a'), api._getCompositeKey('ISOLATED002', 'owner-b'));
        assert.equal(api._getExtractionState(api._getCompositeKey('ISOLATED001', 'owner-a')).lastSuccessfulExtractionSource, 'public');
        assert.equal(api._getExtractionState(api._getCompositeKey('ISOLATED002', 'owner-b')).lastSuccessfulExtractionSource, 'public');
        assert.equal(api._getExtractionState(api._getCompositeKey('ISOLATED001', 'owner-a')).consecutiveExtractionFailures, 0);
        assert.equal(api._getExtractionState(api._getCompositeKey('ISOLATED002', 'owner-b')).consecutiveExtractionFailures, 0);
    } finally {
        capture.restore();
        fakes.cleanup();
    }
}

function installFakeSpawn(resolver) {
    const childProcess = require('child_process');
    const originalSpawn = childProcess.spawn;
    const calls = [];

    childProcess.spawn = (cmd, args) => {
        calls.push(args.slice());
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.killed = false;
        child.kill = () => {
            child.killed = true;
        };
        process.nextTick(() => {
            const result = resolver(args);
            if (result.stdout) child.stdout.emit('data', result.stdout);
            if (result.stderr) child.stderr.emit('data', result.stderr);
            child.emit('close', result.code);
        });
        return child;
    };

    return {
        calls,
        restore() {
            childProcess.spawn = originalSpawn;
        }
    };
}

async function testLiveMonitorPublicFallbackCreatesStream() {
    const capture = captureConsole();
    const originalExistsSync = fs.existsSync;
    fs.existsSync = function existsSyncStub(target) {
        if (/[\\/]cookies[\\/]cookie[123]\.txt$/i.test(String(target || ''))) return true;
        return originalExistsSync.apply(this, arguments);
    };

    const fakeSpawn = installFakeSpawn((args) => {
        if (args.includes('--cookies')) {
            return { code: 1, stderr: 'ERROR: No video formats found' };
        }
        return { code: 0, stdout: JSON.stringify(hlsMetadata(720)) };
    });

    try {
        delete require.cache[require.resolve('../monitor/liveMonitor')];
        const LiveMonitor = require('../monitor/liveMonitor');
        const calls = [];
        const monitor = new LiveMonitor(
            'https://www.youtube.com/watch?v=MONITORPUB1',
            null,
            null,
            null,
            {
                getNextCookiePath: () => path.join(process.cwd(), 'cookies', 'cookie1.txt'),
                getFallbackCookiePath: () => null,
                isCookieAuthError: () => false,
                markFailure: (file) => {
                    calls.push({ op: 'failure', file });
                    return true;
                },
                markSuccess: (file) => {
                    calls.push({ op: 'success', file });
                    return true;
                }
            }
        );
        monitor.checkPlaylistProgress = async () => true;

        await monitor.checkAndRenew();

        const attemptCookies = fakeSpawn.calls.map(cookieFromArgs);
        assert.deepEqual(attemptCookies, ['cookie1.txt', 'cookie2.txt', 'cookie3.txt', null]);
        assert.equal(calls.length, 0);
        assert.equal(monitor.lastSuccessfulCookie, null);
        assert.equal(monitor.lastSuccessfulExtractionSource, 'public');
        assert.equal(monitor.consecutiveExtractionFailures, 0);
        assert.ok(monitor.m3u8Url);
        assert.equal(monitor.liveState, 'online');
    } finally {
        capture.restore();
        fakeSpawn.restore();
        fs.existsSync = originalExistsSync;
        delete require.cache[require.resolve('../monitor/liveMonitor')];
    }
}

async function main() {
    await testPolicy();
    await testConvertPublicFallbackSuccess();
    await testConvertCookieSuccessDoesNotUsePublicFallback();
    await testConvertAllPathsFailBackoff();
    await testAuthOnlyDoesNotUsePublicFallback();
    await testPrivateDoesNotUsePublicFallback();
    await testMixedAuthAndExtractionCanUsePublicFallback();
    await testTwoLivesPublicFallbackAreIsolated();
    await testLiveMonitorPublicFallbackCreatesStream();
    console.log('Public extraction fallback tests OK');
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
