const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { spawn } = require('child_process');
const session = require('express-session');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const CookieRefreshQueue = require('./services/cookieRefreshQueue');
const {
    PlaybackSessionStore,
    sessionPreview
} = require('./services/playbackSessionStore');
const { parseTrustProxyConfig, resolveBindHost } = require('./services/httpRuntimeConfig');
const {
    buildMonitorHealth,
    buildSystemHealth,
    getMonitorDisplayStatus
} = require('./services/healthSnapshot');
const {
    CLASSIFICATION,
    classifyYtdlpError,
    getYtdlpDiagnostics,
    buildYtdlpDumpJsonArgs,
    selectHlsStream,
    sanitizeYtdlpMessage
} = require('./services/ytdlpStreamSelector');
require('dotenv').config();

// ============================================================
// ✅ FORÇAR IPv4
// ============================================================
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

// ============================================================
// ✅ AGENTES HTTP COM KEEPALIVE
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
const BIND_HOST = resolveBindHost();
const TRUST_PROXY = parseTrustProxyConfig(process.env.TRUST_PROXY);
app.set('trust proxy', TRUST_PROXY.value);

function normalizedIpKey(req) {
    const ip = normalizeIp(req.ip || req.socket?.remoteAddress || 'unknown');
    return rateLimit.ipKeyGenerator ? rateLimit.ipKeyGenerator(ip) : ip;
}

function createJsonRateLimiter({ windowMs, limit, error }) {
    return rateLimit({
        windowMs,
        limit,
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator: normalizedIpKey,
        message: { success: false, error },
        handler: (req, res, next, options) => {
            res.status(options.statusCode).json(options.message);
        }
    });
}

const adminLoginLimiter = createJsonRateLimiter({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    error: 'admin_login_rate_limited'
});

const adminApiLimiter = createJsonRateLimiter({
    windowMs: 60 * 1000,
    limit: 120,
    error: 'admin_api_rate_limited'
});

const publicApiLimiter = createJsonRateLimiter({
    windowMs: 60 * 1000,
    limit: 600,
    error: 'public_api_rate_limited'
});

const cookieAgentLimiter = createJsonRateLimiter({
    windowMs: 60 * 1000,
    limit: 120,
    error: 'cookie_agent_rate_limited'
});

// ========== CONFIGURAÇÃO DE SESSÃO ==========
app.use(session({
    secret: process.env.SESSION_SECRET || 'neonews-super-secret-change-this',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: false, 
        maxAge: 30 * 24 * 60 * 60 * 1000 // 30 DIAS
    }
}));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));

const cookiesDir = path.join(__dirname, 'cookies');
if (!fs.existsSync(cookiesDir)) fs.mkdirSync(cookiesDir, { recursive: true });
const cookieRefreshQueue = new CookieRefreshQueue({
    filePath: path.join(__dirname, 'data', 'cookie-refresh-jobs.json')
});
const playbackSessions = new PlaybackSessionStore({
    filePath: path.join(__dirname, 'data', 'playback-sessions.json')
});
const removedPlaybackSessionsOnStartup = playbackSessions.pruneExpired();
if (removedPlaybackSessionsOnStartup > 0) {
    console.log(`🧹 ${removedPlaybackSessionsOnStartup} sessão(ões) HLS expirada(s) removida(s) na inicialização.`);
}

// ========== ARQUIVO DE CLIENTES ==========
const clientesFile = path.join(cookiesDir, 'clientes.json');
function getClientes() {
    try {
        return JSON.parse(fs.readFileSync(clientesFile, 'utf8'));
    } catch (e) {
        return [];
    }
}
function salvarClientes(clientes) {
    fs.writeFileSync(clientesFile, JSON.stringify(clientes, null, 2));
}

// ========== PERSISTÊNCIA DE TOKENS ==========
const tokensFile = path.join(cookiesDir, 'tokens.json');

function loadTokens() {
    try {
        const data = JSON.parse(fs.readFileSync(tokensFile, 'utf8'));
        return data;
    } catch (e) {
        return {};
    }
}

function saveTokens(tokens) {
    fs.writeFileSync(tokensFile, JSON.stringify(tokens, null, 2));
}

let tokenMap = loadTokens(); // token -> { videoId, owner }

function getOrCreateToken(videoId, owner) {
    const key = owner ? `${videoId}:${owner}` : videoId;
    for (const [token, value] of Object.entries(tokenMap)) {
        if (value.videoId === videoId && value.owner === owner) {
            return token;
        }
    }
    const token = crypto.randomBytes(16).toString('hex');
    tokenMap[token] = { videoId, owner };
    saveTokens(tokenMap);
    return token;
}

function revokeToken(token) {
    if (tokenMap[token]) {
        delete tokenMap[token];
        saveTokens(tokenMap);
        return true;
    }
    return false;
}

function getTokenInfo(token) {
    return tokenMap[token] || null;
}

// ========== PERSISTÊNCIA DE DISPOSITIVOS ATIVOS ==========
const ownerViewersFile = path.join(cookiesDir, 'ownerViewers.json');

function loadOwnerViewers() {
    try {
        const data = JSON.parse(fs.readFileSync(ownerViewersFile, 'utf8'));
        const map = new Map();
        const now = Date.now();
        const windowMs = parseInt(process.env.VIEWER_WINDOW_MS) || 7200000;
        let totalLoaded = 0, totalExpired = 0;
        for (const [key, viewers] of Object.entries(data)) {
            const innerMap = new Map();
            for (const [ip, timestamp] of Object.entries(viewers)) {
                if (now - timestamp <= windowMs) {
                    innerMap.set(ip, timestamp);
                    totalLoaded++;
                } else {
                    totalExpired++;
                }
            }
            if (innerMap.size > 0) {
                map.set(key, innerMap);
            }
        }
        console.log(`📱 Carregados ${map.size} chaves (owner:videoId) com dispositivos ativos. ${totalLoaded} ativos, ${totalExpired} expirados descartados.`);
        return map;
    } catch (e) {
        console.log('ℹ️ Nenhum arquivo de dispositivos persistidos encontrado ou vazio.');
        return new Map();
    }
}

function saveOwnerViewers(viewersMap) {
    try {
        const data = {};
        for (const [key, innerMap] of viewersMap.entries()) {
            data[key] = Object.fromEntries(innerMap);
        }
        fs.writeFileSync(ownerViewersFile, JSON.stringify(data, null, 2));
    } catch (e) {
        console.warn('Erro ao salvar dispositivos ativos:', e.message);
    }
}

// ========== PERSISTÊNCIA DO VIEWER ACCESS ==========
const viewerAccessFile = path.join(cookiesDir, 'viewerAccess.json');

function loadViewerAccess() {
    try {
        const data = JSON.parse(fs.readFileSync(viewerAccessFile, 'utf8'));
        const map = new Map();
        const now = Date.now();
        const windowMs = parseInt(process.env.VIEWER_WINDOW_MS) || 7200000;
        for (const [key, ips] of Object.entries(data)) {
            const innerMap = new Map();
            for (const [ip, timestamp] of Object.entries(ips)) {
                if (now - timestamp <= windowMs) {
                    innerMap.set(ip, timestamp);
                }
            }
            if (innerMap.size > 0) {
                map.set(key, innerMap);
            }
        }
        console.log(`📡 Carregados ${map.size} chaves com viewerAccess.`);
        return map;
    } catch (e) {
        console.log('ℹ️ Nenhum arquivo de viewerAccess encontrado ou vazio.');
        return new Map();
    }
}

function saveViewerAccess(viewerMap) {
    try {
        const data = {};
        for (const [key, innerMap] of viewerMap.entries()) {
            data[key] = Object.fromEntries(innerMap);
        }
        fs.writeFileSync(viewerAccessFile, JSON.stringify(data, null, 2));
    } catch (e) {
        console.warn('Erro ao salvar viewerAccess:', e.message);
    }
}

// ========== PERSISTÊNCIA DE MONITORES ATIVOS ==========

async function restoreMonitorsPersistence() {
    try {
        if (!fs.existsSync(mappingFile)) return;
        const data = JSON.parse(fs.readFileSync(mappingFile, 'utf8'));
        const entries = Object.entries(data);
        console.log(`🚀 Restaurando ${entries.length} monitores da última sessão...`);
        
        const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
        
        for (const [key, entry] of entries) {
            try {
                const owner = key.includes(':') ? key.split(':')[1] : null;
                if (entry.youtubeUrl) {
                    const keyVideoId = key.includes(':') ? key.split(':')[0] : key;
                    const extractedVideoId = converter.extractVideoId(entry.youtubeUrl);
                    const restoreVideoId = extractedVideoId === 'url_invalida' ? keyVideoId : extractedVideoId;
                    const result = await converter.convert(entry.youtubeUrl, baseUrl, owner, { automatic: true });
                    if (result?.success && converter.activeMonitors.has(key)) {
                        console.log(`✅ Monitor restaurado: ${key}`);
                    } else {
                        console.warn(`⚠️ Monitor não restaurado ${key}: ${result?.classification || 'unknown'} - ${result?.message || result?.error || 'sem stream ativa'}`);
                        if (isTerminalRestoreClassification(result?.classification)) {
                            removePersistedMapping(restoreVideoId, owner);
                            console.log(`🧹 Monitor persistido terminal removido apos restore: ${key} (${result.classification})`);
                        } else if (restoreVideoId && typeof converter.clearExtractionBackoff === 'function') {
                            converter.clearExtractionBackoff(restoreVideoId, owner);
                            console.log(`🧹 Estado de extracao de restore nao restaurado limpo: ${key}`);
                        }
                    }
                }
            } catch (err) {
                console.warn(`❌ Falha ao restaurar monitor ${key}:`, err.message);
            }
        }
    } catch (e) {
        console.warn('Erro ao restaurar persistência de monitores:', e.message);
    }
}

// ========== MAPA DE VIEWERS ==========
let ownerViewers = loadOwnerViewers();
let viewerAccess = loadViewerAccess();

function isLocalIp(ip) {
    if (!ip) return true;
    if (ip === '127.0.0.1' || ip === 'localhost') return true;
    if (ip === '::1' || ip === '0:0:0:0:0:0:0:1') return true;
    if (ip === '::ffff:127.0.0.1') return true;
    return false;
}

// ============================================================
// RASTREAMENTO DE VIEWERS
// ============================================================
const VIEWER_WINDOW_MS = parseInt(process.env.VIEWER_WINDOW_MS) || 7200000; // 2 horas por padrão

function normalizeIp(ip) {
    if (!ip) return 'unknown';
    if (typeof ip === 'string' && ip.includes('::ffff:')) {
        return ip.replace('::ffff:', '');
    }
    if (ip === '::1' || ip === '0:0:0:0:0:0:0:1') return '127.0.0.1';
    return ip;
}

function getRequestIp(req) {
    return normalizeIp(req.ip || req.socket?.remoteAddress || 'unknown');
}

// Limpeza periódica global de IPs inativos (a cada 15 segundos)
setInterval(() => {
    const now = Date.now();
    let changed = false;
    
    for (const [key, viewers] of ownerViewers.entries()) {
        for (const [ip, timestamp] of viewers.entries()) {
            if (now - timestamp > VIEWER_WINDOW_MS) {
                viewers.delete(ip);
                changed = true;
                console.log(`🧹 [LIMPEZA] Dispositivo ${ip} removido de ${key} por inatividade.`);
            }
        }
        if (viewers.size === 0) {
            ownerViewers.delete(key);
            changed = true;
        }
    }
    if (changed) saveOwnerViewers(ownerViewers);

    let accessChanged = false;
    for (const [key, viewers] of viewerAccess.entries()) {
        for (const [ip, timestamp] of viewers.entries()) {
            if (now - timestamp > VIEWER_WINDOW_MS) {
                viewers.delete(ip);
                accessChanged = true;
            }
        }
        if (viewers.size === 0) {
            viewerAccess.delete(key);
            accessChanged = true;
        }
    }
    if (accessChanged) saveViewerAccess(viewerAccess);
}, 15000);

