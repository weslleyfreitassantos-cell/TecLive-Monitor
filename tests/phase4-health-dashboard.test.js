const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
    buildMonitorHealth,
    buildSystemHealth,
    getMonitorDisplayStatus
} = require('../services/healthSnapshot');

function healthyLegacyHealth() {
    return {
        network: { status: 'ok', message: 'ok' },
        metadata: { status: 'ok', message: 'ok' },
        playlist: { status: 'ok', message: 'ok' },
        cookies: { status: 'ok', message: 'ok' }
    };
}

function fakeMonitor(overrides = {}) {
    const now = Date.now();
    return {
        liveState: 'online',
        isLive: true,
        m3u8Url: 'https://video.example.test/live/index.m3u8',
        _playlistUrls: { 720: 'https://video.example.test/live/720.m3u8' },
        _masterContent: null,
        lastMediaSequence: 12,
        stalledCount: 0,
        health: healthyLegacyHealth(),
        lastSuccessfulCookie: 'cookie1.txt',
        lastExtractionSuccessAt: now - 1000,
        getExtractionBackoffDelayMs: () => 0,
        ...overrides
    };
}

function cookieStatus(valid = true) {
    return {
        cookie1: { valid, state: valid ? 'valid' : 'invalid', alertActive: !valid },
        cookie2: { valid, state: valid ? 'valid' : 'invalid', alertActive: !valid },
        cookie3: { valid, state: valid ? 'valid' : 'invalid', alertActive: !valid }
    };
}

function invalidCookieStatus() {
    return {
        cookie1: { valid: false, state: 'invalid', alertActive: true },
        cookie2: { valid: false, state: 'invalid', alertActive: true },
        cookie3: { valid: false, state: 'invalid', alertActive: true }
    };
}

function agentStatus(status = 'online') {
    return {
        enabled: true,
        agent: {
            status,
            online: status === 'online',
            lastHeartbeatAt: new Date().toISOString()
        }
    };
}

function testExtractionBackoffDegradesDashboardStatus() {
    const now = Date.now();
    const monitor = fakeMonitor({
        nextRetryAt: now + 60000,
        backoffSeconds: 60,
        consecutiveExtractionFailures: 2,
        lastFailureClassification: 'no_formats',
        getExtractionBackoffDelayMs: () => 60000
    });
    const health = buildMonitorHealth(monitor, { nowMs: now });

    assert.equal(health.status, 'degraded');
    assert.equal(health.components.cookies.status, 'ok');
    assert.equal(health.components.extraction.status, 'warning');
    assert.equal(health.components.extraction.retryAfterSeconds, 60);
    assert.equal(getMonitorDisplayStatus(monitor, health), 'degraded');
    assert.ok(health.score < 100);
}

function testNoLiveIsOkWhenNoPendingExtraction() {
    const system = buildSystemHealth({
        converter: { activeMonitors: new Map(), extractionBackoff: new Map() },
        cookieFunctionalStatus: cookieStatus(true),
        cookieRefreshStatus: agentStatus('online'),
        auth: { sessionAdmin: true, adminPasswordConfigured: true },
        nowMs: 1000
    });

    assert.equal(system.status, 'ok');
    assert.equal(system.components.extraction.status, 'ok');
    assert.equal(system.components.manifest.status, 'ok');
    assert.equal(system.components.stream.status, 'ok');
    assert.equal(system.summary.activeMonitors, 0);
}

function testHealthyLiveIsOk() {
    const system = buildSystemHealth({
        converter: { activeMonitors: new Map([['HEALTHYLIVE:owner', fakeMonitor()]]) },
        cookieFunctionalStatus: cookieStatus(true),
        cookieRefreshStatus: agentStatus('online'),
        auth: { sessionAdmin: true, adminPasswordConfigured: true },
        nowMs: 1000
    });

    assert.equal(system.status, 'ok');
    assert.equal(system.components.cookies.status, 'ok');
    assert.equal(system.components.extraction.status, 'ok');
    assert.equal(system.components.manifest.status, 'ok');
    assert.equal(system.components.stream.status, 'ok');
}

