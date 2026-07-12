const assert = require('assert');
const express = require('express');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const rateLimit = require('express-rate-limit');

const CookieRefreshQueue = require('../services/cookieRefreshQueue');
const CookieRotator = require('../cookieRotator');
const { parseTrustProxyConfig, resolveBindHost } = require('../services/httpRuntimeConfig');

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'cookie-refresh-'));
}

function readApp() {
    return fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
}

function readDashboard() {
    return fs.readFileSync(path.join(__dirname, '..', 'public', 'dashboard.html'), 'utf8');
}

function readEcosystem() {
    return fs.readFileSync(path.join(__dirname, '..', 'ecosystem.config.js'), 'utf8');
}

function readHttpRuntimeConfig() {
    return fs.readFileSync(path.join(__dirname, '..', 'services', 'httpRuntimeConfig.js'), 'utf8');
}

function request(server, route, headers = {}) {
    return new Promise((resolve, reject) => {
        const address = server.address();
        const req = http.request({
            hostname: '127.0.0.1',
            port: address.port,
            path: route,
            method: 'GET',
            headers
        }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => {
                let json = null;
                try {
                    json = body ? JSON.parse(body) : null;
                } catch (err) {
                    json = null;
                }
                resolve({ status: res.statusCode, body, json });
            });
        });
        req.on('error', reject);
        req.end();
    });
}

function listen(app, host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
        const server = app.listen(0, host, () => resolve(server));
        server.once('error', reject);
    });
}

function testQueueBasics() {
    const dir = tempDir();
    const queue = new CookieRefreshQueue({
        filePath: path.join(dir, 'jobs.json'),
        leaseMs: 20,
        cooldownMs: 20,
        maxAttempts: 2
    });

    const created = queue.enqueue('cookie2', 'api', 'erro resumido');
    assert.equal(created.created, true);
    assert.equal(created.job.cookie, 'cookie2');

    const duplicate = queue.enqueue('cookie2', 'api', 'duplicado');
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.job.id, created.job.id);

    assert.throws(() => queue.enqueue('cookie4', 'api', 'invalido'), /cookie invalido/);

    const next = queue.getNextPending();
    assert.equal(next.id, created.job.id);

    const claim = queue.claim(next.id, 'agent-a');
    assert.equal(claim.ok, true);
    assert.equal(claim.job.status, 'claimed');

    const secondClaim = queue.claim(next.id, 'agent-b');
    assert.equal(secondClaim.ok, false);
    assert.equal(secondClaim.code, 'conflict');

    const wrongComplete = queue.complete(next.id, 'agent-b', { message: 'ok' });
    assert.equal(wrongComplete.ok, false);
    assert.equal(wrongComplete.code, 'forbidden');
    assert.equal(queue.cancel(next.id, 'claimed cancel').ok, false);

    const running = queue.markRunning(next.id, 'agent-a');
    assert.equal(running.ok, true);
    assert.equal(running.job.status, 'running');

    const complete = queue.complete(next.id, 'agent-a', { message: 'ok', exitCode: 0, durationMs: 10 });
    assert.equal(complete.ok, true);
    assert.equal(complete.job.status, 'succeeded');

    const persisted = new CookieRefreshQueue({ filePath: path.join(dir, 'jobs.json') });
    assert.equal(persisted.list({ limit: 10 })[0].status, 'succeeded');
}

function testLeaseAndCooldown() {
    const dir = tempDir();
    const queue = new CookieRefreshQueue({
        filePath: path.join(dir, 'jobs.json'),
        leaseMs: 5,
        cooldownMs: 50,
        maxAttempts: 3
    });
    const job = queue.enqueue('cookie1', 'api', 'auth').job;
    assert.equal(queue.claim(job.id, 'agent-a').ok, true);

    const store = JSON.parse(fs.readFileSync(path.join(dir, 'jobs.json'), 'utf8'));
    store.jobs[0].claimExpiresAt = new Date(Date.now() - 1000).toISOString();
    fs.writeFileSync(path.join(dir, 'jobs.json'), JSON.stringify(store, null, 2));

    queue.recoverExpiredClaims();
    const recovered = queue.list({ limit: 1 })[0];
    assert.equal(recovered.status, 'pending');
    assert.equal(recovered.agentId, null);

    assert.equal(queue.claim(job.id, 'agent-a').ok, true);
    const failed = queue.fail(job.id, 'agent-a', 'Firefox aberto');
    assert.equal(failed.ok, true);
    assert.equal(failed.job.status, 'pending');
    assert.ok(failed.job.nextAttemptAt);
    assert.equal(queue.getNextPending(), null);
}

