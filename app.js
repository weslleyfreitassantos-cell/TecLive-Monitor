const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { spawn } = require('child_process');
const session = require('express-session');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3002;

// ========== CONFIGURAÇÃO DE SESSÃO ==========
app.use(session({
    secret: process.env.SESSION_SECRET || 'neonews-super-secret-change-this',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 8 * 60 * 60 * 1000 } // 8 horas
}));

// Middlewares
app.use(express.urlencoded({ extended: true }));
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

// ========== FUNÇÕES DE PERSISTÊNCIA DE MAPEAMENTO ==========
const mappingFile = path.join(cookiesDir, 'monitors.json');

function getPersistedUrl(videoId) {
    try {
        const map = JSON.parse(fs.readFileSync(mappingFile, 'utf8'));
        return map[videoId] || null;
    } catch (e) {
        return null;
    }
}

// ========== CACHE LOCAL DO M3U8 COM VALIDAÇÃO DE URL ==========
const m3u8Cache = new Map(); // videoId -> { content, fetchedAt, sourceUrl, pending, waiters }
const M3U8_CACHE_TTL = 4000; // 4 segundos — mantido, mas a renovação será mais ágil

async function fetchM3u8WithCache(videoId, url) {
    const cached = m3u8Cache.get(videoId);
    const now = Date.now();

    // Se cache existe, URL bate e não expirou, retorna do cache
    if (cached && cached.sourceUrl === url && (now - cached.fetchedAt) < M3U8_CACHE_TTL) {
        return { content: cached.content, fromCache: true };
    }

    // Se a URL mudou, invalida o cache antigo
    if (cached && cached.sourceUrl !== url) {
        console.log(`[${videoId}] URL mudou, invalidando cache antigo.`);
        m3u8Cache.delete(videoId);
    }

    // Se já tem uma busca em andamento para esse videoId, aguarda ela
    if (cached && cached.pending) {
        return new Promise((resolve, reject) => {
            cached.waiters = cached.waiters || [];
            cached.waiters.push({ resolve, reject });
        });
    }

    // Marca como em andamento
    m3u8Cache.set(videoId, {
        ...(cached || {}),
        pending: true,
        waiters: [],
        sourceUrl: url
    });

    return new Promise((resolve, reject) => {
        const https = require('https');
        const http = require('http');
        try {
            const urlObj = new URL(url);
            const protocol = urlObj.protocol === 'https:' ? https : http;
            let body = '';
            const request = protocol.get(url, (res) => {
                if (res.statusCode !== 200) {
                    const err = new Error(`Status ${res.statusCode}`);
                    err.statusCode = res.statusCode;
                    const entry = m3u8Cache.get(videoId);
                    if (entry && entry.waiters) {
                        entry.waiters.forEach(w => w.reject(err));
                    }
                    m3u8Cache.delete(videoId);
                    return reject(err);
                }
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    const entry = m3u8Cache.get(videoId);
                    const waiters = (entry && entry.waiters) || [];
                    m3u8Cache.set(videoId, {
                        content: body,
                        fetchedAt: Date.now(),
                        pending: false,
                        sourceUrl: url,
                        waiters: []
                    });
                    waiters.forEach(w => w.resolve({ content: body, fromCache: false }));
                    resolve({ content: body, fromCache: false });
                });
            });
            // Timeout reduzido para 7 segundos (7000 ms)
            request.setTimeout(7000, () => {
                request.destroy();
                const entry = m3u8Cache.get(videoId);
                if (entry && entry.waiters) {
                    entry.waiters.forEach(w => w.reject(new Error('Timeout')));
                }
                m3u8Cache.delete(videoId);
                reject(new Error('Timeout'));
            });
            request.on('error', (err) => {
                const entry = m3u8Cache.get(videoId);
                if (entry && entry.waiters) {
                    entry.waiters.forEach(w => w.reject(err));
                }
                m3u8Cache.delete(videoId);
                reject(err);
            });
        } catch (err) {
            m3u8Cache.delete(videoId);
            reject(err);
        }
    });
}

// ========== ROTAS PÚBLICAS ==========
app.get('/converter.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/converter.html'));
});