setInterval(() => {
    const removed = playbackSessions.pruneExpired();
    if (removed > 0) {
        console.log(`🧹 ${removed} sessão(ões) HLS expirada(s) removida(s).`);
    }
}, Math.max(30000, Math.min(playbackSessions.ttlMs, 60000)));

function trackViewer(owner, videoId, ip, userAgent = '', localIp = null) {
    const now = Date.now();
    const key = owner ? `${owner}:${videoId}` : videoId;
    if (!viewerAccess.has(key)) viewerAccess.set(key, new Map());
    const viewers = viewerAccess.get(key);
    
    const deviceId = localIp ? `${ip}|${userAgent}|${localIp}` : `${ip}|${userAgent}`;
    
    if (viewers.has(ip)) {
        viewers.delete(ip);
    }
    const oldDeviceId = `${ip}|${userAgent}`;
    if (localIp && viewers.has(oldDeviceId)) {
        viewers.delete(oldDeviceId);
    }
    
    viewers.set(deviceId, now);
    
    for (const [id, timestamp] of viewers.entries()) {
        if (now - timestamp > VIEWER_WINDOW_MS) viewers.delete(id);
    }
    saveViewerAccess(viewerAccess);
}

function trackViewerByOwner(owner, ip, videoId, userAgent = '', localIp = null) {
    if (!owner || !videoId) return;
    if (isLocalIp(ip)) return;
    
    const now = Date.now();
    const currentKey = `${owner}:${videoId}`;
    const deviceId = localIp ? `${ip}|${userAgent}|${localIp}` : `${ip}|${userAgent}`;

    let exclusivityRemoved = false;
    for (const [key, viewers] of ownerViewers.entries()) {
        if (key.startsWith(`${owner}:`) && key !== currentKey) {
            if (viewers.has(deviceId)) {
                viewers.delete(deviceId);
                exclusivityRemoved = true;
                const oldVideoId = key.split(':')[1];
                m3u8CacheContent.delete(oldVideoId);
            }
        }
    }

    if (!ownerViewers.has(currentKey)) ownerViewers.set(currentKey, new Map());
    const viewers = ownerViewers.get(currentKey);
    
    if (viewers.has(ip)) {
        viewers.delete(ip);
    }

    const oldDeviceId = `${ip}|${userAgent}`;
    if (localIp && viewers.has(oldDeviceId)) {
        viewers.delete(oldDeviceId);
    }
    
    viewers.set(deviceId, now);

    for (const [id, timestamp] of viewers.entries()) {
        if (now - timestamp > VIEWER_WINDOW_MS) viewers.delete(id);
    }
    
    if (exclusivityRemoved) {
        console.log(`[${owner}] 📱 Dispositivo ${ip} movido para live ${videoId}`);
    }
    
    saveOwnerViewers(ownerViewers);
}

function renewViewersForMonitor(owner, videoId) {
    if (!owner || !videoId) return;
    const key = `${owner}:${videoId}`;
    const viewers = ownerViewers.get(key);
    if (!viewers || viewers.size === 0) return;

    const now = Date.now();
    const ACTIVITY_TIMEOUT = parseInt(process.env.VIEWER_WINDOW_MS) || 7200000;
    const activityKey = `${owner}:${videoId}`;
    const activityMap = viewerAccess.get(activityKey);
    let renewed = 0, removed = 0;

    for (const [ip, timestamp] of viewers.entries()) {
        const lastAccess = activityMap ? (activityMap.get(ip) || 0) : 0;
        const hasRecentActivity = (now - lastAccess) <= ACTIVITY_TIMEOUT;

        if (hasRecentActivity) {
            viewers.set(ip, now);
            renewed++;
        } else {
            if ((now - timestamp) > VIEWER_WINDOW_MS) {
                viewers.delete(ip);
                removed++;
                console.log(`[${key}] 🔌 IP ${ip} removido por inatividade`);
            }
        }
    }

    if (renewed > 0 || removed > 0) {
        console.log(`[${key}] 🔄 Renovação: ${renewed} ativo(s), ${removed} expirado(s)`);
        saveOwnerViewers(ownerViewers);
    }
}

function getActiveDevicesForOwnerAndVideo(owner, videoId) {
    if (!owner || !videoId) return 0;
    return playbackSessions.countActive({ owner, videoId });
}

function getActiveViewerIPsForOwnerAndVideo(owner, videoId) {
    if (!owner || !videoId) return [];
    return playbackSessions.listActive({ owner, videoId }).map(session => ({
        sessionPreview: sessionPreview(session.sessionId),
        deviceId: sessionPreview(session.sessionId),
        ip: session.publicIp || 'unknown',
        userAgent: session.userAgent || '',
        localIp: null,
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt,
        source: session.source || 'hls'
    }));
}

function getDeviceLimitForOwner(owner) {
    const clientes = getClientes();
    const cliente = clientes.find(c => c.login === owner);
    return cliente ? cliente.dispositivos : 0;
}

function getTotalViewers() {
    return playbackSessions.countActive();
}

// ============================================================
// FILTRO DE QUALIDADE (NÃO UTILIZADO - mantido apenas para compatibilidade)
// ============================================================
function filterMasterByMaxHeight(masterContent, maxHeight) {
    console.warn('[filterMaster] Chamado, mas retornando conteúdo original (filtro desativado)');
    return masterContent;
}

// ============================================================

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

// ============================================================
// FUNÇÃO runYtdlp CORRIGIDA (com fallback de cookie e parâmetros forçados)
// ============================================================
function sanitizeYtdlpArgsForLog(args) {
    return (args || []).map((arg, index) => {
        const value = String(arg || '');
        if (args[index - 1] === '--cookies') return '[cookie-path-redacted]';
        if (/^https?:\/\//i.test(value)) return '[url-redacted]';
        if (/[A-Za-z]:\\/.test(value) || value.includes('/var/www/') || value.includes('/cookies/')) return '[path-redacted]';
        return value;
    }).join(' ');
}

function isValidationTargetUnavailableClassification(classification) {
    return [
        CLASSIFICATION.LIVE_ENDED,
        CLASSIFICATION.VIDEO_PRIVATE,
        CLASSIFICATION.VIDEO_UNAVAILABLE,
        CLASSIFICATION.VIDEO_REMOVED,
        CLASSIFICATION.AGE_RESTRICTED,
        CLASSIFICATION.MEMBERS_ONLY,
        CLASSIFICATION.GEO_RESTRICTED
    ].includes(classification);
}

function isTerminalRestoreClassification(classification) {
    return isValidationTargetUnavailableClassification(classification);
}

function getCookieStreamTestUrl() {
    return process.env.COOKIE_STREAM_TEST_URL ||
        process.env.COOKIE_STREAM_VALIDATION_URL ||
        'https://www.youtube.com/watch?v=aSXLerQStXA';
}

function extractVideoIdFromUrl(url) {
    const match = String(url || '').match(/(?:v=|\/)([0-9A-Za-z_-]{11})(?:[?&]|$)/);
    return match ? match[1] : null;
}

function runYtdlp(args, timeout = 30000, allowCookieFallback = true) {
    return new Promise(async (resolve, reject) => {
        const filteredArgs = args.filter((arg, index) => {
            if (arg === '-f' || arg === '--format') return false;
            if (index > 0 && (args[index-1] === '-f' || args[index-1] === '--format')) return false;
            return true;
        });

        const isMetadataCall = filteredArgs.includes('--dump-json') && 
                              filteredArgs.some(a => a.includes('youtube.com/watch'));
        const isRealExtractionCall = filteredArgs.includes('--no-playlist') ||
                                     filteredArgs.includes('--skip-download');

        let finalArgs = [...filteredArgs];

        if (isMetadataCall && !isRealExtractionCall) {
            if (!finalArgs.includes('--flat-playlist')) {
                finalArgs.push('--flat-playlist');
            }
            if (!finalArgs.includes('--playlist-end')) {
                finalArgs.push('--playlist-end', '1');
            }
        }

        let cookieIndex = finalArgs.indexOf('--cookies');
        let cookiePath = null;
        if (cookieIndex !== -1 && finalArgs.length > cookieIndex + 1) {
            cookiePath = finalArgs[cookieIndex + 1];
        }

        if (!cookiePath) {
            const defaultCookie = path.join(cookiesDir, 'cookie1.txt');
            if (fs.existsSync(defaultCookie)) {
                finalArgs.unshift('--cookies', defaultCookie);
                cookiePath = defaultCookie;
            }
        }

        console.log(`🔧 runYtdlp args: ${sanitizeYtdlpArgsForLog(finalArgs)}`);

        const ytCmd = process.platform === 'win32' ? '.\\yt-dlp.exe' : 'yt-dlp';

        const execWithCookie = (cookieFile) => {
            return new Promise((resolveExec, rejectExec) => {
                const argsWithCookie = [...finalArgs];
                const idx = argsWithCookie.indexOf('--cookies');
                if (idx !== -1) {
                    argsWithCookie.splice(idx, 2);
                }
                argsWithCookie.unshift('--cookies', cookieFile);

                const child = spawn(ytCmd, argsWithCookie);
                let stdout = '', stderr = '';
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
                    rejectExec(new Error(`Timeout após ${timeout}ms`));
                }, timeout);

                child.stdout.on('data', (data) => { stdout += data.toString(); });
                child.stderr.on('data', (data) => { stderr += data.toString(); });
                child.on('close', (code) => {
                    clearTimeout(timeoutId);
                    if (killTimeoutId) clearTimeout(killTimeoutId);
                    if (timedOut) return;
                    if (code === 0) {
                        resolveExec({ stdout: stdout.trim(), stderr: stderr.trim() });
                    } else {
                        const errorMsg = stderr.trim() || `Código de saída: ${code}`;
                        if (errorMsg.includes('No video formats found')) {
                            rejectExec(new Error(`No video formats found (cookie: ${path.basename(cookieFile)})`));
                        } else {
                            rejectExec(new Error(errorMsg));
                        }
                    }
                });
                child.on('error', (err) => {
                    clearTimeout(timeoutId);
                    if (killTimeoutId) clearTimeout(killTimeoutId);
                    rejectExec(err);
                });
            });
        };

        try {
            const result = await execWithCookie(cookiePath);
            resolve(result.stdout);
        } catch (err) {
            if (allowCookieFallback && err.message.includes('No video formats found')) {
                console.log(`⚠️ Falha com cookie ${path.basename(cookiePath)}, tentando alternativos...`);
                const cookieFiles = ['cookie1.txt', 'cookie2.txt', 'cookie3.txt'];
                let tried = false;
                for (const file of cookieFiles) {
                    const fullPath = path.join(cookiesDir, file);
                    if (fullPath === cookiePath || !fs.existsSync(fullPath)) continue;
                    try {
                        console.log(`🔄 Tentando com ${file}...`);
                        const result = await execWithCookie(fullPath);
                        console.log(`✅ Sucesso com ${file}`);
                        resolve(result.stdout);
                        tried = true;
                        break;
                    } catch (innerErr) {
                        if (innerErr.message.includes('No video formats found')) {
                            console.log(`❌ ${file} também falhou.`);
                        } else {
                            throw innerErr;
                        }
                    }
                }
                if (!tried) {
                    reject(new Error('Todos os cookies falharam com No video formats found'));
                }
            } else {
                reject(err);
            }
        }
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
        console.log('🔍 Testando extração real do cookie...');
        const stdout = await runYtdlp(buildYtdlpDumpJsonArgs({
            url: getCookieStreamTestUrl(),
            source: 'cookie',
            cookiePath
        }), 45000, false);
        const metadata = JSON.parse(stdout);
        const selection = selectHlsStream(metadata, {
            maxHeight: parseInt(process.env.VIDEO_MAX_HEIGHT, 10) || 720,
            forceArtificial: true
        });
        if (!selection.ok) {
            if (isValidationTargetUnavailableClassification(selection.classification)) {
                console.warn(`⚠️ URL de validação indisponível (${selection.classification}); cookie aceito por estrutura, validação de stream inconclusiva.`);
                return true;
            }
            throw new Error(`sem stream valida (${selection.classification})`);
        }
        console.log(`✅ Cookie válido para streaming (${selection.type})`);
        return true;
    } catch (error) {
        const classification = classifyYtdlpError(error.message);
        if (isValidationTargetUnavailableClassification(classification)) {
            console.warn(`⚠️ URL de validação indisponível (${classification}); cookie aceito por estrutura, validação de stream inconclusiva.`);
            return true;
        }
        throw new Error('Cookie sem extração válida: ' + sanitizeYtdlpMessage(error.message));
    }
}

