const assert = require('assert');
const nodemailer = require('nodemailer');

async function main() {
    const sent = [];
    const originalCreateTransport = nodemailer.createTransport;
    nodemailer.createTransport = () => ({
        sendMail(options, callback) {
            sent.push(options);
            callback(null, { messageId: `test-${sent.length}` });
        }
    });

    try {
        delete require.cache[require.resolve('../alerts/emailAlerts')];
        const EmailAlerts = require('../alerts/emailAlerts');
        const alerts = new EmailAlerts();
        alerts.adminEmail = 'ops@example.com';

        alerts.sendCookieAgentOfflineAlert({
            agent: {
                agentId: 'agent-a',
                hostname: 'ASUS_WESLLEY',
                lastSeen: '2026-07-12T15:00:00.000Z'
            },
            heartbeatAgeSeconds: 610
        });

        alerts.sendCookieAgentRecoveredAlert({
            agent: {
                agentId: 'agent-a',
                hostname: 'ASUS_WESLLEY',
                lastSeen: '2026-07-12T15:20:00.000Z'
            },
            downtimeSeconds: 1210
        });

        alerts.sendCookieRefreshFailedAlert({
            cookie: 'cookie2',
            attempts: 3,
            agentId: 'agent-a',
            completedAt: '2026-07-12T15:25:00.000Z',
            lastError: 'Authorization: Bearer secret https://manifest.googlevideo.com/api/manifest/hls_variant/token/private C:\\Users\\Weslley\\cookies\\cookie2.txt /var/www/livemonitor/app.js <script>x</script>'
        });

        assert.equal(sent.length, 3);
        assert.match(sent[0].subject, /Cookie Agent Offline/);
        assert.match(sent[0].text, /Heartbeat do Agent Windows ausente/);
        assert.match(sent[0].text, /ASUS_WESLLEY/);
        assert.match(sent[0].text, /10m 10s/);

        assert.match(sent[1].subject, /Cookie Agent Online novamente/);
        assert.match(sent[1].text, /voltou a enviar heartbeat/);
        assert.match(sent[1].text, /20m 10s/);

        assert.match(sent[2].subject, /Renovacao automatica falhou - COOKIE2/);
        assert.match(sent[2].text, /Tentativas: 3/);
        assert.ok(!sent[2].text.includes('secret'));
        assert.ok(!sent[2].text.includes('manifest.googlevideo.com'));
        assert.ok(!sent[2].text.includes('C:\\Users'));
        assert.ok(!sent[2].text.includes('/var/www'));
        assert.ok(sent[2].html.includes('&lt;script&gt;x&lt;/script&gt;'));
        assert.ok(!sent[2].html.includes('<script>x</script>'));
    } finally {
        nodemailer.createTransport = originalCreateTransport;
        delete require.cache[require.resolve('../alerts/emailAlerts')];
    }

    console.log('Phase 5 agent alert tests OK');
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