function testSystemHealthSeparatesCookiesAndExtraction() {
    const now = Date.now();
    const converter = {
        activeMonitors: new Map([
            ['BACKOFFLIVE:owner-a', fakeMonitor({
                videoId: 'BACKOFFLIVE',
                owner: 'owner-a',
                nextRetryAt: now + 30000,
                lastFailureClassification: 'no_formats',
                getExtractionBackoffDelayMs: () => 30000
            })],
            ['HEALTHYLIVE:owner-b', fakeMonitor({
                videoId: 'HEALTHYLIVE',
                owner: 'owner-b'
            })]
        ])
    };

    const system = buildSystemHealth({
        converter,
        cookieFunctionalStatus: cookieStatus(true),
        cookieRefreshStatus: agentStatus('online'),
        auth: { sessionAdmin: true, adminPasswordConfigured: true },
        nowMs: now
    });

    assert.equal(system.status, 'degraded');
    assert.equal(system.components.authentication.status, 'ok');
    assert.equal(system.components.cookies.status, 'ok');
    assert.equal(system.components.extraction.status, 'warning');
    assert.equal(system.components.extraction.affected, 1);
    assert.equal(system.components.manifest.status, 'ok');
    assert.equal(system.components.stream.status, 'ok');
    assert.equal(system.components.agent.status, 'ok');
    assert.equal(system.summary.activeMonitors, 2);
    assert.equal(system.summary.degradedMonitors, 1);
    assert.equal(system.summary.backoffMonitors, 1);
}

function testPersistentExtractionAndMissingStreamIsError() {
    const monitor = fakeMonitor({
        m3u8Url: null,
        _playlistUrls: {},
        lastFailureClassification: 'no_formats',
        consecutiveExtractionFailures: 5,
        getExtractionBackoffDelayMs: () => 0
    });
    const system = buildSystemHealth({
        converter: { activeMonitors: new Map([['BROKENLIVE:owner', monitor]]) },
        cookieFunctionalStatus: cookieStatus(true),
        cookieRefreshStatus: agentStatus('online'),
        auth: { sessionAdmin: true, adminPasswordConfigured: true },
        nowMs: 1000
    });

    assert.equal(system.status, 'error');
    assert.equal(system.components.cookies.status, 'ok');
    assert.equal(system.components.extraction.status, 'error');
    assert.equal(system.components.stream.status, 'warning');
}

function testHealthyAndBrokenLiveIsError() {
    const system = buildSystemHealth({
        converter: {
            activeMonitors: new Map([
                ['HEALTHY:owner-a', fakeMonitor()],
                ['BROKEN:owner-b', fakeMonitor({
                    m3u8Url: null,
                    _playlistUrls: {},
                    lastFailureClassification: 'no_formats',
                    consecutiveExtractionFailures: 5,
                    getExtractionBackoffDelayMs: () => 0
                })]
            ])
        },
        cookieFunctionalStatus: cookieStatus(true),
        cookieRefreshStatus: agentStatus('online'),
        auth: { sessionAdmin: true, adminPasswordConfigured: true },
        nowMs: 1000
    });

    assert.equal(system.status, 'error');
    assert.equal(system.summary.activeMonitors, 2);
    assert.equal(system.summary.degradedMonitors, 1);
}

function testValidCookiesWithoutStreamIsNotOk() {
    const system = buildSystemHealth({
        converter: {
            activeMonitors: new Map([
                ['NOSTREAM:owner', fakeMonitor({ m3u8Url: null, _playlistUrls: {} })]
            ])
        },
        cookieFunctionalStatus: cookieStatus(true),
        cookieRefreshStatus: agentStatus('online'),
        auth: { sessionAdmin: true, adminPasswordConfigured: true },
        nowMs: 1000
    });

    assert.equal(system.status, 'degraded');
    assert.equal(system.components.cookies.status, 'ok');
    assert.notEqual(system.components.stream.status, 'ok');
}

