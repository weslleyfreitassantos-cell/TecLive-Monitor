const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { spawn } = require('child_process');
const session = require('express-session');
require('dotenv').config();

// ============================================================
// ✅ FORÇAR IPv4 (evita fallback lento do Node.js)
// ============================================================
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

// ============================================================
// ✅ AGENTES HTTP COM KEEPALIVE E MAX SOCKETS ALTO
// ============================================================
const http = require('http');
const https = require('https');

const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 30000
});
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 30000
});

// ============================================================

const app = express();
const PORT = process.env.PORT || 3002;

// ========== CONFIGURAÇÃO DE SESSÃO ==========
app.use(session({
    secret: process.env.SESSION_SECRET || 'neonews-super-secret-change-this',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 8 * 60 * 60 * 1000 }
}));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));

const cookiesDir = path.join(__dirname, 'cookies');
if (!fs.existsSync(cookiesDir)) fs.mkdirSync(cookiesDir, { recursive: true });

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
        let killTimeoutId = null;
        const timeoutId = setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
            killTimeoutId = setTimeout(() => {
                if (!child.killed) {
                    console.warn(`⚠️ yt-dlp (pid ${child.pid}) não respondeu a SIGTERM, forçando SIGKILL`);
                    try { child.kill('SIGKILL'); } catch (e) {}
                }
            }, 5000);
            reject(new Error(`Timeout após ${timeout}ms`));
        }, timeout);
        child.stdout.on('data', (data) => { stdout += data.toString(); });
        child.stderr.on('data', (data) => { stderr += data.toString(); });
        child.on('close', (code) => {
            clearTimeout(timeoutId);
            if (killTimeoutId) clearTimeout(killTimeoutId);
            if (timedOut) return;
            if (code === 0) resolve(stdout.trim());
            else reject(new Error(stderr.trim() || `Código de saída: ${code}`));
        });
        child.on('error', (err) => {
            clearTimeout(timeoutId);
            if (killTimeoutId) clearTimeout(killTimeoutId);
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

// ========== PERSISTÊNCIA ==========
const mappingFile = path.join(cookiesDir, 'monitors.json');

function getPersistedUrl(videoId) {
    try {
        const map = JSON.parse(fs.readFileSync(mappingFile, 'utf8'));
        return map[videoId] || null;
    } catch (e) { return null; }
}

function removePersistedMapping(videoId) {
    try {
        const map = JSON.parse(fs.readFileSync(mappingFile, 'utf8'));
        delete map[videoId];
        fs.writeFileSync(mappingFile, JSON.stringify(map, null, 2));
        console.log(`🗑️ Removido monitor persistido: ${videoId}`);
    } catch (e) { /* ignora se não existir */ }
}

// ========== CACHE COM PROMISE DEDUPLICADA ==========
const m3u8CachePromises = new Map(); // videoId -> Promise
const m3u8CacheContent = new Map(); // videoId -> { content, fetchedAt, sourceUrl }
const M3U8_CACHE_TTL = parseInt(process.env.M3U8_CACHE_TTL) || 5000;

const REFRESH_WAIT_MS = 10000;

const STALE_SERVE_MAX_AGE_MS = parseInt(process.env.STALE_MAX_AGE_MS) || 60000;

const lastGoodM3u8 = new Map(); // videoId -> { content, fetchedAt, sequence }

function rememberGoodM3u8(videoId, content) {
    const seq = parseM3u8Info(content).sequence;
    lastGoodM3u8.set(videoId, { content, fetchedAt: Date.now(), sequence: seq });
}

function getStaleM3u8IfFresh(videoId, monitorLastSeq) {
    const entry = lastGoodM3u8.get(videoId);
    if (!entry) return null;
    const age = Date.now() - entry.fetchedAt;
    if (age > STALE_SERVE_MAX_AGE_MS) return null;
    if (monitorLastSeq !== null && entry.sequence !== null) {
        const lag = monitorLastSeq - entry.sequence;
        if (lag > 5) {
            console.log(`[${videoId}] ⚠️ Stale muito atrasado (seq ${entry.sequence}, monitor em ${monitorLastSeq}, lag=${lag}), não servindo.`);
            return null;
        }
    }
    return { content: entry.content, age, sequence: entry.sequence };
}

async function fetchM3u8WithCache(videoId, url) {
    if (m3u8CachePromises.has(videoId)) {
        return m3u8CachePromises.get(videoId);
    }

    const cached = m3u8CacheContent.get(videoId);
    const now = Date.now();

    if (cached && cached.sourceUrl === url && (now - cached.fetchedAt) < M3U8_CACHE_TTL) {
        return { content: cached.content, fromCache: true };
    }

    if (cached && cached.sourceUrl !== url) {
        console.log(`[${videoId}] URL do monitor mudou, invalidando cache antigo.`);
        m3u8CacheContent.delete(videoId);
    }

    const promise = new Promise((resolve, reject) => {
        try {
            const urlObj = new URL(url);
            const protocol = urlObj.protocol === 'https:' ? https : http;
            let body = '';
            const request = protocol.get(url, {
                agent: urlObj.protocol === 'https:' ? httpsAgent : httpAgent
            }, (res) => {
                if (res.statusCode !== 200) {
                    const err = new Error(`Status ${res.statusCode}`);
                    err.statusCode = res.statusCode;
                    m3u8CachePromises.delete(videoId);
                    return reject(err);
                }
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    m3u8CacheContent.set(videoId, {
                        content: body,
                        fetchedAt: Date.now(),
                        sourceUrl: url
                    });
                    m3u8CachePromises.delete(videoId);
                    resolve({ content: body, fromCache: false });
                });
            });
            request.setTimeout(30000, () => {
                request.destroy();
                m3u8CachePromises.delete(videoId);
                reject(new Error('Timeout'));
            });
            request.on('error', (err) => {
                m3u8CachePromises.delete(videoId);
                reject(err);
            });
        } catch (err) {
            m3u8CachePromises.delete(videoId);
            reject(err);
        }
    });

    m3u8CachePromises.set(videoId, promise);
    return promise;
}

