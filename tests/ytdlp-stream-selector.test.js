const assert = require('assert');

const {
    CLASSIFICATION,
    YOUTUBE_COOKIE_EXTRACTOR_ARGS,
    buildYtdlpArgsForSource,
    buildYtdlpDumpJsonArgs,
    classifyYtdlpError,
    getYtdlpDiagnostics,
    selectHlsStream,
    sanitizeYtdlpMessage,
    isGlobalExtractionOutagePattern
} = require('../services/ytdlpStreamSelector');

function hlsFormat(height, extra = {}) {
    return {
        format_id: `hls-${height}`,
        protocol: 'm3u8_native',
        ext: 'mp4',
        url: `https://video.example.test/hls/${height}/index`, // intentionally no .m3u8
        height,
        width: Math.round(height * 16 / 9),
        vcodec: 'avc1',
        acodec: 'mp4a',
        fps: 30,
        ...extra
    };
}

function testClassifications() {
    assert.equal(classifyYtdlpError('Sign in to confirm you are not a bot'), CLASSIFICATION.AUTH_COOKIE);
    assert.equal(classifyYtdlpError('No video formats found'), CLASSIFICATION.NO_FORMATS);
    assert.equal(classifyYtdlpError('This live event has ended'), CLASSIFICATION.LIVE_ENDED);
    assert.equal(classifyYtdlpError('This video is private'), CLASSIFICATION.VIDEO_PRIVATE);
    assert.equal(classifyYtdlpError('Video has been removed'), CLASSIFICATION.VIDEO_REMOVED);
    assert.equal(classifyYtdlpError('Video unavailable'), CLASSIFICATION.VIDEO_UNAVAILABLE);
    assert.equal(classifyYtdlpError('socket hang up ECONNRESET'), CLASSIFICATION.NETWORK);
    assert.equal(classifyYtdlpError('Timeout apos 90000ms'), CLASSIFICATION.TIMEOUT);
    assert.equal(classifyYtdlpError('HTTP Error 503: Service Unavailable'), CLASSIFICATION.SERVER_5XX);
    assert.equal(classifyYtdlpError('URL expired: HTTP Error 403 Forbidden'), CLASSIFICATION.EXPIRED_STREAM_URL);
    assert.notEqual(classifyYtdlpError('HTTP Error 403: Forbidden'), CLASSIFICATION.AUTH_COOKIE);
    assert.equal(classifyYtdlpError('ERROR: login required to confirm access'), CLASSIFICATION.AUTH_COOKIE);
    assert.equal(classifyYtdlpError('Unable to extract player response'), CLASSIFICATION.PLAYER_RESPONSE_INVALID);
}

function testHlsSelectionFromFormatsWithoutM3u8Extension() {
    const result = selectHlsStream({
        live_status: 'is_live',
        is_live: true,
        formats: [hlsFormat(360), hlsFormat(720)]
    });

    assert.equal(result.ok, true);
    assert.equal(result.type, 'artificial_master');
    assert.equal(result.selectedHeight, 720);
    assert.ok(result.url.includes('/720/'));
    assert.ok(result.masterContent.includes('#EXTM3U'));
    assert.ok(!result.urlPreview.includes('?'));
}

function testManifestUrlSelection() {
    const result = selectHlsStream({
        protocol: 'https',
        url: 'https://video.example.test/direct/file.mp4',
        manifest_url: 'https://video.example.test/manifest/hls_playlist/abc?sig=secret',
        formats: []
    });

    assert.equal(result.ok, true);
    assert.equal(result.type, 'manifest_url');
    assert.equal(result.url, 'https://video.example.test/manifest/hls_playlist/abc?sig=secret');
    assert.equal(result.urlPreview, 'https://video.example.test/manifest/hls_playlist/abc');
}