function testInvalidJsonRecoveryAndHistory() {
    const dir = tempDir();
    const file = path.join(dir, 'jobs.json');
    fs.writeFileSync(file, '{ invalid json', 'utf8');
    const queue = new CookieRefreshQueue({ filePath: file, maxHistory: 3 });
    assert.deepEqual(queue.list({ limit: 10 }), []);
    assert.ok(fs.readdirSync(dir).some(name => name.includes('.corrupt-')));

    for (let i = 0; i < 8; i += 1) {
        const job = queue.enqueue(`cookie${(i % 3) + 1}`, 'api', `job ${i}`).job;
        queue.claim(job.id, 'agent-a');
        queue.complete(job.id, 'agent-a', { message: 'ok' });
    }
    assert.ok(queue.list({ limit: 20 }).length <= 3);
}

function testSanitization() {
    const dir = tempDir();
    const queue = new CookieRefreshQueue({ filePath: path.join(dir, 'jobs.json') });
    const job = queue.enqueue(
        'cookie2',
        'api',
        'Authorization: Bearer secret C:\\Users\\Weslley\\cookies\\cookie2.txt /var/www/livemonitor/app.js # Netscape HTTP Cookie File should not leak'
    ).job;
    assert.ok(!job.reason.includes('secret'));
    assert.ok(!job.reason.includes('C:\\Users'));
    assert.ok(!job.reason.includes('/var/www'));
    assert.ok(!job.reason.includes('Netscape'));
}

function testRotatorIntegration() {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'cookie1.txt'), '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t2147483647\ta\tb\n');
    const queue = new CookieRefreshQueue({ filePath: path.join(dir, 'jobs.json') });
    const rotator = new CookieRotator(dir, path.join(dir, 'status.json'));
    rotator.setRefreshQueue(queue);

    rotator.markFailure('cookie1.txt', 'Sign in to confirm you are not a bot', 'video-a');
    rotator.markFailure('cookie1.txt', 'Sign in to confirm you are not a bot', 'video-a');
    assert.equal(queue.list({ limit: 10 }).length, 0);

    rotator.markFailure('cookie1.txt', 'Sign in to confirm you are not a bot', 'video-a');
    const jobs = queue.list({ limit: 10 });
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].cookie, 'cookie1');
    assert.equal(jobs[0].status, 'pending');

    rotator.markFailure('cookie1.txt', 'Sign in to confirm you are not a bot', 'video-a');
    assert.equal(queue.list({ limit: 10 }).filter(job => job.status === 'pending').length, 1);

    rotator.markSuccess('cookie1.txt');
    assert.equal(queue.list({ limit: 10 })[0].status, 'cancelled');
}

function testRotatorDoesNotCancelClaimedOrRunning() {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'cookie2.txt'), '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t2147483647\ta\tb\n');
    const queue = new CookieRefreshQueue({ filePath: path.join(dir, 'jobs.json') });
    const rotator = new CookieRotator(dir, path.join(dir, 'status.json'));
    rotator.setRefreshQueue(queue);

    const claimed = queue.enqueue('cookie2', 'api', 'claimed').job;
    assert.equal(queue.claim(claimed.id, 'agent-a').ok, true);
    rotator.markSuccess('cookie2.txt');
    assert.equal(queue.list({ limit: 10 })[0].status, 'claimed');

    const running = queue.enqueue('cookie3', 'api', 'running').job;
    assert.equal(queue.claim(running.id, 'agent-a').ok, true);
    assert.equal(queue.markRunning(running.id, 'agent-a').ok, true);
    rotator.markSuccess('cookie3.txt');
    const runningAfter = queue.list({ limit: 10 }).find(job => job.id === running.id);
    assert.equal(runningAfter.status, 'running');
}

