const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { spawn } = require('child_process');
const session = require('express-session');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const CookieRefreshQueue = require('./services/cookieRefreshQueue');
const { HlsSegmentCache } = require('./services/hlsSegmentCache');
const {
    PlaybackSessionStore,
    sessionPreview
} = require('./services/playbackSessionStore');
const { parseTrustProxyConfig, resolveBindHost } = require('./services/httpRuntimeConfig');
const {
    buildMonitorHealth,
    buildSystemHealth,
    getMonitorDisplayStatus,
    isMonitorEnding,
    isMonitorTerminalAvailability
} = require('./services/healthSnapshot');
const {
    CLASSIFICATION,
    classifyYtdlpError,
    getYtdlpDiagnostics,
    buildYtdlpDumpJsonArgs,
    selectHlsStream,
    sanitizeYtdlpMessage,
    shouldAttemptPublicFallback
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
const DEFAULT_PUBLIC_HLS_BASE_URL = 'https://livemonitor.vps-kinghost.net';
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
const TOKEN_TOMBSTONE_TTL_MS = parseInt(process.env.TOKEN_TOMBSTONE_TTL_MS, 10) || 7 * 24 * 60 * 60 * 1000;

function loadTokens() {
    try {
        const data = JSON.parse(fs.readFileSync(tokensFile, 'utf8'));
        return data;
    } catch (e) {
        return {};
    }
}

function saveTokens(tokens) {
    pruneTokenTombstones(tokens);
    fs.writeFileSync(tokensFile, JSON.stringify(tokens, null, 2));
}

let tokenMap = loadTokens(); // token -> { videoId, owner }

function pruneTokenTombstones(tokens, now = Date.now()) {
    if (!tokens || typeof tokens !== 'object') return 0;
    let removed = 0;
    for (const [token, info] of Object.entries(tokens)) {
        if (!info?.revokedAt) continue;
        const revokedAt = Date.parse(info.revokedAt);
        if (!Number.isFinite(revokedAt) || now - revokedAt > TOKEN_TOMBSTONE_TTL_MS) {
            delete tokens[token];
            removed += 1;
        }
    }
    return removed;
}

if (pruneTokenTombstones(tokenMap) > 0) {
    saveTokens(tokenMap);
}

function getOrCreateToken(videoId, owner) {
    const key = owner ? `${videoId}:${owner}` : videoId;
    for (const [token, value] of Object.entries(tokenMap)) {
        if (value.videoId === videoId && value.owner === owner && !value.revokedAt) {
            return token;
        }
    }
    const token = crypto.randomBytes(16).toString('hex');
    tokenMap[token] = { videoId, owner };
    saveTokens(tokenMap);
    return token;
}

function tokenPreview(token) {
    const value = String(token || '');
    return value.length > 8 ? `${value.slice(0, 8)}...` : value || 'n/a';
}

function isRevokedTokenInfo(info) {
    return Boolean(info && info.revokedAt);
}

function revokeToken(token, reason = 'gone') {
    const existing = tokenMap[token];
    if (!existing) return false;
    clearHlsSessionVariantStateFor({
        owner: existing.owner || null,
        videoId: existing.videoId || null,
        token
    });
    tokenMap[token] = {
        ...existing,
        revokedAt: existing.revokedAt || new Date().toISOString(),
        revokedReason: existing.revokedReason || String(reason || 'gone').slice(0, 80)
    };
    saveTokens(tokenMap);
    return true;
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
    prunePlaybackVariantUrlPins();
    pruneHlsMediaPlaylistHistory();
    pruneHlsSessionVariantState();
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
// MÉTRICAS DE FALLBACK PÚBLICO
// ============================================================
let publicFallbackAttempts = 0;
let publicFallbackSuccess = 0;
let publicFallbackFailure = 0;

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

function getPublicFallbackStats() {
    return { publicFallbackAttempts, publicFallbackSuccess, publicFallbackFailure };
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

function runYtdlp(args, timeout = 30000, allowCookieFallback = true, options = {}) {
    const {
        allowPublicFallback = false,
        disableCookies = false
    } = (typeof options === 'object' && options !== null) ? options : {};

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

        // Remove --cookies-from-browser se presente
        let cookiefromIndex = finalArgs.indexOf('--cookies-from-browser');
        if (cookiefromIndex !== -1) {
            finalArgs.splice(cookiefromIndex, 2);
        }

        let cookieIndex = finalArgs.indexOf('--cookies');
        let cookiePath = null;
        if (cookieIndex !== -1 && finalArgs.length > cookieIndex + 1) {
            cookiePath = finalArgs[cookieIndex + 1];
        }

        // disableCookies: remove --cookies se explicitamente informado
        if (disableCookies && cookiePath) {
            const ci = finalArgs.indexOf('--cookies');
            if (ci !== -1) {
                finalArgs.splice(ci, 2);
            }
            cookiePath = null;
        }

        // Não injetar cookie1 automaticamente se disableCookies=true
        if (!cookiePath && !disableCookies) {
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
                const argsWithCookie = cookieFile ? [...finalArgs] : [...finalArgs];
                if (cookieFile) {
                    const idx = argsWithCookie.indexOf('--cookies');
                    if (idx !== -1) {
                        argsWithCookie.splice(idx, 2);
                    }
                    argsWithCookie.unshift('--cookies', cookieFile);
                } else {
                    // Tentativa pública: remover qualquer --cookies residual
                    const idx = argsWithCookie.indexOf('--cookies');
                    if (idx !== -1) {
                        argsWithCookie.splice(idx, 2);
                    }
                }

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
                        if (cookieFile && errorMsg.includes('No video formats found')) {
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
                const failures = [];
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
                        const innerClassification = innerErr.message.includes('No video formats found')
                            ? CLASSIFICATION.NO_FORMATS
                            : CLASSIFICATION.UNKNOWN;
                        failures.push({ file, classification: innerClassification });
                        if (innerErr.message.includes('No video formats found')) {
                            console.log(`❌ ${file} também falhou.`);
                        } else {
                            throw innerErr;
                        }
                    }
                }
                if (!tried && allowPublicFallback && shouldAttemptPublicFallback(failures)) {
                    publicFallbackAttempts++;
                    try {
                        console.log(`🌐 Tentando extracao publica sem cookie...`);
                        const result = await execWithCookie(null);
                        publicFallbackSuccess++;
                        console.log(`🌐 public-fallback success`);
                        resolve(result.stdout);
                        tried = true;
                    } catch (publicErr) {
                        publicFallbackFailure++;
                        console.log(`🌐 public-fallback failure: ${classifyYtdlpError(publicErr.message)}`);
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
// Playlists live precisam ficar frescas para evitar segmentos/URLs expirados no player.
function parseNonNegativeIntegerEnv(name, fallback) {
    const value = parseInt(process.env[name], 10);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function parseHlsStartOffsetEnv(name, fallback) {
    const value = Number(process.env[name]);
    if (!Number.isFinite(value)) return fallback;
    return value <= 0 ? value : -Math.abs(value);
}

const M3U8_CACHE_TTL = parseInt(process.env.M3U8_CACHE_TTL) || 2000;
const PLAYBACK_VARIANT_PIN_TTL_MS = parseInt(process.env.PLAYBACK_VARIANT_PIN_TTL_MS, 10) || 0;
const HLS_SEGMENT_PROXY_MODE = String(process.env.HLS_SEGMENT_PROXY_MODE || 'auto').toLowerCase();
const HLS_EXOMEDIA_SEGMENT_PROXY = String(process.env.HLS_EXOMEDIA_SEGMENT_PROXY || 'true').toLowerCase() !== 'false';
const HLS_LEGACY_VLC_SEGMENT_PROXY = String(process.env.HLS_LEGACY_VLC_SEGMENT_PROXY || 'true').toLowerCase() !== 'false';
const HLS_SEGMENT_PROXY_TTL_MS = parseInt(process.env.HLS_SEGMENT_PROXY_TTL_MS, 10) || 3 * 60 * 1000;
const HLS_EXTENDED_WINDOW_SEGMENTS = parseInt(process.env.HLS_EXTENDED_WINDOW_SEGMENTS, 10) || 7;
const HLS_COMPAT_TARGET_DURATION = parseInt(process.env.HLS_COMPAT_TARGET_DURATION, 10) || 8;
const HLS_SESSION_UPSTREAM_STUCK_MS = parseInt(process.env.HLS_SESSION_UPSTREAM_STUCK_MS, 10) || 45000;
const HLS_SESSION_DISCONTINUITY_RESET_MS = parseInt(process.env.HLS_SESSION_DISCONTINUITY_RESET_MS, 10) || 12000;
const HLS_EXOMEDIA_SINGLE_VARIANT_MASTER = String(process.env.HLS_EXOMEDIA_SINGLE_VARIANT_MASTER || 'true').toLowerCase() !== 'false';
const HLS_EXOMEDIA_SINGLE_VARIANT_HEIGHT = parseInt(process.env.HLS_EXOMEDIA_SINGLE_VARIANT_HEIGHT, 10) || 720;
const HLS_EXOMEDIA_ANDROID_MAX_FPS = parseNonNegativeIntegerEnv('HLS_EXOMEDIA_ANDROID_MAX_FPS', 30);
const HLS_EXOMEDIA_ANDROID_FALLBACK_HEIGHT = Math.max(144, parseNonNegativeIntegerEnv('HLS_EXOMEDIA_ANDROID_FALLBACK_HEIGHT', 480));
const HLS_EXOMEDIA_START_TIME_OFFSET_SECONDS = parseHlsStartOffsetEnv('HLS_EXOMEDIA_START_TIME_OFFSET_SECONDS', 40);
const HLS_EXOMEDIA_STEADY_LIVE_EDGE_OFFSET_SEGMENTS = Math.min(2, parseNonNegativeIntegerEnv('HLS_EXOMEDIA_STEADY_LIVE_EDGE_OFFSET_SEGMENTS', 2));
const HLS_EXOMEDIA_STABLE_WINDOW_SEGMENTS = Math.max(
    HLS_EXTENDED_WINDOW_SEGMENTS,
    parseNonNegativeIntegerEnv('HLS_EXOMEDIA_STABLE_WINDOW_SEGMENTS', 12)
);
const HLS_EXOMEDIA_STARTUP_WINDOW_MS = parseNonNegativeIntegerEnv('HLS_EXOMEDIA_STARTUP_WINDOW_MS', 3 * 60 * 1000);
const HLS_EXOMEDIA_STARTUP_WINDOW_SEGMENTS = Math.max(3, parseNonNegativeIntegerEnv('HLS_EXOMEDIA_STARTUP_WINDOW_SEGMENTS', 12));
const HLS_EXOMEDIA_MIN_SEGMENTS_WITH_LIVE_EDGE_OFFSET = Math.max(3, parseNonNegativeIntegerEnv('HLS_EXOMEDIA_MIN_SEGMENTS_WITH_LIVE_EDGE_OFFSET', 5));
const HLS_VLC_SINGLE_VARIANT_MASTER = String(process.env.HLS_VLC_SINGLE_VARIANT_MASTER || 'true').toLowerCase() !== 'false';
const HLS_VLC_MEDIA_PLAYLIST_STABILIZATION = String(process.env.HLS_VLC_MEDIA_PLAYLIST_STABILIZATION || 'true').toLowerCase() !== 'false';
const HLS_VLC_START_TIME_OFFSET_SECONDS = parseHlsStartOffsetEnv('HLS_VLC_START_TIME_OFFSET_SECONDS', 0);
const HLS_VLC_STARTUP_LIVE_EDGE_OFFSET_SEGMENTS = Math.min(2, parseNonNegativeIntegerEnv('HLS_VLC_STARTUP_LIVE_EDGE_OFFSET_SEGMENTS', 2));
const HLS_VLC_STARTUP_WINDOW_MS = parseNonNegativeIntegerEnv('HLS_VLC_STARTUP_WINDOW_MS', 3 * 60 * 1000);
const HLS_VLC_STARTUP_MIN_SEGMENTS = Math.max(3, parseNonNegativeIntegerEnv('HLS_VLC_STARTUP_MIN_SEGMENTS', 5));
const HLS_VLC_STEADY_LIVE_EDGE_OFFSET_SEGMENTS = Math.min(2, parseNonNegativeIntegerEnv('HLS_VLC_STEADY_LIVE_EDGE_OFFSET_SEGMENTS', 2));
const HLS_LEGACY_VLC_DEFAULT_HEIGHT = Math.max(144, parseNonNegativeIntegerEnv('HLS_LEGACY_VLC_DEFAULT_HEIGHT', 480));
const HLS_VLC_STABLE_WINDOW_SEGMENTS = Math.max(
    HLS_EXTENDED_WINDOW_SEGMENTS,
    parseNonNegativeIntegerEnv('HLS_VLC_STABLE_WINDOW_SEGMENTS', 12)
);
const HLS_DIAGNOSTIC_MODE = String(process.env.HLS_DIAGNOSTIC_MODE || '').toLowerCase() === 'true';
const HLS_DISABLE_WINDOW_ADJUSTMENT = String(process.env.HLS_DISABLE_WINDOW_ADJUSTMENT || '').toLowerCase() === 'true';
const HLS_SEGMENT_NETWORK_DIAG = String(process.env.HLS_SEGMENT_NETWORK_DIAG || '').toLowerCase() === 'true';
const HLS_SEGMENT_FORCE_IPV4 = String(process.env.HLS_SEGMENT_FORCE_IPV4 || '').toLowerCase() === 'true';
const HLS_PLAYBACK_STALL_DIAG = String(process.env.HLS_PLAYBACK_STALL_DIAG || '').toLowerCase() === 'true';
const HLS_SEGMENT_TRANSIENT_RETRY = String(process.env.HLS_SEGMENT_TRANSIENT_RETRY || '').toLowerCase() === 'true';
const HLS_SEGMENT_TRANSIENT_RETRY_MAX = Math.max(0, parseInt(process.env.HLS_SEGMENT_TRANSIENT_RETRY_MAX) || 1);
const HLS_SEGMENT_TRANSIENT_RETRY_DELAY_MS = Math.max(0, parseInt(process.env.HLS_SEGMENT_TRANSIENT_RETRY_DELAY_MS) || 100);
const HLS_VLC_SAFE_LIVE_EDGE = String(process.env.HLS_VLC_SAFE_LIVE_EDGE || '').toLowerCase() === 'true';
const HLS_VLC_SAFE_LIVE_EDGE_SEGMENTS = Math.max(1, parseInt(process.env.HLS_VLC_SAFE_LIVE_EDGE_SEGMENTS) || 3);


// ========== HLS SEGMENT CACHE ==========
const HLS_SEGMENT_CACHE_ENABLED = String(process.env.HLS_SEGMENT_CACHE_ENABLED || 'false').toLowerCase() === 'true';
const HLS_SEGMENT_CACHE_DIR = process.env.HLS_SEGMENT_CACHE_DIR || '/var/cache/livemonitor/hls-segments';
const HLS_SEGMENT_CACHE_TTL_MS = Math.max(30000, parseInt(process.env.HLS_SEGMENT_CACHE_TTL_MS, 10) || 120000);
const HLS_SEGMENT_CACHE_MAX_BYTES = Math.max(1048576, parseInt(process.env.HLS_SEGMENT_CACHE_MAX_BYTES, 10) || 1073741824);
const HLS_SEGMENT_CACHE_MAX_FILES = Math.max(100, parseInt(process.env.HLS_SEGMENT_CACHE_MAX_FILES, 10) || 5000);
const HLS_SEGMENT_PREFETCH_ENABLED = HLS_SEGMENT_CACHE_ENABLED && String(process.env.HLS_SEGMENT_PREFETCH_ENABLED || 'true').toLowerCase() !== 'false';
const HLS_SEGMENT_PREFETCH_CONCURRENCY = Math.max(1, parseInt(process.env.HLS_SEGMENT_PREFETCH_CONCURRENCY, 10) || 4);
const HLS_SEGMENT_PREFETCH_TIMEOUT_MS = Math.max(5000, parseInt(process.env.HLS_SEGMENT_PREFETCH_TIMEOUT_MS, 10) || 10000);
const HLS_SEGMENT_PLAYLIST_WAIT_MS = Math.max(1000, parseInt(process.env.HLS_SEGMENT_PLAYLIST_WAIT_MS, 10) || 2000);
const HLS_SEGMENT_CACHE_MIN_READY = Math.max(1, parseInt(process.env.HLS_SEGMENT_CACHE_MIN_READY, 10) || 3);
const HLS_SEGMENT_CACHE_VIDEO_IDS_RAW = String(process.env.HLS_SEGMENT_CACHE_VIDEO_IDS || '').trim();
const HLS_SEGMENT_CACHE_VIDEO_IDS = HLS_SEGMENT_CACHE_VIDEO_IDS_RAW
  ? HLS_SEGMENT_CACHE_VIDEO_IDS_RAW.split(',').map(s => s.trim()).filter(id => /^[0-9A-Za-z_-]{11}$/.test(id))
  : [];

const REFRESH_WAIT_MS = 20000; // Aumentado para 20s
const STALE_SERVE_MAX_AGE_MS = parseInt(process.env.STALE_MAX_AGE_MS) || 60000; // 1 minuto

const lastGoodM3u8 = new Map();
const playbackVariantUrlPins = new Map();
const hlsSegmentProxyEntries = new Map();
const hlsMediaPlaylistHistory = new Map();
const hlsSessionVariantState = new Map();
const hlsSessionVariantPins = new Map();
let hlsSegmentCache = null;

function rememberGoodM3u8(videoId, content) {
    const info = parseM3u8Info(content);
    lastGoodM3u8.set(videoId, {
        content,
        fetchedAt: Date.now(),
        sequence: info.sequence,
        lastSequence: info.lastSequence,
        segments: info.segments
    });
}

function getStaleM3u8IfFresh(videoId, monitorLastSeq) {
    const entry = lastGoodM3u8.get(videoId);
    if (!entry) return null;
    const age = Date.now() - entry.fetchedAt;
    if (age > STALE_SERVE_MAX_AGE_MS) return null;
    const comparableSequence = entry.lastSequence ?? entry.sequence;
    if (monitorLastSeq !== null && comparableSequence !== null) {
        const lag = monitorLastSeq - comparableSequence;
        if (lag > 5) {
            console.log(`[${videoId}] ⚠️ Stale muito atrasado (seq ${entry.sequence}-${comparableSequence}, monitor em ${monitorLastSeq}, lag=${lag}), não servindo.`);
            return null;
        }
    }
    return { content: entry.content, age, sequence: entry.sequence };
}

function prunePlaybackVariantUrlPins(now = Date.now()) {
    let removed = 0;
    for (const [key, pin] of playbackVariantUrlPins.entries()) {
        if (!pin || now - (Number(pin.updatedAt) || 0) > PLAYBACK_VARIANT_PIN_TTL_MS) {
            playbackVariantUrlPins.delete(key);
            removed += 1;
        }
    }
    return removed;
}

function normalizeHlsStateKeyPart(value, fallback = 'none') {
    const normalized = String(value || '').trim().replace(/[^a-z0-9._-]/ig, '_').slice(0, 80);
    return normalized || fallback;
}

function getPlaybackVariantPinKey(videoId, height, sessionId, owner = null, token = null) {
    if (!videoId || !height || !sessionId) return null;
    const safeVideoId = normalizeHlsStateKeyPart(videoId, 'video');
    const safeHeight = Number.isFinite(Number(height)) ? String(Number(height)) : 'auto';
    const ownerHash = owner ? getShortHash(owner, 12) : 'public';
    const tokenHash = token ? getShortHash(token, 12) : 'direct';
    return `${safeVideoId}:${ownerHash}:${tokenHash}:${safeHeight}:${getShortHash(sessionId, 16)}`;
}

function getPinnedVariantUrl(pinKey, currentUrl) {
    if (!PLAYBACK_VARIANT_PIN_TTL_MS) return currentUrl;
    if (!pinKey) return currentUrl;
    const now = Date.now();
    const pin = playbackVariantUrlPins.get(pinKey);
    if (pin && pin.url && now - pin.updatedAt <= PLAYBACK_VARIANT_PIN_TTL_MS) {
        return pin.url;
    }
    playbackVariantUrlPins.set(pinKey, {
        url: currentUrl,
        createdAt: now,
        updatedAt: now
    });
    return currentUrl;
}

function rememberPinnedVariantUrl(pinKey, url) {
    if (!PLAYBACK_VARIANT_PIN_TTL_MS) return;
    if (!pinKey || !url) return;
    const now = Date.now();
    const existing = playbackVariantUrlPins.get(pinKey);
    playbackVariantUrlPins.set(pinKey, {
        url,
        createdAt: existing?.createdAt || now,
        updatedAt: now
    });
}

function clearPinnedVariantUrl(pinKey) {
    if (pinKey) playbackVariantUrlPins.delete(pinKey);
}

function getSessionVariantPin(pinKey) {
    if (!pinKey) return null;
    return hlsSessionVariantPins.get(pinKey) || null;
}

function getSessionVariantPinnedUrl(pinKey) {
    return getSessionVariantPin(pinKey)?.url || null;
}

function rememberSessionVariantPin(pinKey, url, metadata = {}) {
    if (!pinKey || !url) return null;
    const now = Date.now();
    const existing = hlsSessionVariantPins.get(pinKey);
    const entry = {
        url,
        videoId: metadata.videoId || existing?.videoId || null,
        owner: metadata.owner || existing?.owner || null,
        tokenHash: metadata.token ? getShortHash(metadata.token, 12) : (existing?.tokenHash || 'direct'),
        quality: metadata.quality || existing?.quality || null,
        sessionHash: metadata.sessionId ? getShortHash(metadata.sessionId, 16) : (existing?.sessionHash || null),
        createdAt: existing?.createdAt || now,
        updatedAt: now,
        discontinuityUntil: existing?.discontinuityUntil || 0,
        refreshRejectedAt: existing?.refreshRejectedAt || 0,
        refreshRejectedCount: existing?.refreshRejectedCount || 0
    };
    hlsSessionVariantPins.set(pinKey, entry);
    return entry;
}

function markSessionVariantRefreshRejected(pinKey, now = Date.now()) {
    if (!pinKey) return null;
    const existing = hlsSessionVariantPins.get(pinKey) || {};
    const entry = {
        ...existing,
        updatedAt: now,
        refreshRejectedAt: now,
        refreshRejectedCount: (Number(existing.refreshRejectedCount) || 0) + 1,
        discontinuityUntil: now + HLS_SESSION_DISCONTINUITY_RESET_MS
    };
    hlsSessionVariantPins.set(pinKey, entry);
    return entry;
}

function getShortHash(value, length = 12) {
    return crypto
        .createHash('sha256')
        .update(String(value || ''))
        .digest('hex')
        .slice(0, length);
}

function getPlaybackSessionTokenScope(token) {
    return token ? getShortHash(token, 32) : 'direct';
}

function getUpstreamIdentityHash(url) {
    return getShortHash(url || 'no-upstream');
}

function getSegmentIdentity(segment, sourceUrl) {
    const uriLine = Array.isArray(segment?.lines)
        ? segment.lines.map(line => String(line || '').trim()).find(line => line && !line.startsWith('#'))
        : '';
    if (!uriLine) return `seq:${segment?.sequence}`;
    try {
        const parsed = new URL(uriLine, sourceUrl);
        return getShortHash(`${parsed.origin}${parsed.pathname}`);
    } catch (_) {
        return getShortHash(uriLine.split('?')[0]);
    }
}

function getPlaylistSnapshot(content, sourceUrl) {
    const text = String(content || '');
    const parsed = parseMediaPlaylistWindow(text);
    const targetMatch = text.match(/^#EXT-X-TARGETDURATION:(\d+)/m);
    const targetDuration = targetMatch ? parseInt(targetMatch[1], 10) : null;
    const discontinuityCount = (text.match(/^#EXT-X-DISCONTINUITY\b/gm) || []).length;
    if (!parsed) {
        const info = parseM3u8Info(text);
        return {
            mediaSequence: info.sequence,
            lastSequence: info.lastSequence,
            segmentCount: info.segments,
            targetDuration: Number.isFinite(targetDuration) ? targetDuration : null,
            discontinuityCount,
            hasDiscontinuity: discontinuityCount > 0,
            segments: [],
            firstSegment: null,
            lastSegment: null
        };
    }
    const segments = parsed.segments.map(segment => ({
        sequence: segment.sequence,
        identity: getSegmentIdentity(segment, sourceUrl)
    }));
    return {
        mediaSequence: parsed.mediaSequence,
        lastSequence: segments.length > 0 ? segments[segments.length - 1].sequence : parsed.mediaSequence,
        segmentCount: segments.length,
        targetDuration: Number.isFinite(targetDuration) ? targetDuration : null,
        discontinuityCount,
        hasDiscontinuity: discontinuityCount > 0,
        segments,
        firstSegment: segments[0]?.identity || null,
        lastSegment: segments[segments.length - 1]?.identity || null
    };
}

function playlistsHaveOverlap(previousSnapshot, nextSnapshot) {
    if (!previousSnapshot || !nextSnapshot) return true;
    const previousSegments = Array.isArray(previousSnapshot.segments) ? previousSnapshot.segments : [];
    const nextSegments = Array.isArray(nextSnapshot.segments) ? nextSnapshot.segments : [];
    if (previousSegments.length === 0 || nextSegments.length === 0) return true;

    if (
        Number.isFinite(Number(previousSnapshot.mediaSequence)) &&
        Number.isFinite(Number(nextSnapshot.mediaSequence)) &&
        Number(nextSnapshot.mediaSequence) < Number(previousSnapshot.mediaSequence)
    ) {
        return false;
    }

    const previousIdentities = new Set(previousSegments.map(segment => segment.identity).filter(Boolean));
    if (nextSegments.some(segment => segment.identity && previousIdentities.has(segment.identity))) {
        return true;
    }

    const previousLast = previousSegments[previousSegments.length - 1].sequence;
    const nextFirst = nextSegments[0].sequence;
    return Number.isFinite(previousLast) && Number.isFinite(nextFirst) && nextFirst === previousLast + 1;
}

function playlistsHaveSegmentIdentityOverlap(previousSnapshot, nextSnapshot) {
    const previousSegments = Array.isArray(previousSnapshot?.segments) ? previousSnapshot.segments : [];
    const nextSegments = Array.isArray(nextSnapshot?.segments) ? nextSnapshot.segments : [];
    if (previousSegments.length === 0 || nextSegments.length === 0) return false;

    const previousIdentities = new Set(previousSegments.map(segment => segment.identity).filter(Boolean));
    return nextSegments.some(segment => segment.identity && previousIdentities.has(segment.identity));
}

function playlistSequenceRangesOverlap(previousSnapshot, nextSnapshot) {
    const previousFirst = Number(previousSnapshot?.mediaSequence);
    const previousLast = Number(previousSnapshot?.lastSequence);
    const nextFirst = Number(nextSnapshot?.mediaSequence);
    const nextLast = Number(nextSnapshot?.lastSequence);

    if (
        !Number.isFinite(previousFirst) ||
        !Number.isFinite(previousLast) ||
        !Number.isFinite(nextFirst) ||
        !Number.isFinite(nextLast)
    ) {
        return false;
    }

    return nextFirst <= previousLast && nextLast >= previousFirst;
}

function isSafePlaylistWindowExpansion(previousSnapshot, nextSnapshot) {
    const previousFirst = Number(previousSnapshot?.mediaSequence);
    const previousLast = Number(previousSnapshot?.lastSequence);
    const nextFirst = Number(nextSnapshot?.mediaSequence);
    const nextLast = Number(nextSnapshot?.lastSequence);

    if (
        !Number.isFinite(previousFirst) ||
        !Number.isFinite(previousLast) ||
        !Number.isFinite(nextFirst) ||
        !Number.isFinite(nextLast)
    ) {
        return false;
    }

    if (nextFirst >= previousFirst) return false;
    if (nextLast < previousLast) return false;

    return playlistsHaveSegmentIdentityOverlap(previousSnapshot, nextSnapshot) ||
        playlistSequenceRangesOverlap(previousSnapshot, nextSnapshot);
}

function shouldRefreshStuckSessionVariant(state, snapshot, now = Date.now()) {
    if (!state || !snapshot || snapshot.mediaSequence === null || snapshot.mediaSequence === undefined) return false;
    const lastServedSequence = Number(state.lastServedSequence);
    if (!Number.isFinite(lastServedSequence)) return false;
    if (snapshot.mediaSequence > lastServedSequence) return false;
    return now - (Number(state.lastAdvanceAt || state.updatedAt || 0)) > HLS_SESSION_UPSTREAM_STUCK_MS;
}

function updateSessionVariantState(stateKey, {
    videoId,
    owner,
    quality,
    sessionId,
    token,
    upstreamUrl,
    snapshot,
    source
}) {
    if (!stateKey || !snapshot) return null;
    const now = Date.now();
    const existing = hlsSessionVariantState.get(stateKey);
    const previousSequence = Number(existing?.lastServedSequence);
    const currentSequence = Number(snapshot.mediaSequence);
    const advanced = Number.isFinite(currentSequence) && (!Number.isFinite(previousSequence) || currentSequence > previousSequence);
    const state = {
        videoId,
        owner,
        tokenHash: token ? getShortHash(token, 12) : 'direct',
        quality,
        sessionHash: sessionId ? getShortHash(sessionId, 16) : null,
        upstreamIdentityHash: getUpstreamIdentityHash(upstreamUrl),
        lastSnapshot: {
            mediaSequence: snapshot.mediaSequence,
            lastSequence: snapshot.lastSequence,
            segmentCount: snapshot.segmentCount,
            targetDuration: snapshot.targetDuration,
            discontinuityCount: snapshot.discontinuityCount,
            hasDiscontinuity: snapshot.hasDiscontinuity,
            segments: snapshot.segments,
            firstSegment: snapshot.firstSegment,
            lastSegment: snapshot.lastSegment
        },
        lastServedSequence: snapshot.mediaSequence,
        lastServedSegments: snapshot.segments,
        targetDuration: snapshot.targetDuration,
        lastAdvanceAt: advanced ? now : (existing?.lastAdvanceAt || now),
        createdAt: existing?.createdAt || now,
        updatedAt: now,
        source
    };
    hlsSessionVariantState.set(stateKey, state);
    return state;
}

function clearSessionVariantState(stateKey) {
    if (!stateKey) return;
    hlsSessionVariantState.delete(stateKey);
    hlsSessionVariantPins.delete(stateKey);
}

function pruneHlsSessionVariantState(now = Date.now()) {
    let removed = 0;
    const maxAgeMs = Math.max(5 * 60 * 1000, STALE_SERVE_MAX_AGE_MS * 4);
    const activeSessionHashesByScope = new Map();
    const isSessionStillActive = (state) => {
        if (!state?.owner || !state?.videoId || !state?.sessionHash) return true;
        const scopeKey = `${state.owner}:${state.videoId}`;
        if (!activeSessionHashesByScope.has(scopeKey)) {
            const activeHashes = new Set(
                playbackSessions.listActive({ owner: state.owner, videoId: state.videoId }, now)
                    .map(session => getShortHash(session.sessionId, 16))
            );
            activeSessionHashesByScope.set(scopeKey, activeHashes);
        }
        return activeSessionHashesByScope.get(scopeKey).has(state.sessionHash);
    };
    for (const [key, state] of hlsSessionVariantState.entries()) {
        if (!state || now - (Number(state.updatedAt) || 0) > maxAgeMs || !isSessionStillActive(state)) {
            hlsSessionVariantState.delete(key);
            hlsSessionVariantPins.delete(key);
            removed += 1;
        }
    }
    for (const [key, pin] of hlsSessionVariantPins.entries()) {
        if (!pin || now - (Number(pin.updatedAt) || 0) > maxAgeMs || !hlsSessionVariantState.has(key)) {
            hlsSessionVariantPins.delete(key);
            removed += 1;
        }
    }
    return removed;
}

function clearHlsSessionVariantStateFor({ owner = null, videoId = null, token = null, sessionId = null } = {}) {
    const tokenHash = token ? getShortHash(token, 12) : null;
    const sessionHash = sessionId ? getShortHash(sessionId, 16) : null;
    let removed = 0;
    const matches = (entry) => {
        if (!entry) return false;
        if (owner !== null && entry.owner !== owner) return false;
        if (videoId !== null && entry.videoId !== videoId) return false;
        if (tokenHash !== null && entry.tokenHash !== tokenHash) return false;
        if (sessionHash !== null && entry.sessionHash !== sessionHash) return false;
        return true;
    };
    for (const [key, state] of hlsSessionVariantState.entries()) {
        if (matches(state)) {
            hlsSessionVariantState.delete(key);
            hlsSessionVariantPins.delete(key);
            removed += 1;
        }
    }
    for (const [key, pin] of hlsSessionVariantPins.entries()) {
        if (matches(pin)) {
            hlsSessionVariantPins.delete(key);
            removed += 1;
        }
    }
    if (videoId) {
        const prefix = `${videoId}_`;
        for (const key of Array.from(m3u8CacheContent.keys())) {
            if (String(key).startsWith(prefix)) m3u8CacheContent.delete(key);
        }
        for (const key of Array.from(m3u8CachePromises.keys())) {
            if (String(key).startsWith(prefix)) m3u8CachePromises.delete(key);
        }
        for (const key of Array.from(lastServedSequence.keys())) {
            if (String(key).startsWith(videoId)) lastServedSequence.delete(key);
        }
        for (const key of Array.from(lastGoodM3u8.keys())) {
            if (String(key).startsWith(videoId)) lastGoodM3u8.delete(key);
        }
        for (const key of Array.from(playbackVariantUrlPins.keys())) {
            if (String(key).startsWith(videoId)) playbackVariantUrlPins.delete(key);
        }
        for (const key of Array.from(hlsMediaPlaylistHistory.keys())) {
            if (String(key).startsWith(videoId)) hlsMediaPlaylistHistory.delete(key);
        }
    }
    return removed;
}

function isExoCompatibleUserAgent(req) {
    const userAgent = String(req?.headers?.['user-agent'] || '').toLowerCase();
    return /\b(exomedia|neonews)\b/.test(userAgent);
}

function isExoAndroidUserAgent(req) {
    const userAgent = String(req?.headers?.['user-agent'] || '').toLowerCase();
    return isExoCompatibleUserAgent(req) && /\bandroid\b/.test(userAgent);
}

function isVlcCompatibleUserAgent(req) {
    const userAgent = String(req?.headers?.['user-agent'] || '').toLowerCase();
    return /\b(vlc|libvlc)\b/.test(userAgent);
}

function shouldStabilizeVlcMediaPlaylist(req) {
    return HLS_VLC_MEDIA_PLAYLIST_STABILIZATION && isLegacyVlcSegmentProxyUserAgent(req);
}

function shouldUseSingleVariantMaster(req) {
    return (HLS_EXOMEDIA_SINGLE_VARIANT_MASTER && isExoCompatibleUserAgent(req)) ||
        (HLS_VLC_SINGLE_VARIANT_MASTER && isVlcCompatibleUserAgent(req));
}

function getPlaybackStartupReferenceMs(session) {
    const candidates = [session?.lastReopenAt, session?.createdAt]
        .map(value => Date.parse(value || ''))
        .filter(value => Number.isFinite(value) && value > 0);
    return candidates.length ? Math.max(...candidates) : 0;
}

function getPlaybackStartupAgeMs(session, now = Date.now()) {
    const referenceMs = getPlaybackStartupReferenceMs(session);
    return referenceMs ? now - referenceMs : 0;
}

function getHlsStartupLiveEdgeOffsetSegments(req, session, now = Date.now()) {
    if (!HLS_VLC_STARTUP_LIVE_EDGE_OFFSET_SEGMENTS || !HLS_VLC_STARTUP_WINDOW_MS) return 0;
    if (!isVlcCompatibleUserAgent(req)) return 0;
    if (!shouldStabilizeVlcMediaPlaylist(req)) return 0;

    const ageMs = getPlaybackStartupAgeMs(session, now);
    if (ageMs < 0 || ageMs > HLS_VLC_STARTUP_WINDOW_MS) return 0;
    return HLS_VLC_STARTUP_LIVE_EDGE_OFFSET_SEGMENTS;
}

function getHlsSteadyLiveEdgeOffsetSegments(req) {
    if (isVlcCompatibleUserAgent(req)) {
        if (!shouldStabilizeVlcMediaPlaylist(req)) return 0;
        return HLS_VLC_STEADY_LIVE_EDGE_OFFSET_SEGMENTS || 0;
    }
    if (isExoCompatibleUserAgent(req)) {
        return HLS_EXOMEDIA_STEADY_LIVE_EDGE_OFFSET_SEGMENTS || 0;
    }
    return 0;
}

function getHlsTargetWindowSegments(req, session = null, now = Date.now()) {
    if (isVlcCompatibleUserAgent(req)) {
        return shouldStabilizeVlcMediaPlaylist(req)
            ? HLS_VLC_STABLE_WINDOW_SEGMENTS
            : HLS_EXTENDED_WINDOW_SEGMENTS;
    }
    if (isExoCompatibleUserAgent(req)) {
        const sessionAgeMs = getPlaybackStartupAgeMs(session, now);
        if (HLS_EXOMEDIA_STARTUP_WINDOW_MS > 0 && sessionAgeMs >= 0 && sessionAgeMs < HLS_EXOMEDIA_STARTUP_WINDOW_MS) {
            return Math.min(HLS_EXOMEDIA_STABLE_WINDOW_SEGMENTS, HLS_EXOMEDIA_STARTUP_WINDOW_SEGMENTS);
        }
        return HLS_EXOMEDIA_STABLE_WINDOW_SEGMENTS;
    }
    return HLS_EXTENDED_WINDOW_SEGMENTS;
}

function getHlsStabilityKeySuffix(req) {
    if (isVlcCompatibleUserAgent(req)) {
        return shouldStabilizeVlcMediaPlaylist(req) ? '_vlcWindow' : '_vlcRaw';
    }
    if (isExoCompatibleUserAgent(req)) return '_exoWindow';
    return '';
}

function getHlsMinSegmentsWithLiveEdgeOffset(req) {
    if (isVlcCompatibleUserAgent(req)) {
        return shouldStabilizeVlcMediaPlaylist(req) ? HLS_VLC_STARTUP_MIN_SEGMENTS : 3;
    }
    if (isExoCompatibleUserAgent(req)) return HLS_EXOMEDIA_MIN_SEGMENTS_WITH_LIVE_EDGE_OFFSET;
    return 3;
}

function getHlsSteadyLiveEdgeOffsetReason(req, segments) {
    if (!segments) return '';
    if (isVlcCompatibleUserAgent(req)) return `vlc_edge_offset_${segments}`;
    if (isExoCompatibleUserAgent(req)) return `exo_edge_offset_${segments}`;
    return `edge_offset_${segments}`;
}

function getHlsStartTimeOffsetSeconds(req, session = null, now = Date.now()) {
    if (isVlcCompatibleUserAgent(req)) {
        if (!shouldStabilizeVlcMediaPlaylist(req)) return 0;
        const referenceMs = getPlaybackStartupReferenceMs(session);
        if (!referenceMs) return 0;
        const sessionAgeMs = now - referenceMs;
        if (HLS_VLC_STARTUP_WINDOW_MS > 0 && sessionAgeMs >= 0 && sessionAgeMs < HLS_VLC_STARTUP_WINDOW_MS) {
            return HLS_VLC_START_TIME_OFFSET_SECONDS || 0;
        }
    }
    if (isExoAndroidUserAgent(req)) {
        const referenceMs = getPlaybackStartupReferenceMs(session);
        if (!referenceMs) return 0;
        const sessionAgeMs = now - referenceMs;
        if (HLS_EXOMEDIA_STARTUP_WINDOW_MS > 0 && sessionAgeMs >= 0 && sessionAgeMs < HLS_EXOMEDIA_STARTUP_WINDOW_MS) {
            return HLS_EXOMEDIA_START_TIME_OFFSET_SECONDS || 0;
        }
    }
    return 0;
}

function shouldRelaxLiveMediaPlaylistTiming(req) {
    return true;
}

function shouldExtendLiveMediaPlaylistWindow(req) {
    if (isVlcCompatibleUserAgent(req)) return shouldStabilizeVlcMediaPlaylist(req);
    return true;
}

function logVariantSessionSnapshot(videoId, {
    owner,
    sessionId,
    quality,
    upstreamUrl,
    snapshot,
    source,
    reason = ''
}) {
    const sessionTag = sessionId ? sessionPreview(sessionId) : 'none';
    const upstreamHash = getUpstreamIdentityHash(upstreamUrl);
    const reasonText = reason ? ` reason=${reason}` : '';
    console.log(
        `[${videoId}] HLS session=${sessionTag} owner=${owner || 'n/a'} q=${quality || 'auto'} ` +
        `upstream=${upstreamHash} source=${source || 'current'} seq=${snapshot?.mediaSequence ?? 'n/a'} ` +
        `last=${snapshot?.lastSequence ?? 'n/a'} td=${snapshot?.targetDuration ?? 'n/a'} segs=${snapshot?.segmentCount ?? 'n/a'} ` +
        `first=${snapshot?.firstSegment || 'n/a'} lastSeg=${snapshot?.lastSegment || 'n/a'}${reasonText}`
    );
}

async function fetchM3u8WithCache(videoId, url, monitorSequence = null) {
    if (m3u8CachePromises.has(videoId)) {
        return m3u8CachePromises.get(videoId);
    }

    const cached = m3u8CacheContent.get(videoId);
    const now = Date.now();

    if (cached && cached.sourceUrl === url && (now - cached.fetchedAt) < M3U8_CACHE_TTL) {
        // Master playlists não possuem MEDIA-SEQUENCE e continuam usando
        // normalmente o cache por TTL.
        //
        // Para media playlists, não servimos um cache cuja janela já ficou
        // completamente atrás da sequência observada pelo monitor.
        let cachedLastSequence = cached.lastSequence;

        // Compatibilidade com entradas antigas ou criadas em outros pontos.
        if (
            cachedLastSequence === undefined &&
            typeof cached.content === 'string'
        ) {
            const cachedInfo = parseM3u8Info(cached.content);
            cachedLastSequence = cachedInfo.lastSequence;
        }

        const isStaleMediaCache =
            Number.isFinite(monitorSequence) &&
            Number.isFinite(cachedLastSequence) &&
            cachedLastSequence < monitorSequence;

        if (!isStaleMediaCache) {
            return { content: cached.content, fromCache: true };
        }

        console.warn(
            `[${videoId}] Cache HLS de mídia ignorado: ` +
            `cachedLast=${cachedLastSequence} monitorSeq=${monitorSequence}`
        );

        m3u8CacheContent.delete(videoId);
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
                    const playlistInfo = parseM3u8Info(body);

                    m3u8CacheContent.set(videoId, {
                        content: body,
                        fetchedAt: Date.now(),
                        sourceUrl: url,
                        mediaSequence: playlistInfo.sequence,
                        lastSequence: playlistInfo.lastSequence
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
    const sequence = seqMatch ? parseInt(seqMatch[1], 10) : null;
    return {
        sequence,
        segments,
        lastSequence: sequence !== null && segments > 0 ? sequence + segments - 1 : sequence
    };
}

function parseMediaPlaylistWindow(content) {
    const source = String(content || '');
    if (!source || source.includes('#EXT-X-STREAM-INF') || source.includes('#EXT-X-ENDLIST')) return null;

    const mediaSequenceMatch = source.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/);
    if (!mediaSequenceMatch) return null;

    const mediaSequence = Number(mediaSequenceMatch[1]);
    if (!Number.isFinite(mediaSequence)) return null;

    const lines = source.split(/\r?\n/);
    const header = [];
    const segments = [];
    const footer = [];
    let currentBlock = [];
    let inSegments = false;

    for (const line of lines) {
        const trimmed = line.trim();

        if (!inSegments && !trimmed.startsWith('#EXTINF:')) {
            header.push(line);
            continue;
        }

        inSegments = true;
        currentBlock.push(line);

        if (trimmed && !trimmed.startsWith('#')) {
            segments.push({
                sequence: mediaSequence + segments.length,
                lines: currentBlock.slice()
            });
            currentBlock = [];
        }
    }

    if (currentBlock.length > 0) footer.push(...currentBlock);
    if (segments.length === 0) return null;

    return { mediaSequence, header, segments, footer };
}

function rebuildMediaPlaylistWindow(parsed, selectedSegments) {
    if (!parsed || !Array.isArray(selectedSegments) || selectedSegments.length === 0) {
        return null;
    }

    const firstSequence = selectedSegments[0].sequence;
    const header = parsed.header.map((line) => {
        if (/^#EXT-X-MEDIA-SEQUENCE:/i.test(line.trim())) {
            return `#EXT-X-MEDIA-SEQUENCE:${firstSequence}`;
        }
        return line;
    });

    const body = [];
    for (const segment of selectedSegments) {
        body.push(...segment.lines);
    }

    const footer = parsed.footer.filter(line => line.trim() !== '#EXT-X-ENDLIST');
    return `${header.concat(body, footer).join('\n').replace(/\n+$/g, '')}\n`;
}

function extendLiveMediaPlaylistWindow(logVideoId, stabilityKey, content, options = {}) {
    if (!HLS_EXTENDED_WINDOW_SEGMENTS || HLS_EXTENDED_WINDOW_SEGMENTS < 1) {
        return { content, extended: false };
    }

    const parsed = parseMediaPlaylistWindow(content);
    if (!parsed) return { content, extended: false };
    const targetSegmentCount = Math.max(
        1,
        parseInt(options.targetSegmentCount, 10) || HLS_EXTENDED_WINDOW_SEGMENTS
    );

    const now = Date.now();
    const state = hlsMediaPlaylistHistory.get(stabilityKey) || {
        segments: new Map(),
        updatedAt: now
    };

    for (const segment of parsed.segments) {
        state.segments.set(segment.sequence, segment);
    }

    const lastCurrentSequence = parsed.segments[parsed.segments.length - 1].sequence;
    const requestedLiveEdgeOffsetSegments = Math.max(0, parseInt(options.liveEdgeOffsetSegments, 10) || 0);
    const buildSelection = (lastSequence) => {
        const result = [];
        for (
            let seq = lastSequence;
            result.length < targetSegmentCount && state.segments.has(seq);
            seq -= 1
        ) {
            result.unshift(state.segments.get(seq));
        }
        return result;
    };
    let liveEdgeOffsetSegments = requestedLiveEdgeOffsetSegments;
    let effectiveLastSequence = Math.max(
        parsed.mediaSequence,
        lastCurrentSequence - liveEdgeOffsetSegments
    );
    let selected = buildSelection(effectiveLastSequence);

    const minSegmentsWithLiveEdgeOffset = Math.max(
        3,
        parseInt(options.minSegmentsWithLiveEdgeOffset, 10) || 3
    );
    if (liveEdgeOffsetSegments && selected.length < Math.min(minSegmentsWithLiveEdgeOffset, parsed.segments.length)) {
        liveEdgeOffsetSegments = 0;
        effectiveLastSequence = lastCurrentSequence;
        selected = buildSelection(effectiveLastSequence);
    }

    const minimumToKeep = lastCurrentSequence - (targetSegmentCount * 2);
    for (const seq of state.segments.keys()) {
        if (seq < minimumToKeep || seq > lastCurrentSequence) {
            state.segments.delete(seq);
        }
    }
    state.updatedAt = now;
    hlsMediaPlaylistHistory.set(stabilityKey, state);

    if (selected.length === parsed.segments.length && effectiveLastSequence === lastCurrentSequence) {
        return { content, extended: false };
    }

    const rebuilt = rebuildMediaPlaylistWindow(parsed, selected);
    if (!rebuilt) return { content, extended: false };

    const offsetText = liveEdgeOffsetSegments ? ` offset=${liveEdgeOffsetSegments}` : '';
    console.log(`[${logVideoId}] 🧩 Janela HLS ajustada ${stabilityKey}: ${parsed.segments.length} -> ${selected.length} segmentos${offsetText}`);
    return {
        content: rebuilt,
        extended: true,
        segments: selected.length,
        firstSequence: selected[0].sequence,
        lastSequence: selected[selected.length - 1].sequence,
        liveEdgeOffsetSegments
    };
}

function pruneHlsMediaPlaylistHistory(now = Date.now()) {
    let removed = 0;
    const maxAgeMs = Math.max(60000, STALE_SERVE_MAX_AGE_MS * 2);
    for (const [key, state] of hlsMediaPlaylistHistory.entries()) {
        if (!state || now - (Number(state.updatedAt) || 0) > maxAgeMs) {
            hlsMediaPlaylistHistory.delete(key);
            removed += 1;
        }
    }
    return removed;
}

function applyHlsStartTimeOffset(content, offsetSeconds) {
    const offset = Number(offsetSeconds);
    if (!Number.isFinite(offset) || offset === 0) return content;

    const source = String(content || '');
    if (!source || source.includes('#EXT-X-STREAM-INF') || source.includes('#EXT-X-ENDLIST')) return content;

    const formattedOffset = offset.toFixed(3);
    const startLine = `#EXT-X-START:TIME-OFFSET=${formattedOffset},PRECISE=NO`;
    if (/^#EXT-X-START:/m.test(source)) {
        return source.replace(/^#EXT-X-START:.*$/m, startLine);
    }

    const lines = source.split(/\r?\n/);
    const mediaSequenceIndex = lines.findIndex(line => /^#EXT-X-MEDIA-SEQUENCE:/i.test(line.trim()));
    if (mediaSequenceIndex >= 0) {
        lines.splice(mediaSequenceIndex + 1, 0, startLine);
        return lines.join('\n');
    }
    const insertAfterIndex = lines.findIndex(line => /^#EXT-X-TARGETDURATION:/i.test(line.trim()));
    if (insertAfterIndex >= 0) {
        lines.splice(insertAfterIndex + 1, 0, startLine);
        return lines.join('\n');
    }
    return source;
}

function relaxLiveMediaPlaylistTiming(content, enabled = true) {
    if (!enabled) return content;
    if (!HLS_COMPAT_TARGET_DURATION || HLS_COMPAT_TARGET_DURATION < 1) return content;
    const source = String(content || '');
    if (!source || source.includes('#EXT-X-STREAM-INF') || source.includes('#EXT-X-ENDLIST')) return content;

    return source.replace(/^#EXT-X-TARGETDURATION:(\d+)/m, (line, value) => {
        const current = parseInt(value, 10);
        if (!Number.isFinite(current) || current >= HLS_COMPAT_TARGET_DURATION) return line;
        return `#EXT-X-TARGETDURATION:${HLS_COMPAT_TARGET_DURATION}`;
    });
}

function logProxyAccess(videoId, { statusCode, fromCache, elapsedMs, content, stale, monitorSeq, logLabel }) {
    let info = '';
    let lagInfo = '';
    if (content) {
        const { sequence, segments, lastSequence } = parseM3u8Info(content);
        const prev = lastServedSequence.get(videoId);
        let anomaly = '';
        if (prev && sequence !== null && sequence < prev.sequence) {
            const sinceLastMs = Date.now() - prev.servedAt;
            const previousLast = Number(prev.lastSequence ?? (prev.sequence + prev.segments - 1));
            const currentLast = Number(lastSequence);
            if (Number.isFinite(previousLast) && Number.isFinite(currentLast) && currentLast >= previousLast) {
                anomaly = ` janela_expandida (${prev.sequence} → ${sequence}, last=${currentLast})`;
            } else {
                anomaly = ` ⚠️ SEQUENCE REGREDIU (${prev.sequence} → ${sequence}, ${sinceLastMs}ms)`;
            }
        }
        if (sequence !== null) {
            lastServedSequence.set(videoId, { sequence, segments, lastSequence, servedAt: Date.now() });
            if (monitorSeq !== undefined && monitorSeq !== null) {
                const lag = monitorSeq - sequence;
                const allowedLag = Math.max(3, HLS_EXTENDED_WINDOW_SEGMENTS);
                if (lag > allowedLag) {
                    lagInfo = ` ⚠️ LAG=${lag} (monitor=${monitorSeq}, served=${sequence})`;
                } else {
                    lagInfo = ` lag=${lag}`;
                }
            }
        }
        info = ` seq=${sequence} segs=${segments}${anomaly}${lagInfo}`;
    }
    const staleTag = stale ? ` 🕒 STALE(${stale}ms)` : '';
    console.log(`[${logLabel || videoId}] 📡 Acesso m3u8: status=${statusCode} cache=${fromCache ? 'HIT' : 'MISS'} ${elapsedMs}ms${info}${staleTag}`);
}

function safeUrlHash(url) {
    const hash = crypto.createHash('sha256').update(String(url || '')).digest('hex');
    return hash.substring(0, 12);
}

function safeUrlType(url) {
    const u = String(url || '').trim();
    if (!u) return 'empty';
    if (u.startsWith('http://') || u.startsWith('https://')) return 'absolute';
    if (u.startsWith('//')) return 'protocol-relative';
    if (u.startsWith('/')) return 'absolute-path';
    return 'relative';
}

function safeUrlExtension(url) {
    const u = String(url || '').trim();
    const qm = u.indexOf('?');
    const path = qm >= 0 ? u.substring(0, qm) : u;
    if (path.endsWith('.ts')) return 'ts';
    if (path.endsWith('.m4s')) return 'm4s';
    if (path.endsWith('.m3u8')) return 'm3u8';
    if (path.endsWith('.mp4')) return 'mp4';
    if (path.endsWith('.aac')) return 'aac';
    if (path.endsWith('.vtt')) return 'vtt';
    return 'none';
}

function isProxyUrl(url) {
    return String(url || '').includes('/neonews/seg/');
}

function diagnosticLogPlaylist(videoId, stage, content, extra = {}) {
    if (!HLS_DIAGNOSTIC_MODE) return;
    const text = String(content || '');
    const lines = text.split(/\r?\n/);
    const nonEmptyLines = lines.filter(l => l.trim());
    const isMaster = /#EXT-X-STREAM-INF:/i.test(text);
    const isMedia = /#EXTINF:/i.test(text) && !isMaster;
    const type = isMaster ? 'master' : (isMedia ? 'media' : 'unknown');
    const bytes = text.length;
    const seqMatch = text.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/);
    const tdMatch = text.match(/#EXT-X-TARGETDURATION:(\d+)/);
    const extinfCount = (text.match(/#EXTINF:/g) || []).length;
    const uriLines = nonEmptyLines.filter(l => !l.startsWith('#'));
    const discontinuityCount = (text.match(/^#EXT-X-DISCONTINUITY\b/gm) || []).length;
    const mapCount = (text.match(/#EXT-X-MAP:/g) || []).length;
    const keyCount = (text.match(/#EXT-X-KEY:/g) || []).length;
    const hasBom = text.charCodeAt(0) === 0xFEFF;
    const crlfCount = (text.match(/\r\n/g) || []).length;
    const lfCount = (text.match(/[^\r]\n/g) || []).length;
    const lineEnding = crlfCount > lfCount ? 'CRLF' : (lfCount > 0 ? 'LF' : 'unknown');
    const proxiedCount = uriLines.filter(u => isProxyUrl(u)).length;
    const extinfNoUri = text.includes('#EXTINF:') && uriLines.length < extinfCount;
    const uriNoExtinf = uriLines.length > extinfCount && extinfCount > 0;

    const uriSummaries = uriLines.slice(0, 5).map(u => ({
        hash: safeUrlHash(u),
        type: safeUrlType(u),
        ext: safeUrlExtension(u),
        proxy: isProxyUrl(u)
    }));

    const lastUriLines = uriLines.length > 5 ? uriLines.slice(-3) : [];
    const lastUriSummaries = lastUriLines.map(u => ({
        hash: safeUrlHash(u),
        type: safeUrlType(u),
        ext: safeUrlExtension(u),
        proxy: isProxyUrl(u)
    }));

    const m3u8Uris = uriLines.filter(u => safeUrlExtension(u) === 'm3u8');

    console.log(
        `[${videoId}] [HLS-DIAG] playlist stage=${stage} type=${type} bytes=${bytes} ` +
        `lines=${lines.length} nonEmpty=${nonEmptyLines.length} ` +
        `seq=${seqMatch ? seqMatch[1] : 'none'} td=${tdMatch ? tdMatch[1] : 'none'} ` +
        `extinf=${extinfCount} uris=${uriLines.length} ` +
        `discontinuity=${discontinuityCount} map=${mapCount} key=${keyCount} ` +
        `bom=${hasBom} lineEnding=${lineEnding} ` +
        `proxiedUrls=${proxiedCount} extinfNoUri=${extinfNoUri} uriNoExtinf=${uriNoExtinf} ` +
        `m3u8Refs=${m3u8Uris.length}` +
        (extra.windowAdjustment !== undefined ? ` windowAdjustment=${extra.windowAdjustment}` : '') +
        (extra.startOffset !== undefined ? ` startOffset=${extra.startOffset}` : '')
    );

    uriSummaries.forEach((u, i) => {
        console.log(`[${videoId}] [HLS-DIAG]   uri[${i}] hash=${u.hash} type=${u.type} ext=${u.ext} proxy=${u.proxy}`);
    });

    if (lastUriSummaries.length > 0) {
        console.log(`[${videoId}] [HLS-DIAG]   ... last ${lastUriSummaries.length} uris:`);
        lastUriSummaries.forEach((u, i) => {
            console.log(`[${videoId}] [HLS-DIAG]   uri[-${lastUriSummaries.length - i}] hash=${u.hash} type=${u.type} ext=${u.ext} proxy=${u.proxy}`);
        });
    }

    if (extinfNoUri) console.log(`[${videoId}] [HLS-DIAG] ⚠️ EXTINF sem URI correspondente`);
    if (uriNoExtinf) console.log(`[${videoId}] [HLS-DIAG] ⚠️ URI sem EXTINF correspondente`);
    if (m3u8Uris.length > 0) console.log(`[${videoId}] [HLS-DIAG] ⚠️ Playlist contém referências a outras playlists m3u8`);
    if (!text.startsWith('#EXTM3U')) console.log(`[${videoId}] [HLS-DIAG] ⚠️ Primeira linha não é #EXTM3U`);
}

const hlsNetDiagInstrumentedSockets = new WeakSet();
let hlsNetDiagOneShotDone = false;
const hlsPlaybackSessionState = new Map();
const HLS_PLAYBACK_SESSION_STATE_TTL_MS = 7200000;
function getHlsPlaybackSessionState(sessionId) {
    if (!sessionId || !HLS_PLAYBACK_STALL_DIAG) return null;
    let state = hlsPlaybackSessionState.get(sessionId);
    if (!state) {
        state = { lastReqSeq: null, lastCompletedSeq: null, lastCompletedAt: 0, consecutiveErrors: 0, consecutiveSlow: 0, lastMediaSequence: null, lastLastSequence: null, createdAt: Date.now() };
        hlsPlaybackSessionState.set(sessionId, state);
    }
    state.lastAccessAt = Date.now();
    return state;
}
function pruneHlsPlaybackSessionState(now) {
    if (!HLS_PLAYBACK_STALL_DIAG) return;
    const t = now || Date.now();
    for (const [sid, st] of hlsPlaybackSessionState.entries()) {
        if (t - (st.lastAccessAt || st.createdAt) > HLS_PLAYBACK_SESSION_STATE_TTL_MS) hlsPlaybackSessionState.delete(sid);
    }
}

function stabilizeMediaPlaylist(logVideoId, stabilityKey, content, monitorSeq, options = {}) {
    let contentToServe = content;
    let staleServed = null;
    let safeWindowExpansion = false;

    if (HLS_DISABLE_WINDOW_ADJUSTMENT) {
        if (HLS_DIAGNOSTIC_MODE) {
            console.log(`[${logVideoId}] [HLS-DIAG] window-adjustment=disabled`);
            console.log(`[${logVideoId}] [HLS-DIAG] startup-offset=skipped`);
        }
        const parsed = parseM3u8Info(contentToServe);
        const prev = lastServedSequence.get(stabilityKey);
        if (parsed.sequence !== null) {
            lastServedSequence.set(stabilityKey, { sequence: parsed.sequence, segments: parsed.segments, lastSequence: parsed.lastSequence, servedAt: Date.now() });
        }
        return { content: contentToServe, stale: null, extended: { content: contentToServe, extended: false } };
    }

    const extended = options.extendWindow === false
        ? { content: contentToServe, extended: false }
        : extendLiveMediaPlaylistWindow(logVideoId, stabilityKey, contentToServe, options);
    contentToServe = extended.content;
    contentToServe = relaxLiveMediaPlaylistTiming(contentToServe, options.relaxTargetDuration !== false);
    contentToServe = applyHlsStartTimeOffset(contentToServe, options.startTimeOffsetSeconds);

    const parsed = parseM3u8Info(contentToServe);
    const prev = lastServedSequence.get(stabilityKey);

    if (parsed.sequence !== null && prev && parsed.sequence < prev.sequence) {
        console.warn(`[${logVideoId}] ⚠️ Detectada regressão de sequência ${stabilityKey} (${prev.sequence} → ${parsed.sequence}).`);
        const stale = getStaleM3u8IfFresh(stabilityKey, monitorSeq);
        if (stale) {
            const previousSnapshot = getPlaylistSnapshot(stale.content, '');
            const nextSnapshot = getPlaylistSnapshot(contentToServe, '');
            if (isSafePlaylistWindowExpansion(previousSnapshot, nextSnapshot)) {
                safeWindowExpansion = true;
                console.log(`[${logVideoId}] 🧩 Expansão segura de janela HLS ${stabilityKey}: ${prev.sequence} → ${parsed.sequence}, last=${nextSnapshot.lastSequence}.`);
            } else {
                console.log(`[${logVideoId}] 🔄 Usando playlist ${stabilityKey} anterior estável.`);
                contentToServe = stale.content;
                staleServed = stale;
            }
        } else {
            console.warn(`[${logVideoId}] ⚠️ Sem stale seguro; servindo playlist real sem forçar MEDIA-SEQUENCE.`);
        }
    }

    const finalParsed = parseM3u8Info(contentToServe);
    if (finalParsed.sequence !== null) {
        if (!prev || finalParsed.sequence >= prev.sequence || safeWindowExpansion) {
            rememberGoodM3u8(stabilityKey, contentToServe);
        }
    } else {
        rememberGoodM3u8(stabilityKey, contentToServe);
    }

    return { content: contentToServe, stale: staleServed, extended };
}

function makeBandwidthForHeight(height) {
    if (height <= 240) return 300000;
    if (height <= 360) return 600000;
    if (height <= 480) return 1200000;
    if (height <= 720) return 2500000;
    if (height <= 1080) return 5000000;
    return 8000000;
}

function normalizeManifestBaseUrl(value) {
    try {
        const parsed = new URL(String(value || '').trim());
        if (!['http:', 'https:'].includes(parsed.protocol)) return '';
        if (parsed.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) {
            parsed.protocol = 'https:';
        }
        const pathname = parsed.pathname && parsed.pathname !== '/'
            ? parsed.pathname.replace(/\/+$/g, '')
            : '';
        return `${parsed.protocol}//${parsed.host}${pathname}`;
    } catch (_) {
        return '';
    }
}

function getPlaybackManifestBaseUrl(req) {
    return normalizeManifestBaseUrl(
        process.env.HLS_PUBLIC_BASE_URL ||
        process.env.PUBLIC_BASE_URL ||
        process.env.BASE_URL ||
        DEFAULT_PUBLIC_HLS_BASE_URL
    );
}

function buildInternalHlsUrl({ token, videoId, owner, sessionId, maxHeight, baseUrl = '', segmentProxy = false }) {
    const basePath = token
        ? `/neonews/t/${encodeURIComponent(token)}.m3u8`
        : `/neonews/${encodeURIComponent(videoId)}.m3u8`;
    const params = new URLSearchParams();
    if (!token && owner) params.set('owner', owner);
    params.set('session', sessionId);
    if (maxHeight) params.set('max', String(maxHeight));
    if (segmentProxy) params.set('segmentProxy', '1');
    const pathAndQuery = `${basePath}?${params.toString()}`;
    const normalizedBaseUrl = normalizeManifestBaseUrl(baseUrl);
    return normalizedBaseUrl ? `${normalizedBaseUrl}${pathAndQuery}` : pathAndQuery;
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

function extractVariantFrameRatesFromMasterContent(content) {
    const frameRates = new Map();
    const pattern = /#EXT-X-STREAM-INF:([^\n]*)/ig;
    let match;
    while ((match = pattern.exec(String(content || ''))) !== null) {
        const attributes = match[1] || '';
        const heightMatch = attributes.match(/\bRESOLUTION=\d+x(\d+)/i);
        if (!heightMatch) continue;
        const height = Number(heightMatch[1]);
        if (!Number.isFinite(height) || height <= 0) continue;
        const fpsMatch = attributes.match(/\bFRAME-RATE=([0-9.]+)/i);
        const fps = fpsMatch ? Number(fpsMatch[1]) : null;
        if (Number.isFinite(fps) && fps > 0) frameRates.set(height, fps);
    }
    return frameRates;
}

function inferYoutubeHlsFrameRateFromUrl(url) {
    const match = String(url || '').match(/(?:^|[/?&])itag[=/](\d+)(?:[/?&]|$)/i);
    const itag = match ? Number(match[1]) : null;
    if (!Number.isFinite(itag)) return null;
    if ([298, 299, 300, 301, 308, 315].includes(itag)) return 60;
    return null;
}

function getVariantFrameRateForHeight(monitor, height) {
    const frameRates = extractVariantFrameRatesFromMasterContent(monitor?._masterContent?.content);
    const fromMaster = frameRates.get(height);
    if (Number.isFinite(fromMaster) && fromMaster > 0) return fromMaster;
    return inferYoutubeHlsFrameRateFromUrl(monitor?._playlistUrls?.[height]);
}

function selectSingleVariantHeightForRequest(heights, monitor, req, requestedMaxHeight) {
    if (!Array.isArray(heights) || heights.length === 0) return null;
    const defaultHeight = isLegacyVlcSegmentProxyUserAgent(req)
        ? HLS_LEGACY_VLC_DEFAULT_HEIGHT
        : HLS_EXOMEDIA_SINGLE_VARIANT_HEIGHT;
    const defaultPreferred = requestedMaxHeight
        ? heights[0]
        : (heights.find(height => height <= defaultHeight) || heights[0]);

    if (!isExoAndroidUserAgent(req) || HLS_EXOMEDIA_ANDROID_MAX_FPS <= 0) {
        return defaultPreferred;
    }

    const preferredFps = getVariantFrameRateForHeight(monitor, defaultPreferred);
    if (!Number.isFinite(preferredFps) || preferredFps <= HLS_EXOMEDIA_ANDROID_MAX_FPS) {
        return defaultPreferred;
    }

    const fallback = heights.find(height => height <= HLS_EXOMEDIA_ANDROID_FALLBACK_HEIGHT);
    if (!fallback || fallback >= defaultPreferred) return defaultPreferred;

    console.log(`ExoMedia Android: evitando ${defaultPreferred}p${preferredFps}fps; usando ${fallback}p para estabilidade.`);
    return fallback;
}

function getEffectiveVariantHeightForRequest(monitor, req, requestedHeight) {
    const requested = Number(requestedHeight);
    if (!Number.isFinite(requested) || requested <= 0) return requestedHeight;
    let heights = getAvailablePlaylistHeights(monitor);
    if (heights.length === 0) {
        heights = extractHeightsFromMasterContent(monitor?._masterContent?.content);
    }
    const eligible = heights.filter(height => height <= requested);
    if (eligible.length === 0) return requested;
    return selectSingleVariantHeightForRequest(eligible, monitor, req, requested) || requested;
}

function buildPlaybackSessionMaster(monitor, {
    token,
    videoId,
    owner,
    sessionId,
    requestedMaxHeight,
    fallbackMaxHeight,
    baseUrl,
    segmentProxy = false,
    singleVariant = false,
    req = null
}) {
    let heights = getAvailablePlaylistHeights(monitor);
    if (heights.length === 0) {
        heights = extractHeightsFromMasterContent(monitor?._masterContent?.content);
    }
    if (heights.length === 0 && fallbackMaxHeight) {
        heights = [fallbackMaxHeight];
    }
    if (requestedMaxHeight) {
        const eligible = heights.filter(height => height <= requestedMaxHeight);
        heights = eligible.length > 0
            ? eligible
            : (heights.length > 0 ? [heights[heights.length - 1]] : heights);
    }
    if (singleVariant && heights.length > 1) {
        const preferred = selectSingleVariantHeightForRequest(heights, monitor, req, requestedMaxHeight);
        heights = [preferred];
    }

    const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];
    for (const height of heights) {
        const width = Math.round(height * 16 / 9);
        const url = buildInternalHlsUrl({ token, videoId, owner, sessionId, maxHeight: height, baseUrl, segmentProxy });
        lines.push(
            `#EXT-X-STREAM-INF:BANDWIDTH=${makeBandwidthForHeight(height)},RESOLUTION=${width}x${height},FRAME-RATE=30`,
            url
        );
    }
    return `${lines.join('\n')}\n`;
}

function isTruthyQueryValue(value) {
    return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function isFalseyQueryValue(value) {
    return ['0', 'false', 'no', 'off'].includes(String(value || '').trim().toLowerCase());
}

function isLegacyVlcSegmentProxyUserAgent(req) {
    const userAgent = String(req?.headers?.['user-agent'] || '').toLowerCase();
    const match = userAgent.match(/\b(?:libvlc|vlc)\/(\d+)\.(\d+)\.(\d+)/);
    if (!match) return false;
    const major = Number(match[1]);
    const minor = Number(match[2]);
    const patch = Number(match[3]);
    if (![major, minor, patch].every(Number.isFinite)) return false;
    if (major < 3) return true;
    return major === 3 && minor === 0 && patch <= 11;
}

function shouldProxyHlsSegments(req) {
    const requested = req.query?.segmentProxy ?? req.query?.proxySegments;
    if (isTruthyQueryValue(requested)) return true;
    if (isFalseyQueryValue(requested)) return false;
    if (HLS_SEGMENT_PROXY_MODE === 'on' || HLS_SEGMENT_PROXY_MODE === 'true' || HLS_SEGMENT_PROXY_MODE === '1') return true;
    if (HLS_SEGMENT_PROXY_MODE === 'off' || HLS_SEGMENT_PROXY_MODE === 'false' || HLS_SEGMENT_PROXY_MODE === '0') return false;
    if (HLS_EXOMEDIA_SEGMENT_PROXY && isExoCompatibleUserAgent(req)) return true;
    if (isLegacyVlcSegmentProxyUserAgent(req)) return HLS_LEGACY_VLC_SEGMENT_PROXY;
    const userAgent = String(req.headers['user-agent'] || '').toLowerCase();
    if (/\b(vlc|libvlc)\b/.test(userAgent)) return false;
    return /\b(ffmpeg|ffprobe|kodi)\b/.test(userAgent);
}

function pruneHlsSegmentProxyEntries(now = Date.now()) {
    let removed = 0;
    for (const [id, entry] of hlsSegmentProxyEntries.entries()) {
        if (!entry || now - (Number(entry.lastAccessAt || entry.createdAt) || 0) > HLS_SEGMENT_PROXY_TTL_MS) {
            hlsSegmentProxyEntries.delete(id);
            removed += 1;
        }
    }
    return removed;
}

function buildHlsSegmentProxyId({ url, sessionId }) {
    return crypto
        .createHmac('sha256', process.env.SESSION_SECRET || 'neonews-segment-proxy')
        .update(String(sessionId || ''))
        .update('\0')
        .update(String(url || ''))
        .digest('hex')
        .slice(0, 32);
}

function registerHlsSegmentProxyUrl({ url, videoId, owner, sessionId }) {
    const id = buildHlsSegmentProxyId({ url, sessionId });
    const now = Date.now();
    const existing = hlsSegmentProxyEntries.get(id);
    hlsSegmentProxyEntries.set(id, {
        id,
        url,
        videoId,
        owner,
        sessionId,
        createdAt: existing?.createdAt || now,
        lastAccessAt: now
    });
    if (hlsSegmentProxyEntries.size > 5000) pruneHlsSegmentProxyEntries(now);
    return id;
}

function buildHlsSegmentProxyUrl({ url, videoId, owner, sessionId, baseUrl }) {
    const id = registerHlsSegmentProxyUrl({ url, videoId, owner, sessionId });
    const normalizedBaseUrl = normalizeManifestBaseUrl(baseUrl);
    const pathAndQuery = `/neonews/seg/${encodeURIComponent(id)}.ts`;
    return normalizedBaseUrl ? `${normalizedBaseUrl}${pathAndQuery}` : pathAndQuery;
}

function rewriteHlsUriAttributes(line, context) {
    return line.replace(/URI="([^"]+)"/g, (full, uri) => {
        try {
            const absoluteUrl = new URL(uri, context.sourceUrl).href;
            const proxiedUrl = buildHlsSegmentProxyUrl({ ...context, url: absoluteUrl });
            return `URI="${proxiedUrl}"`;
        } catch (_) {
            return full;
        }
    });
}

function rewriteHlsSegmentUrls(content, context) {
    if (!context?.sessionId || !context?.owner || !context?.sourceUrl) return content;
    return String(content || '').split(/\r?\n/).map((line) => {
        const trimmed = line.trim();
        if (!trimmed) return line;
        if (trimmed.startsWith('#')) return rewriteHlsUriAttributes(line, context);
        try {
            const absoluteUrl = new URL(trimmed, context.sourceUrl).href;
            return buildHlsSegmentProxyUrl({ ...context, url: absoluteUrl });
        } catch (_) {
            return line;
        }
    }).join('\n');
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

function sendHlsError(res, statusCode, message, extraHeaders = {}) {
    if (res.headersSent) return;
    res.writeHead(statusCode, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'private, no-store, no-cache',
        'Vary': 'User-Agent',
        'Pragma': 'no-cache',
        'Expires': '0',
        ...extraHeaders
    });
    res.end(`${message}\n`);
}

function findActiveHlsMonitor(videoId, owner = null) {
    if (owner) {
        const key = `${videoId}:${owner}`;
        if (converter.activeMonitors.has(key)) {
            return {
                monitor: converter.activeMonitors.get(key),
                actualOwner: owner,
                keyFound: key
            };
        }
    }

    for (const [key, mon] of converter.activeMonitors.entries()) {
        if (key.startsWith(videoId + ':')) {
            return {
                monitor: mon,
                actualOwner: key.split(':')[1] || null,
                keyFound: key
            };
        }
    }

    return { monitor: null, actualOwner: null, keyFound: null };
}

function handleHlsHead(videoId, owner, res) {
    const found = findActiveHlsMonitor(videoId, owner);
    if (!found.monitor || !found.monitor.m3u8Url) {
        if (getPersistedEntry(videoId, owner)) {
            res.setHeader('Retry-After', '2');
            return sendHlsError(res, 503, 'stream_temporarily_unavailable', {
                'Retry-After': '2'
            });
        }
        return sendHlsError(res, 404, 'stream_not_found');
    }
    res.writeHead(200, {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'private, no-store, no-cache',
        'Vary': 'User-Agent',
        'Pragma': 'no-cache',
        'Expires': '0',
        'X-Master': 'true'
    });
    res.end();
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

function getMonitorPlaybackTerminalReason(monitor) {
    if (!monitor) return null;
    if (monitor.liveState === 'ended' || monitor._liveEnded) return 'live_ended';
    if (isMonitorEnding(monitor)) return 'live_ended';

    const classification = String(
        monitor.lastFailureClassification ||
        monitor.lastExtractionFailureClassification ||
        ''
    );
    if (classification === CLASSIFICATION.LIVE_ENDED) return 'live_ended';
    return null;
}

function isMonitorAcceptingPlayback(monitor) {
    return Boolean(monitor && !getMonitorPlaybackTerminalReason(monitor));
}

function cleanupTerminalLivePlayback(videoId, owner, token = null, reason = 'live_ended') {
    if (token) revokeToken(token, reason);

    if (owner) {
        const devKey = `${owner}:${videoId}`;
        if (ownerViewers.has(devKey)) {
            ownerViewers.delete(devKey);
            saveOwnerViewers(ownerViewers);
        }
        if (viewerAccess.has(devKey)) {
            viewerAccess.delete(devKey);
            saveViewerAccess(viewerAccess);
        }

        const removedSessions = playbackSessions.removeForLive(owner, videoId);
        if (removedSessions > 0) {
            console.log(`[${owner}:${videoId}] ${removedSessions} sessão(ões) HLS removida(s) após ${reason}.`);
        }
    }

    clearHlsSessionVariantStateFor({ owner, videoId, token });
    m3u8CacheContent.delete(videoId);
    m3u8CachePromises.delete(videoId);
    lastGoodM3u8.delete(videoId);
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

    const foundMonitor = findActiveHlsMonitor(videoId, queryOwner);
    let monitor = foundMonitor.monitor;
    let keyFound = foundMonitor.keyFound;
    let actualOwner = foundMonitor.actualOwner;

    if (!monitor) {
        const retryAfterSeconds = getGlobalExtractionRetryAfterSeconds();
        if (retryAfterSeconds > 0) {
            logRestoreBackoffSuppressed(videoId, queryOwner, retryAfterSeconds);
            logProxyAccess(videoId, { statusCode: 503, fromCache: false, elapsedMs: Date.now() - reqStart });
            res.set('Retry-After', String(retryAfterSeconds));
            return sendHlsError(res, 503, 'stream_extraction_unavailable', {
                'Retry-After': String(retryAfterSeconds)
            });
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
        if (routeContext.token || getPersistedEntry(videoId, queryOwner || actualOwner)) {
            logProxyAccess(videoId, { statusCode: 503, fromCache: false, elapsedMs: Date.now() - reqStart });
            return sendHlsError(res, 503, 'stream_temporarily_unavailable', {
                'Retry-After': '2'
            });
        }
        logProxyAccess(videoId, { statusCode: 404, fromCache: false, elapsedMs: Date.now() - reqStart });
        return sendHlsError(res, 404, 'stream_not_found');
    }

    const trackingOwner = queryOwner || actualOwner;
    const terminalPlaybackReason = getMonitorPlaybackTerminalReason(monitor);
    if (terminalPlaybackReason) {
        cleanupTerminalLivePlayback(videoId, trackingOwner, routeContext.token || null, terminalPlaybackReason);
        logProxyAccess(videoId, { statusCode: 410, fromCache: false, elapsedMs: Date.now() - reqStart });
        return sendHlsError(res, 410, terminalPlaybackReason);
    }

    const localIp = req.query.localIp || null;
    const sessionIdFromRequest = String(req.query.session || '').trim();
    let activePlaybackSessionId = null;
    let activePlaybackSession = null;
    const playbackManifestBaseUrl = getPlaybackManifestBaseUrl(req);
    const segmentProxyEnabled = shouldProxyHlsSegments(req);
    const singleVariantMaster = shouldUseSingleVariantMaster(req);
    const playbackSessionTokenScope = getPlaybackSessionTokenScope(routeContext.token || null);

    if (trackingOwner) {
        const clientIp = getRequestIp(req);
        const userAgent = req.headers['user-agent'] || '';

        if (!isLocalIp(clientIp)) {
            if (sessionIdFromRequest) {
                const touched = playbackSessions.touchSession({
                    sessionId: sessionIdFromRequest,
                    owner: trackingOwner,
                    videoId,
                    tokenScope: playbackSessionTokenScope,
                    publicIp: clientIp,
                    userAgent,
                    hlsActivity: urlMaxHeight ? 'variant' : 'master'
                });
                if (!touched.ok) {
                    const status = touched.code === 'expired' ? 410 : 403;
                    if (touched.code === 'expired') {
                        clearHlsSessionVariantStateFor({
                            owner: trackingOwner,
                            videoId,
                            sessionId: sessionIdFromRequest
                        });
                    }
                    console.warn(`[${trackingOwner}:${videoId}] sessao HLS rejeitada (${touched.code}) session=${sessionPreview(sessionIdFromRequest)}`);
                    return sendHlsError(res, status, touched.code === 'expired' ? 'session_expired' : 'session_invalid');
                }
                activePlaybackSessionId = sessionIdFromRequest;
                activePlaybackSession = touched.session;
            } else {
                if (isPlaybackSessionCreationRateLimited(clientIp, trackingOwner, videoId)) {
                    console.warn(`[${trackingOwner}:${videoId}] criacao de sessao HLS limitada por taxa para IP ${clientIp}`);
                    return sendHlsError(res, 429, 'session_rate_limited', {
                        'Retry-After': '60'
                    });
                }
                const deviceLimit = getDeviceLimitForOwner(trackingOwner);
                const created = playbackSessions.createSession({
                    owner: trackingOwner,
                    videoId,
                    tokenScope: playbackSessionTokenScope,
                    limit: deviceLimit,
                    publicIp: clientIp,
                    userAgent,
                    source: 'hls',
                    fingerprint: localIp ? `localIp:${localIp}` : null
                });

                if (!created.ok) {
                    console.log(`[${trackingOwner}:${videoId}] 🚫 Sessao HLS bloqueada: ${created.active} ativas, limite ${created.limit}`);
                    return sendHlsError(res, 429, 'limit_exceeded');
                }

                activePlaybackSessionId = created.session.sessionId;
                activePlaybackSession = created.session;
                const sessionAction = created.code === 'reused_recent' ||
                    created.code === 'reused_stale' ||
                    created.code === 'reused_expired' ||
                    created.code === 'reused_reopen' ||
                    created.code === 'reused_master_reopen'
                    ? 'reaproveitada'
                    : 'criada';
                console.log(`[${trackingOwner}:${videoId}] 📱 Sessao HLS ${sessionAction}: ${sessionPreview(activePlaybackSessionId)} (${clientIp} | ${userAgent.substring(0, 30)}...)`);
                const sessionMaster = buildPlaybackSessionMaster(monitor, {
                    token: routeContext.token || null,
                    videoId,
                    owner: trackingOwner,
                    sessionId: activePlaybackSessionId,
                    requestedMaxHeight: Number.isFinite(urlMaxHeight) && allowedHeights.includes(urlMaxHeight) ? finalMaxHeight : null,
                    fallbackMaxHeight: finalMaxHeight,
                    baseUrl: playbackManifestBaseUrl,
                    segmentProxy: segmentProxyEnabled,
                    singleVariant: singleVariantMaster,
                    req
                });
                return sendHlsManifest(res, sessionMaster, {
                    'X-Playback-Session': sessionPreview(activePlaybackSessionId),
                    'X-Master': 'true',
                    ...(segmentProxyEnabled ? { 'X-Segment-Proxy': 'true' } : {})
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
    const effectiveUrlMaxHeight = getEffectiveVariantHeightForRequest(monitor, req, urlMaxHeight);
    if (urlMaxHeight && effectiveUrlMaxHeight !== urlMaxHeight) {
        console.log(`[${videoId}] 📺 Qualidade ajustada para ExoMedia Android: ${urlMaxHeight}p -> ${effectiveUrlMaxHeight}p`);
    }

    if (effectiveUrlMaxHeight && monitor._playlistUrls && monitor._playlistUrls[effectiveUrlMaxHeight]) {
        const urlMaxHeight = effectiveUrlMaxHeight;
        const playlistUrl = monitor._playlistUrls[urlMaxHeight];
        const cacheKey = videoId + '_' + urlMaxHeight;
        const pinKey = getPlaybackVariantPinKey(videoId, urlMaxHeight, activePlaybackSessionId, trackingOwner, routeContext.token || null);
        const sessionVariantState = pinKey ? hlsSessionVariantState.get(pinKey) : null;
        const sessionVariantPin = getSessionVariantPin(pinKey);
        // If a refreshed upstream has no continuity with the current session, give
        // ExoPlayer a short 503 window, then reset the session pin on the next try.
        if (sessionVariantPin?.discontinuityUntil && Date.now() < sessionVariantPin.discontinuityUntil) {
            logProxyAccess(pinKey || cacheKey, { statusCode: 503, fromCache: false, elapsedMs: Date.now() - reqStart, logLabel: cacheKey });
            return sendHlsError(res, 503, 'stream_temporarily_unavailable', {
                'Retry-After': '2'
            });
        }
        if (sessionVariantPin?.discontinuityUntil && Date.now() >= sessionVariantPin.discontinuityUntil) {
            clearSessionVariantState(pinKey);
        }
        const pinnedPlaylistUrl = getSessionVariantPinnedUrl(pinKey) || getPinnedVariantUrl(pinKey, playlistUrl);
        const sourceLabel = getSessionVariantPinnedUrl(pinKey)
            ? 'fixada'
            : (pinnedPlaylistUrl === playlistUrl ? 'atual' : 'fixada');
        console.log(`[${videoId}] 🎯 Servindo playlist de qualidade ${urlMaxHeight}p (${sourceLabel}) diretamente do YouTube`);
        const fetchVariantPlaylist = async (sourceUrl, source) => {
            const upstreamHash = getUpstreamIdentityHash(sourceUrl);
            const variantCacheKey = `${cacheKey}_${upstreamHash}`;
            const result = await fetchM3u8WithCache(
                variantCacheKey,
                sourceUrl,
                monitor.lastMediaSequence
            );
            return {
                result,
                sourceUrl,
                source,
                snapshot: getPlaylistSnapshot(result.content, sourceUrl)
            };
        };
        try {
            let playlistSourceUrl = pinnedPlaylistUrl;
            let variant;
            try {
                variant = await fetchVariantPlaylist(playlistSourceUrl, getSessionVariantPinnedUrl(pinKey) ? 'pinned' : 'current');

                const state = pinKey ? hlsSessionVariantState.get(pinKey) : null;
                if (
                    state &&
                    playlistSourceUrl !== playlistUrl &&
                    shouldRefreshStuckSessionVariant(state, variant.snapshot)
                ) {
                    console.warn(`[${videoId}] Playlist ${urlMaxHeight}p fixada parada; testando URL atual sem trocar silenciosamente.`);
                    const refreshed = await fetchVariantPlaylist(playlistUrl, 'refresh');
                    if (!playlistsHaveOverlap(state.lastSnapshot, refreshed.snapshot)) {
                        logVariantSessionSnapshot(videoId, {
                            owner: trackingOwner,
                            sessionId: activePlaybackSessionId,
                            quality: urlMaxHeight,
                            upstreamUrl: playlistUrl,
                            snapshot: refreshed.snapshot,
                            source: 'refresh-rejected',
                            reason: 'no_overlap'
                        });
                        logProxyAccess(pinKey || cacheKey, { statusCode: 503, fromCache: false, elapsedMs: Date.now() - reqStart, logLabel: cacheKey });
                        markSessionVariantRefreshRejected(pinKey);
                        return sendHlsError(res, 503, 'stream_temporarily_unavailable', {
                            'Retry-After': '2'
                        });
                    }
                    playlistSourceUrl = playlistUrl;
                    variant = refreshed;
                    clearPinnedVariantUrl(pinKey);
                }
            } catch (pinErr) {
                if (pinKey && playlistSourceUrl !== playlistUrl) {
                    console.warn(`[${videoId}] Playlist ${urlMaxHeight}p fixada falhou (${pinErr.statusCode || pinErr.code || pinErr.message}); tentando URL atual.`);
                    clearPinnedVariantUrl(pinKey);
                    const previousState = hlsSessionVariantState.get(pinKey);
                    playlistSourceUrl = playlistUrl;
                    const refreshed = await fetchVariantPlaylist(playlistSourceUrl, 'refresh');
                    if (!playlistsHaveOverlap(previousState?.lastSnapshot, refreshed.snapshot)) {
                        logVariantSessionSnapshot(videoId, {
                            owner: trackingOwner,
                            sessionId: activePlaybackSessionId,
                            quality: urlMaxHeight,
                            upstreamUrl: playlistSourceUrl,
                            snapshot: refreshed.snapshot,
                            source: 'refresh-rejected',
                            reason: 'no_overlap_after_error'
                        });
                        logProxyAccess(pinKey || cacheKey, { statusCode: 503, fromCache: false, elapsedMs: Date.now() - reqStart, logLabel: cacheKey });
                        markSessionVariantRefreshRejected(pinKey);
                        return sendHlsError(res, 503, 'stream_temporarily_unavailable', {
                            'Retry-After': '2'
                        });
                    }
                    variant = refreshed;
                } else {
                    throw pinErr;
                }
            }
            rememberPinnedVariantUrl(pinKey, playlistSourceUrl);
            rememberSessionVariantPin(pinKey, playlistSourceUrl, {
                videoId,
                owner: trackingOwner,
                token: routeContext.token || null,
                quality: urlMaxHeight,
                sessionId: activePlaybackSessionId
            });
            const startupLiveEdgeOffsetSegments = getHlsStartupLiveEdgeOffsetSegments(req, activePlaybackSession);
            const steadyLiveEdgeOffsetSegments = startupLiveEdgeOffsetSegments ? 0 : getHlsSteadyLiveEdgeOffsetSegments(req);
            const liveEdgeOffsetSegments = startupLiveEdgeOffsetSegments || steadyLiveEdgeOffsetSegments;
            const targetWindowSegments = getHlsTargetWindowSegments(req, activePlaybackSession);
            const stabilityKey = `${pinKey || cacheKey}${getHlsStabilityKeySuffix(req)}`;
            if (HLS_DIAGNOSTIC_MODE) {
                diagnosticLogPlaylist(videoId, 'upstream', variant.result.content, { windowAdjustment: HLS_DISABLE_WINDOW_ADJUSTMENT ? 'disabled' : 'enabled' });
            }
            const stabilized = stabilizeMediaPlaylist(videoId, stabilityKey, variant.result.content, monitor.lastMediaSequence, {
                liveEdgeOffsetSegments,
                targetSegmentCount: targetWindowSegments,
                minSegmentsWithLiveEdgeOffset: liveEdgeOffsetSegments ? getHlsMinSegmentsWithLiveEdgeOffset(req) : 3,
                relaxTargetDuration: shouldRelaxLiveMediaPlaylistTiming(req),
                startTimeOffsetSeconds: getHlsStartTimeOffsetSeconds(req, activePlaybackSession),
                extendWindow: shouldExtendLiveMediaPlaylistWindow(req)
            });
            let content = stabilized.content;
            const servedSnapshot = getPlaylistSnapshot(content, playlistSourceUrl);
            if (pinKey) {
                updateSessionVariantState(pinKey, {
                    videoId,
                    owner: trackingOwner,
                    quality: urlMaxHeight,
                    sessionId: activePlaybackSessionId,
                    token: routeContext.token || null,
                    upstreamUrl: playlistSourceUrl,
                    snapshot: servedSnapshot,
                    source: variant.source
                });
            }
            logVariantSessionSnapshot(videoId, {
                owner: trackingOwner,
                sessionId: activePlaybackSessionId,
                quality: urlMaxHeight,
                upstreamUrl: playlistSourceUrl,
                snapshot: servedSnapshot,
                source: `${variant.source}${variant.result.fromCache ? ':cache' : ''}`,
                reason: stabilized.stale
                    ? 'last_good'
                    : (startupLiveEdgeOffsetSegments
                        ? `startup_offset_${startupLiveEdgeOffsetSegments}`
                        : (steadyLiveEdgeOffsetSegments
                            ? getHlsSteadyLiveEdgeOffsetReason(req, steadyLiveEdgeOffsetSegments)
                            : (stabilized.extended?.extended ? 'extended_window' : '')))
            });
            if (HLS_DIAGNOSTIC_MODE) {
                const startOffset = getHlsStartTimeOffsetSeconds(req, activePlaybackSession);
                diagnosticLogPlaylist(videoId, 'stabilized', content, { startOffset });
            }
            // --- HLS Segment Cache ---
            let segmentRewriteViaCache = false;
            if (HLS_SEGMENT_CACHE_ENABLED && hlsSegmentCache && activePlaybackSessionId) {
                const requestUserAgent = req.headers['user-agent'] || '';
                const cachedResult = await hlsSegmentCache.processPlaylist({
                    videoId,
                    quality: urlMaxHeight,
                    playlistContent: content,
                    playlistUrl: playlistSourceUrl,
                    sessionId: activePlaybackSessionId,
                    baseUrl: playbackManifestBaseUrl,
                    token: routeContext.token || null,
                    waitMs: HLS_SEGMENT_PLAYLIST_WAIT_MS,
                    minReady: HLS_SEGMENT_CACHE_MIN_READY,
                    userAgent: requestUserAgent,
                    owner: trackingOwner,
                    registerSegmentProxy: ({ url, videoId, owner, sessionId }) => registerHlsSegmentProxyUrl({ url, videoId, owner, sessionId })
                });
                if (cachedResult.notReady) {
                    logProxyAccess(pinKey || stabilityKey, { statusCode: 503, fromCache: false, elapsedMs: Date.now() - reqStart, logLabel: cacheKey });
                    return sendHlsError(res, 503, 'playlist_not_ready', { 'Retry-After': '1' });
                }
                if (cachedResult.content) {
                    content = cachedResult.content;
                    segmentRewriteViaCache = true;
                    console.log(`[${videoId}] [HLS-CACHE] playlist served by cache (${urlMaxHeight}p, ${content.length} bytes)`);
                }
                // passthrough: fall through to segment proxy below
            }

            if (segmentProxyEnabled && activePlaybackSessionId && trackingOwner && !segmentRewriteViaCache) {
                content = rewriteHlsSegmentUrls(content, {
                    sourceUrl: playlistSourceUrl,
                    baseUrl: playbackManifestBaseUrl,
                    videoId,
                    owner: trackingOwner,
                    sessionId: activePlaybackSessionId
                });
                if (HLS_DIAGNOSTIC_MODE) {
                    console.log(`[${videoId}] [HLS-DIAG] segment-rewrite enabled=true`);
                    diagnosticLogPlaylist(videoId, 'rewritten', content);
                }
            } else if (HLS_DIAGNOSTIC_MODE) {
                console.log(`[${videoId}] [HLS-DIAG] segment-rewrite enabled=false`);
            }
            if (HLS_DIAGNOSTIC_MODE) {
                const legacyProxy = isLegacyVlcSegmentProxyUserAgent(req);
                console.log(`[${videoId}] [HLS-DIAG] legacy-vlc-proxy enabled=${legacyProxy}`);
                console.log(`[${videoId}] [HLS-DIAG] segment-force-ipv4 enabled=${HLS_SEGMENT_FORCE_IPV4}`);
            }
            // VLC safe live edge — trim window for legacy players hitting the edge
            if (HLS_VLC_SAFE_LIVE_EDGE && isLegacyVlcSegmentProxyUserAgent(req)) {
                const parsed = parseMediaPlaylistWindow(content);
                if (parsed && parsed.segments.length > HLS_VLC_SAFE_LIVE_EDGE_SEGMENTS) {
                    const keepCount = Math.max(HLS_VLC_SAFE_LIVE_EDGE_SEGMENTS, parsed.segments.length - HLS_VLC_SAFE_LIVE_EDGE_SEGMENTS);
                    const selected = parsed.segments.slice(-keepCount);
                    const newContent = rebuildMediaPlaylistWindow(parsed, selected);
                    if (newContent) {
                        content = newContent;
                        if (HLS_DIAGNOSTIC_MODE) {
                            console.log(`[${videoId}] [HLS-DIAG] vlc-safe-live-edge enabled=true segments=${HLS_VLC_SAFE_LIVE_EDGE_SEGMENTS} original=${parsed.segments.length} trimmed=${keepCount}`);
                        }
                    }
                }
            }
            // Playback stall diag — playlist-level gap detection
            const playbackSessionId = activePlaybackSessionId;
            if (HLS_PLAYBACK_STALL_DIAG && playbackSessionId && servedSnapshot) {
                const psState = getHlsPlaybackSessionState(playbackSessionId);
                if (psState) {
                    const now = Date.now();
                    const elapsedMs = now - reqStart;
                    const wFirst = Number.isFinite(servedSnapshot.mediaSequence) ? servedSnapshot.mediaSequence : null;
                    const wLast = Number.isFinite(servedSnapshot.lastSequence) ? servedSnapshot.lastSequence : null;
                    const wCount = servedSnapshot.segmentCount || 0;
                    const wDur = wCount && servedSnapshot.targetDuration ? wCount * servedSnapshot.targetDuration : null;
                    const plog = (tag, extra) => {
                        const parts = [`[HLS-PLAYBACK] ${tag}`, `video=${videoId}`, `session=${sessionPreview(playbackSessionId)}`, `elapsed=${elapsedMs}ms`, `seq=${wFirst}-${wLast}`, `segments=${wCount}`];
                        if (wDur) parts.push(`window=${wDur}s`);
                        if (extra) parts.push(extra);
                        console.log(parts.join(' '));
                    };
                    if (!wCount || wCount === 0) plog('playlist-empty', 'no segments in window');
                    if (psState.lastCompletedSeq !== null && wFirst !== null && wFirst > psState.lastCompletedSeq + 1) {
                        psState.consecutiveErrors = (psState.consecutiveErrors || 0) + 1;
                        plog('sequence-gap', `missed=${wFirst - psState.lastCompletedSeq - 1} lastCompletedSeq=${psState.lastCompletedSeq} windowFirst=${wFirst}`);
                    } else {
                        psState.consecutiveErrors = 0;
                    }
                    if (psState.lastCompletedAt > 0 && now - psState.lastCompletedAt > 10000) {
                        const gapSec = ((now - psState.lastCompletedAt) / 1000).toFixed(1);
                        plog('request-gap', `noCompleted=${gapSec}s lastCompletedAt=${new Date(psState.lastCompletedAt).toISOString().slice(11, 19)}`);
                    }
                    if (wLast !== null) {
                        psState.lastCompletedSeq = wLast;
                        psState.lastCompletedAt = now;
                    }
                }
            }
            console.log(`[${videoId}] 🔍 Playlist ${urlMaxHeight}p recebida (${content.length} bytes)`);
            logProxyAccess(stabilityKey, {
                statusCode: 200,
                fromCache: variant.result.fromCache,
                elapsedMs: Date.now() - reqStart,
                content,
                stale: stabilized.stale?.age,
                monitorSeq: monitor.lastMediaSequence,
                logLabel: cacheKey
            });
            res.writeHead(200, {
                'Content-Type': 'application/vnd.apple.mpegurl',
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'private, no-store',
                'Vary': 'User-Agent',
                'Pragma': 'no-cache',
                'Expires': '0',
                ...(segmentProxyEnabled ? { 'X-Segment-Proxy': 'true' } : {}),
                ...(activePlaybackSessionId ? { 'X-Playback-Session': sessionPreview(activePlaybackSessionId) } : {})
            });
            res.end(content);
            return;
        } catch (err) {
            console.error(`[${videoId}] ❌ Erro ao buscar playlist ${urlMaxHeight}:`, err.message);
            if ([403, 404, 410].includes(err.statusCode)) {
                clearSessionVariantState(pinKey);
                clearPinnedVariantUrl(pinKey);
                if (typeof monitor.requestRefresh === 'function') {
                    monitor.requestRefresh().catch(refreshErr => {
                        console.error(`[${videoId}] Falha ao renovar playlist ${urlMaxHeight}p:`, refreshErr.message);
                    });
                }
            }
            logProxyAccess(pinKey || cacheKey, { statusCode: 503, fromCache: false, elapsedMs: Date.now() - reqStart, logLabel: cacheKey });
            return sendHlsError(res, 503, 'stream_temporarily_unavailable', {
                'Retry-After': '2'
            });
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
                requestedMaxHeight: Number.isFinite(urlMaxHeight) && allowedHeights.includes(urlMaxHeight) ? finalMaxHeight : null,
                fallbackMaxHeight: finalMaxHeight,
                baseUrl: playbackManifestBaseUrl,
                segmentProxy: segmentProxyEnabled,
                singleVariant: singleVariantMaster
            })
            : monitor._masterContent.content;
        console.log(`[${videoId}] 🎯 Servindo master ${activePlaybackSessionId ? 'interno com sessao HLS' : 'ORIGINAL (sem filtro)'}`);
        sendHlsManifest(res, content, {
            'X-Master': 'true',
            ...(segmentProxyEnabled ? { 'X-Segment-Proxy': 'true' } : {}),
            ...(activePlaybackSessionId ? { 'X-Playback-Session': sessionPreview(activePlaybackSessionId) } : {})
        });
        return;
    }

    // Fallback: fetch normal
    try {
        const result = await fetchM3u8WithCache(
            videoId,
            monitor.m3u8Url,
            monitor.lastMediaSequence
        );

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
                    requestedMaxHeight: Number.isFinite(urlMaxHeight) && allowedHeights.includes(urlMaxHeight) ? finalMaxHeight : null,
                    fallbackMaxHeight: finalMaxHeight,
                    baseUrl: playbackManifestBaseUrl,
                    segmentProxy: segmentProxyEnabled,
                    singleVariant: singleVariantMaster
                });
            }
            console.log(`[${videoId}] 🎯 Servindo master ${activePlaybackSessionId ? 'interno com sessao HLS' : 'ORIGINAL (via cache)'}`);
            sendHlsManifest(res, contentToServe, {
                'X-Master': 'true',
                ...(segmentProxyEnabled ? { 'X-Segment-Proxy': 'true' } : {}),
                ...(activePlaybackSessionId ? { 'X-Playback-Session': sessionPreview(activePlaybackSessionId) } : {})
            });
            return;
        }

        // Para playlists de qualidade (não master), aplicamos a estabilização segura.
        if (HLS_DIAGNOSTIC_MODE) {
            diagnosticLogPlaylist(videoId, 'upstream-fallback', contentToServe, { windowAdjustment: HLS_DISABLE_WINDOW_ADJUSTMENT ? 'disabled' : 'enabled' });
        }
        const stabilized = stabilizeMediaPlaylist(videoId, videoId, contentToServe, monitor.lastMediaSequence);
        contentToServe = stabilized.content;
        if (HLS_DIAGNOSTIC_MODE) {
            diagnosticLogPlaylist(videoId, 'stabilized-fallback', contentToServe);
        }

        const finalParsed = parseM3u8Info(contentToServe);
        if (finalParsed.sequence !== null) {
            if (monitor.lastMediaSequence === null || finalParsed.sequence > monitor.lastMediaSequence) {
                rememberGoodM3u8(videoId, contentToServe);
            }
        } else {
            rememberGoodM3u8(videoId, contentToServe);
        }

        if (segmentProxyEnabled && activePlaybackSessionId && trackingOwner) {
            contentToServe = rewriteHlsSegmentUrls(contentToServe, {
                sourceUrl: monitor.m3u8Url,
                baseUrl: playbackManifestBaseUrl,
                videoId,
                owner: trackingOwner,
                sessionId: activePlaybackSessionId
            });
            if (HLS_DIAGNOSTIC_MODE) {
                console.log(`[${videoId}] [HLS-DIAG] segment-rewrite enabled=true`);
                diagnosticLogPlaylist(videoId, 'rewritten-fallback', contentToServe);
            }
        } else if (HLS_DIAGNOSTIC_MODE) {
            console.log(`[${videoId}] [HLS-DIAG] segment-rewrite enabled=false`);
        }
        if (HLS_DIAGNOSTIC_MODE) {
            console.log(`[${videoId}] [HLS-DIAG] segment-force-ipv4 enabled=${HLS_SEGMENT_FORCE_IPV4}`);
        }

        if (HLS_VLC_SAFE_LIVE_EDGE && isLegacyVlcSegmentProxyUserAgent(req)) {
            const parsed = parseMediaPlaylistWindow(contentToServe);
            if (parsed && parsed.segments.length > HLS_VLC_SAFE_LIVE_EDGE_SEGMENTS) {
                const keepCount = Math.max(HLS_VLC_SAFE_LIVE_EDGE_SEGMENTS, parsed.segments.length - HLS_VLC_SAFE_LIVE_EDGE_SEGMENTS);
                const selected = parsed.segments.slice(-keepCount);
                const newContent = rebuildMediaPlaylistWindow(parsed, selected);
                if (newContent) {
                    contentToServe = newContent;
                    if (HLS_DIAGNOSTIC_MODE) {
                        console.log(`[${videoId}] [HLS-DIAG] vlc-safe-live-edge enabled=true segments=${HLS_VLC_SAFE_LIVE_EDGE_SEGMENTS} original=${parsed.segments.length} trimmed=${keepCount}`);
                    }
                }
            }
        }
        const fbSessionId = activePlaybackSessionId;
        if (HLS_PLAYBACK_STALL_DIAG && fbSessionId) {
            const fbSnapshot = getPlaylistSnapshot(contentToServe, monitor.m3u8Url);
            const psState = getHlsPlaybackSessionState(fbSessionId);
            if (psState && fbSnapshot) {
                const now = Date.now();
                const elapsedMs = now - reqStart;
                const wFirst = Number.isFinite(fbSnapshot.mediaSequence) ? fbSnapshot.mediaSequence : null;
                const wLast = Number.isFinite(fbSnapshot.lastSequence) ? fbSnapshot.lastSequence : null;
                const wCount = fbSnapshot.segmentCount || 0;
                if (!wCount || wCount === 0) {
                    console.log(`[HLS-PLAYBACK] playlist-empty video=${videoId} session=${sessionPreview(fbSessionId)} elapsed=${elapsedMs}ms`);
                }
                if (psState.lastCompletedSeq !== null && wFirst !== null && wFirst > psState.lastCompletedSeq + 1) {
                    console.log(`[HLS-PLAYBACK] sequence-gap video=${videoId} session=${sessionPreview(fbSessionId)} missed=${wFirst - psState.lastCompletedSeq - 1} lastCompletedSeq=${psState.lastCompletedSeq} windowFirst=${wFirst}`);
                }
                if (psState.lastCompletedAt > 0 && now - psState.lastCompletedAt > 10000) {
                    console.log(`[HLS-PLAYBACK] request-gap video=${videoId} session=${sessionPreview(fbSessionId)} noCompleted=${((now - psState.lastCompletedAt) / 1000).toFixed(1)}s`);
                }
                if (wLast !== null) {
                    psState.lastCompletedSeq = wLast;
                    psState.lastCompletedAt = now;
                }
            }
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
            ...(segmentProxyEnabled ? { 'X-Segment-Proxy': 'true' } : {}),
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
                    const renewed = await fetchM3u8WithCache(
                        videoId,
                        monitor.m3u8Url,
                        monitor.lastMediaSequence
                    );
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
                        if (activePlaybackSessionId && trackingOwner) {
                            renewedContent = buildPlaybackSessionMaster(monitor, {
                                token: routeContext.token || null,
                                videoId,
                                owner: trackingOwner,
                                sessionId: activePlaybackSessionId,
                                requestedMaxHeight: Number.isFinite(urlMaxHeight) && allowedHeights.includes(urlMaxHeight) ? finalMaxHeight : null,
                                fallbackMaxHeight: finalMaxHeight,
                                baseUrl: playbackManifestBaseUrl,
                                segmentProxy: segmentProxyEnabled,
                                singleVariant: singleVariantMaster
                            });
                        }
                        console.log(`[${videoId}] 🎯 Servindo master renovado ${activePlaybackSessionId ? 'interno com sessao HLS' : '(sem filtro)'}`);
                        res.writeHead(200, {
                            'Content-Type': 'application/vnd.apple.mpegurl',
                            'Access-Control-Allow-Origin': '*',
                            'Cache-Control': 'private, no-store',
                            'Vary': 'User-Agent',
                            'Pragma': 'no-cache',
                            'Expires': '0',
                            'X-Master': 'true',
                            ...(segmentProxyEnabled ? { 'X-Segment-Proxy': 'true' } : {}),
                            ...(activePlaybackSessionId ? { 'X-Playback-Session': sessionPreview(activePlaybackSessionId) } : {})
                        });
                        return res.end(renewedContent);
                    } else {
                        rememberGoodM3u8(videoId, renewedContent);
                    }
                    if (segmentProxyEnabled && activePlaybackSessionId && trackingOwner) {
                        renewedContent = rewriteHlsSegmentUrls(renewedContent, {
                            sourceUrl: monitor.m3u8Url,
                            baseUrl: playbackManifestBaseUrl,
                            videoId,
                            owner: trackingOwner,
                            sessionId: activePlaybackSessionId
                        });
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
                        ...(segmentProxyEnabled ? { 'X-Segment-Proxy': 'true' } : {}),
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
                    let staleContent = stale.content;
                    if (segmentProxyEnabled && activePlaybackSessionId && trackingOwner) {
                        staleContent = rewriteHlsSegmentUrls(staleContent, {
                            sourceUrl: monitor.m3u8Url,
                            baseUrl: playbackManifestBaseUrl,
                            videoId,
                            owner: trackingOwner,
                            sessionId: activePlaybackSessionId
                        });
                    }
                    logProxyAccess(videoId, {
                        statusCode: 200,
                        fromCache: false,
                        elapsedMs: Date.now() - reqStart,
                        content: staleContent,
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
                        ...(segmentProxyEnabled ? { 'X-Segment-Proxy': 'true' } : {}),
                        ...(activePlaybackSessionId ? { 'X-Playback-Session': sessionPreview(activePlaybackSessionId) } : {})
                    });
                    return res.end(staleContent);
                }

                console.log(`[${videoId}] Renovação não concluiu em ${REFRESH_WAIT_MS}ms, respondendo 503.`);
                logProxyAccess(videoId, { statusCode: 503, fromCache: false, elapsedMs: Date.now() - reqStart });
                return sendHlsError(res, 503, 'stream_renewing', {
                    'Retry-After': '2'
                });
            }
        }

        console.error(`[${videoId}] Proxy error:`, err.message);
        if (!res.headersSent) {
            logProxyAccess(videoId, { statusCode: 500, fromCache: false, elapsedMs: Date.now() - reqStart });
            sendHlsError(res, 500, 'proxy_error');
        }
    }
}

function getHlsSegmentProxyEntry(segmentId) {
    pruneHlsSegmentProxyEntries();
    const id = String(segmentId || '').trim();
    if (!/^[a-f0-9]{24,64}$/i.test(id)) return null;
    return hlsSegmentProxyEntries.get(id) || null;
}

function validateHlsSegmentSession(entry, req) {
    if (!entry?.sessionId || !entry?.owner || !entry?.videoId) {
        return { ok: false, status: 410, message: 'segment_expired' };
    }
    const touched = playbackSessions.touchSession({
        sessionId: entry.sessionId,
        owner: entry.owner,
        videoId: entry.videoId,
        publicIp: getRequestIp(req),
        userAgent: req.headers['user-agent'] || '',
        hlsActivity: 'segment'
    });
    if (!touched.ok) {
        if (touched.code === 'expired') {
            clearHlsSessionVariantStateFor({
                owner: entry.owner,
                videoId: entry.videoId,
                sessionId: entry.sessionId
            });
        }
        return {
            ok: false,
            status: touched.code === 'expired' ? 410 : 403,
            message: touched.code === 'expired' ? 'session_expired' : 'session_invalid'
        };
    }
    entry.lastAccessAt = Date.now();
    return { ok: true };
}

function handleHlsSegmentHead(req, res) {
    const entry = getHlsSegmentProxyEntry(req.params.segmentId);
    if (!entry) return sendHlsError(res, 410, 'segment_expired');
    const validation = validateHlsSegmentSession(entry, req);
    if (!validation.ok) return sendHlsError(res, validation.status, validation.message);
    res.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'private, no-store',
        'Pragma': 'no-cache',
        'Expires': '0',
        'X-Segment-Proxy': 'true'
    });
    res.end();
}

function handleHlsSegmentProxy(req, res) {
    const startedAt = Date.now();
    const entry = getHlsSegmentProxyEntry(req.params.segmentId);
    if (!entry) {
        if (HLS_DIAGNOSTIC_MODE) {
            console.log(`[HLS-SEGMENT] request id=${String(req.params.segmentId || '').slice(0, 8)} result=expired`);
        }
        return sendHlsError(res, 410, 'segment_expired');
    }
    const validation = validateHlsSegmentSession(entry, req);
    if (!validation.ok) {
        if (HLS_DIAGNOSTIC_MODE) {
            console.log(`[HLS-SEGMENT] request id=${entry.id.slice(0, 8)} session=${sessionPreview(entry.sessionId)} result=session_${validation.message}`);
        }
        return sendHlsError(res, validation.status, validation.message);
    }

    if (HLS_DIAGNOSTIC_MODE) {
        const upstreamHash = crypto.createHash('sha256').update(String(entry.url || '')).digest('hex').substring(0, 12);
        console.log(`[HLS-SEGMENT] request id=${entry.id.slice(0, 8)} session=${sessionPreview(entry.sessionId)} videoId=${entry.videoId} upstream=${upstreamHash}`);
    }

    let activeUpstreamReq = null;
    let closed = false;

    let netDiag = null;
    if (HLS_SEGMENT_NETWORK_DIAG) {
        netDiag = {
            requestId: entry.id ? entry.id.slice(0, 8) : 'unknown',
            startTime: Date.now(),
            networkStage: 'request-created',
            appTimeoutTriggered: false,
            sockTimeoutTriggered: false,
            responseStarted: false,
            firstByteReceived: false,
            hostHash: '',
            protocol: '',
            timeoutMs: 30000,
            log(event, extra = {}) {
                const elapsed = Date.now() - this.startTime;
                const parts = [`[HLS-NET] ${event}`, `id=${this.requestId}`, `elapsed=${elapsed}ms`, `stage=${this.networkStage}`];
                if (extra.hostHash) parts.push(`host=${extra.hostHash}`);
                if (extra.protocol) parts.push(`proto=${extra.protocol}`);
                if (extra.family) parts.push(`family=${extra.family}`);
                if (extra.reusedSocket !== undefined) parts.push(`reused=${extra.reusedSocket}`);
                if (extra.connecting !== undefined) parts.push(`connecting=${extra.connecting}`);
                if (extra.timeoutMs) parts.push(`timeout=${extra.timeoutMs}`);
                if (extra.code) parts.push(`code=${extra.code}`);
                if (extra.errno) parts.push(`errno=${extra.errno}`);
                if (extra.syscall) parts.push(`syscall=${extra.syscall}`);
                if (extra.bytes !== undefined) parts.push(`bytes=${extra.bytes}`);
                if (extra.status !== undefined) parts.push(`status=${extra.status}`);
                if (extra.hadError !== undefined) parts.push(`hadError=${extra.hadError}`);
                if (extra.errorMsg) parts.push(`error=${String(extra.errorMsg).slice(0, 60)}`);
                console.log(parts.join(' '));
            }
        };
        netDiag.log('request-created');
    }

    let stallDiag = null;
    if (HLS_PLAYBACK_STALL_DIAG) {
        const sessionId = entry.sessionId;
        const sessionState = getHlsPlaybackSessionState(sessionId);
        stallDiag = {
            requestId: entry.id ? entry.id.slice(0, 8) : 'unknown',
            startTime: Date.now(),
            sessionHash: sessionId ? sessionPreview(sessionId) : '',
            videoId: entry.videoId || '',
            sessionState,
            log(tag, extra = {}) {
                const elapsed = Date.now() - this.startTime;
                const parts = [`[HLS-PLAYBACK] ${tag}`, `id=${this.requestId}`, `session=${this.sessionHash}`, `elapsed=${elapsed}ms`];
                if (extra.status !== undefined) parts.push(`status=${extra.status}`);
                if (extra.bytes !== undefined) parts.push(`bytes=${extra.bytes}`);
                if (extra.firstByteMs !== undefined) parts.push(`firstByte=${extra.firstByteMs}ms`);
                if (extra.totalMs !== undefined) parts.push(`total=${extra.totalMs}ms`);
                if (extra.reusedSocket !== undefined) parts.push(`reused=${extra.reusedSocket}`);
                if (extra.retryCount !== undefined) parts.push(`retry=${extra.retryCount}`);
                if (extra.family) parts.push(`family=${extra.family}`);
                if (extra.seq !== undefined) parts.push(`seq=${extra.seq}`);
                if (extra.extinfDuration) parts.push(`extinf=${extra.extinfDuration}s`);
                if (extra.mediaSequence !== undefined) parts.push(`mediaSeq=${extra.mediaSequence}`);
                if (extra.lastSequence !== undefined) parts.push(`lastSeq=${extra.lastSequence}`);
                if (extra.segmentCount !== undefined) parts.push(`segments=${extra.segmentCount}`);
                if (extra.windowDuration !== undefined) parts.push(`window=${extra.windowDuration}s`);
                if (extra.playlistAge !== undefined) parts.push(`age=${extra.playlistAge}ms`);
                if (extra.cacheHit !== undefined) parts.push(`cache=${extra.cacheHit ? 'HIT' : 'MISS'}`);
                if (extra.source) parts.push(`source=${extra.source}`);
                if (extra.lag !== undefined) parts.push(`lag=${extra.lag}`);
                if (extra.startupReason) parts.push(`startup=${extra.startupReason}`);
                if (extra.code) parts.push(`code=${extra.code}`);
                if (extra.errorMsg) parts.push(`error=${String(extra.errorMsg).slice(0, 60)}`);
                if (extra.gapType) parts.push(`gap=${extra.gapType}`);
                if (extra.gapDetail) parts.push(`detail=${extra.gapDetail}`);
                console.log(parts.join(' '));
            }
        };
        pruneHlsPlaybackSessionState();
    }

    const requestSegment = (url, redirects = 0) => {
        let upstreamUrl;
        try {
            upstreamUrl = new URL(url);
        } catch (_) {
            hlsSegmentProxyEntries.delete(entry.id);
            if (HLS_DIAGNOSTIC_MODE) {
                console.log(`[HLS-SEGMENT] error=invalid_url id=${entry.id.slice(0, 8)}`);
            }
            return sendHlsError(res, 410, 'segment_expired');
        }

        const headers = {
            'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0',
            'Accept': '*/*'
        };
        if (req.headers.range) headers.Range = req.headers.range;

        const protocol = upstreamUrl.protocol === 'https:' ? https : http;
        const requestOptions = {
            agent: upstreamUrl.protocol === 'https:' ? httpsAgent : httpAgent,
            headers
        };
        if (HLS_SEGMENT_FORCE_IPV4) {
            requestOptions.family = 4;
        }
        if (stallDiag) {
            stallDiag.log('request-start', {
                seq: entry.mediaSequence,
                extinfDuration: entry.extinfDuration
            });
        }
        activeUpstreamReq = protocol.get(upstreamUrl, requestOptions, (upstreamRes) => {
            const statusCode = upstreamRes.statusCode || 502;
            if (HLS_SEGMENT_NETWORK_DIAG && netDiag) {
                netDiag.responseStarted = true;
                netDiag.networkStage = 'response-received';
                netDiag.log('response-received', { status: statusCode });
            }
            if ([301, 302, 303, 307, 308].includes(statusCode) && upstreamRes.headers.location && redirects < 4) {
                upstreamRes.resume();
                const redirectedUrl = new URL(upstreamRes.headers.location, upstreamUrl).href;
                return requestSegment(redirectedUrl, redirects + 1);
            }

            if (statusCode < 200 || statusCode >= 300) {
                upstreamRes.resume();
                if ([403, 404, 410].includes(statusCode)) hlsSegmentProxyEntries.delete(entry.id);
                console.warn(`[${entry.videoId}] Segmento HLS proxy falhou: status=${statusCode} id=${entry.id.slice(0, 8)} session=${sessionPreview(entry.sessionId)}`);
                if (HLS_DIAGNOSTIC_MODE) {
                    console.log(`[HLS-SEGMENT] upstream-status=${statusCode} error=http_error id=${entry.id.slice(0, 8)}`);
                }
                return sendHlsError(res, [403, 404, 410].includes(statusCode) ? 410 : 502, 'segment_unavailable');
            }

            let responseBytes = 0;
            const responseHeaders = {
                'Content-Type': upstreamRes.headers['content-type'] || 'application/octet-stream',
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'private, no-store',
                'Pragma': 'no-cache',
                'Expires': '0',
                'X-Segment-Proxy': 'true'
            };
            if (upstreamRes.headers['content-length']) responseHeaders['Content-Length'] = upstreamRes.headers['content-length'];
            if (upstreamRes.headers['content-range']) responseHeaders['Content-Range'] = upstreamRes.headers['content-range'];
            if (upstreamRes.headers['accept-ranges']) responseHeaders['Accept-Ranges'] = upstreamRes.headers['accept-ranges'];

            res.writeHead(statusCode, responseHeaders);
            upstreamRes.pipe(res);
            upstreamRes.on('data', (chunk) => {
                if (HLS_SEGMENT_NETWORK_DIAG && netDiag && !netDiag.firstByteReceived) {
                    netDiag.firstByteReceived = true;
                    netDiag.networkStage = 'first-byte';
                    netDiag.log('first-byte', { bytes: chunk.length });
                }
                responseBytes += chunk.length;
            });
            upstreamRes.on('end', () => {
                const elapsed = Date.now() - startedAt;
                if (HLS_SEGMENT_NETWORK_DIAG && netDiag) {
                    netDiag.networkStage = 'response-end';
                    netDiag.log('response-end', { bytes: responseBytes, status: statusCode, elapsed });
                }
                if (stallDiag) {
                    stallDiag.log('response-end', {
                        status: statusCode,
                        bytes: responseBytes,
                        totalMs: elapsed,
                        seq: entry.mediaSequence,
                        reusedSocket: activeUpstreamReq && activeUpstreamReq.reusedSocket
                    });
                }
                if (elapsed > 2000) {
                    console.log(`[${entry.videoId}] Segmento HLS proxy lento: status=${statusCode} ${elapsed}ms id=${entry.id.slice(0, 8)} session=${sessionPreview(entry.sessionId)}`);
                }
                const slowThreshold = Math.max(1000, (Number(entry.extinfDuration) || 2) * 0.5);
                if (stallDiag && elapsed > slowThreshold) {
                    stallDiag.log('slow-segment', {
                        totalMs: elapsed,
                        bytes: responseBytes,
                        seq: entry.mediaSequence,
                        extinfDuration: entry.extinfDuration,
                        status: statusCode
                    });
                }
                if (HLS_DIAGNOSTIC_MODE) {
                    console.log(`[HLS-SEGMENT] upstream-status=${statusCode} content-type=${upstreamRes.headers['content-type'] || 'unknown'} bytes=${responseBytes} elapsed=${elapsed}ms id=${entry.id.slice(0, 8)}`);
                }
            });
        });

        activeUpstreamReq.setTimeout(30000, () => {
            if (HLS_SEGMENT_NETWORK_DIAG && netDiag) {
                netDiag.appTimeoutTriggered = true;
                netDiag.networkStage = 'request-timeout';
                netDiag.log('request-timeout', { timeoutMs: 30000 });
            }
            activeUpstreamReq.destroy(new Error('segment_timeout'));
        });
        activeUpstreamReq.on('error', (err) => {
            if (closed) return;
            if (HLS_SEGMENT_NETWORK_DIAG && netDiag) {
                netDiag.networkStage = 'request-error';
                netDiag.log('request-error', {
                    code: err.code,
                    errno: err.errno,
                    syscall: err.syscall,
                    appTimeoutTriggered: netDiag.appTimeoutTriggered,
                    sockTimeoutTriggered: netDiag.sockTimeoutTriggered
                });
            }
            if (stallDiag) {
                stallDiag.log('request-error', {
                    code: err.code,
                    errorMsg: err.message
                });
            }
            const isTransientError = err && ['ETIMEDOUT','ECONNRESET','EPIPE','ENETUNREACH','EHOSTUNREACH','ENOTFOUND','ECONNREFUSED'].includes(err.code);
            const currentRetryCount = Number(entry._retryCount) || 0;
            if (HLS_SEGMENT_TRANSIENT_RETRY && isTransientError && !closed && !res.headersSent && currentRetryCount < HLS_SEGMENT_TRANSIENT_RETRY_MAX) {
                entry._retryCount = currentRetryCount + 1;
                if (stallDiag) {
                    stallDiag.log('retry', { retryCount: entry._retryCount });
                }
                console.log(`[${entry.videoId}] Segmento HLS proxy retry: attempt=${entry._retryCount}/${HLS_SEGMENT_TRANSIENT_RETRY_MAX} id=${entry.id.slice(0, 8)}`);
                setTimeout(() => requestSegment(url, redirects), HLS_SEGMENT_TRANSIENT_RETRY_DELAY_MS);
                return;
            }
            if (!res.headersSent) {
                console.warn(`[${entry.videoId}] Segmento HLS proxy erro: ${err.code || err.message} id=${entry.id.slice(0, 8)} session=${sessionPreview(entry.sessionId)}`);
                if (HLS_DIAGNOSTIC_MODE) {
                    console.log(`[HLS-SEGMENT] error=${err.code || 'unknown'} id=${entry.id.slice(0, 8)}`);
                }
                sendHlsError(res, 502, 'segment_unavailable');
            } else {
                res.destroy(err);
            }
        });
        if (HLS_SEGMENT_NETWORK_DIAG && netDiag) {
            netDiag.protocol = upstreamUrl.protocol;
            netDiag.hostHash = crypto.createHash('sha256').update(upstreamUrl.hostname).digest('hex').slice(0, 12);
            activeUpstreamReq.on('socket', (socket) => {
                if (!socket) return;
                netDiag.networkStage = 'socket-assigned';
                const reused = activeUpstreamReq.reusedSocket;
                netDiag.log('socket-assigned', { reusedSocket: reused, connecting: socket.connecting });
                if (reused && !socket.connecting) {
                    netDiag.networkStage = 'socket-reused';
                    netDiag.log('socket-reused', { family: socket.remoteFamily });
                }
                if (!reused && !hlsNetDiagInstrumentedSockets.has(socket)) {
                    hlsNetDiagInstrumentedSockets.add(socket);
                    socket.once('lookup', (lookupErr, address, family) => {
                        netDiag.networkStage = 'dns-lookup';
                        if (lookupErr) netDiag.log('dns-lookup', { code: lookupErr.code });
                        else netDiag.log('dns-lookup', { family });
                    });
                    socket.once('connect', () => {
                        netDiag.networkStage = 'tcp-connected';
                        netDiag.log('tcp-connected', { family: socket.remoteFamily });
                    });
                    socket.once('secureConnect', () => {
                        netDiag.networkStage = 'tls-connected';
                        netDiag.log('tls-connected');
                    });
                    socket.once('timeout', () => {
                        netDiag.sockTimeoutTriggered = true;
                        netDiag.networkStage = 'socket-timeout';
                        netDiag.log('socket-timeout');
                    });
                    socket.once('close', (hadError) => {
                        netDiag.log('socket-close', { hadError });
                    });
                }
            });
        }
    };

    try {
        if (stallDiag) {
            stallDiag.log('seg-start', {
                seq: entry.mediaSequence,
                extinfDuration: entry.extinfDuration
            });
        }
        requestSegment(entry.url);
        if (HLS_SEGMENT_NETWORK_DIAG && netDiag && !hlsNetDiagOneShotDone) {
            hlsNetDiagOneShotDone = true;
            const diagUrl = entry.url;
            const diagHostname = new URL(diagUrl).hostname;
            const diagHostHash = crypto.createHash('sha256').update(diagHostname).digest('hex').slice(0, 12);
            const dnsStart = Date.now();
            dns.lookup(diagHostname, { all: true }, (dnsErr, addresses) => {
                const dnsElapsed = Date.now() - dnsStart;
                if (dnsErr) {
                    console.log(`[HLS-NET-DNS] host=${diagHostHash} error=${dnsErr.code} elapsed=${dnsElapsed}ms`);
                } else {
                    const families = addresses.map(a => a.family);
                    console.log(`[HLS-NET-DNS] host=${diagHostHash} count=${addresses.length} families=${JSON.stringify(families)} elapsed=${dnsElapsed}ms`);
                    addresses.forEach((a, i) => {
                        const addrHash = crypto.createHash('sha256').update(a.address).digest('hex').slice(0, 8);
                        console.log(`[HLS-NET-DNS]   addr[${i}] family=${a.family} hash=${addrHash}`);
                    });
                }
            });
            let ndStage = 'start';
            const ndStart = Date.now();
            const ndReq = https.get(diagUrl, {
                agent: false, family: 4,
                headers: {
                    'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0',
                    'Accept': '*/*',
                    'Range': 'bytes=0-1023'
                },
                timeout: 25000
            }, (ndRes) => {
                ndStage = 'response';
                let ndBytes = 0;
                ndRes.on('data', (chunk) => {
                    if (ndBytes === 0) console.log(`[HLS-NODE-DIRECT] first-byte status=${ndRes.statusCode} elapsed=${Date.now()-ndStart}ms host=${diagHostHash}`);
                    ndBytes += chunk.length;
                    ndRes.destroy();
                });
                ndRes.on('end', () => { console.log(`[HLS-NODE-DIRECT] end status=${ndRes.statusCode} bytes=${ndBytes} elapsed=${Date.now()-ndStart}ms host=${diagHostHash}`); });
            });
            ndReq.on('socket', (sock) => {
                console.log(`[HLS-NODE-DIRECT] socket host=${diagHostHash}`);
                sock.once('lookup', (ndErr, address, family) => {
                    ndStage = 'lookup';
                    if (ndErr) console.log(`[HLS-NODE-DIRECT] lookup error=${ndErr.code} elapsed=${Date.now()-ndStart}ms`);
                    else {
                        const addrHash = crypto.createHash('sha256').update(address).digest('hex').slice(0, 8);
                        console.log(`[HLS-NODE-DIRECT] lookup family=${family} addr=${addrHash} elapsed=${Date.now()-ndStart}ms`);
                    }
                });
                sock.once('connect', () => { ndStage = 'connect'; console.log(`[HLS-NODE-DIRECT] connect family=${sock.remoteFamily} elapsed=${Date.now()-ndStart}ms`); });
                sock.once('secureConnect', () => { ndStage = 'secureConnect'; console.log(`[HLS-NODE-DIRECT] secureConnect elapsed=${Date.now()-ndStart}ms`); });
                sock.once('close', () => { console.log(`[HLS-NODE-DIRECT] close stage=${ndStage} elapsed=${Date.now()-ndStart}ms`); });
            });
            ndReq.on('timeout', () => { console.log(`[HLS-NODE-DIRECT] timeout elapsed=${Date.now()-ndStart}ms host=${diagHostHash}`); ndReq.destroy(); });
            ndReq.on('error', (err) => { console.log(`[HLS-NODE-DIRECT] error code=${err.code||'unknown'} syscall=${err.syscall||''} elapsed=${Date.now()-ndStart}ms host=${diagHostHash}`); });
            const curlStart = Date.now();
            const curlArgs = ['--ipv4', '--location', '--range', '0-1023', '--connect-timeout', '10', '--max-time', '25', '--silent', '--show-error', '--output', '/dev/null', '--write-out', 'http=%{http_code} dns=%{time_namelookup} connect=%{time_connect} tls=%{time_appconnect} first=%{time_starttransfer} total=%{time_total} size=%{size_download}', diagUrl];
            const curlProc = spawn('curl', curlArgs, { shell: false, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
            let curlOut = '';
            let curlErr = '';
            curlProc.stdout.on('data', (d) => { curlOut += d.toString(); });
            curlProc.stderr.on('data', (d) => { curlErr += d.toString(); });
            curlProc.on('close', (exitCode) => {
                console.log(`[HLS-CURL-DIAG] exit=${exitCode} host=${diagHostHash} elapsed=${Date.now()-curlStart}ms`);
                if (curlOut) curlOut.trim().split(/\s+/).forEach(p => { const m = p.match(/^(\w+)=(.*)$/); if (m) console.log(`[HLS-CURL-DIAG] ${m[1]}=${m[2]}`); });
                if (curlErr && exitCode !== 0) console.log(`[HLS-CURL-DIAG] error=${curlErr.replace(/[\r\n]/g,' ').slice(0,200)}`);
            });
            curlProc.on('error', (err) => { console.log(`[HLS-CURL-DIAG] spawn_error code=${err.code} host=${diagHostHash} elapsed=${Date.now()-curlStart}ms`); });
        }
    } catch (_) {
        hlsSegmentProxyEntries.delete(entry.id);
        if (HLS_DIAGNOSTIC_MODE) {
            console.log(`[HLS-SEGMENT] error=exception id=${entry.id.slice(0, 8)}`);
        }
        return sendHlsError(res, 410, 'segment_expired');
    }
    req.on('close', () => {
        closed = true;
        if (!res.writableEnded && activeUpstreamReq) activeUpstreamReq.destroy();
    });
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
        .filter(session => isMonitorAcceptingPlayback(converter.activeMonitors.get(`${session.videoId}:${owner}`)))
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
            clearHlsSessionVariantStateFor({ owner, videoId });
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
                    clearHlsSessionVariantStateFor({ owner, videoId: vid });
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
            clearHlsSessionVariantStateFor({ owner, videoId });
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
        const active = playbackSessions.listActive({ owner })
            .filter(session => isMonitorAcceptingPlayback(converter.activeMonitors.get(`${session.videoId}:${owner}`)))
            .length;
        result[owner] = {
            active,
            limit: cliente.dispositivos
        };
    }
    res.json(result);
});

app.get('/api/public/monitors', publicApiLimiter, (req, res) => {
    const monitors = [];
    const nowMs = Date.now();
    if (converter && converter.activeMonitors) {
        for (const [key, monitor] of converter.activeMonitors.entries()) {
            const [videoId, owner] = key.split(':');

            if (monitor.liveState === 'ended' || monitor._liveEnded) {
                continue;
            }

            const token = getOrCreateToken(videoId, owner || null);
            const healthSummary = buildMonitorHealth(monitor, { nowMs });
            const rawStatus = monitor.liveState || (monitor.isLive ? 'online' : 'offline');
            const displayStatus = getMonitorDisplayStatus(monitor, healthSummary);
            const ending = isMonitorEnding(monitor);
            const terminalAvailability = isMonitorTerminalAvailability(monitor);
            const liveEndedFirstDetection = Number(monitor._liveEndedFirstDetection) || 0;
            const removalDelaySeconds = ending && liveEndedFirstDetection
                ? Math.max(0, 120 - Math.floor((nowMs - liveEndedFirstDetection) / 1000))
                : 0;
            monitors.push({
                videoId,
                owner: owner || null,
                token,
                status: displayStatus,
                rawStatus,
                ending,
                terminalAvailability,
                removalDelaySeconds,
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
            clearHlsSessionVariantStateFor({ owner });
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

// ========== HLS SEGMENT CACHE ==========
// Rotas GET/HEAD de /neonews/hls-segment sao registradas DENTRO da IIFE de
// inicializacao (abaixo), imediatamente apos hlsSegmentCache.init(), para
// garantir que o cache ja esta pronto e evitar HTTP 404 em requests de
// segmento do Android. O registro em escopo de modulo falhava porque
// hlsSegmentCache ainda era null no carregamento do modulo.

app.head('/neonews/seg/:segmentId.ts', handleHlsSegmentHead);

app.get('/neonews/seg/:segmentId.ts', handleHlsSegmentProxy);

app.head('/neonews/:videoId.m3u8', (req, res) => {
    handleHlsHead(req.params.videoId, req.query.owner || null, res);
});

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
app.head('/neonews/t/:token.m3u8', (req, res) => {
    const info = getTokenInfo(req.params.token);
    if (!info) {
        return sendHlsError(res, 404, 'token_not_found');
    }
    if (isRevokedTokenInfo(info)) {
        return sendHlsError(res, 410, 'token_gone');
    }
    handleHlsHead(info.videoId, info.owner, res);
});

app.get('/neonews/t/:token.m3u8', async (req, res) => {
    const token = req.params.token;
    const info = getTokenInfo(token);
    if (!info) {
        return sendHlsError(res, 404, 'token_not_found');
    }
    if (isRevokedTokenInfo(info)) {
        return sendHlsError(res, 410, 'token_gone');
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
    return readLogTailInfo(filePath, maxBytes).text;
}

function readLogTailInfo(filePath, maxBytes) {
    if (!fs.existsSync(filePath)) return { text: '', mtimeMs: 0 };
    const stats = fs.statSync(filePath);
    if (!stats.isFile() || stats.size <= 0) return { text: '', mtimeMs: 0 };
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
    return {
        text: start > 0 ? text.replace(/^[^\n]*(\n|$)/, '') : text,
        mtimeMs: stats.mtimeMs
    };
}

function resolveExistingLogPath(candidates) {
    for (const candidate of candidates) {
        const filePath = String(candidate || '').trim();
        if (!filePath) continue;
        try {
            const stats = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
            if (stats?.isFile() && stats.size > 0) return filePath;
        } catch (_) {
            // Ignore unreadable candidates and try the next source.
        }
    }
    return '';
}

function getServerLogSources() {
    const projectOut = path.join(__dirname, 'logs', 'pm2-out-0.log');
    const projectErr = path.join(__dirname, 'logs', 'pm2-error-0.log');
    return [
        {
            source: 'out',
            filePath: resolveExistingLogPath([
                process.env.SERVER_LOG_OUT_PATH,
                process.env.PM2_OUT_LOG_PATH,
                '/root/.pm2/logs/livemonitor-out.log',
                '/root/.pm2/logs/youtube-monitor-v3-out.log',
                projectOut
            ])
        },
        {
            source: 'err',
            filePath: resolveExistingLogPath([
                process.env.SERVER_LOG_ERROR_PATH,
                process.env.PM2_ERROR_LOG_PATH,
                '/root/.pm2/logs/livemonitor-error.log',
                '/root/.pm2/logs/youtube-monitor-v3-error.log',
                projectErr
            ])
        }
    ].filter(file => file.filePath);
}

function formatServerLogTimestamp(ms, approximate = false) {
    if (!Number.isFinite(ms) || ms <= 0) return '';
    const date = new Date(ms);
    const pad = (value, size = 2) => String(value).padStart(size, '0');
    const formatted = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
        `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    return approximate ? `~ ${formatted}` : formatted;
}

function parseServerLogLine(line, source, index, fallbackTimestampMs = 0) {
    const sanitized = sanitizeServerLogLine(line);
    const match = sanitized.match(/^(\d{4}-\d{2}-\d{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{3}Z|Z)?):?\s*(.*)$/);
    const timestamp = match
        ? match[1].replace('T', ' ').replace('Z', '')
        : formatServerLogTimestamp(fallbackTimestampMs, true);
    const message = match ? match[2] : sanitized;
    const parsedSortTime = match ? Date.parse(timestamp.replace(' ', 'T')) : 0;
    const sortTime = match ? parsedSortTime : ((Number(fallbackTimestampMs) || 0) + index);
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
    const files = getServerLogSources();

    let index = 0;
    const entries = [];
    for (const file of files) {
        const { text, mtimeMs } = readLogTailInfo(file.filePath, maxBytes);
        for (const line of text.split(/\r?\n/)) {
            if (!line.trim()) continue;
            entries.push(parseServerLogLine(line, file.source, index, mtimeMs));
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
                    clearHlsSessionVariantStateFor({ owner, videoId });
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
            const ending = isMonitorEnding(monitor);
            const terminalAvailability = isMonitorTerminalAvailability(monitor);
            const liveEndedFirstDetection = Number(monitor._liveEndedFirstDetection) || 0;
            const removalDelaySeconds = ending && liveEndedFirstDetection
                ? Math.max(0, 120 - Math.floor((nowMs - liveEndedFirstDetection) / 1000))
                : 0;
            monitors.push({
                videoId,
                youtubeUrl: monitor.youtubeUrl,
                owner: owner || null,
                token,
                status: displayStatus,
                rawStatus,
                isLive: displayStatus === 'online',
                ending,
                terminalAvailability,
                removalDelaySeconds,
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
            clearHlsSessionVariantStateFor({ owner: actualOwner, videoId });
            viewerAccess.delete(`${actualOwner}:${videoId}`);
            saveViewerAccess(viewerAccess);
        } else {
            viewerAccess.delete(videoId);
            saveViewerAccess(viewerAccess);
            clearHlsSessionVariantStateFor({ videoId });
        }

        m3u8CacheContent.delete(videoId);
        m3u8CachePromises.delete(videoId);
        lastGoodM3u8.delete(videoId);
        lastServedSequence.delete(videoId);

        for (const [token, info] of Object.entries(tokenMap)) {
            if (info.videoId === videoId && info.owner === actualOwner && !info.revokedAt) {
                revokeToken(token, 'manual_stop');
                console.log(`🗑️ Token ${tokenPreview(token)} revogado para ${videoId}:${actualOwner}`);
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
        if (info.videoId === videoId && info.owner === owner && !info.revokedAt) {
            revokeToken(token, 'live_ended');
            console.log(`🗑️ Token ${tokenPreview(token)} revogado para ${videoId}:${owner}`);
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
        clearHlsSessionVariantStateFor({ owner, videoId });
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


// ========== HLS SEGMENT CACHE INIT ==========
(async () => {
    if (HLS_SEGMENT_CACHE_ENABLED) {
        try {
            hlsSegmentCache = new HlsSegmentCache({
                cacheDir: HLS_SEGMENT_CACHE_DIR,
                ttlMs: HLS_SEGMENT_CACHE_TTL_MS,
                maxBytes: HLS_SEGMENT_CACHE_MAX_BYTES,
                maxFiles: HLS_SEGMENT_CACHE_MAX_FILES,
                prefetchConcurrency: HLS_SEGMENT_PREFETCH_CONCURRENCY,
                prefetchTimeoutMs: HLS_SEGMENT_PREFETCH_TIMEOUT_MS,
                prefetchPlaylistWaitMs: HLS_SEGMENT_PLAYLIST_WAIT_MS,
                minReady: HLS_SEGMENT_CACHE_MIN_READY,
                prefetchEnabled: HLS_SEGMENT_PREFETCH_ENABLED,
                forceIPv4: true,
                diagnostic: HLS_DIAGNOSTIC_MODE,
                playbackSessions,
                allowedVideoIds: HLS_SEGMENT_CACHE_VIDEO_IDS
            });
            await hlsSegmentCache.init();
            app.get('/neonews/hls-segment/:sessionId/:cacheId', async (req, res) => {
                try {
                    const { sessionId, cacheId } = req.params;
                    const served = await hlsSegmentCache.serveSegment(cacheId, sessionId, req, res);
                    if (!served) {
                        sendHlsError(res, 503, 'segment_unavailable', { 'Retry-After': '1' });
                    }
                } catch (err) {
                    if (!res.headersSent) {
                        sendHlsError(res, 500, 'segment_cache_error');
                    }
                }
            });

            app.head('/neonews/hls-segment/:sessionId/:cacheId', async (req, res) => {
                try {
                    const { sessionId, cacheId } = req.params;
                    const served = await hlsSegmentCache.serveSegmentHead(cacheId, req, res);
                    if (!served) {
                        res.status(503).end();
                    }
                } catch (_) {
                    if (!res.headersSent) res.status(500).end();
                }
            });
            console.log(`[HLS-CACHE] cache enabled dir=${HLS_SEGMENT_CACHE_DIR} ttl=${HLS_SEGMENT_CACHE_TTL_MS}ms prefetch=${HLS_SEGMENT_PREFETCH_ENABLED} allowlist=[${HLS_SEGMENT_CACHE_VIDEO_IDS.join(',')}]`);
        } catch (err) {
            console.error('[HLS-CACHE] initialization failed:', err.message);
            hlsSegmentCache = null;
        }
    } else {
        console.log('[HLS-CACHE] cache disabled');
    }
})();

// ========== SHUTDOWN ==========
function shutdownCache() {
    if (hlsSegmentCache) {
        hlsSegmentCache.shutdown();
        hlsSegmentCache = null;
        console.log('[HLS-CACHE] shut down');
    }
}

process.on('SIGTERM', () => {
    console.log('[APP] SIGTERM received, shutting down cache...');
    shutdownCache();
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('[APP] SIGINT received, shutting down cache...');
    shutdownCache();
    process.exit(0);
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