// ========== PERSISTÊNCIA DE MONITORES ==========
const mappingFile = path.join(cookiesDir, 'monitors.json');

function getPersistedEntry(videoId, owner) {
    try {
        const map = JSON.parse(fs.readFileSync(mappingFile, 'utf8'));
        const key = owner ? `${videoId}:${owner}` : videoId;
        return map[key] || null;
    } catch (e) { return null; }
}

function removePersistedMapping(videoId, owner) {
    try {
        const map = JSON.parse(fs.readFileSync(mappingFile, 'utf8'));
        const key = owner ? `${videoId}:${owner}` : videoId;
        delete map[key];
        fs.writeFileSync(mappingFile, JSON.stringify(map, null, 2));
        console.log(`🗑️ Removido monitor persistido: ${key}`);
    } catch (e) { /* ignora se não existir */ }
}

// ========== CACHE ==========
const m3u8CachePromises = new Map();
const m3u8CacheContent = new Map();
// REDUZIDO para 5 segundos para forçar atualizações mais frequentes
const M3U8_CACHE_TTL = parseInt(process.env.M3U8_CACHE_TTL) || 5000;

const REFRESH_WAIT_MS = 20000; // Aumentado para 20s
const STALE_SERVE_MAX_AGE_MS = parseInt(process.env.STALE_MAX_AGE_MS) || 60000; // 1 minuto

const lastGoodM3u8 = new Map();

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

function makeBandwidthForHeight(height) {
    if (height <= 240) return 300000;
    if (height <= 360) return 600000;
    if (height <= 480) return 1200000;
    if (height <= 720) return 2500000;
    if (height <= 1080) return 5000000;
    return 8000000;
}

function buildInternalHlsUrl({ token, videoId, owner, sessionId, maxHeight }) {
    const basePath = token
        ? `/neonews/t/${encodeURIComponent(token)}.m3u8`
        : `/neonews/${encodeURIComponent(videoId)}.m3u8`;
    const params = new URLSearchParams();
    if (!token && owner) params.set('owner', owner);
    params.set('session', sessionId);
    if (maxHeight) params.set('max', String(maxHeight));
    return `${basePath}?${params.toString()}`;
}

function getAvailablePlaylistHeights(monitor) {
    return Object.keys(monitor?._playlistUrls || {})
        .map(value => Number(value))
        .filter(value => Number.isFinite(value) && value > 0)
        .sort((a, b) => b - a);
}

function extractHeightsFromMasterContent(content) {
    const heights = [];
    const pattern = /#EXT-X-STREAM-INF:[^\n]*RESOLUTION=\d+x(\d+)/ig;
    let match;
    while ((match = pattern.exec(String(content || ''))) !== null) {
        const height = Number(match[1]);
        if (Number.isFinite(height) && height > 0) heights.push(height);
    }
    return Array.from(new Set(heights)).sort((a, b) => b - a);
}

function buildPlaybackSessionMaster(monitor, {
    token,
    videoId,
    owner,
    sessionId,
    requestedMaxHeight,
    fallbackMaxHeight
}) {
    let heights = getAvailablePlaylistHeights(monitor);
    if (heights.length === 0) {
        heights = extractHeightsFromMasterContent(monitor?._masterContent?.content);
    }
    if (heights.length === 0 && fallbackMaxHeight) {
        heights = [fallbackMaxHeight];
    }
    if (requestedMaxHeight && heights.includes(requestedMaxHeight)) {
        heights = [requestedMaxHeight];
    }

    const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];
    for (const height of heights) {
        const width = Math.round(height * 16 / 9);
        const url = buildInternalHlsUrl({ token, videoId, owner, sessionId, maxHeight: height });
        lines.push(
            `#EXT-X-STREAM-INF:BANDWIDTH=${makeBandwidthForHeight(height)},RESOLUTION=${width}x${height},FRAME-RATE=30`,
            url
        );
    }
    return `${lines.join('\n')}\n`;
}

function sendHlsManifest(res, content, extraHeaders = {}) {
    res.writeHead(200, {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'private, no-store',
        'Vary': 'User-Agent',
        'Pragma': 'no-cache',
        'Expires': '0',
        ...extraHeaders
    });
    res.end(content);
}

// ============================================================
// CONTROLE DE VERBOSIDADE DOS LOGS (rate limiting)
// ============================================================
let requestLogCount = 0;
let lastLogTime = 0;
const LOG_INTERVAL_MS = 5000;
const playbackSessionCreationWindows = new Map();
const restoreBackoffLogTracker = new Map();

function isPlaybackSessionCreationRateLimited(ip, owner, videoId) {
    const limit = parseInt(process.env.PLAYBACK_SESSION_CREATE_LIMIT_PER_MINUTE, 10) || 30;
    const windowMs = 60 * 1000;
    const now = Date.now();
    const key = `${ip}|${owner}|${videoId}`;
    const current = playbackSessionCreationWindows.get(key) || { startedAt: now, count: 0 };
    if (now - current.startedAt > windowMs) {
        current.startedAt = now;
        current.count = 0;
    }
    current.count += 1;
    playbackSessionCreationWindows.set(key, current);
    return current.count > limit;
}

function logRequestSummary(videoId, ip, owner) {
    requestLogCount++;
    const now = Date.now();
    if (now - lastLogTime > LOG_INTERVAL_MS) {
        console.log(`[${videoId}] 📡 ${requestLogCount} requisições (último IP: ${ip}, owner: ${owner})`);
        requestLogCount = 0;
        lastLogTime = now;
    }
}

function getGlobalExtractionRetryAfterSeconds(now = Date.now()) {
    const nextRetryAt = Number(converter?.globalExtractionBackoff?.nextRetryAt) || 0;
    if (nextRetryAt <= now) return 0;
    return Math.ceil((nextRetryAt - now) / 1000);
}

function logRestoreBackoffSuppressed(videoId, owner, retryAfterSeconds) {
    const key = `${owner || 'public'}:${videoId}`;
    const now = Date.now();
    const last = restoreBackoffLogTracker.get(key) || 0;
    if (now - last < 30000) return;
    restoreBackoffLogTracker.set(key, now);
    console.log(`[${videoId}] recriacao de monitor suprimida por circuit breaker global; retry em ${retryAfterSeconds}s (owner: ${owner || 'n/a'})`);
}