function testRotatorIgnoresExtractionAndNetworkErrors() {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'cookie1.txt'), '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t2147483647\ta\tb\n');
    const queue = new CookieRefreshQueue({ filePath: path.join(dir, 'jobs.json') });
    const rotator = new CookieRotator(dir, path.join(dir, 'status.json'));
    rotator.setRefreshQueue(queue);

    const ignored = [
        'No video formats found',
        'This live event has ended',
        'Video unavailable',
        'Timeout apos 90000ms',
        'HTTP Error 503: Service Unavailable'
    ];

    for (const message of ignored) {
        assert.equal(rotator.markFailure('cookie1.txt', message, 'video-a'), false);
    }

    const status = rotator.status['cookie1.txt'];
    assert.equal(status.state, 'valid');
    assert.equal(status.failCount, 0);
    assert.equal(queue.list({ limit: 10 }).length, 0);
}

function testAgentStatusClassification() {
    const now = Date.parse('2026-07-11T12:00:00.000Z');
    const heartbeatRecent = CookieRefreshQueue.computeAgentStatus({
        lastSeen: '2026-07-11T11:59:20.000Z',
        lastQueueCheck: '2026-07-11T11:58:00.000Z'
    }, { nowMs: now, heartbeatRecentMs: 90000, activityRecentMs: 180000 });
    assert.equal(heartbeatRecent.status, 'online');
    assert.equal(heartbeatRecent.reason, 'heartbeat_recent');

    const queueRecent = CookieRefreshQueue.computeAgentStatus({
        lastSeen: '2026-07-11T11:55:00.000Z',
        lastQueueCheck: '2026-07-11T11:59:00.000Z'
    }, { nowMs: now, heartbeatRecentMs: 90000, activityRecentMs: 180000 });
    assert.equal(queueRecent.status, 'degraded');
    assert.equal(queueRecent.reason, 'heartbeat_stale_queue_recent');

    const staleHeartbeatRecentActivity = CookieRefreshQueue.computeAgentStatus({
        lastSeen: '2026-07-11T11:58:20.000Z'
    }, { nowMs: now, heartbeatRecentMs: 90000, activityRecentMs: 180000 });
    assert.equal(staleHeartbeatRecentActivity.status, 'degraded');

    const stale = CookieRefreshQueue.computeAgentStatus({
        lastSeen: '2026-07-11T11:50:00.000Z',
        lastQueueCheck: '2026-07-11T11:50:30.000Z'
    }, { nowMs: now, heartbeatRecentMs: 90000, activityRecentMs: 180000 });
    assert.equal(stale.status, 'offline');
    assert.equal(stale.reason, 'no_recent_activity');

    const neverSeen = CookieRefreshQueue.computeAgentStatus(null, { nowMs: now });
    assert.equal(neverSeen.status, 'offline');
    assert.equal(neverSeen.reason, 'never_seen');

    const invalid = CookieRefreshQueue.computeAgentStatus({
        lastSeen: 'not-a-date',
        lastQueueCheck: 'also-invalid'
    }, { nowMs: now });
    assert.equal(invalid.status, 'offline');
    assert.equal(invalid.reason, 'never_seen');
}

function testQueueCheckActivityIsPersisted() {
    const dir = tempDir();
    const queue = new CookieRefreshQueue({ filePath: path.join(dir, 'jobs.json') });
    queue.recordQueueCheck('agent-a');
    const agent = queue.getAgents()[0];
    assert.equal(agent.agentId, 'agent-a');
    assert.ok(agent.lastQueueCheckAt);
    assert.equal(agent.lastSeen, null);
    const status = CookieRefreshQueue.computeAgentStatus(agent, {
        nowMs: Date.parse(agent.lastQueueCheckAt),
        heartbeatRecentMs: 90000,
        activityRecentMs: 180000
    });
    assert.equal(status.status, 'degraded');
    assert.equal(status.reason, 'heartbeat_stale_queue_recent');
}