function testAuthCookieAffectsAuthenticationAndCookies() {
    const monitor = fakeMonitor({
        health: {
            ...healthyLegacyHealth(),
            cookies: { status: 'error', message: 'Cookie inválido', failCount: 1 }
        }
    });
    const system = buildSystemHealth({
        converter: { activeMonitors: new Map([['AUTHFAIL:owner', monitor]]) },
        cookieFunctionalStatus: cookieStatus(true),
        cookieRefreshStatus: agentStatus('online'),
        auth: { sessionAdmin: true, adminPasswordConfigured: true },
        nowMs: 1000
    });

    assert.equal(system.components.authentication.status, 'error');
    assert.equal(system.components.cookies.status, 'error');
}

function testAgentOfflineIsSeparateError() {
    const system = buildSystemHealth({
        converter: { activeMonitors: new Map([['HEALTHY:owner', fakeMonitor()]]) },
        cookieFunctionalStatus: cookieStatus(true),
        cookieRefreshStatus: agentStatus('offline'),
        auth: { sessionAdmin: true, adminPasswordConfigured: true },
        nowMs: 1000
    });

    assert.equal(system.components.agent.status, 'error');
    assert.equal(system.components.stream.status, 'ok');
    assert.equal(system.status, 'error');
}

function testCriticalCookiesDoNotHideOtherComponents() {
    const system = buildSystemHealth({
        converter: { activeMonitors: new Map([['LIVE:owner', fakeMonitor()]]) },
        cookieFunctionalStatus: invalidCookieStatus(),
        cookieRefreshStatus: agentStatus('degraded'),
        auth: { sessionAdmin: true, adminPasswordConfigured: true }
    });

    assert.equal(system.status, 'critical');
    assert.equal(system.components.cookies.status, 'critical');
    assert.equal(system.components.extraction.status, 'ok');
    assert.equal(system.components.agent.status, 'warning');
}

function testAuthenticatedCookiesWithDegradedStreamAreWarning() {
    const degraded = {
        cookie1: { valid: true, authReady: true, authValid: true, streamReady: false, extractionValid: false, streamValid: false, capabilityStatus: 'degraded' },
        cookie2: { valid: true, authReady: true, authValid: true, streamReady: false, extractionValid: false, streamValid: false, capabilityStatus: 'degraded' },
        cookie3: { valid: true, authReady: true, authValid: true, streamReady: false, extractionValid: false, streamValid: false, capabilityStatus: 'degraded' }
    };
    const system = buildSystemHealth({
        converter: { activeMonitors: new Map([['PUBLICOK:owner', fakeMonitor({ lastSuccessfulExtractionSource: 'public' })]]) },
        cookieFunctionalStatus: degraded,
        cookieRefreshStatus: agentStatus('online'),
        auth: { sessionAdmin: true, adminPasswordConfigured: true },
        nowMs: 1000
    });

    assert.equal(system.status, 'degraded');
    assert.equal(system.components.cookies.status, 'warning');
    assert.equal(system.components.cookies.functional.authValid, 3);
    assert.equal(system.components.cookies.functional.streamReady, 0);
    assert.ok(system.components.cookies.message.includes('stream autenticado'));
    assert.equal(system.components.stream.status, 'ok');
}

function testTerminalAvailabilityDoesNotPolluteGlobalHealth() {
    const now = Date.now();
    const system = buildSystemHealth({
        converter: {
            activeMonitors: new Map([
                ['ENDED:owner', fakeMonitor({ liveState: 'ended', _liveEnded: true })]
            ]),
            extractionBackoff: new Map([
                ['ENDED:owner', {
                    consecutiveExtractionFailures: 1,
                    lastFailureClassification: 'live_ended',
                    nextRetryAt: now + 600000,
                    backoffSeconds: 600
                }],
                ['UNAVAILABLE:owner', {
                    consecutiveExtractionFailures: 1,
                    lastFailureClassification: 'video_unavailable',
                    nextRetryAt: now + 600000,
                    backoffSeconds: 600
                }]
            ])
        },
        cookieFunctionalStatus: cookieStatus(true),
        cookieRefreshStatus: agentStatus('online'),
        auth: { sessionAdmin: true, adminPasswordConfigured: true },
        nowMs: now
    });

    assert.equal(system.status, 'ok');
    assert.equal(system.components.extraction.status, 'ok');
    assert.equal(system.summary.activeMonitors, 0);
    assert.equal(system.summary.pendingExtractions, 0);
}