function testForcedMaxHeightPrefersVariantsOverManifestUrl() {
    const result = selectHlsStream({
        live_status: 'is_live',
        is_live: true,
        manifest_url: 'https://manifest.googlevideo.com/api/manifest/hls_variant/expire/1783885887/sig/secret/index.m3u8?token=secret',
        formats: [hlsFormat(144), hlsFormat(240), hlsFormat(360), hlsFormat(480), hlsFormat(720), hlsFormat(1080)]
    }, { maxHeight: 720, forceArtificial: true });

    assert.equal(result.ok, true);
    assert.equal(result.type, 'artificial_master');
    assert.equal(result.selectedHeight, 720);
    assert.ok(result.masterContent.includes('RESOLUTION=1280x720'));
    assert.ok(!result.masterContent.includes('RESOLUTION=1920x1080'));
    assert.ok(result.url.includes('/720/'));
    const firstVariantUrl = result.masterContent.split('\n')[2];
    assert.ok(firstVariantUrl.includes('/720/'));
}

function testSignedGooglevideoPreviewIsRedacted() {
    const result = selectHlsStream({
        protocol: 'm3u8_native',
        url: 'https://manifest.googlevideo.com/api/manifest/hls_variant/expire/1783885887/sig/secret/file/index.m3u8?token=secret',
        formats: []
    });

    assert.equal(result.ok, true);
    assert.equal(result.urlPreview, 'https://manifest.googlevideo.com/api/manifest/hls_variant/...');
    assert.ok(!result.urlPreview.includes('secret'));
    assert.ok(!result.urlPreview.includes('1783885887'));
}

function testYtdlpMessageSanitization() {
    const message = 'Authorization: Bearer secret-token failed at https://manifest.googlevideo.com/api/manifest/hls_variant/expire/1783885887/sig/secret/file/index.m3u8?token=secret';
    const sanitized = sanitizeYtdlpMessage(message);

    assert.ok(!sanitized.includes('secret-token'));
    assert.ok(!sanitized.includes('/sig/secret'));
    assert.ok(!sanitized.includes('token=secret'));
    assert.ok(!sanitized.includes('1783885887'));
    assert.ok(sanitized.includes('Authorization: Bearer [redacted]'));
    assert.ok(sanitized.includes('https://manifest.googlevideo.com/api/manifest/hls_variant/...'));
}

function testTopLevelProtocolSelection() {
    const result = selectHlsStream({
        protocol: 'm3u8',
        url: 'https://video.example.test/live/no-extension?sig=secret',
        formats: []
    });

    assert.equal(result.ok, true);
    assert.equal(result.type, 'top_level');
    assert.equal(result.urlPreview, 'https://video.example.test/live/no-extension');
}

function testDashOnlyAndNoFormats() {
    const dash = selectHlsStream({
        formats: [{
            protocol: 'dash',
            ext: 'mp4',
            url: 'https://video.example.test/dash/manifest.mpd',
            height: 720,
            vcodec: 'avc1'
        }]
    });
    assert.equal(dash.ok, false);
    assert.equal(dash.classification, CLASSIFICATION.DASH_ONLY);

    const noFormats = selectHlsStream({ formats: [] });
    assert.equal(noFormats.ok, false);
    assert.equal(noFormats.classification, CLASSIFICATION.NO_FORMATS);

    const endedLive = selectHlsStream({
        live_status: 'was_live',
        was_live: true,
        is_live: false,
        formats: [{ protocol: 'https', ext: 'mp4', url: 'https://video.example.test/file.mp4' }]
    });
    assert.equal(endedLive.ok, false);
    assert.equal(endedLive.classification, CLASSIFICATION.LIVE_ENDED);
}

function testMaxHeightFallbackAndDiagnostics() {
    const result = selectHlsStream({
        live_status: 'is_live',
        formats: [hlsFormat(720), hlsFormat(1080)]
    }, { maxHeight: 480, forceArtificial: true });

    assert.equal(result.ok, true);
    assert.equal(result.selectedHeight, 720);
    assert.equal(result.type, 'variant');

    const diagnostics = getYtdlpDiagnostics({
        live_status: 'is_live',
        formats: [hlsFormat(360), { protocol: 'dash', ext: 'mp4' }],
        requested_formats: [hlsFormat(240)]
    });
    assert.equal(diagnostics.formatCount, 2);
    assert.equal(diagnostics.requestedFormatsCount, 1);
    assert.equal(diagnostics.hasHls, true);
    assert.equal(diagnostics.hasDash, true);
    assert.ok(diagnostics.protocols.includes('dash'));
    assert.ok(diagnostics.protocols.includes('m3u8_native'));
}

