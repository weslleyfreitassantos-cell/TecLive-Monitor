const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { spawn } = require('child_process');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3002;

app.use(express.json());
app.use(express.static('public'));

const cookiesDir = path.join(__dirname, 'cookies');
if (!fs.existsSync(cookiesDir)) {
    fs.mkdirSync(cookiesDir, { recursive: true });
}

let uploadInProgress = false;
let lastCookieValidation = null;
let lastCookieValid = false;

const storage = multer.diskStorage({
    destination: cookiesDir,
    filename: (req, file, cb) => {
        const uniqueName = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.txt`;
        cb(null, uniqueName);
    }
});
const upload = multer({ storage: storage });

app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        console.error(`❌ Erro Multer: ${err.message}`);
        return res.status(400).json({ success: false, message: err.message });
    }
    next(err);
});

let converter = null;

function runYtdlp(args, timeout = 30000) {
    return new Promise((resolve, reject) => {
        const ytCmd = process.platform === 'win32' ? '.\\yt-dlp.exe' : 'yt-dlp';
        const child = spawn(ytCmd, args);
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const timeoutId = setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
            reject(new Error(`Timeout após ${timeout}ms`));
        }, timeout);
        child.stdout.on('data', (data) => { stdout += data.toString(); });
        child.stderr.on('data', (data) => { stderr += data.toString(); });
        child.on('close', (code) => {
            clearTimeout(timeoutId);
            if (timedOut) return;
            if (code === 0) resolve(stdout.trim());
            else reject(new Error(stderr.trim() || `Código de saída: ${code}`));
        });
        child.on('error', (err) => {
            clearTimeout(timeoutId);
            reject(err);
        });
    });
}

async function validateCookieSimple(cookiePath) {
    const stats = fs.statSync(cookiePath);
    if (stats.size < 5000) throw new Error(`Arquivo muito pequeno (${stats.size} bytes)`);
    const content = fs.readFileSync(cookiePath, 'utf8');
    if (!content.includes('.youtube.com') && !content.includes('youtube.com')) {
        throw new Error('Cookie inválido - domínio YouTube não encontrado');
    }
    console.log('✅ Estrutura do cookie OK');
    try {
        console.log('🔍 Testando autenticação do cookie...');
        await runYtdlp([
            '--cookies', cookiePath,
            '--flat-playlist',
            '--playlist-end', '1',
            '--dump-json',
            'https://www.youtube.com/feed/subscriptions'
        ], 20000);
        console.log('✅ Cookie válido (autenticação confirmada)');
        return true;
    } catch (error) {
        throw new Error('Cookie inválido: ' + error.message);
    }
}

app.post('/api/cookie/test', async (req, res) => {
    let activePath = null;
    for (let i = 1; i <= 3; i++) {
        const testPath = path.join(cookiesDir, `cookie${i}.txt`);
        if (fs.existsSync(testPath) && fs.statSync(testPath).size > 5000) {
            activePath = testPath;
            break;
        }
    }
    if (!activePath) {
        const mainPath = path.join(cookiesDir, 'main.txt');
        if (fs.existsSync(mainPath)) activePath = mainPath;
    }
    if (!activePath) {
        return res.json({ valid: false, error: 'Nenhum cookie configurado' });
    }
    const cacheTime = 5 * 60 * 1000;
    if (lastCookieValidation && (Date.now() - lastCookieValidation) < cacheTime) {
        console.log('📦 Usando cache de validação do cookie');
        return res.json({ valid: lastCookieValid, message: lastCookieValid ? 'Cookie válido (cache)' : 'Cookie inválido (cache)' });
    }
    try {
        await validateCookieSimple(activePath);
        lastCookieValid = true;
        lastCookieValidation = Date.now();
        res.json({ valid: true, message: 'Cookie válido' });
    } catch (error) {
        lastCookieValid = false;
        lastCookieValidation = Date.now();
        res.json({ valid: false, error: error.message });
    }
});

app.post('/api/cookie/upload', upload.single('cookie'), async (req, res) => {
    const startTime = Date.now();
    if (uploadInProgress) {
        return res.status(409).json({ success: false, message: 'Já existe um upload em andamento.' });
    }
    uploadInProgress = true;
    try {
        if (!req.file) return res.status(400).json({ success: false, message: 'Nenhum arquivo enviado' });
        const tempPath = req.file.path;
        let targetType = req.query.type || '1';
        let targetPath;
        let isLegacy = false;
        if (targetType === '1') targetPath = path.join(cookiesDir, 'cookie1.txt');
        else if (targetType === '2') targetPath = path.join(cookiesDir, 'cookie2.txt');
        else if (targetType === '3') targetPath = path.join(cookiesDir, 'cookie3.txt');
        else {
            isLegacy = true;
            targetPath = path.join(cookiesDir, 'main.txt');
        }
        console.log(`📁 Upload: ${req.file.originalname} (${req.file.size} bytes) -> ${path.basename(targetPath)}`);
        await validateCookieSimple(tempPath);
        console.log(`✅ Cookie validado em ${Date.now() - startTime}ms`);
        let backupCreated = false;
        if (isLegacy && fs.existsSync(targetPath)) {
            const backupPath = path.join(cookiesDir, 'backup.txt');
            fs.copyFileSync(targetPath, backupPath);
            backupCreated = true;
            console.log('📁 Backup do main.txt criado');
        }
        if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
        fs.renameSync(tempPath, targetPath);
        if (!isLegacy && targetType === '1') {
            try {
                fs.copyFileSync(targetPath, path.join(cookiesDir, 'main.txt'));
                console.log('🔄 Compatibilidade: cookie1.txt copiado para main.txt');
            } catch (e) { console.warn('Não foi possível criar main.txt:', e.message); }
        }
        lastCookieValidation = Date.now();
        lastCookieValid = true;
        console.log(`✅ Cookie ${isLegacy ? 'legacy' : `cookie${targetType}`} atualizado com sucesso! Tempo total: ${Date.now() - startTime}ms`);
        res.json({ success: true, message: `Cookie ${isLegacy ? 'principal' : `cookie${targetType}`} atualizado com sucesso`, backupCreated, elapsedMs: Date.now() - startTime });
    } catch (error) {
        console.error(`❌ Erro no upload: ${error.message}`);
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(400).json({ success: false, message: error.message });
    } finally {
        uploadInProgress = false;
    }
});

app.get('/api/cookie/status', (req, res) => {
    const cookie1Path = path.join(cookiesDir, 'cookie1.txt');
    const cookie2Path = path.join(cookiesDir, 'cookie2.txt');
    const cookie3Path = path.join(cookiesDir, 'cookie3.txt');
    const mainPath = path.join(cookiesDir, 'main.txt');
    const backupPath = path.join(cookiesDir, 'backup.txt');
    const MIN_SIZE = 5000;
    const cookie1Valid = fs.existsSync(cookie1Path) && fs.statSync(cookie1Path).size > MIN_SIZE;
    const cookie2Valid = fs.existsSync(cookie2Path) && fs.statSync(cookie2Path).size > MIN_SIZE;
    const cookie3Valid = fs.existsSync(cookie3Path) && fs.statSync(cookie3Path).size > MIN_SIZE;
    let cookie1Content = 'nenhum', cookie2Content = 'nenhum', cookie3Content = 'nenhum';
    if (cookie1Valid) cookie1Content = fs.readFileSync(cookie1Path, 'utf8');
    if (cookie2Valid) cookie2Content = fs.readFileSync(cookie2Path, 'utf8');
    if (cookie3Valid) cookie3Content = fs.readFileSync(cookie3Path, 'utf8');
    let activeCookie = 'nenhum';
    if (cookie1Valid) activeCookie = 'cookie1';
    else if (cookie2Valid) activeCookie = 'cookie2';
    else if (cookie3Valid) activeCookie = 'cookie3';
    const mainValid = fs.existsSync(mainPath) && fs.statSync(mainPath).size > MIN_SIZE;
    const backupValid = fs.existsSync(backupPath) && fs.statSync(backupPath).size > MIN_SIZE;
    let finalActive = activeCookie;
    let finalActiveName = finalActive !== 'nenhum' ? (finalActive === 'cookie1' ? 'cookie1.txt' : finalActive === 'cookie2' ? 'cookie2.txt' : 'cookie3.txt') : 'nenhum';
    let finalHealthy = finalActive !== 'nenhum';
    let finalHasBackup = false;
    if (finalActive === 'cookie1' && (cookie2Valid || cookie3Valid)) finalHasBackup = true;
    else if (finalActive === 'cookie2' && (cookie1Valid || cookie3Valid)) finalHasBackup = true;
    else if (finalActive === 'cookie3' && (cookie1Valid || cookie2Valid)) finalHasBackup = true;
    if (!finalHealthy && mainValid) {
        finalActive = 'main.txt';
        finalActiveName = 'main.txt';
        finalHealthy = true;
        finalHasBackup = backupValid;
        if (cookie1Content === 'nenhum') cookie1Content = fs.readFileSync(mainPath, 'utf8');
    }
    let activeSize = 0;
    if (finalActive === 'cookie1') activeSize = fs.statSync(cookie1Path).size;
    else if (finalActive === 'cookie2') activeSize = fs.statSync(cookie2Path).size;
    else if (finalActive === 'cookie3') activeSize = fs.statSync(cookie3Path).size;
    else if (finalActive === 'main.txt') activeSize = fs.statSync(mainPath).size;
    res.json({
        cookie1: cookie1Content,
        cookie2: cookie2Content,
        cookie3: cookie3Content,
        consecutiveFailures: 0,
        lastCookieCheck: new Date().toISOString(),
        cookieStatus: finalHealthy ? 'valid' : 'invalid',
        healthy: finalHealthy,
        hasBackup: finalHasBackup,
        activeCookie: finalActiveName,
        cookieSize: activeSize,
        lastCheck: new Date().toISOString()
    });
});

const EmailAlerts = require('./alerts/emailAlerts');
const ConvertAPI = require('./api/convert');
const emailAlerts = new EmailAlerts();
converter = new ConvertAPI(emailAlerts);

setInterval(() => {
    if (converter && converter.activeMonitors && emailAlerts && typeof emailAlerts.evaluateAndAlert === 'function') {
        const liveCount = converter.activeMonitors.size;
        emailAlerts.evaluateAndAlert(liveCount);
    }
}, 120000);

app.post('/api/convert', async (req, res) => {
    const { youtubeUrl } = req.body;
    if (!youtubeUrl) return res.status(400).json({ success: false, error: 'URL obrigatoria' });
    const baseUrl = process.env.BASE_URL || 'http://localhost:' + PORT;
    const result = await converter.convert(youtubeUrl, baseUrl);
    res.json(result);
});

app.get('/api/monitors', (req, res) => {
    const monitors = [];
    if (converter && converter.activeMonitors) {
        for (const [videoId, monitor] of converter.activeMonitors.entries()) {
            monitors.push({
                videoId: videoId,
                youtubeUrl: monitor.youtubeUrl,
                status: monitor.liveState || (monitor.isLive ? 'online' : 'offline'),
                isLive: monitor.liveState === 'online',
                failCount: monitor.failCount || 0,
                lastRenewSuccess: monitor.lastSuccessTime || monitor.lastUpdate,
                health: monitor.health,
                stalledCount: monitor.stalledCount,
                lastMediaSequence: monitor.lastMediaSequence
            });
        }
    }
    res.json({ totalMonitors: monitors.length, monitors });
});

// Rota /neonews com renovação assíncrona correta
app.get('/neonews/:videoId.m3u8', async (req, res) => {
    const videoId = req.params.videoId;
    const monitor = converter?.activeMonitors?.get(videoId);
    if (!monitor || !monitor.m3u8Url) {
        return res.status(404).send('Stream not found');
    }
    monitor.lastAccess = Date.now();
    const streamUrl = monitor.m3u8Url;
    const https = require('https');
    const http = require('http');
    try {
        const urlObj = new URL(streamUrl);
        const protocol = urlObj.protocol === 'https:' ? https : http;
        const request = protocol.get(streamUrl, async (proxyRes) => {
            if (proxyRes.statusCode === 403 || proxyRes.statusCode === 410) {
                console.log(`[${videoId}] URL expirada, solicitando renovação...`);
                try {
                    await monitor.requestRefresh();
                    const newUrl = monitor.m3u8Url;
                    if (newUrl && newUrl !== streamUrl) {
                        return res.redirect(`/neonews/${videoId}.m3u8`);
                    }
                } catch (err) {
                    console.error(`[${videoId}] Falha na renovação:`, err.message);
                }
                return res.status(502).send('Stream unavailable after renewal attempt');
            }
            if (proxyRes.statusCode !== 200) {
                return res.status(502).send('Stream error');
            }
            res.writeHead(200, {
                'Content-Type': 'application/vnd.apple.mpegurl',
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'no-cache'
            });
            proxyRes.pipe(res);
        });
        request.setTimeout(10000, () => {
            request.destroy();
            if (!res.headersSent) res.status(504).send('Timeout');
        });
        request.on('error', (err) => {
            console.error(`Proxy error for ${videoId}:`, err.message);
            if (!res.headersSent) res.status(500).send('Proxy error');
        });
    } catch (err) {
        console.error(`Invalid URL for ${videoId}:`, err.message);
        res.status(500).send('Invalid URL');
    }
});

app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok',
        version: '3.0.0',
        uptime: process.uptime(),
        activeMonitors: converter?.activeMonitors?.size || 0
    });
});

app.get('/stats', (req, res) => {
    res.json(converter.getLiveStats());
});

app.get('/admin/cookie', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/admin/cookie.html'));
});

app.get('/', (req, res) => {
    res.redirect('/dashboard.html');
});

app.post('/admin/test-recovery', async (req, res) => {
    try {
        const systemState = require('./systemState');
        if (systemState && systemState.sendRecoveryEmail) {
            let liveCount = converter?.activeMonitors?.size || 1;
            await systemState.sendRecoveryEmail(emailAlerts, liveCount);
            res.json({ success: true, message: 'E-mail de recuperação enviado!' });
        } else {
            res.json({ success: false, message: 'SystemState não disponível' });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

const scheduler = require('./globalScheduler');
app.get('/api/scheduler/stats', (req, res) => {
    if (converter && converter.scheduler) {
        res.json(converter.scheduler.getStats());
    } else {
        res.json({ error: 'Scheduler não disponível' });
    }
});

// Coletor de lixo (limpeza de lives encerradas) a cada 10 minutos
setInterval(() => {
    if (!converter?.activeMonitors) return;
    const now = Date.now();
    for (const [videoId, monitor] of converter.activeMonitors.entries()) {
        if (monitor.liveState === 'ended' && (now - (monitor.lastAccess || 0)) > 3600000) {
            console.log(`🧹 Removendo monitor da live encerrada: ${videoId}`);
            monitor.stopMonitoring();
            converter.activeMonitors.delete(videoId);
            for (const [url, data] of converter.liveCache.entries()) {
                if (data.videoId === videoId) {
                    converter.liveCache.delete(url);
                    break;
                }
            }
        }
    }
}, 600000);

app.listen(PORT, () => {
    console.log('========================================');
    console.log('NeoNews Live Converter V3 - SSOT + GlobalScheduler');
    console.log('========================================');
    console.log(`Dashboard: http://localhost:${PORT}/dashboard.html`);
    console.log(`Conversor: http://localhost:${PORT}/converter.html`);
    console.log(`API Health: http://localhost:${PORT}/health`);
    console.log('========================================\n');
});