function testConversionBackoffWithoutActiveMonitorAffectsSystemHealth() {
    const now = Date.now();
    const converter = {
        activeMonitors: new Map(),
        extractionBackoff: new Map([
            ['PENDINGLIVE:owner-a', {
                consecutiveExtractionFailures: 3,
                lastFailureClassification: 'no_formats',
                nextRetryAt: now + 120000,
                backoffSeconds: 120
            }]
        ])
    };

    const system = buildSystemHealth({
        converter,
        cookieFunctionalStatus: cookieStatus(true),
        cookieRefreshStatus: agentStatus('online'),
        auth: { sessionAdmin: true, adminPasswordConfigured: true },
        nowMs: now
    });

    assert.equal(system.status, 'degraded');
    assert.equal(system.summary.activeMonitors, 0);
    assert.equal(system.summary.pendingExtractions, 1);
    assert.equal(system.summary.backoffMonitors, 1);
    assert.equal(system.components.extraction.status, 'warning');
    assert.equal(system.components.cookies.status, 'ok');
}

function testGlobalExtractionCriticalAffectsSystemHealth() {
    const now = Date.now();
    const converter = {
        activeMonitors: new Map(),
        extractionBackoff: new Map(),
        globalExtractionCritical: true,
        globalExtractionBackoff: {
            consecutiveExtractionFailures: 2,
            lastFailureClassification: 'no_formats',
            nextRetryAt: now + 120000,
            backoffSeconds: 120,
            lastAutomaticCookieRefreshQueuedAt: now - 5000,
            automaticCookieRefreshReason: 'extracao global critica: no_formats'
        }
    };

    const system = buildSystemHealth({
        converter,
        cookieFunctionalStatus: cookieStatus(true),
        cookieRefreshStatus: agentStatus('online'),
        auth: { sessionAdmin: true, adminPasswordConfigured: true },
        nowMs: now
    });

    assert.equal(system.status, 'critical');
    assert.equal(system.summary.activeMonitors, 0);
    assert.equal(system.components.extraction.status, 'critical');
    assert.equal(system.components.extraction.actionCode, 'automatic_cookie_refresh_queued');
    assert.ok(system.components.extraction.recommendedAction.includes('Renovacao automatica'));
    assert.equal(system.components.extraction.automaticCookieRefreshReason, undefined);
    assert.ok(system.components.extraction.examples.some(item => item.includes('global')));
}

function testInvalidTimestampsAndMissingFieldsAreSafe() {
    assert.doesNotThrow(() => buildSystemHealth({
        converter: {
            activeMonitors: new Map([
                ['MISSING:owner', {
                    liveState: 'online',
                    nextRetryAt: 'not-a-date',
                    lastFailureClassification: 'https://example.test/path?token=secret'
                }]
            ])
        },
        cookieFunctionalStatus: {},
        cookieRefreshStatus: {},
        auth: { sessionAdmin: true, adminPasswordConfigured: true },
        nowMs: 'invalid'
    }));

    const health = buildMonitorHealth({
        liveState: 'online',
        nextRetryAt: 'bad',
        lastFailureClassification: 'https://example.test/path?token=secret'
    }, { nowMs: 'bad' });
    assert.equal(health.lastFailureClassification, 'unknown');
    assert.ok(JSON.stringify(health).includes('token=secret') === false);
}

function testPublicHealthRouteDoesNotExposeSensitiveOperationalDetails() {
    const appSource = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
    assert.ok(appSource.includes("status: 'ok'"));
    assert.ok(appSource.includes('operationalStatus: snapshot.status'));
    assert.ok(!appSource.includes('operational: publicHealthView'));
    assert.ok(!appSource.includes('components,\\n        summary'));
}

function testAdminHealthRouteRequiresAdminSession() {
    const appSource = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
    assert.ok(appSource.includes("app.get('/api/admin/health', isAdminApiAuthenticated"));
    assert.ok(appSource.includes("error: 'admin_session_expired'"));
    assert.ok(!appSource.includes("app.use('/api/admin/health', authenticateCookieAgent"));
}