// ============================================================
// HANDLER DO PROXY M3U8 (com logs reduzidos e proxy de playlists)
// ============================================================
async function handleM3u8Proxy(videoId, owner, req, res, maxHeight, routeContext = {}) {
    const reqStart = Date.now();
    const queryOwner = owner || req.query.owner || null;

    logRequestSummary(videoId, req.ip, queryOwner);

    const allowedHeights = [144, 240, 360, 480, 720, 1080];
    const envMaxHeight = parseInt(process.env.VIDEO_MAX_HEIGHT, 10) || 1080;
    const urlMaxHeight = parseInt(req.query.max, 10);
    let finalMaxHeight = maxHeight || envMaxHeight;
    if (Number.isFinite(urlMaxHeight) && allowedHeights.includes(urlMaxHeight)) {
        finalMaxHeight = urlMaxHeight;
        console.log(`[${videoId}] 📺 Qualidade forçada via URL: ${finalMaxHeight}p (proxy de playlist)`);
    }

    let monitor = null;
    let keyFound = null;
    let actualOwner = null;

    if (queryOwner) {
        const key = `${videoId}:${queryOwner}`;
        if (converter.activeMonitors.has(key)) {
            monitor = converter.activeMonitors.get(key);
            actualOwner = queryOwner;
            keyFound = key;
        }
    }

    if (!monitor) {
        for (const [key, mon] of converter.activeMonitors.entries()) {
            if (key.startsWith(videoId + ':')) {
                monitor = mon;
                actualOwner = key.split(':')[1] || null;
                keyFound = key;
                break;
            }
        }
    }

    if (!monitor) {
        const retryAfterSeconds = getGlobalExtractionRetryAfterSeconds();
        if (retryAfterSeconds > 0) {
            logRestoreBackoffSuppressed(videoId, queryOwner, retryAfterSeconds);
            logProxyAccess(videoId, { statusCode: 503, fromCache: false, elapsedMs: Date.now() - reqStart });
            res.set('Retry-After', String(retryAfterSeconds));
            return res.status(503).send('Stream extraction temporarily unavailable');
        }

        try {
            const map = JSON.parse(fs.readFileSync(mappingFile, 'utf8'));
            const keysToTry = queryOwner
                ? [`${videoId}:${queryOwner}`]
                : Object.keys(map).filter(k => k.startsWith(videoId + ':') || k === videoId);

            for (const key of keysToTry) {
                const entry = map[key];
                if (entry && entry.youtubeUrl) {
                    const savedOwner = key.includes(':') ? key.split(':')[1] : null;
                    console.log(`[${videoId}] Monitor ausente, recriando a partir do persistido... (owner: ${savedOwner})`);
                    const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
                    const restoreResult = await converter.convert(entry.youtubeUrl, baseUrl, savedOwner, { automatic: true });
                    if (!restoreResult?.success) {
                        console.warn(`[${videoId}] Monitor persistido não recriado: ${restoreResult?.classification || 'unknown'} - ${restoreResult?.message || restoreResult?.error || 'sem stream ativa'}`);
                        continue;
                    }
                    const newKey = savedOwner ? `${videoId}:${savedOwner}` : videoId;
                    if (converter.activeMonitors.has(newKey)) {
                        monitor = converter.activeMonitors.get(newKey);
                        actualOwner = savedOwner;
                        keyFound = newKey;
                        break;
                    }
                }
            }
        } catch (e) {
            console.warn(`[${videoId}] Erro ao buscar persistido:`, e.message);
        }
    }

    if (!monitor || !monitor.m3u8Url) {
        logProxyAccess(videoId, { statusCode: 404, fromCache: false, elapsedMs: Date.now() - reqStart });
        return res.status(404).send('Stream not found');
    }

    const trackingOwner = queryOwner || actualOwner;
    const localIp = req.query.localIp || null;
    const sessionIdFromRequest = String(req.query.session || '').trim();
    let activePlaybackSessionId = null;

    if (trackingOwner) {
        const clientIp = getRequestIp(req);
        const userAgent = req.headers['user-agent'] || '';

        if (!isLocalIp(clientIp)) {
            if (sessionIdFromRequest) {
                const touched = playbackSessions.touchSession({
                    sessionId: sessionIdFromRequest,
                    owner: trackingOwner,
                    videoId,
                    publicIp: clientIp,
                    userAgent
                });
                if (!touched.ok) {
                    const status = touched.code === 'expired' ? 410 : 403;
                    console.warn(`[${trackingOwner}:${videoId}] sessao HLS rejeitada (${touched.code}) session=${sessionPreview(sessionIdFromRequest)}`);
                    return res.status(status).send('Playback session invalid');
                }
                activePlaybackSessionId = sessionIdFromRequest;
            } else {
                if (isPlaybackSessionCreationRateLimited(clientIp, trackingOwner, videoId)) {
                    console.warn(`[${trackingOwner}:${videoId}] criacao de sessao HLS limitada por taxa para IP ${clientIp}`);
                    res.set('Retry-After', '60');
                    return res.status(429).json({
                        error: 'Muitas tentativas de sessão',
                        message: 'Tente novamente em instantes.'
                    });
                }
                const deviceLimit = getDeviceLimitForOwner(trackingOwner);
                const created = playbackSessions.createSession({
                    owner: trackingOwner,
                    videoId,
                    limit: deviceLimit,
                    publicIp: clientIp,
                    userAgent,
                    source: 'hls',
                    fingerprint: localIp ? `localIp:${localIp}` : null
                });

                if (!created.ok) {
                    console.log(`[${trackingOwner}:${videoId}] 🚫 Sessao HLS bloqueada: ${created.active} ativas, limite ${created.limit}`);
                    return res.status(429).json({
                        error: 'Limite de dispositivos excedido',
                        message: `Você atingiu o limite de ${deviceLimit} dispositivos simultâneos para esta live.`
                    });
                }

                activePlaybackSessionId = created.session.sessionId;
                console.log(`[${trackingOwner}:${videoId}] 📱 Sessao HLS criada: ${sessionPreview(activePlaybackSessionId)} (${clientIp} | ${userAgent.substring(0, 30)}...)`);
                const sessionMaster = buildPlaybackSessionMaster(monitor, {
                    token: routeContext.token || null,
                    videoId,
                    owner: trackingOwner,
                    sessionId: activePlaybackSessionId,
                    requestedMaxHeight: Number.isFinite(urlMaxHeight) && allowedHeights.includes(urlMaxHeight) ? finalMaxHeight : null,
                    fallbackMaxHeight: finalMaxHeight
                });
                return sendHlsManifest(res, sessionMaster, {
                    'X-Playback-Session': sessionPreview(activePlaybackSessionId),
                    'X-Master': 'true'
                });
            }
        }
    } else {
        console.warn(`[${videoId}] Acesso sem owner definido - dispositivo não será rastreado.`);
    }

    monitor.lastAccess = Date.now();

    // ============================================================
    // 🔧 PROXY DE PLAYLISTS DE QUALIDADE (individual por requisição)
    // ============================================================
    if (urlMaxHeight && monitor._playlistUrls && monitor._playlistUrls[urlMaxHeight]) {
        const playlistUrl = monitor._playlistUrls[urlMaxHeight];
        console.log(`[${videoId}] 🎯 Servindo playlist de qualidade ${urlMaxHeight}p diretamente do YouTube`);
        try {
            // Força a renovação do cache, evitando servir conteúdo antigo
            const cacheKey = videoId + '_' + urlMaxHeight;
            // Remove o cache existente para forçar um fetch fresco
            if (m3u8CacheContent.has(cacheKey)) {
                const cached = m3u8CacheContent.get(cacheKey);
                if (Date.now() - cached.fetchedAt > M3U8_CACHE_TTL) {
                    m3u8CacheContent.delete(cacheKey);
                    m3u8CachePromises.delete(cacheKey);
                }
            }
            const result = await fetchM3u8WithCache(cacheKey, playlistUrl);
            let content = result.content;
            console.log(`[${videoId}] 🔍 Playlist ${urlMaxHeight}p recebida (${content.length} bytes)`);
            res.writeHead(200, {
                'Content-Type': 'application/vnd.apple.mpegurl',
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'private, no-store',
                'Vary': 'User-Agent',
                'Pragma': 'no-cache',
                'Expires': '0',
                ...(activePlaybackSessionId ? { 'X-Playback-Session': sessionPreview(activePlaybackSessionId) } : {})
            });
            res.end(content);
            return;
        } catch (err) {
            console.error(`[${videoId}] ❌ Erro ao buscar playlist ${urlMaxHeight}:`, err.message);
            // Fallback: tenta servir o master original
        }
    }

    // Se não for requisição de qualidade, verifica se é o master
    if (monitor._masterContent && monitor._masterContent.isMaster) {
        const content = activePlaybackSessionId && trackingOwner
            ? buildPlaybackSessionMaster(monitor, {
                token: routeContext.token || null,
                videoId,
                owner: trackingOwner,
                sessionId: activePlaybackSessionId,
                requestedMaxHeight: null,
                fallbackMaxHeight: finalMaxHeight
            })
            : monitor._masterContent.content;
        console.log(`[${videoId}] 🎯 Servindo master ${activePlaybackSessionId ? 'interno com sessao HLS' : 'ORIGINAL (sem filtro)'}`);
        sendHlsManifest(res, content, {
            'X-Master': 'true',
            ...(activePlaybackSessionId ? { 'X-Playback-Session': sessionPreview(activePlaybackSessionId) } : {})
        });
        return;
    }

    // Fallback: fetch normal
    try {
        const result = await fetchM3u8WithCache(videoId, monitor.m3u8Url);

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

        if (isMaster) {
            if (activePlaybackSessionId && trackingOwner) {
                contentToServe = buildPlaybackSessionMaster(monitor, {
                    token: routeContext.token || null,
                    videoId,
                    owner: trackingOwner,
                    sessionId: activePlaybackSessionId,
                    requestedMaxHeight: null,
                    fallbackMaxHeight: finalMaxHeight
                });
            }
            console.log(`[${videoId}] 🎯 Servindo master ${activePlaybackSessionId ? 'interno com sessao HLS' : 'ORIGINAL (via cache)'}`);
            sendHlsManifest(res, contentToServe, {
                'X-Master': 'true',
                ...(activePlaybackSessionId ? { 'X-Playback-Session': sessionPreview(activePlaybackSessionId) } : {})
            });
            return;
        }

        // Para playlists de qualidade (não master), aplicamos a correção de regressão
        const parsed = parseM3u8Info(contentToServe);
        const prev = lastServedSequence.get(videoId);

        if (parsed.sequence !== null && prev && parsed.sequence < prev.sequence) {
            console.warn(`[${videoId}] ⚠️ Detectada regressão de sequência (${prev.sequence} → ${parsed.sequence}). Forçando correção.`);
            
            const stale = getStaleM3u8IfFresh(videoId, monitor.lastMediaSequence);
            if (stale) {
                console.log(`[${videoId}] 🔄 Usando playlist anterior estável para evitar BehindLiveWindowException.`);
                contentToServe = stale.content;
            } else {
                console.warn(`[${videoId}] ⚠️ Sem stale disponível, forçando sequência ${prev.sequence + 1}`);
                contentToServe = contentToServe.replace(
                    /#EXT-X-MEDIA-SEQUENCE:\d+/,
                    `#EXT-X-MEDIA-SEQUENCE:${prev.sequence + 1}`
                );
            }
        }

        const finalParsed = parseM3u8Info(contentToServe);
        if (finalParsed.sequence !== null) {
            if (monitor.lastMediaSequence === null || finalParsed.sequence > monitor.lastMediaSequence) {
                rememberGoodM3u8(videoId, contentToServe);
            }
        } else {
            rememberGoodM3u8(videoId, contentToServe);
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
            'Cache-Control': 'private, no-store',
            'Vary': 'User-Agent',
            'Pragma': 'no-cache',
            'Expires': '0',
            'X-Cache': result.fromCache ? 'HIT' : 'MISS',
            'X-Master': 'false',
            ...(activePlaybackSessionId ? { 'X-Playback-Session': sessionPreview(activePlaybackSessionId) } : {})
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
                    if (isRenewedMaster) {
                        console.log(`[${videoId}] 🎯 Servindo master renovado (sem filtro)`);
                        res.writeHead(200, {
                            'Content-Type': 'application/vnd.apple.mpegurl',
                            'Access-Control-Allow-Origin': '*',
                            'Cache-Control': 'private, no-store',
                            'Vary': 'User-Agent',
                            'Pragma': 'no-cache',
                            'Expires': '0',
                            'X-Master': 'true',
                            ...(activePlaybackSessionId ? { 'X-Playback-Session': sessionPreview(activePlaybackSessionId) } : {})
                        });
                        return res.end(renewedContent);
                    } else {
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
                        'Cache-Control': 'private, no-store',
                        'Vary': 'User-Agent',
                        'Pragma': 'no-cache',
                        'Expires': '0',
                        'X-Master': isRenewedMaster ? 'true' : 'false',
                        ...(activePlaybackSessionId ? { 'X-Playback-Session': sessionPreview(activePlaybackSessionId) } : {})
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
                        'Cache-Control': 'private, no-store',
                        'Vary': 'User-Agent',
                        'Pragma': 'no-cache',
                        'Expires': '0',
                        'X-Stale': 'true',
                        ...(activePlaybackSessionId ? { 'X-Playback-Session': sessionPreview(activePlaybackSessionId) } : {})
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
}

// ============================================================
// ROTAS (mantidas inalteradas)
// ============================================================
app.get('/converter.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/converter.html'));
});

app.post('/api/convert', publicApiLimiter, async (req, res) => {
    const { youtubeUrl, owner } = req.body;
    if (!youtubeUrl) return res.status(400).json({ success: false, error: 'URL obrigatoria' });
    const baseUrl = process.env.BASE_URL || 'http://localhost:' + PORT;
    const result = await converter.convert(youtubeUrl, baseUrl, owner, { manual: true });
    if (result.success && result.videoId) {
        const token = getOrCreateToken(result.videoId, owner);
        result.token = token;
        result.serverUrl = `${baseUrl}/neonews/t/${token}.m3u8`;
    }
    res.json(result);
});

app.get('/api/public/device-status/:owner', publicApiLimiter, (req, res) => {
    const owner = req.params.owner;
    const localIp = req.query.localIp || null;
    if (!owner) {
        return res.status(400).json({ error: 'Owner não informado' });
    }

    if (localIp) {
        const ip = getRequestIp(req);
        const userAgent = req.headers['user-agent'] || '';
        trackViewer(owner, 'panel', ip, userAgent, localIp);
    }

    const allDevices = playbackSessions.listActive({ owner })
        .filter(session => converter.activeMonitors.has(`${session.videoId}:${owner}`))
        .map(session => ({
            sessionPreview: sessionPreview(session.sessionId),
            deviceId: sessionPreview(session.sessionId),
            ip: session.publicIp || 'unknown',
            userAgent: session.userAgent || '',
            localIp: null,
            videoId: session.videoId,
            createdAt: session.createdAt,
            lastSeenAt: session.lastSeenAt
        }));
    const limit = getDeviceLimitForOwner(owner);
    const remaining = Math.max(0, limit - allDevices.length);

    res.json({
        owner,
        limit,
        active: allDevices.length,
        remaining,
        ips: allDevices
    });
});