// ========== LOG DE ACESSO ==========
const lastServedSequence = new Map();

function parseM3u8Info(content) {
    const seqMatch = content.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/);
    const segments = (content.match(/#EXTINF:/g) || []).length;
    return {
        sequence: seqMatch ? parseInt(seqMatch[1], 10) : null,
        segments
    };
}

function logProxyAccess(videoId, { statusCode, fromCache, elapsedMs, content, stale, monitorSeq }) {
    let info = '';
    let lagInfo = '';
    if (content) {
        const { sequence, segments } = parseM3u8Info(content);
        const prev = lastServedSequence.get(videoId);
        let anomaly = '';
        if (prev && sequence !== null && sequence < prev.sequence) {
            const sinceLastMs = Date.now() - prev.servedAt;
            anomaly = ` ⚠️ SEQUENCE REGREDIU (${prev.sequence} → ${sequence}, ${sinceLastMs}ms)`;
        }
        if (sequence !== null) {
            lastServedSequence.set(videoId, { sequence, segments, servedAt: Date.now() });
            if (monitorSeq !== undefined && monitorSeq !== null) {
                const lag = monitorSeq - sequence;
                if (lag > 3) {
                    lagInfo = ` ⚠️ LAG=${lag} (monitor=${monitorSeq}, served=${sequence})`;
                } else {
                    lagInfo = ` lag=${lag}`;
                }
            }
        }
        info = ` seq=${sequence} segs=${segments}${anomaly}${lagInfo}`;
    }
    const staleTag = stale ? ` 🕒 STALE(${stale}ms)` : '';
    console.log(`[${videoId}] 📡 Acesso m3u8: status=${statusCode} cache=${fromCache ? 'HIT' : 'MISS'} ${elapsedMs}ms${info}${staleTag}`);
}

// ============================================================
// ✅ RASTREAMENTO DE VIEWERS POR IP ÚNICO
// ============================================================
const viewerAccess = new Map(); // videoId -> Map(ip -> timestamp)
const VIEWER_WINDOW_MS = 30000;

function normalizeIp(ip) {
    if (!ip) return 'unknown';
    if (ip.startsWith('::ffff:')) return ip.replace('::ffff:', '');
    return ip;
}

function trackViewer(videoId, ip) {
    const now = Date.now();
    if (!viewerAccess.has(videoId)) viewerAccess.set(videoId, new Map());
    const viewers = viewerAccess.get(videoId);
    viewers.set(ip, now);
    for (const [viewerIp, timestamp] of viewers.entries()) {
        if (now - timestamp > VIEWER_WINDOW_MS) viewers.delete(viewerIp);
    }
}

function getActiveViewers(videoId) {
    const now = Date.now();
    const viewers = viewerAccess.get(videoId);
    if (!viewers) return 0;
    for (const [ip, timestamp] of viewers.entries()) {
        if (now - timestamp > VIEWER_WINDOW_MS) viewers.delete(ip);
    }
    return viewers.size;
}

function getTotalViewers() {
    const now = Date.now();
    let total = 0;
    for (const viewers of viewerAccess.values()) {
        for (const [ip, timestamp] of viewers.entries()) {
            if (now - timestamp > VIEWER_WINDOW_MS) viewers.delete(ip);
        }
        total += viewers.size;
    }
    return total;
}

// ========== ROTAS ==========
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

app.get('/metrics', (req, res) => {
    if (!converter) return res.status(503).send('Service unavailable');
    const stats = converter.scheduler?.getStats() || {};
    res.set('Content-Type', 'text/plain');
    res.send(`
# HELP neonews_active_monitors Número de monitores ativos
# TYPE neonews_active_monitors gauge
neonews_active_monitors ${stats.activeMonitors || 0}
# HELP neonews_pool_running Workers em execução
# TYPE neonews_pool_running gauge
neonews_pool_running ${stats.pool?.running || 0}
# HELP neonews_pool_queued Workers na fila
# TYPE neonews_pool_queued gauge
neonews_pool_queued ${stats.pool?.queued || 0}
`);
});

// ========== PROXY HLS (COM SUPORTE A PARÂMETRO max E MASTER ARTIFICIAL) ==========
app.get('/neonews/:videoId.m3u8', async (req, res) => {
    const videoId = req.params.videoId;
    const reqStart = Date.now();
    
    // ============================================
    // ✅ HIERARQUIA DE QUALIDADE MÁXIMA
    // 1. ?max=XXX na URL (se válido)
    // 2. VIDEO_MAX_HEIGHT do .env
    // 3. 1080 (fallback)
    // ============================================
    const allowedHeights = [144, 240, 360, 480, 720, 1080];
    const envMaxHeight = parseInt(process.env.VIDEO_MAX_HEIGHT, 10) || 1080;
    const urlMaxHeight = parseInt(req.query.max, 10);
    
    let maxHeight = envMaxHeight;
    if (Number.isFinite(urlMaxHeight) && allowedHeights.includes(urlMaxHeight)) {
        maxHeight = urlMaxHeight;
        console.log(`[${videoId}] 📺 Qualidade forçada via URL: ${maxHeight}p`);
    } else if (req.query.max) {
        console.log(`[${videoId}] ⚠️ Valor inválido para 'max': ${req.query.max}. Usando padrão (${envMaxHeight}p).`);
    }

    let monitor = converter?.activeMonitors?.get(videoId);

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
        logProxyAccess(videoId, { statusCode: 404, fromCache: false, elapsedMs: Date.now() - reqStart });
        return res.status(404).send('Stream not found');
    }

    // Repassa o maxHeight para o monitor (para uso na geração do master ou fixo)
    monitor._currentMaxHeight = maxHeight;
    monitor.lastAccess = Date.now();

    // ============================================
    // ✅ RASTREAMENTO DE VIEWER (IP ÚNICO)
    // ============================================
    const clientIp = normalizeIp(
        req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
        req.socket.remoteAddress ||
        req.ip
    );
    trackViewer(videoId, clientIp);

    // ============================================
    // VERIFICA SE O MONITOR TEM UM MASTER ARTIFICIAL
    // ============================================
    if (monitor._masterContent && monitor._masterContent.isMaster) {
        console.log(`[${videoId}] 📦 Servindo master artificial (ABR) com maxHeight=${maxHeight}.`);
        const content = monitor._masterContent.content;
        res.writeHead(200, {
            'Content-Type': 'application/vnd.apple.mpegurl',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-cache',
            'X-Master': 'true'
        });
        res.end(content);
        return;
    }

    try {
        const result = await fetchM3u8WithCache(videoId, monitor.m3u8Url);

        // ============================================
        // TRATAMENTO DO MASTER ARTIFICIAL (via cache)
        // ============================================
        let contentToServe = result.content;
        let isMaster = false;

        if (result.fromCache && typeof result.content === 'object' && result.content.isMaster) {
            contentToServe = result.content.content;
            isMaster = true;
        } else if (!result.fromCache && typeof result.content === 'object' && result.content.isMaster) {
            contentToServe = result.content.content;
            isMaster = true;
            m3u8CacheContent.set(videoId, {
                content: contentToServe,
                fetchedAt: Date.now(),
                sourceUrl: monitor.m3u8Url
            });
        }

        if (!isMaster) {
            const parsed = parseM3u8Info(contentToServe);
            if (parsed.sequence !== null) {
                if (monitor.lastMediaSequence === null || parsed.sequence > monitor.lastMediaSequence) {
                    rememberGoodM3u8(videoId, contentToServe);
                } else {
                    console.log(`[${videoId}] Sequência não avançou (${parsed.sequence}), não atualizando lastGood.`);
                }
            } else {
                rememberGoodM3u8(videoId, contentToServe);
            }
        } else {
            console.log(`[${videoId}] 📦 Servindo manifesto master (ABR) via cache.`);
        }

        const monitorSeq = monitor.lastMediaSequence;
        logProxyAccess(videoId, {
            statusCode: 200,
            fromCache: result.fromCache,
            elapsedMs: Date.now() - reqStart,
            content: contentToServe,
            monitorSeq: isMaster ? undefined : monitorSeq
        });

        res.writeHead(200, {
            'Content-Type': 'application/vnd.apple.mpegurl',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-cache',
            'X-Cache': result.fromCache ? 'HIT' : 'MISS',
            'X-Master': isMaster ? 'true' : 'false'
        });
        res.end(contentToServe);

    } catch (err) {
        const isExpired = err.statusCode === 403 || err.statusCode === 410;
        const isNetworkError = err.code === 'ECONNRESET' ||
                               err.code === 'ETIMEDOUT' ||
                               err.code === 'EPIPE' ||
                               err.message.includes('socket hang up') ||
                               err.message.includes('EOF');

        if (isExpired || isNetworkError) {
            console.log(`[${videoId}] ${isExpired ? 'URL expirada' : 'Erro de rede'} (${err.code || err.statusCode}), disparando renovação...`);
            m3u8CacheContent.delete(videoId);
            m3u8CachePromises.delete(videoId);

            const refreshPromise = monitor.requestRefresh().catch(refreshErr => {
                console.error(`[${videoId}] Falha na renovação:`, refreshErr.message);
            });

            const outcome = await Promise.race([
                refreshPromise.then(() => 'done'),
                new Promise(resolve => setTimeout(() => resolve('timeout'), REFRESH_WAIT_MS))
            ]);

            if (outcome === 'done' && monitor.m3u8Url) {
                try {
                    const renewed = await fetchM3u8WithCache(videoId, monitor.m3u8Url);
                    let renewedContent = renewed.content;
                    let isRenewedMaster = false;
                    if (typeof renewed.content === 'object' && renewed.content.isMaster) {
                        renewedContent = renewed.content.content;
                        isRenewedMaster = true;
                        m3u8CacheContent.set(videoId, {
                            content: renewedContent,
                            fetchedAt: Date.now(),
                            sourceUrl: monitor.m3u8Url
                        });
                    }
                    if (!isRenewedMaster) {
                        rememberGoodM3u8(videoId, renewedContent);
                    }
                    logProxyAccess(videoId, {
                        statusCode: 200,
                        fromCache: renewed.fromCache,
                        elapsedMs: Date.now() - reqStart,
                        content: renewedContent,
                        monitorSeq: isRenewedMaster ? undefined : monitor.lastMediaSequence
                    });
                    res.writeHead(200, {
                        'Content-Type': 'application/vnd.apple.mpegurl',
                        'Access-Control-Allow-Origin': '*',
                        'Cache-Control': 'no-cache',
                        'X-Master': isRenewedMaster ? 'true' : 'false'
                    });
                    return res.end(renewedContent);
                } catch (renewErr) {
                    console.error(`[${videoId}] Falha ao buscar m3u8 após renovação:`, renewErr.message);
                }
            }

            if (!res.headersSent) {
                const stale = getStaleM3u8IfFresh(videoId, monitor.lastMediaSequence);
                if (stale) {
                    logProxyAccess(videoId, {
                        statusCode: 200,
                        fromCache: false,
                        elapsedMs: Date.now() - reqStart,
                        content: stale.content,
                        stale: stale.age,
                        monitorSeq: monitor.lastMediaSequence
                    });
                    res.writeHead(200, {
                        'Content-Type': 'application/vnd.apple.mpegurl',
                        'Access-Control-Allow-Origin': '*',
                        'Cache-Control': 'no-cache',
                        'X-Stale': 'true'
                    });
                    return res.end(stale.content);
                }

                console.log(`[${videoId}] Renovação não concluiu em ${REFRESH_WAIT_MS}ms, respondendo 503.`);
                logProxyAccess(videoId, { statusCode: 503, fromCache: false, elapsedMs: Date.now() - reqStart });
                res.set('Retry-After', '2');
                return res.status(503).send('Stream renewing, retry shortly');
            }
        }

        console.error(`[${videoId}] Proxy error:`, err.message);
        if (!res.headersSent) {
            logProxyAccess(videoId, { statusCode: 500, fromCache: false, elapsedMs: Date.now() - reqStart });
            res.status(500).send('Proxy error');
        }
    }
});