function testTerminalRestoreCleanupIsPresent() {
    const appSource = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
    assert.ok(appSource.includes('function isTerminalRestoreClassification'));
    assert.ok(appSource.includes('isTerminalRestoreClassification(result?.classification)'));
    assert.ok(appSource.includes('removePersistedMapping(restoreVideoId, owner)'));
    assert.ok(appSource.includes('converter.clearExtractionBackoff(restoreVideoId, owner)'));
}

function testDashboardUsesOperationalHealth() {
    const html = fs.readFileSync(path.join(__dirname, '../public/dashboard.html'), 'utf8');
    const appSource = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
    assert.ok(html.includes('/api/admin/health'));
    assert.ok(!html.includes('OPERACIONAL'));
    assert.ok(html.includes('authentication'));
    assert.ok(html.includes('extraction'));
    assert.ok(html.includes('manifest'));
    assert.ok(html.includes('agent'));
    assert.ok(html.includes('healthSummary || m.health'));
    assert.ok(html.includes('renderHealthChips'));
    assert.ok(html.includes('getHealthCssStatus'));
    assert.ok(html.includes('health-component-action'));
    assert.ok(html.includes('recommendedAction'));
    assert.ok(html.includes('stream-warning'));
    assert.ok(html.includes('capabilityStatus'));
    assert.ok(html.includes('EXTRAÇÃO VIA COOKIE'));
    assert.ok(html.includes('Arquivo/sync'));
    assert.ok(html.includes('Stream via cookie'));
    assert.ok(html.includes('fallbackPublic'));
    assert.ok(appSource.includes('fallbackPublic'));
    assert.ok(html.includes('manual-upload-progress'));
    assert.ok(html.includes('getCookieJobProgress'));
    assert.ok(!html.includes('<h2>ATIVIDADE</h2>'));
    assert.ok(html.includes('Log do servidor'));
    assert.ok(html.includes('/api/admin/logs/timeline'));
    assert.ok(html.includes('serverLogContent'));
    assert.ok(appSource.includes("app.get('/api/admin/logs/timeline', isAdminApiAuthenticated"));
    assert.ok(appSource.includes('sanitizeServerLogLine'));
    assert.ok(appSource.includes('sanitizeYtdlpArgsForLog'));
    assert.ok(!appSource.includes('runYtdlp args: ${finalArgs.join'));
    assert.ok(appSource.includes('getGlobalExtractionRetryAfterSeconds'));
    assert.ok(appSource.includes('stream_extraction_unavailable'));
    assert.equal((html.match(/setInterval\(fetchData/g) || []).length, 1);
    assert.equal((html.match(/fetchAdminJson\('\/api\/admin\/health'/g) || []).length, 1);
    assert.ok(!html.includes('onclick="openClientDetailModal'));
    assert.ok(!html.includes('onclick="event.stopPropagation(); openModal'));
}

function main() {
    testNoLiveIsOkWhenNoPendingExtraction();
    testHealthyLiveIsOk();
    testExtractionBackoffDegradesDashboardStatus();
    testSystemHealthSeparatesCookiesAndExtraction();
    testPersistentExtractionAndMissingStreamIsError();
    testHealthyAndBrokenLiveIsError();
    testValidCookiesWithoutStreamIsNotOk();
    testAuthCookieAffectsAuthenticationAndCookies();
    testAgentOfflineIsSeparateError();
    testCriticalCookiesDoNotHideOtherComponents();
    testAuthenticatedCookiesWithDegradedStreamAreWarning();
    testTerminalAvailabilityDoesNotPolluteGlobalHealth();
    testConversionBackoffWithoutActiveMonitorAffectsSystemHealth();
    testGlobalExtractionCriticalAffectsSystemHealth();
    testInvalidTimestampsAndMissingFieldsAreSafe();
    testPublicHealthRouteDoesNotExposeSensitiveOperationalDetails();
    testAdminHealthRouteRequiresAdminSession();
    testTerminalRestoreCleanupIsPresent();
    testDashboardUsesOperationalHealth();
    console.log('Phase 4 health dashboard tests OK');
}

main();