function testGlobalExtractionOutagePattern() {
    assert.equal(isGlobalExtractionOutagePattern([
        { classification: CLASSIFICATION.NO_FORMATS },
        { classification: CLASSIFICATION.NO_FORMATS },
        { classification: CLASSIFICATION.INVALID_HLS }
    ], { classification: CLASSIFICATION.AUTH_COOKIE }), true);

    assert.equal(isGlobalExtractionOutagePattern([
        { classification: CLASSIFICATION.AUTH_COOKIE }
    ], { classification: CLASSIFICATION.AUTH_COOKIE }), false);

    assert.equal(isGlobalExtractionOutagePattern([
        { classification: CLASSIFICATION.NO_FORMATS }
    ], { classification: CLASSIFICATION.LIVE_ENDED }), false);
}

function testYtdlpArgsBuilder() {
    const spacedCookiePath = '/tmp/Cookie Dir/cookie 1.txt';
    const cookieArgs = buildYtdlpDumpJsonArgs({
        url: 'https://www.youtube.com/watch?v=COOKIEARG01',
        source: 'cookie',
        cookiePath: spacedCookiePath
    });
    assert.deepEqual(cookieArgs.slice(0, 4), [
        '--cookies',
        spacedCookiePath,
        '--extractor-args',
        YOUTUBE_COOKIE_EXTRACTOR_ARGS
    ]);
    assert.ok(cookieArgs.includes('--dump-json'));
    assert.ok(cookieArgs.includes('--skip-download'));
    assert.ok(cookieArgs.includes('--no-playlist'));

    const publicArgs = buildYtdlpDumpJsonArgs({
        url: 'https://www.youtube.com/watch?v=PUBLICARG01',
        source: 'public'
    });
    assert.equal(publicArgs.includes('--cookies'), false);
    assert.equal(publicArgs.includes('--extractor-args'), false);
    assert.equal(publicArgs.includes(YOUTUBE_COOKIE_EXTRACTOR_ARGS), false);

    const strippedPublicArgs = buildYtdlpArgsForSource(cookieArgs, { source: 'public' });
    assert.equal(strippedPublicArgs.includes('--cookies'), false);
    assert.equal(strippedPublicArgs.includes('--extractor-args'), false);
    assert.equal(strippedPublicArgs.includes(YOUTUBE_COOKIE_EXTRACTOR_ARGS), false);

    const rebuiltCookieArgs = buildYtdlpArgsForSource(cookieArgs, {
        source: 'cookie',
        cookiePath: '/tmp/cookie2.txt'
    });
    assert.equal(rebuiltCookieArgs.filter(arg => arg === '--extractor-args').length, 1);
    assert.equal(rebuiltCookieArgs[1], '/tmp/cookie2.txt');

    const replacedPlayerClient = buildYtdlpArgsForSource([
        '--cookies',
        '/tmp/cookie-old.txt',
        '--extractor-args',
        'youtube:player_client=tv',
        '--dump-json',
        'https://www.youtube.com/watch?v=REPLACE001'
    ], {
        source: 'cookie',
        cookiePath: '/tmp/cookie-new.txt'
    });
    assert.equal(replacedPlayerClient.filter(arg => arg === '--extractor-args').length, 1);
    assert.equal(replacedPlayerClient.includes('youtube:player_client=tv'), false);
    assert.equal(replacedPlayerClient.includes(YOUTUBE_COOKIE_EXTRACTOR_ARGS), true);
}

testClassifications();
testHlsSelectionFromFormatsWithoutM3u8Extension();
testManifestUrlSelection();
testForcedMaxHeightPrefersVariantsOverManifestUrl();
testSignedGooglevideoPreviewIsRedacted();
testYtdlpMessageSanitization();
testTopLevelProtocolSelection();
testDashOnlyAndNoFormats();
testMaxHeightFallbackAndDiagnostics();
testGlobalExtractionOutagePattern();
testYtdlpArgsBuilder();

console.log('yt-dlp stream selector tests OK');