async function testPhase1ProxyAndLimiterRuntime() {
    assert.equal(resolveBindHost({}), '127.0.0.1');
    assert.equal(resolveBindHost({ BIND_HOST: '0.0.0.0' }), '0.0.0.0');
    assert.equal(resolveBindHost({ BIND_HOST: '   ', HOST: '' }), '127.0.0.1');

    assert.deepEqual(parseTrustProxyConfig('false'), { value: false, label: 'false' });
    assert.deepEqual(parseTrustProxyConfig('loopback'), { value: 'loopback', label: 'loopback' });
    assert.deepEqual(parseTrustProxyConfig('1'), { value: 1, label: '1' });
    assert.deepEqual(parseTrustProxyConfig('127.0.0.1,10.0.0.0/8'), {
        value: ['127.0.0.1', '10.0.0.0/8'],
        label: '127.0.0.1,10.0.0.0/8'
    });
    assert.throws(() => parseTrustProxyConfig('true'), /TRUST_PROXY=true nao e permitido/);
    assert.throws(() => parseTrustProxyConfig('not-a-proxy'), /TRUST_PROXY invalido/);
    assert.throws(() => parseTrustProxyConfig('0'), /TRUST_PROXY invalido/);

    const directApp = express();
    directApp.set('trust proxy', parseTrustProxyConfig('false').value);
    directApp.get('/ip', (req, res) => res.json({ ip: req.ip }));
    const directServer = await listen(directApp);
    try {
        const direct = await request(directServer, '/ip', { 'X-Forwarded-For': '203.0.113.77' });
        assert.equal(direct.status, 200);
        assert.notEqual(direct.json.ip, '203.0.113.77');
        assert.match(direct.json.ip, /127\.0\.0\.1|::ffff:127\.0\.0\.1/);
    } finally {
        directServer.close();
    }

    const proxyApp = express();
    proxyApp.set('trust proxy', parseTrustProxyConfig('loopback').value);
    proxyApp.get('/ip', (req, res) => res.json({ ip: req.ip }));
    const proxyServer = await listen(proxyApp);
    try {
        const proxied = await request(proxyServer, '/ip', { 'X-Forwarded-For': '203.0.113.77' });
        assert.equal(proxied.status, 200);
        assert.equal(proxied.json.ip, '203.0.113.77');
    } finally {
        proxyServer.close();
    }

    const limiterKey = req => rateLimit.ipKeyGenerator(req.ip);
    const adminLimiter = rateLimit({
        windowMs: 60 * 1000,
        limit: 1,
        keyGenerator: limiterKey,
        legacyHeaders: false,
        standardHeaders: true,
        message: { success: false, error: 'admin_api_rate_limited' }
    });
    const agentLimiter = rateLimit({
        windowMs: 60 * 1000,
        limit: 1,
        keyGenerator: limiterKey,
        legacyHeaders: false,
        standardHeaders: true,
        message: { success: false, error: 'cookie_agent_rate_limited' }
    });
    const limiterApp = express();
    limiterApp.set('trust proxy', parseTrustProxyConfig('false').value);
    limiterApp.get('/admin', adminLimiter, (req, res) => res.json({ success: true, scope: 'admin' }));
    limiterApp.get('/agent', agentLimiter, (req, res) => res.json({ success: true, scope: 'agent' }));
    limiterApp.get('/admin401', (req, res) => res.status(401).json({ success: false, error: 'admin_session_expired' }));
    limiterApp.get('/agent401', (req, res) => res.status(401).json({ success: false, error: 'unauthorized' }));
    const limiterServer = await listen(limiterApp);
    try {
        assert.equal((await request(limiterServer, '/admin')).status, 200);
        assert.equal((await request(limiterServer, '/admin')).status, 429);
        assert.equal((await request(limiterServer, '/agent')).status, 200);
        assert.equal((await request(limiterServer, '/agent')).status, 429);

        const admin401 = await request(limiterServer, '/admin401');
        assert.equal(admin401.status, 401);
        assert.equal(admin401.json.success, false);
        assert.equal(admin401.json.error, 'admin_session_expired');

        const agent401 = await request(limiterServer, '/agent401');
        assert.equal(agent401.status, 401);
        assert.equal(agent401.json.error, 'unauthorized');
    } finally {
        limiterServer.close();
    }

    const bindApp = express();
    bindApp.get('/health', (req, res) => res.json({ status: 'ok' }));
    const bindServer = await listen(bindApp, resolveBindHost({ BIND_HOST: '127.0.0.1' }));
    try {
        assert.equal(bindServer.address().address, '127.0.0.1');
    } finally {
        bindServer.close();
    }
}