app.post('/api/convert', async (req, res) => {
    const { youtubeUrl } = req.body;
    if (!youtubeUrl) return res.status(400).json({ success: false, error: 'URL obrigatoria' });
    const baseUrl = process.env.BASE_URL || 'http://localhost:' + PORT;
    const result = await converter.convert(youtubeUrl, baseUrl);
    res.json(result);
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

// ========== ROTA DE PROXY COM CACHE E RENOVAÇÃO TRANSPARENTE ==========
app.get('/neonews/:videoId.m3u8', async (req, res) => {
    const videoId = req.params.videoId;
    let monitor = converter?.activeMonitors?.get(videoId);

    // Tenta recriar o monitor a partir do mapeamento persistido se ele não existir
    if (!monitor) {
        const youtubeUrl = getPersistedUrl(videoId);
        if (youtubeUrl) {
            console.log(`[${videoId}] Monitor ausente, recriando a partir do persistido...`);
            const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
            try {
                await converter.convert(youtubeUrl, baseUrl);
                monitor = converter.activeMonitors.get(videoId);
            } catch (err) {
                console.error(`[${videoId}] Falha ao recriar monitor:`, err.message);
            }
        }
    }

    if (!monitor || !monitor.m3u8Url) {
        return res.status(404).send('Stream not found');
    }

    monitor.lastAccess = Date.now();

    try {
        const result = await fetchM3u8WithCache(videoId, monitor.m3u8Url);

        res.writeHead(200, {
            'Content-Type': 'application/vnd.apple.mpegurl',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-cache',
            'X-Cache': result.fromCache ? 'HIT' : 'MISS'
        });
        res.end(result.content);

    } catch (err) {
        // Verifica se o erro é de expiração (403/410) OU erro de rede (ECONNRESET, ETIMEDOUT, etc.)
        const isExpired = err.statusCode === 403 || err.statusCode === 410;
        const isNetworkError = err.code === 'ECONNRESET' ||
                               err.code === 'ETIMEDOUT' ||
                               err.code === 'EPIPE' ||
                               err.message.includes('socket hang up') ||
                               err.message.includes('EOF');

        if (isExpired || isNetworkError) {
            console.log(`[${videoId}] ${isExpired ? 'URL expirada' : 'Erro de rede'} (${err.code || err.statusCode}), renovando...`);

            // Invalida o cache antes de renovar
            m3u8Cache.delete(videoId);

            try {
                await monitor.requestRefresh();
                const renewed = await fetchM3u8WithCache(videoId, monitor.m3u8Url);
                res.writeHead(200, {
                    'Content-Type': 'application/vnd.apple.mpegurl',
                    'Access-Control-Allow-Origin': '*',
                    'Cache-Control': 'no-cache'
                });
                return res.end(renewed.content);
            } catch (renewErr) {
                console.error(`[${videoId}] Falha na renovação:`, renewErr.message);
                if (!res.headersSent) return res.status(502).send('Stream unavailable');
            }
        }

        console.error(`[${videoId}] Proxy error:`, err.message);
        if (!res.headersSent) res.status(500).send('Proxy error');
    }
});

// ========== MIDDLEWARE DE AUTENTICAÇÃO ==========
function isAuthenticated(req, res, next) {
    if (req.session && req.session.admin === true) {
        return next();
    }
    res.redirect('/admin-login');
}

// ========== ROTAS DE AUTENTICAÇÃO ==========
app.get('/admin-login', (req, res) => {
    if (req.session.admin) return res.redirect('/dashboard');
    res.sendFile(path.join(__dirname, 'public/admin-login.html'));
});

app.post('/admin-login', (req, res) => {
    const { password } = req.body;
    const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
    if (password === adminPassword) {
        req.session.admin = true;
        return res.redirect('/dashboard');
    }
    res.redirect('/admin-login?error=1');
});

app.get('/admin-logout', (req, res) => {
    req.session.destroy();
    res.redirect('/admin-login');
});

// ========== ROTAS PROTEGIDAS ==========
app.get('/dashboard', isAuthenticated, (req, res) => {
    res.sendFile(path.join(__dirname, 'public/dashboard.html'));
});

app.get('/api/cookie/functional-status', isAuthenticated, (req, res) => {
    if (!converter || !converter.cookieRotator) {
        return res.status(500).json({ error: 'CookieRotator não disponível' });
    }
    const functional = converter.cookieRotator.getFunctionalStatus();
    res.json({ functional, timestamp: new Date().toISOString() });
});

app.get('/api/monitors', isAuthenticated, (req, res) => {
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

app.get('/api/cookie/status', isAuthenticated, (req, res) => {
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

// ========== ROTA DE UPLOAD COMPLETA (COM SYNC NO COOKIEROTATOR) ==========
app.post('/api/cookie/upload', isAuthenticated, upload.single('cookie'), async (req, res) => {
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

        if (!isLegacy && converter && converter.cookieRotator) {
            const cookieKey = `cookie${targetType}.txt`;
            converter.cookieRotator.status[cookieKey] = {
                state: 'valid',
                failCount: 0,
                lastFailure: null,
                lastSuccess: new Date().toISOString(),
                reason: null
            };
            converter.cookieRotator.saveStatus();
            console.log(`🔄 CookieRotator: ${cookieKey} marcado como 'valid' após upload`);
        }

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

app.get('/admin/cookie', isAuthenticated, (req, res) => {
    res.sendFile(path.join(__dirname, 'public/admin/cookie.html'));
});

app.post('/admin/test-recovery', isAuthenticated, async (req, res) => {
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

const scheduler = require('./globalScheduler'); // compatibilidade
app.get('/api/scheduler/stats', isAuthenticated, (req, res) => {
    if (converter && converter.scheduler) {
        res.json(converter.scheduler.getStats());
    } else {
        res.json({ error: 'Scheduler não disponível' });
    }
});

// ========== INICIALIZAÇÃO DO CONVERTER ==========
const EmailAlerts = require('./alerts/emailAlerts');
const ConvertAPI = require('./api/convert');
const emailAlerts = new EmailAlerts();
converter = new ConvertAPI(emailAlerts);

if (emailAlerts && converter.cookieRotator) {
    emailAlerts.setCookieRotator(converter.cookieRotator);
    console.log('📧 CookieRotator injetado no EmailAlerts');
} else {
    console.log('⚠️ Não foi possível injetar CookieRotator no EmailAlerts');
}

// ========== CARREGAR MONITORES PERSISTIDOS NO BOOT ==========
(async function loadPersistedMonitors() {
    try {
        const map = JSON.parse(fs.readFileSync(mappingFile, 'utf8'));
        const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
        console.log(`♻️ Carregando ${Object.keys(map).length} monitores persistidos...`);
        for (const [videoId, youtubeUrl] of Object.entries(map)) {
            if (!converter.activeMonitors.has(videoId)) {
                console.log(`♻️ Recriando monitor persistido: ${videoId}`);
                try {
                    await converter.convert(youtubeUrl, baseUrl);
                } catch (err) {
                    console.error(`❌ Falha ao recriar monitor ${videoId}:`, err.message);
                }
            }
        }
        console.log(`✅ ${converter.activeMonitors.size} monitores ativos após boot.`);
    } catch (e) {
        console.log('ℹ️ Nenhum arquivo de persistência encontrado ou vazio.');
    }
})();

// Verificação periódica de cookies válidos (a cada 30 min)
setInterval(async () => {
    if (!converter?.cookieRotator) return;
    const hasValid = converter.cookieRotator.hasValidCookies();
    if (!hasValid) {
        console.log('⚠️ Nenhum cookie válido detectado! Enviando alerta...');
        if (emailAlerts && emailAlerts.sendEmailAlert) {
            const subject = '🔴 CRÍTICO - Nenhum cookie funcional';
            const message = 'O sistema não possui nenhum cookie válido no momento.\n\nAções: Substitua os cookies imediatamente no dashboard.\n\nSem cookies, o sistema não conseguirá monitorar novas lives ou renovar m3u8.';
            emailAlerts.sendEmailAlert(subject, message, 'no_valid_cookies');
        }
    }
}, 30 * 60 * 1000);

// ========== COLETOR DE LIXO DE LIVES ENCERRADAS ==========
setInterval(() => {
    if (!converter?.activeMonitors) return;
    const now = Date.now();
    for (const [videoId, monitor] of converter.activeMonitors.entries()) {
        if (monitor.liveState === 'ended' && (now - (monitor._liveEndedAt || monitor.lastAccess || 0)) > 3600000) {
            console.log(`🧹 Removendo monitor da live encerrada: ${videoId}`);
            monitor.stopMonitoring();
            converter.activeMonitors.delete(videoId);
            // Limpa cache também
            m3u8Cache.delete(videoId);
            for (const [url, data] of converter.liveCache.entries()) {
                if (data.videoId === videoId) {
                    converter.liveCache.delete(url);
                    break;
                }
            }
        }
    }
}, 600000);

app.get('/', (req, res) => {
    res.redirect('/converter.html');
});

app.listen(PORT, () => {
    console.log('========================================');
    console.log('NeoNews Live Converter V3 - SSOT + GlobalScheduler');
    console.log('========================================');
    console.log(`Conversor público: http://localhost:${PORT}/converter.html`);
    console.log(`Dashboard protegido: http://localhost:${PORT}/dashboard`);
    console.log(`API Health: http://localhost:${PORT}/health`);
    console.log('========================================\n');
});