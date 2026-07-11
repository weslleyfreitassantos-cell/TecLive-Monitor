const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CookieRefreshQueue = require('../services/cookieRefreshQueue');
const CookieRotator = require('../cookieRotator');

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'cookie-refresh-'));
}

function readApp() {
    return fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
}

function readDashboard() {
    return fs.readFileSync(path.join(__dirname, '..', 'public', 'dashboard.html'), 'utf8');
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

function testSecurityAndDashboardStaticChecks() {
    const app = readApp();
    assert.ok(app.includes('COOKIE_AGENT_TOKEN'));
    assert.ok(app.includes('crypto.timingSafeEqual'));
    assert.ok(app.includes("Object.prototype.hasOwnProperty.call(req.query || {}, 'token')"));
    assert.ok(app.includes("app.use('/api/cookie-agent', cookieAgentLimiter, authenticateCookieAgent)"));
    assert.ok(app.includes('/api/admin/cookie-refresh/status'));

    const dashboard = readDashboard();
    assert.ok(dashboard.includes('AUTOMAÇÃO DE COOKIES'));
    assert.ok(dashboard.includes('/api/admin/cookie-refresh/enqueue/'));
    assert.ok(!dashboard.includes('COOKIE_AGENT_TOKEN'));
}

testQueueBasics();
testLeaseAndCooldown();
testInvalidJsonRecoveryAndHistory();
testSanitization();
testRotatorIntegration();
testRotatorDoesNotCancelClaimedOrRunning();
testSecurityAndDashboardStaticChecks();

console.log('Cookie refresh automation Node tests OK');