function testSecurityAndDashboardStaticChecks() {
    const app = readApp();
    const httpRuntimeConfig = readHttpRuntimeConfig();
    assert.ok(app.includes('COOKIE_AGENT_TOKEN'));
    assert.ok(app.includes('crypto.timingSafeEqual'));
    assert.ok(app.includes("require('./services/httpRuntimeConfig')"));
    assert.ok(app.includes("app.set('trust proxy', TRUST_PROXY.value)"));
    assert.ok(httpRuntimeConfig.includes("TRUST_PROXY=true nao e permitido"));
    assert.ok(httpRuntimeConfig.includes('function resolveBindHost'));
    assert.ok(httpRuntimeConfig.includes("return configured || '127.0.0.1'"));
    assert.ok(httpRuntimeConfig.includes('hops < 1 || hops > 16'));
    assert.ok(app.includes('app.listen(PORT, BIND_HOST'));
    assert.ok(app.includes('adminLoginLimiter'));
    assert.ok(app.includes('adminApiLimiter'));
    assert.ok(app.includes('publicApiLimiter'));
    assert.ok(app.includes('cookieAgentLimiter'));
    assert.ok(app.includes("app.post('/admin-login', adminLoginLimiter"));
    assert.ok(app.includes("app.use('/api/admin/cookie-refresh', adminApiLimiter)"));
    assert.ok(app.includes("Object.prototype.hasOwnProperty.call(req.query || {}, 'token')"));
    assert.ok(app.includes("app.use('/api/cookie-agent', cookieAgentLimiter, authenticateCookieAgent)"));
    assert.ok(app.includes('/api/admin/cookie-refresh/status'));
    assert.ok(app.includes("error: 'admin_session_expired'"));
    assert.ok(!app.includes("req.headers['x-forwarded-for']"));
    assert.ok(app.includes('recordQueueCheck(req.agentId)'));
    assert.ok(app.includes('lastAgentActivityAt'));
    assert.ok(app.includes('heartbeatAgeSeconds'));
    assert.ok(app.includes('activityAgeSeconds'));
    assert.ok(app.includes('lastQueueCheck'));
    assert.ok(app.includes('lastCookieUpdated'));

    const dashboard = readDashboard();
    assert.ok(dashboard.includes('AUTOMAÇÃO DE COOKIES'));
    assert.ok(dashboard.includes('Status do agente'));
    assert.ok(dashboard.includes('Último heartbeat'));
    assert.ok(dashboard.includes('Última execução'));
    assert.ok(dashboard.includes('Último cookie atualizado'));
    assert.ok(dashboard.includes('Último erro'));
    assert.ok(dashboard.includes('Última consulta à fila'));
    assert.ok(dashboard.includes('DEGRADADO'));
    assert.ok(dashboard.includes('atividade recente, heartbeat atrasado'));
    assert.ok(dashboard.includes('/api/admin/cookie-refresh/enqueue/'));
    assert.ok(dashboard.includes("credentials: 'same-origin'"));
    assert.ok(dashboard.includes('Sessão administrativa expirada'));
    assert.ok(dashboard.includes('Muitas requisições; tente novamente em instantes'));
    assert.ok(dashboard.includes('Automação de cookies desativada'));
    assert.ok(dashboard.includes('Erro de rede ao acessar API administrativa'));
    assert.ok(dashboard.includes('Entrar novamente'));
    assert.ok(dashboard.includes('redirectToAdminLoginOnce'));
    assert.ok(dashboard.includes('adminRedirectInProgress'));
    assert.ok(dashboard.includes('fetchAdminJson'));
    assert.ok(!dashboard.includes('COOKIE_AGENT_TOKEN'));
    assert.ok(!dashboard.includes('LINHA DO TEMPO'));
    assert.ok(!dashboard.includes('timelineContent'));
    assert.ok(!dashboard.includes('function addEvent'));

    const ecosystem = readEcosystem();
    assert.ok(ecosystem.includes("BIND_HOST: '127.0.0.1'"));
    assert.ok(ecosystem.includes("TRUST_PROXY: 'loopback'"));
}

async function main() {
    testQueueBasics();
    testLeaseAndCooldown();
    testInvalidJsonRecoveryAndHistory();
    testSanitization();
    testRotatorIntegration();
    testRotatorDoesNotCancelClaimedOrRunning();
    testRotatorIgnoresExtractionAndNetworkErrors();
    testAgentStatusClassification();
    testQueueCheckActivityIsPersisted();
    await testPhase1ProxyAndLimiterRuntime();
    testSecurityAndDashboardStaticChecks();

    console.log('Cookie refresh automation Node tests OK');
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