app.post('/api/device/remove', (req, res) => {
    const { owner, ip, videoId } = req.body;
    if (!owner || !ip) {
        return res.status(400).json({ error: 'Owner e IP são obrigatórios' });
    }
    if (videoId) {
        const key = `${owner}:${videoId}`;
        const viewers = ownerViewers.get(key);
        const removedSession = playbackSessions.removeSession(ip, { owner, videoId });
        if (removedSession || (viewers && viewers.has(ip))) {
            if (viewers && viewers.has(ip)) viewers.delete(ip);
            console.log(`[${key}] 📱 Dispositivo removido manualmente`);
            saveOwnerViewers(ownerViewers);
            const accessKey = `${owner}:${videoId}`;
            const accessMap = viewerAccess.get(accessKey);
            if (accessMap) {
                accessMap.delete(ip);
                saveViewerAccess(viewerAccess);
            }
            m3u8CacheContent.delete(videoId);
            m3u8CachePromises.delete(videoId);
            lastGoodM3u8.delete(videoId);
            return res.json({ success: true, message: 'IP removido e cache invalidado' });
        } else {
            return res.status(404).json({ error: 'IP não encontrado na lista de ativos' });
        }
    } else {
        let removed = false;
        if (playbackSessions.removeSession(ip, { owner })) {
            removed = true;
        }
        for (const [key, viewers] of ownerViewers.entries()) {
            if (key.startsWith(owner + ':')) {
                if (viewers.has(ip)) {
                    viewers.delete(ip);
                    removed = true;
                    const vid = key.split(':')[1];
                    const accessKey = `${owner}:${vid}`;
                    const accessMap = viewerAccess.get(accessKey);
                    if (accessMap) {
                        accessMap.delete(ip);
                        saveViewerAccess(viewerAccess);
                    }
                    m3u8CacheContent.delete(vid);
                    m3u8CachePromises.delete(vid);
                    lastGoodM3u8.delete(vid);
                }
            }
        }
        if (removed) {
            saveOwnerViewers(ownerViewers);
            console.log(`[${owner}] 📱 IP ${ip} removido de todas as lives`);
            return res.json({ success: true, message: 'IP removido de todas as lives' });
        } else {
            return res.status(404).json({ error: 'IP não encontrado' });
        }
    }
});

app.post('/api/device/release-all', (req, res) => {
    const { owner } = req.body;
    if (!owner) {
        return res.status(400).json({ error: 'Owner não informado' });
    }
    let removed = false;
    const removedSessions = playbackSessions.removeForOwner(owner);
    if (removedSessions > 0) removed = true;
    for (const [key, viewers] of ownerViewers.entries()) {
        if (key.startsWith(owner + ':')) {
            const videoId = key.split(':')[1];
            ownerViewers.delete(key);
            removed = true;
            if (videoId) {
                const accessKey = `${owner}:${videoId}`;
                viewerAccess.delete(accessKey);
                saveViewerAccess(viewerAccess);
            }
            m3u8CacheContent.delete(videoId);
            m3u8CachePromises.delete(videoId);
            lastGoodM3u8.delete(videoId);
        }
    }
    if (removed) {
        saveOwnerViewers(ownerViewers);
        console.log(`[${owner}] 📱 Todos os dispositivos liberados manualmente (todas as lives)`);
        return res.json({ success: true, message: 'Todos os dispositivos liberados e cache invalidado' });
    } else {
        return res.json({ success: true, message: 'Nenhum dispositivo ativo para liberar' });
    }
});

app.get('/api/public/device-status-all', publicApiLimiter, (req, res) => {
    const clientes = getClientes();
    const result = {};

    for (const cliente of clientes) {
        const owner = cliente.login;
        result[owner] = {
            active: playbackSessions.countActive({ owner }),
            limit: cliente.dispositivos
        };
    }
    res.json(result);
});

app.get('/api/public/monitors', publicApiLimiter, (req, res) => {
    const monitors = [];
    if (converter && converter.activeMonitors) {
        for (const [key, monitor] of converter.activeMonitors.entries()) {
            const [videoId, owner] = key.split(':');

            if (monitor.liveState === 'ended' || monitor._liveEnded) {
                continue;
            }

            const token = getOrCreateToken(videoId, owner || null);
            monitors.push({
                videoId,
                owner: owner || null,
                token,
                status: monitor.liveState || (monitor.isLive ? 'online' : 'offline'),
                lastUpdate: monitor.lastUpdate || monitor.lastAccess,
                title: monitor.metadata?.title || null,
                channel: monitor.metadata?.channel || null
            });
        }
    }
    res.json({ monitors });
});

app.get('/api/clientes', (req, res) => {
    const clientes = getClientes();
    res.json(clientes);
});

app.post('/api/client/sync', (req, res) => {
    const { clientes } = req.body;
    if (!Array.isArray(clientes)) {
        return res.status(400).json({ success: false, message: 'Formato inválido' });
    }
    const previousOwners = new Set(getClientes().map(cliente => cliente.login).filter(Boolean));
    const nextOwners = new Set(clientes.map(cliente => cliente.login).filter(Boolean));
    for (const owner of previousOwners) {
        if (!nextOwners.has(owner)) {
            const removedSessions = playbackSessions.removeForOwner(owner);
            if (removedSessions > 0) {
                console.log(`[${owner}] ${removedSessions} sessão(ões) HLS removida(s) após sincronização de clientes.`);
            }
        }
    }
    salvarClientes(clientes);
    console.log(`🔄 Clientes sincronizados: ${clientes.length}`);
    res.json({ success: true, message: 'Clientes sincronizados' });
});

function getCookieFunctionalStatusSafe() {
    try {
        return converter?.cookieRotator?.getFunctionalStatus ? converter.cookieRotator.getFunctionalStatus() : {};
    } catch (err) {
        console.warn('Falha ao montar status funcional dos cookies:', err.message);
        return {};
    }
}

function getCookieRefreshStatusSafe() {
    try {
        return getCookieRefreshAdminStatus();
    } catch (err) {
        console.warn('Falha ao montar status do agente Windows:', err.message);
        return { enabled: false, agent: { status: 'offline', reason: 'status_unavailable' } };
    }
}

function buildOperationalHealthSnapshot(req = null) {
    return buildSystemHealth({
        converter,
        cookieFunctionalStatus: getCookieFunctionalStatusSafe(),
        cookieRefreshStatus: getCookieRefreshStatusSafe(),
        auth: {
            sessionAdmin: req ? req.session?.admin === true : undefined,
            adminPasswordConfigured: Boolean(process.env.ADMIN_PASSWORD)
        }
    });
}

function publicHealthView(snapshot) {
    return {
        operationalStatus: snapshot.status,
        score: snapshot.score,
        summary: snapshot.summary,
        timestamp: snapshot.timestamp
    };
}

