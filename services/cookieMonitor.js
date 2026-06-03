// services/cookieMonitor.js
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const db = require('../database/schema');
const { logEvent, EVENT_TYPES } = require('./eventLogger');

const TEST_URLS = process.env.COOKIE_TEST_URLS 
    ? process.env.COOKIE_TEST_URLS.split(',') 
    : ['https://www.youtube.com/watch?v=dGiMBVU3j8s'];

const COOKIE_PATH = path.join(__dirname, '..', 'cookies', 'tecnico.txt');

let cookieStatus = {
    status: 'unknown',
    consecutiveFailures: 0,
    lastSuccess: null,
    lastFailure: null,
    lastTest: null
};

async function loadPersistedState() {
    return new Promise((resolve) => {
        db.get('SELECT * FROM cookie_health WHERE id = 1', (err, row) => {
            if (!err && row) {
                cookieStatus = {
                    status: row.status,
                    consecutiveFailures: row.consecutive_failures,
                    lastSuccess: row.last_success ? new Date(row.last_success) : null,
                    lastFailure: row.last_failure ? new Date(row.last_failure) : null,
                    lastTest: row.last_test ? new Date(row.last_test) : null
                };
                console.log(`📊 Estado do cookie: ${cookieStatus.status}`);
            }
            resolve();
        });
    });
}

async function savePersistedState() {
    db.run(
        `UPDATE cookie_health SET 
            status = ?, 
            consecutive_failures = ?, 
            last_success = ?, 
            last_failure = ?, 
            last_test = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = 1`,
        [
            cookieStatus.status, 
            cookieStatus.consecutiveFailures, 
            cookieStatus.lastSuccess?.toISOString(), 
            cookieStatus.lastFailure?.toISOString(), 
            cookieStatus.lastTest?.toISOString()
        ]
    );
}

async function testCookie() {
    for (const url of TEST_URLS) {
        const command = `yt-dlp --cookies "${COOKIE_PATH}" -g "${url}" --simulate`;
        const success = await new Promise((resolve) => {
            exec(command, { timeout: 15000 }, (error) => resolve(!error));
        });
        if (success) return { working: true, url };
    }
    return { working: false };
}

async function checkCookieStatus() {
    console.log('🩺 Verificando cookie técnico...');
    
    const testResult = await testCookie();
    cookieStatus.lastTest = new Date();
    
    if (testResult.working) {
        const wasFailing = cookieStatus.status !== 'healthy';
        cookieStatus.status = 'healthy';
        cookieStatus.consecutiveFailures = 0;
        cookieStatus.lastSuccess = new Date();
        
        if (wasFailing) {
            await logEvent(null, EVENT_TYPES.COOKIE_RECOVERED, 'Cookie voltou a funcionar');
            console.log('✅ Cookie RECUPERADO!');
        } else {
            console.log('✅ Cookie saudável');
        }
    } else {
        cookieStatus.lastFailure = new Date();
        cookieStatus.consecutiveFailures++;
        
        if (cookieStatus.consecutiveFailures >= 3) {
            cookieStatus.status = 'critical';
            if (cookieStatus.consecutiveFailures === 3) {
                await logEvent(null, EVENT_TYPES.COOKIE_FAILED, 'Cookie expirou ou foi invalidado');
                console.log('🔴 Cookie CRÍTICO!');
            }
        } else {
            cookieStatus.status = 'warning';
            console.log('🟡 Cookie com atenção');
        }
    }
    
    await savePersistedState();
    return { working: testResult.working, status: cookieStatus };
}

function getCookieStatus() {
    return { ...cookieStatus, cookieFileExists: fs.existsSync(COOKIE_PATH) };
}

function startCookieMonitoring() {
    console.log('🕒 Monitor de cookie iniciado (30 em 30 min)');
    loadPersistedState().then(() => {
        checkCookieStatus();
        setInterval(checkCookieStatus, 30 * 60 * 1000);
    });
}

module.exports = { startCookieMonitoring, getCookieStatus, checkCookieStatus };