// ========== AUTENTICAÇÃO E DASHBOARD ==========
function isAuthenticated(req, res, next) {
    if (req.session && req.session.admin === true) return next();
    res.redirect('/admin-login');
}

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

// ========== ROTA /api/monitors (COM VIEWERS) ==========
app.get('/api/monitors', isAuthenticated, (req, res) => {
    const monitors = [];
    if (converter && converter.activeMonitors) {
        for (const [videoId, monitor] of converter.activeMonitors.entries()) {
            monitors.push({
                videoId,
                youtubeUrl: monitor.youtubeUrl,
                status: monitor.liveState || (monitor.isLive ? 'online' : 'offline'),
                isLive: monitor.liveState === 'online',
                failCount: monitor.failCount || 0,
                lastRenewSuccess: monitor.lastSuccessTime || monitor.lastUpdate,
                health: monitor.health,
                stalledCount: monitor.stalledCount,
                lastMediaSequence: monitor.lastMediaSequence,
                viewers: getActiveViewers(videoId)
            });
        }
    }
    res.json({ totalMonitors: monitors.length, totalViewers: getTotalViewers(), monitors });
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

app.get('/api/scheduler/stats', isAuthenticated, (req, res) => {
    if (converter && converter.scheduler) {
        res.json(converter.scheduler.getStats());
    } else {
        res.json({ error: 'Scheduler não disponível' });
    }
});

// ========== INICIALIZAÇÃO ==========
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

// ========== CARREGAR MONITORES PERSISTIDOS ==========
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

// Verificação periódica de cookies
setInterval(async () => {
    if (!converter?.cookieRotator) return;
    const hasValid = converter.cookieRotator.hasValidCookies();
    if (!hasValid) {
        console.log('⚠️ Nenhum cookie válido detectado! Enviando alerta...');
        if (emailAlerts && emailAlerts.sendEmailAlert) {
            emailAlerts.sendEmailAlert(
                '🔴 CRÍTICO - Nenhum cookie funcional',
                'O sistema não possui nenhum cookie válido no momento.\n\nAções: Substitua os cookies imediatamente no dashboard.\n\nSem cookies, o sistema não conseguirá monitorar novas lives ou renovar m3u8.',
                'no_valid_cookies'
            );
        }
    }
}, 30 * 60 * 1000);

// ========== COLETOR DE LIXO ==========
setInterval(() => {
    if (!converter?.activeMonitors) return;
    const now = Date.now();
    for (const [videoId, monitor] of converter.activeMonitors.entries()) {
        if (monitor.liveState === 'ended' && (now - (monitor._liveEndedAt || monitor.lastAccess || 0)) > 3600000) {
            console.log(`🧹 Removendo monitor da live encerrada: ${videoId}`);
            monitor.stopMonitoring();
            converter.activeMonitors.delete(videoId);
            removePersistedMapping(videoId);
            m3u8CacheContent.delete(videoId);
            m3u8CachePromises.delete(videoId);
            lastGoodM3u8.delete(videoId);
            lastServedSequence.delete(videoId);
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
    console.log(`Métricas: http://localhost:${PORT}/metrics`);
    console.log('========================================\n');
});