app.get('/health', (req, res) => {
    const operational = buildOperationalHealthSnapshot();
    res.json({
        status: 'ok',
        version: '3.0.0',
        uptime: process.uptime(),
        activeMonitors: converter?.activeMonitors?.size || 0,
        ...publicHealthView(operational)
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

app.get('/api/keepalive', publicApiLimiter, (req, res) => {
    const { owner, videoId, localIp } = req.query;
    const ip = getRequestIp(req);
    const userAgent = req.headers['user-agent'] || '';
    if (owner && videoId && !isLocalIp(ip)) {
        trackViewerByOwner(owner, ip, videoId, userAgent, localIp);
        return res.send('ok');
    }
    res.status(400).send('invalid');
});

// ========== PROXY HLS (rota com videoId) - compatibilidade ==========
app.get('/neonews/:videoId.m3u8', async (req, res) => {
    const videoId = req.params.videoId;
    const queryOwner = req.query.owner || null;
    const allowedHeights = [144, 240, 360, 480, 720, 1080];
    const envMaxHeight = parseInt(process.env.VIDEO_MAX_HEIGHT, 10) || 1080;
    const urlMaxHeight = parseInt(req.query.max, 10);
    let maxHeight = envMaxHeight;
    if (Number.isFinite(urlMaxHeight) && allowedHeights.includes(urlMaxHeight)) {
        maxHeight = urlMaxHeight;
    }
    await handleM3u8Proxy(videoId, queryOwner, req, res, maxHeight, { token: null });
});

// ========== PROXY HLS (rota com token) ==========
app.get('/neonews/t/:token.m3u8', async (req, res) => {
    const token = req.params.token;
    const info = getTokenInfo(token);
    if (!info) {
        return res.status(404).send('Token inválido ou expirado');
    }
    const { videoId, owner } = info;
    const allowedHeights = [144, 240, 360, 480, 720, 1080];
    const envMaxHeight = parseInt(process.env.VIDEO_MAX_HEIGHT, 10) || 1080;
    const urlMaxHeight = parseInt(req.query.max, 10);
    let maxHeight = envMaxHeight;
    if (Number.isFinite(urlMaxHeight) && allowedHeights.includes(urlMaxHeight)) {
        maxHeight = urlMaxHeight;
    }
    await handleM3u8Proxy(videoId, owner, req, res, maxHeight, { token });
});

// ========== AUTENTICAÇÃO E DASHBOARD ==========
function isAuthenticated(req, res, next) {
    if (req.session && req.session.admin === true) return next();
    if (req.path && req.path.startsWith('/api/')) {
        return res.status(401).json({ success: false, error: 'admin_session_expired' });
    }
    res.redirect('/admin-login');
}

function isAdminApiAuthenticated(req, res, next) {
    if (req.session && req.session.admin === true) return next();
    return res.status(401).json({ success: false, error: 'admin_session_expired' });
}

function sanitizeApiText(value, max = 500) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function sanitizeLogUrl(rawUrl) {
    try {
        const parsed = new URL(rawUrl);
        const host = parsed.hostname.toLowerCase();
        if ((host === 'www.youtube.com' || host === 'youtube.com' || host === 'm.youtube.com') && parsed.pathname === '/watch') {
            const videoId = parsed.searchParams.get('v');
            return videoId ? `${parsed.origin}/watch?v=${videoId}` : `${parsed.origin}${parsed.pathname}`;
        }
        if (host === 'youtu.be') return `${parsed.origin}${parsed.pathname}`;

        let safePath = parsed.pathname || '/';
        safePath = safePath.replace(/\/t\/[^/]+\.m3u8$/i, '/t/[token].m3u8');
        if (host.includes('googlevideo.com') || safePath.includes('/manifest/') || safePath.toLowerCase().includes('.m3u8')) {
            return `${parsed.origin}/[stream-url-redacted]`;
        }
        if (safePath.length > 80) safePath = `${safePath.slice(0, 77)}...`;
        return `${parsed.origin}${safePath}`;
    } catch (err) {
        return '[url-redacted]';
    }
}

function sanitizeServerLogLine(line) {
    return String(line || '')
        .replace(/authorization:\s*bearer\s+[^\s]+/ig, 'Authorization: Bearer [redacted]')
        .replace(/\b(COOKIE_AGENT_TOKEN|SESSION_SECRET|ADMIN_PASSWORD|token|signature|sig|lsig|expire)=([^\s&]+)/ig, '$1=[redacted]')
        .replace(/https?:\/\/[^\s"'<>]+/g, sanitizeLogUrl)
        .replace(/[A-Z]:\\Users\\[^\s"'<>]+/g, '[path-redacted]')
        .replace(/\/var\/www\/[^\s"'<>]+/g, '[path-redacted]')
        .replace(/\/root\/[^\s"'<>]+/g, '[path-redacted]')
        .replace(/# Netscape HTTP Cookie File[\s\S]*/ig, '[cookie content redacted]')
        .slice(0, 1000);
}

function readLogTail(filePath, maxBytes) {
    if (!fs.existsSync(filePath)) return '';
    const stats = fs.statSync(filePath);
    if (!stats.isFile() || stats.size <= 0) return '';
    const start = Math.max(0, stats.size - maxBytes);
    const length = stats.size - start;
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(filePath, 'r');
    try {
        fs.readSync(fd, buffer, 0, length, start);
    } finally {
        fs.closeSync(fd);
    }
    const text = buffer.toString('utf8');
    return start > 0 ? text.replace(/^[^\n]*(\n|$)/, '') : text;
}

function parseServerLogLine(line, source, index) {
    const sanitized = sanitizeServerLogLine(line);
    const match = sanitized.match(/^(\d{4}-\d{2}-\d{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{3}Z|Z)?):?\s*(.*)$/);
    const timestamp = match ? match[1].replace('T', ' ').replace('Z', '') : '';
    const message = match ? match[2] : sanitized;
    const sortTime = timestamp ? Date.parse(timestamp.replace(' ', 'T')) : 0;
    return {
        timestamp,
        source,
        message,
        sortTime: Number.isFinite(sortTime) ? sortTime : 0,
        index
    };
}

function getServerLogTimeline(options = {}) {
    const lineLimit = Math.max(20, Math.min(Number(options.lineLimit) || 160, 300));
    const maxBytes = Math.max(32768, Math.min(Number(options.maxBytes) || 256 * 1024, 1024 * 1024));
    const files = [
        { source: 'out', filePath: path.join(__dirname, 'logs', 'pm2-out-0.log') },
        { source: 'err', filePath: path.join(__dirname, 'logs', 'pm2-error-0.log') }
    ];

    let index = 0;
    const entries = [];
    for (const file of files) {
        const text = readLogTail(file.filePath, maxBytes);
        for (const line of text.split(/\r?\n/)) {
            if (!line.trim()) continue;
            entries.push(parseServerLogLine(line, file.source, index));
            index += 1;
        }
    }

    return entries
        .sort((a, b) => (a.sortTime - b.sortTime) || (a.index - b.index))
        .slice(-lineLimit)
        .map(({ timestamp, source, message }) => ({ timestamp, source, message }));
}

function getBearerToken(req) {
    const header = req.get('authorization') || '';
    const match = header.match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : '';
}

function safeTokenMatch(provided, expected) {
    if (!provided || !expected) return false;
    const providedHash = crypto.createHash('sha256').update(provided).digest();
    const expectedHash = crypto.createHash('sha256').update(expected).digest();
    return crypto.timingSafeEqual(providedHash, expectedHash);
}

function authenticateCookieAgent(req, res, next) {
    if (!process.env.COOKIE_AGENT_TOKEN) {
        return res.status(503).json({ success: false, error: 'cookie_agent_unavailable' });
    }
    if (Object.prototype.hasOwnProperty.call(req.query || {}, 'token')) {
        return res.status(401).json({ success: false, error: 'unauthorized' });
    }
    const token = getBearerToken(req);
    if (!safeTokenMatch(token, process.env.COOKIE_AGENT_TOKEN)) {
        return res.status(401).json({ success: false, error: 'unauthorized' });
    }
    const agentId = sanitizeApiText(req.get('x-agent-id'), 120);
    if (!agentId) {
        return res.status(400).json({ success: false, error: 'agent_id_required' });
    }
    req.agentId = agentId;
    next();
}

function mapQueueResultToStatus(result) {
    if (result.ok) return 200;
    if (result.code === 'not_found') return 404;
    if (result.code === 'conflict' || result.code === 'cooldown') return 409;
    if (result.code === 'forbidden') return 403;
    if (result.code === 'running') return 409;
    return 400;
}

function positiveNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
}

function getCookieRefreshAdminStatus() {
    const queueStatus = cookieRefreshQueue.getStatus();
    const agents = queueStatus.agents || [];
    const lastAgent = agents[0] || null;
    const queueCheckedAt = new Date().toISOString();
    const agentTiming = CookieRefreshQueue.computeAgentStatus(lastAgent, {
        heartbeatRecentMs: positiveNumber(
            process.env.COOKIE_AGENT_HEARTBEAT_RECENT_MS || process.env.COOKIE_AGENT_OFFLINE_MS,
            90000
        ),
        activityRecentMs: positiveNumber(process.env.COOKIE_AGENT_ACTIVITY_RECENT_MS, 180000)
    });
    const recentJobs = queueStatus.recentJobs || [];
    const byLatestJobUpdate = (a, b) => {
        const aTime = Date.parse(a.completedAt || a.updatedAt || a.createdAt || 0);
        const bTime = Date.parse(b.completedAt || b.updatedAt || b.createdAt || 0);
        return bTime - aTime;
    };
    const lastExecution = recentJobs
        .filter(job => ['succeeded', 'failed', 'cancelled'].includes(job.status))
        .sort(byLatestJobUpdate)[0] || null;
    const lastCookieUpdated = recentJobs
        .filter(job => job.status === 'succeeded')
        .sort(byLatestJobUpdate)[0] || null;
    const lastErrorJob = recentJobs
        .filter(job => job.lastError && job.status !== 'cancelled')
        .sort(byLatestJobUpdate)[0] || null;
    return {
        enabled: Boolean(process.env.COOKIE_AGENT_TOKEN),
        tokenConfigured: Boolean(process.env.COOKIE_AGENT_TOKEN),
        agent: {
            online: agentTiming.online,
            status: agentTiming.status,
            reason: agentTiming.reason,
            lastSeen: agentTiming.lastHeartbeatAt,
            lastHeartbeatAt: agentTiming.lastHeartbeatAt,
            lastQueueCheckAt: agentTiming.lastQueueCheckAt,
            lastAgentActivityAt: agentTiming.lastAgentActivityAt,
            heartbeatAgeSeconds: agentTiming.heartbeatAgeSeconds,
            activityAgeSeconds: agentTiming.activityAgeSeconds,
            hostname: lastAgent?.hostname || null,
            version: lastAgent?.version || null,
            reportedStatus: lastAgent?.status || null
        },
        counts: queueStatus.counts,
        activeJobs: queueStatus.activeJobs,
        recentJobs,
        summary: {
            lastExecutionAt: lastExecution?.completedAt || lastExecution?.updatedAt || null,
            lastExecutionCookie: lastExecution?.cookie || null,
            lastExecutionStatus: lastExecution?.status || null,
            lastCookieUpdated: lastCookieUpdated?.cookie || null,
            lastCookieUpdatedAt: lastCookieUpdated?.completedAt || lastCookieUpdated?.updatedAt || null,
            lastError: lastErrorJob?.lastError || null,
            lastQueueCheck: agentTiming.lastQueueCheckAt
        },
        cookies: converter?.cookieRotator?.getFunctionalStatus ? converter.cookieRotator.getFunctionalStatus() : {},
        timestamp: queueCheckedAt
    };
}

function notifyCookieRefreshFinalFailure(job) {
    if (!job || job.status !== 'failed') return false;
    if (!emailAlerts || typeof emailAlerts.sendCookieRefreshFailedAlert !== 'function') return false;
    emailAlerts.sendCookieRefreshFailedAlert(job);
    return true;
}

function checkCookieAgentEmailAlerts(nowMs = Date.now()) {
    if (!process.env.COOKIE_AGENT_TOKEN) {
        return { action: 'none', disabled: true };
    }
    if (!emailAlerts || !cookieRefreshQueue || typeof cookieRefreshQueue.evaluateAgentOfflineAlert !== 'function') {
        return { action: 'none' };
    }
    const transition = cookieRefreshQueue.evaluateAgentOfflineAlert({
        nowMs,
        offlineMs: positiveNumber(process.env.COOKIE_AGENT_OFFLINE_ALERT_MS, 10 * 60 * 1000)
    });

    if (transition.action === 'offline' && typeof emailAlerts.sendCookieAgentOfflineAlert === 'function') {
        emailAlerts.sendCookieAgentOfflineAlert(transition);
    } else if (transition.action === 'recovered' && typeof emailAlerts.sendCookieAgentRecoveredAlert === 'function') {
        emailAlerts.sendCookieAgentRecoveredAlert(transition);
    }

    return transition;
}

function startCookieAgentAlertWatcher() {
    const intervalMs = positiveNumber(process.env.COOKIE_AGENT_ALERT_CHECK_INTERVAL_MS, 60 * 1000);
    const run = () => {
        try {
            checkCookieAgentEmailAlerts();
        } catch (err) {
            console.warn('Falha ao verificar alertas do Agent Windows:', err.message);
        }
    };
    const firstRun = setTimeout(run, Math.min(intervalMs, 15000));
    if (typeof firstRun.unref === 'function') firstRun.unref();
    const timer = setInterval(run, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    return timer;
}

app.get('/admin-login', (req, res) => {
    if (req.session.admin) return res.redirect('/dashboard');
    res.sendFile(path.join(__dirname, 'public/admin-login.html'));
});

app.post('/admin-login', adminLoginLimiter, (req, res) => {
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
    const fallbackPublic = {
        status: 'unknown',
        activeMonitors: 0,
        publicActive: 0,
        cookieActive: 0,
        message: 'Sem streams ativos'
    };

    if (converter.activeMonitors) {
        for (const monitor of converter.activeMonitors.values()) {
            if (!monitor || monitor.liveState === 'ended' || monitor._liveEnded) continue;
            fallbackPublic.activeMonitors += 1;
            if (monitor.lastSuccessfulExtractionSource === 'public') {
                fallbackPublic.publicActive += 1;
            } else if (monitor.lastSuccessfulExtractionSource) {
                fallbackPublic.cookieActive += 1;
            }
        }
    }

    if (converter.globalExtractionCritical) {
        fallbackPublic.status = 'error';
        fallbackPublic.message = 'Fallback público indisponível na última falha global';
    } else if (fallbackPublic.publicActive > 0) {
        fallbackPublic.status = 'ok';
        fallbackPublic.message = `${fallbackPublic.publicActive}/${fallbackPublic.activeMonitors} live(s) usando fallback público`;
    } else if (fallbackPublic.activeMonitors > 0) {
        fallbackPublic.message = 'Sem uso ativo';
    }

    res.json({ functional, fallbackPublic, timestamp: new Date().toISOString() });
});

app.get('/api/admin/health', isAdminApiAuthenticated, (req, res) => {
    const health = buildOperationalHealthSnapshot(req);
    res.json({
        success: true,
        uptime: process.uptime(),
        health,
        timestamp: new Date().toISOString()
    });
});

app.use('/api/admin/logs', adminApiLimiter);

app.get('/api/admin/logs/timeline', isAdminApiAuthenticated, (req, res) => {
    try {
        const lineLimit = parseInt(req.query.lines, 10);
        res.json({
            success: true,
            logs: getServerLogTimeline({ lineLimit }),
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        res.status(500).json({ success: false, error: 'log_timeline_unavailable' });
    }
});

// ============================================================
// COOKIE AGENT API (Bearer token, sem sessão de dashboard)
// ============================================================
app.use('/api/cookie-agent', cookieAgentLimiter, authenticateCookieAgent);

app.get('/api/cookie-agent/jobs/next', (req, res) => {
    cookieRefreshQueue.recordQueueCheck(req.agentId);
    const job = cookieRefreshQueue.getNextPending();
    if (!job) return res.status(204).send();
    res.json({ success: true, job });
});

app.post('/api/cookie-agent/jobs/:id/claim', (req, res) => {
    const result = cookieRefreshQueue.claim(req.params.id, req.agentId);
    const status = mapQueueResultToStatus(result);
    res.status(status).json({ success: result.ok, code: result.code, job: result.job });
});

app.post('/api/cookie-agent/jobs/:id/running', (req, res) => {
    const result = cookieRefreshQueue.markRunning(req.params.id, req.agentId);
    const status = mapQueueResultToStatus(result);
    res.status(status).json({ success: result.ok, code: result.code, job: result.job });
});

app.post('/api/cookie-agent/jobs/:id/complete', (req, res) => {
    const result = cookieRefreshQueue.complete(req.params.id, req.agentId, {
        message: sanitizeApiText(req.body?.message, 500),
        exitCode: req.body?.exitCode,
        durationMs: req.body?.durationMs
    });
    const status = mapQueueResultToStatus(result);
    res.status(status).json({ success: result.ok, code: result.code, idempotent: result.idempotent === true, job: result.job });
});

app.post('/api/cookie-agent/jobs/:id/fail', (req, res) => {
    const result = cookieRefreshQueue.fail(req.params.id, req.agentId, sanitizeApiText(req.body?.error || req.body?.message, 500));
    if (result.ok && result.job?.status === 'failed' && result.idempotent !== true) {
        notifyCookieRefreshFinalFailure(result.job);
    }
    const status = mapQueueResultToStatus(result);
    res.status(status).json({ success: result.ok, code: result.code, idempotent: result.idempotent === true, job: result.job });
});

app.post('/api/cookie-agent/heartbeat', (req, res) => {
    try {
        const heartbeat = cookieRefreshQueue.recordHeartbeat(req.agentId, {
            hostname: req.body?.hostname,
            version: req.body?.version,
            status: req.body?.status
        });
        res.json({ success: true, heartbeat });
    } catch (err) {
        res.status(400).json({ success: false, error: 'invalid_heartbeat' });
    }
});

// ============================================================
// COOKIE REFRESH ADMIN API (sessão administrativa)
// ============================================================
app.use('/api/admin/cookie-refresh', adminApiLimiter);

app.get('/api/admin/cookie-refresh/status', isAdminApiAuthenticated, (req, res) => {
    res.json({ success: true, status: getCookieRefreshAdminStatus() });
});

app.get('/api/admin/cookie-refresh/jobs', isAdminApiAuthenticated, (req, res) => {
    try {
        const jobs = cookieRefreshQueue.list({
            cookie: req.query.cookie,
            status: req.query.status,
            limit: req.query.limit
        });
        res.json({ success: true, jobs });
    } catch (err) {
        res.status(400).json({ success: false, error: 'invalid_filter' });
    }
});

app.post('/api/admin/cookie-refresh/enqueue/:cookie', isAdminApiAuthenticated, (req, res) => {
    try {
        const result = cookieRefreshQueue.enqueue(
            req.params.cookie,
            'dashboard',
            sanitizeApiText(req.body?.reason || 'solicitado pelo dashboard', 300),
            { requestedBy: req.session?.user || 'admin' }
        );
        res.status(result.created ? 201 : 200).json({ success: true, created: result.created, job: result.job });
    } catch (err) {
        res.status(400).json({ success: false, error: 'invalid_cookie' });
    }
});

app.post('/api/admin/cookie-refresh/enqueue-all', isAdminApiAuthenticated, (req, res) => {
    const results = [];
    for (const cookie of ['cookie1', 'cookie2', 'cookie3']) {
        results.push(cookieRefreshQueue.enqueue(cookie, 'dashboard', 'solicitado pelo dashboard', { requestedBy: req.session?.user || 'admin' }));
    }
    res.status(201).json({ success: true, results });
});

app.post('/api/admin/cookie-refresh/cancel/:jobId', isAdminApiAuthenticated, (req, res) => {
    const result = cookieRefreshQueue.cancel(req.params.jobId, sanitizeApiText(req.body?.reason || 'cancelado pelo dashboard', 300));
    const status = mapQueueResultToStatus(result);
    res.status(status).json({ success: result.ok, code: result.code, job: result.job });
});

app.get('/api/monitors', isAuthenticated, (req, res) => {
    const monitors = [];
    const nowMs = Date.now();
    if (converter && converter.activeMonitors) {
        for (const [key, monitor] of converter.activeMonitors.entries()) {
            const [videoId, owner] = key.split(':');

            if (monitor.liveState === 'ended' || monitor._liveEnded) {
                console.log(`[${key}] 🗑️ Removendo monitor de live encerrada detectada na API`);
                converter.removeMonitor(videoId, owner);
                if (owner) {
                    const devKey = `${owner}:${videoId}`;
                    if (ownerViewers.has(devKey)) {
                        ownerViewers.delete(devKey);
                        saveOwnerViewers(ownerViewers);
                    }
                    playbackSessions.removeForLive(owner, videoId);
                    if (viewerAccess.has(devKey)) {
                        viewerAccess.delete(devKey);
                        saveViewerAccess(viewerAccess);
                    }
                }
                continue;
            }

            const activeDevices = owner ? getActiveDevicesForOwnerAndVideo(owner, videoId) : 0;
            const deviceIPs = owner ? getActiveViewerIPsForOwnerAndVideo(owner, videoId) : [];
            const token = getOrCreateToken(videoId, owner || null);
            const healthSummary = buildMonitorHealth(monitor, { nowMs });
            const rawStatus = monitor.liveState || (monitor.isLive ? 'online' : 'offline');
            const displayStatus = getMonitorDisplayStatus(monitor, healthSummary);
            monitors.push({
                videoId,
                youtubeUrl: monitor.youtubeUrl,
                owner: owner || null,
                token,
                status: displayStatus,
                rawStatus,
                isLive: displayStatus === 'online',
                failCount: monitor.failCount || 0,
                lastRenewSuccess: monitor.lastSuccessTime || monitor.lastUpdate,
                health: monitor.health,
                healthSummary,
                extractionBackoff: {
                    active: Boolean(healthSummary.components?.extraction?.retryAfterSeconds),
                    retryAfterSeconds: healthSummary.components?.extraction?.retryAfterSeconds || 0,
                    nextRetryAt: monitor.nextRetryAt || 0,
                    backoffSeconds: monitor.backoffSeconds || 0,
                    classification: monitor.lastFailureClassification || monitor.lastExtractionFailureClassification || null,
                    consecutiveFailures: monitor.consecutiveExtractionFailures || 0,
                    source: monitor.lastSuccessfulExtractionSource || null
                },
                stalledCount: monitor.stalledCount,
                lastMediaSequence: monitor.lastMediaSequence,
                viewers: activeDevices,
                viewerIPs: deviceIPs,
                title: monitor.metadata?.title || null,
                channel: monitor.metadata?.channel || null
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

// ============================================================
// 🔧 ROTA UPLOAD COOKIE (COM RESET DO ALERTA USANDO reactivateCookie)
// ============================================================
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
            const reactivated = converter.cookieRotator.reactivateCookie(cookieKey);
            if (reactivated) {
                console.log(`✅ Cookie ${cookieKey} reativado via upload manual.`);
            } else {
                console.warn(`⚠️ Falha ao reativar ${cookieKey} via upload (pode já estar válido).`);
            }
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

// ============================================================
// ROTA PARA FINALIZAR MONITOR
// ============================================================
app.post('/api/monitor/stop/:videoId', async (req, res) => {
    const videoId = req.params.videoId;
    const owner = (req.body && req.body.owner) ? req.body.owner : null;

    try {
        let monitorFound = null;
        let keyFound = null;
        let actualOwner = null;

        if (owner) {
            const key = `${videoId}:${owner}`;
            if (converter.activeMonitors.has(key)) {
                monitorFound = converter.activeMonitors.get(key);
                keyFound = key;
                actualOwner = owner;
            }
        }

        if (!monitorFound) {
            for (const [key, mon] of converter.activeMonitors.entries()) {
                const parts = key.split(':');
                if (parts[0] === videoId) {
                    if (!owner || parts[1] === owner) {
                        monitorFound = mon;
                        keyFound = key;
                        actualOwner = parts[1] || null;
                        break;
                    }
                }
            }
            if (!monitorFound && converter.activeMonitors.has(videoId)) {
                monitorFound = converter.activeMonitors.get(videoId);
                keyFound = videoId;
                actualOwner = null;
            }
        }

        if (!monitorFound) {
            return res.status(404).json({ success: false, message: 'Monitor não encontrado' });
        }

        const isAdmin = req.session && req.session.admin === true;

        if (actualOwner && actualOwner !== owner && !isAdmin) {
            return res.status(403).json({ success: false, message: 'Você não tem permissão para parar esta live' });
        }

        monitorFound.stopMonitoring();
        converter.activeMonitors.delete(keyFound);
        if (converter.clearExtractionBackoff) {
            converter.clearExtractionBackoff(videoId, actualOwner);
        }
        removePersistedMapping(videoId, actualOwner);

        if (actualOwner) {
            const key = `${actualOwner}:${videoId}`;
            ownerViewers.delete(key);
            saveOwnerViewers(ownerViewers);
            playbackSessions.removeForLive(actualOwner, videoId);
            viewerAccess.delete(`${actualOwner}:${videoId}`);
            saveViewerAccess(viewerAccess);
        } else {
            viewerAccess.delete(videoId);
            saveViewerAccess(viewerAccess);
        }

        m3u8CacheContent.delete(videoId);
        m3u8CachePromises.delete(videoId);
        lastGoodM3u8.delete(videoId);
        lastServedSequence.delete(videoId);

        for (const [token, info] of Object.entries(tokenMap)) {
            if (info.videoId === videoId && info.owner === actualOwner) {
                revokeToken(token);
                console.log(`🗑️ Token ${token} revogado para ${videoId}:${actualOwner}`);
                break;
            }
        }

        console.log(`✅ Monitor finalizado manualmente: ${keyFound}`);
        res.json({ success: true, message: 'Live finalizada com sucesso' });
    } catch (error) {
        console.error(`❌ Erro ao finalizar monitor ${videoId}:`, error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ============================================================
// ATUALIZAÇÃO AUTOMÁTICA DO YT-DLP
// ============================================================
async function runCommand(cmd, args, timeoutMs = 30000) {
    return new Promise((resolve) => {
        const child = spawn(cmd, args);
        let stdout = '', stderr = '';
        const timeoutId = setTimeout(() => {
            child.kill('SIGTERM');
            resolve({ success: false, error: 'Timeout' });
        }, timeoutMs);

        child.stdout.on('data', (data) => { stdout += data.toString(); });
        child.stderr.on('data', (data) => { stderr += data.toString(); });

        child.on('close', (code) => {
            clearTimeout(timeoutId);
            if (code === 0) {
                resolve({ success: true, output: stdout, cmd: cmd });
            } else {
                resolve({ success: false, error: stderr || stdout || `Código ${code}` });
            }
        });

        child.on('error', (err) => {
            clearTimeout(timeoutId);
            resolve({ success: false, error: err.message });
        });
    });
}

async function updateYtDlp() {
    const isWin = process.platform === 'win32';
    const commands = [];
    if (isWin) {
        commands.push({ cmd: '.\\yt-dlp.exe', args: ['-U'] });
    } else {
        commands.push(
            { cmd: 'yt-dlp', args: ['-U'] },
            { cmd: 'pip', args: ['install', '-U', 'yt-dlp'] },
            { cmd: 'python3', args: ['-m', 'pip', 'install', '-U', 'yt-dlp'] }
        );
    }

    for (const entry of commands) {
        try {
            console.log(`🔄 Tentando: ${entry.cmd} ${entry.args.join(' ')}`);
            const result = await runCommand(entry.cmd, entry.args, 30000);
            if (result.success) {
                console.log(`✅ Atualização bem-sucedida com: ${entry.cmd}`);
                return result;
            }
        } catch (err) {
            console.warn(`⚠️ Falha com ${entry.cmd}: ${err.message}`);
        }
    }

    return { success: false, error: 'Todos os métodos de atualização falharam.' };
}

const AUTO_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;

setInterval(async () => {
    console.log('🔄 [AGENDADO] Iniciando atualização automática do yt-dlp...');
    const result = await updateYtDlp();
    if (result.success) {
        console.log('✅ yt-dlp foi atualizado para a versão mais recente.');
        if (converter && converter.activeMonitors) {
            console.log('🔄 Forçando renovação dos monitores para usar nova versão...');
            for (const [key, monitor] of converter.activeMonitors.entries()) {
                monitor.requestRefresh().catch(e => console.warn(`Falha ao renovar ${key}:`, e.message));
            }
        }
    } else {
        console.log(`ℹ️ Nenhuma atualização disponível ou erro: ${result.error}`);
    }
}, AUTO_UPDATE_INTERVAL_MS);

app.get('/admin/update-ytdlp', isAuthenticated, async (req, res) => {
    try {
        const result = await updateYtDlp();
        if (result.success) {
            res.json({ success: true, message: 'yt-dlp atualizado com sucesso!', output: result.output });
        } else {
            res.status(500).json({ success: false, message: 'Falha na atualização', error: result.error });
        }
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ========== INICIALIZAÇÃO ==========
const EmailAlerts = require('./alerts/emailAlerts');
const ConvertAPI = require('./api/convert');
const emailAlerts = new EmailAlerts();

const revokeTokenFn = (videoId, owner) => {
    for (const [token, info] of Object.entries(tokenMap)) {
        if (info.videoId === videoId && info.owner === owner) {
            revokeToken(token);
            console.log(`🗑️ Token revogado para ${videoId}:${owner}`);
            break;
        }
    }
    if (owner) {
        const key = `${owner}:${videoId}`;
        if (ownerViewers.has(key)) {
            ownerViewers.delete(key);
            saveOwnerViewers(ownerViewers);
            console.log(`🧹 Dispositivos de ${key} limpos após encerramento automático da live.`);
        }
        playbackSessions.removeForLive(owner, videoId);
        const accessKey = `${owner}:${videoId}`;
        if (viewerAccess.has(accessKey)) {
            viewerAccess.delete(accessKey);
            saveViewerAccess(viewerAccess);
        }
    } else {
        if (viewerAccess.has(videoId)) {
            viewerAccess.delete(videoId);
            saveViewerAccess(viewerAccess);
        }
    }
};

converter = new ConvertAPI(emailAlerts, null, revokeTokenFn);

if (emailAlerts && converter.cookieRotator) {
    emailAlerts.setCookieRotator(converter.cookieRotator);
    if (converter.cookieRotator.setRefreshQueue) {
        converter.cookieRotator.setRefreshQueue(cookieRefreshQueue);
        console.log('🧾 Fila de atualização de cookies injetada no CookieRotator');
    }
    console.log('📧 CookieRotator injetado no EmailAlerts');
} else {
    console.log('⚠️ Não foi possível injetar CookieRotator no EmailAlerts');
}

startCookieAgentAlertWatcher();

// ============================================================
// ✅ VALIDAÇÃO CORRIGIDA DOS COOKIES NA INICIALIZAÇÃO
// ============================================================
(async function validateCookiesOnStartup() {
    if (!converter || !converter.cookieRotator) return;
    console.log('🔍 Validando cookies na inicialização (extração real de HLS)...');
    const cookieFiles = ['cookie1.txt', 'cookie2.txt', 'cookie3.txt'];
    const TEST_URL = getCookieStreamTestUrl();
    const testVideoId = extractVideoIdFromUrl(TEST_URL);
    let validationInconclusive = false;

    for (const file of cookieFiles) {
        const fullPath = path.join(cookiesDir, file);
        if (!fs.existsSync(fullPath)) {
            console.log(`⚠️ ${file} não encontrado, ignorando.`);
            continue;
        }

        const cookieKey = file;
        const currentState = converter.cookieRotator.status[cookieKey]?.state || 'valid';

        try {
            console.log(`🔍 Testando ${file} com extração real de stream...`);
            const stdout = await runYtdlp(buildYtdlpDumpJsonArgs({
                url: TEST_URL,
                source: 'cookie',
                cookiePath: fullPath
            }), 45000, false);

            const metadata = JSON.parse(stdout);
            const diagnostics = getYtdlpDiagnostics(metadata);
            const selection = selectHlsStream(metadata, {
                maxHeight: parseInt(process.env.VIDEO_MAX_HEIGHT, 10) || 720,
                forceArtificial: true
            });
            console.log(`[startup:${file}] yt-dlp JSON: formats=${diagnostics.formatCount}, protocols=${diagnostics.protocols.join('|') || 'nenhum'}, requested=${diagnostics.requestedFormatsCount}, live=${diagnostics.liveStatus || 'n/a'}`);

            if (!selection.ok) {
                const extractionError = new Error(`Falha de validação de stream: ${selection.classification}`);
                extractionError.classification = selection.classification || CLASSIFICATION.UNKNOWN;
                extractionError.diagnostics = selection.diagnostics;
                throw extractionError;
            }

            converter.cookieRotator.markExtractionSuccess(cookieKey, {
                probeVideoId: testVideoId
            });
            if (currentState !== 'valid') {
                console.log(`✅ ${file} voltou de '${currentState}' para 'valid' após extração real bem-sucedida.`);
            } else {
                console.log(`✅ ${file} validado para streaming (${selection.type}, ${selection.urlPreview})`);
            }
        } catch (err) {
            const classification = err.classification || classifyYtdlpError(err.message);
            const safeError = sanitizeYtdlpMessage(err.message);
            console.log(`❌ ${file} falhou na validação real: ${classification} - ${safeError}`);
            if (err.diagnostics) {
                console.log(`[startup:${file}] Diagnóstico seguro: ${JSON.stringify(err.diagnostics)}`);
            }
            if (isValidationTargetUnavailableClassification(classification)) {
                validationInconclusive = true;
            }
            if (classification === CLASSIFICATION.AUTH_COOKIE || converter.cookieRotator.isCookieAuthError(err.message)) {
                converter.cookieRotator.markFailure(cookieKey, err.message, 'startup-validation');
            } else {
                const diagnostics = err.diagnostics || null;
                converter.cookieRotator.markExtractionFailure(cookieKey, classification, safeError, 'startup-validation', {
                    probeVideoId: testVideoId,
                    metadataValid: diagnostics ? true : undefined,
                    formatsValid: diagnostics ? diagnostics.formatCount > 0 : undefined,
                    hlsValid: false
                });
            }
        }
    }

    const statusAfterValidation = converter.cookieRotator.getFunctionalStatus();
    const problematic = Object.entries(statusAfterValidation)
        .filter(([name, info]) => info.state !== 'valid' && info.alertActive === true);

    if (problematic.length > 0) {
        console.log(`📧 Enviando alerta de inicialização com ${problematic.length} cookie(s) problemático(s)...`);
        if (emailAlerts && emailAlerts.sendCookieFailureSummaryAlert) {
            emailAlerts.sendCookieFailureSummaryAlert(problematic);
        }
    } else if (validationInconclusive) {
        console.log('ℹ️ Validação de stream dos cookies inconclusiva: a URL de validação está indisponível/encerrada. Estado dos cookies preservado.');
    } else {
        const allValid = Object.values(statusAfterValidation).every(v => v.valid === true);
        if (allValid) {
            console.log('✅ Todos os cookies estão válidos para extração real após validação.');
        } else {
            console.log('ℹ️ Há cookies sem validação completa de streaming; dashboard não deve exibir falso OK.');
        }
    }

    if (emailAlerts && emailAlerts.checkCookiesHealthAlert && !validationInconclusive) {
        setTimeout(() => {
            console.log('🔄 Iniciando verificação periódica de cookies após validação...');
            emailAlerts.checkCookiesHealthAlert();
        }, 1000);
    } else if (validationInconclusive) {
        console.log('ℹ️ Alerta periódico de cookies pulado nesta inicialização por validação inconclusiva.');
    }

    setTimeout(async () => {
        await restoreMonitorsPersistence();
    }, 2000);
})();

// ============================================================
// RENOVAÇÃO E LIMPEZA PERIÓDICA
// ============================================================
setInterval(() => {
    let modified = false;
    const now = Date.now();
    for (const [key, viewers] of ownerViewers.entries()) {
        for (const [ip, timestamp] of viewers.entries()) {
            if (now - timestamp > VIEWER_WINDOW_MS) {
                viewers.delete(ip);
                modified = true;
                console.log(`[${key}] 🧹 IP ${ip} expirado (inatividade > ${VIEWER_WINDOW_MS / 3600000}h)`);
            }
        }
        if (viewers.size === 0) {
            ownerViewers.delete(key);
        }
    }
    if (modified) {
        saveOwnerViewers(ownerViewers);
        console.log(`🧹 Limpeza periódica: IPs expirados removidos.`);
    }
}, 7200000);

setInterval(() => {
    if (!converter?.activeMonitors) return;
    console.log(`🔁 [RENOVAÇÃO] Executando ciclo de renovação...`);
    for (const [key, monitor] of converter.activeMonitors.entries()) {
        const parts = key.split(':');
        const videoId = parts[0];
        const owner = parts[1];
        if (owner && videoId) {
            renewViewersForMonitor(owner, videoId);
        }
    }
}, 180000);

// ============================================================
// VERIFICAÇÃO DE COOKIES (a cada 30 min)
// ============================================================
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

app.get('/', (req, res) => {
    res.redirect('/converter.html');
});

app.listen(PORT, BIND_HOST, () => {
    console.log('========================================');
    console.log('NeoNews Live Converter V3 - SSOT + GlobalScheduler + Tokens');
    console.log('========================================');
    console.log(`Bind: ${BIND_HOST}:${PORT}`);
    console.log(`Trust proxy: ${TRUST_PROXY.label}`);
    console.log(`Conversor público: http://${BIND_HOST}:${PORT}/converter.html`);
    console.log(`Dashboard protegido: http://${BIND_HOST}:${PORT}/dashboard`);
    console.log(`API Health: http://${BIND_HOST}:${PORT}/health`);
    console.log(`Métricas: http://${BIND_HOST}:${PORT}/metrics`);
    console.log(`Timeout de dispositivos: ${VIEWER_WINDOW_MS}ms (${VIEWER_WINDOW_MS / 3600000}h)`);
    console.log('========================================\n');
});
