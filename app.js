const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { spawn } = require('child_process');
const session = require('express-session');
const crypto = require('crypto');
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
        for (const [key, viewers] of Object.entries(data)) {
            const innerMap = new Map();
            for (const [ip, timestamp] of Object.entries(viewers)) {
                innerMap.set(ip, timestamp);
            }
            map.set(key, innerMap);
        }
        console.log(`📱 Carregados ${map.size} chaves (owner:videoId) com dispositivos ativos.`);
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
        for (const [key, ips] of Object.entries(data)) {
            const innerMap = new Map();
            for (const [ip, timestamp] of Object.entries(ips)) {
                innerMap.set(ip, timestamp);
            }
            map.set(key, innerMap);
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
const VIEWER_WINDOW_MS = parseInt(process.env.VIEWER_WINDOW_MS) || 45000; // 45 segundos (ajustado para expiração rápida)

function normalizeIp(ip) {
    if (!ip) return 'unknown';
    if (typeof ip === 'string' && ip.includes('::ffff:')) {
        return ip.replace('::ffff:', '');
    }
    if (ip === '::1' || ip === '0:0:0:0:0:0:0:1') return '127.0.0.1';
    return ip;
}

// Limpeza periódica global de IPs inativos (a cada 30 segundos)
setInterval(() => {
    const now = Date.now();
    let changed = false;
    
    // Limpar ownerViewers
    for (const [key, viewers] of ownerViewers.entries()) {
        for (const [ip, timestamp] of viewers.entries()) {
            if (now - timestamp > VIEWER_WINDOW_MS) {
                viewers.delete(ip);
                changed = true;
            }
        }
        if (viewers.size === 0) {
            ownerViewers.delete(key);
            changed = true;
        }
    }
    if (changed) saveOwnerViewers(ownerViewers);

    // Limpar viewerAccess
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
}, 30000);

function trackViewer(owner, videoId, ip) {
    const now = Date.now();
    const key = owner ? `${owner}:${videoId}` : videoId;
    if (!viewerAccess.has(key)) viewerAccess.set(key, new Map());
    const viewers = viewerAccess.get(key);
    viewers.set(ip, now);
    for (const [viewerIp, timestamp] of viewers.entries()) {
        if (now - timestamp > VIEWER_WINDOW_MS) viewers.delete(viewerIp);
    }
    saveViewerAccess(viewerAccess);
}

function trackViewerByOwner(owner, ip, videoId) {
    if (!owner || !videoId) {
        console.warn('[WARN] trackViewerByOwner chamado com owner ou videoId nulo');
        return;
    }
    if (isLocalIp(ip)) return; // ignora IPs locais
    
    const now = Date.now();
    const currentKey = `${owner}:${videoId}`;

    // --- LÓGICA DE EXCLUSIVIDADE DE IP POR CLIENTE ---
    // Se este IP aparecer em QUALQUER OUTRA live deste mesmo owner, removemos imediatamente.
    // Isso evita que um único dispositivo conte como 2 se o player mudar de canal rápido.
    let exclusivityRemoved = false;
    for (const [key, viewers] of ownerViewers.entries()) {
        if (key.startsWith(`${owner}:`) && key !== currentKey) {
            if (viewers.has(ip)) {
                viewers.delete(ip);
                exclusivityRemoved = true;
                // Opcional: limpar cache da live antiga para forçar atualização no dashboard
                const oldVideoId = key.split(':')[1];
                m3u8CacheContent.delete(oldVideoId);
            }
        }
    }

    if (!ownerViewers.has(currentKey)) ownerViewers.set(currentKey, new Map());
    const viewers = ownerViewers.get(currentKey);
    viewers.set(ip, now);

    // Limpeza por expiração normal (fallback)
    for (const [viewerIp, timestamp] of viewers.entries()) {
        if (now - timestamp > VIEWER_WINDOW_MS) {
            viewers.delete(viewerIp);
        }
    }
    
    if (exclusivityRemoved) {
        console.log(`[${owner}] 📱 IP ${ip} movido exclusivamente para live ${videoId}`);
    }
    
    saveOwnerViewers(ownerViewers);
}

function renewViewersForMonitor(owner, videoId) {
    if (!owner || !videoId) return;
    const key = `${owner}:${videoId}`;
    const viewers = ownerViewers.get(key);
    if (!viewers || viewers.size === 0) return;

    const now = Date.now();
    const ACTIVITY_TIMEOUT = parseInt(process.env.VIEWER_WINDOW_MS) || 45000;
    const activityKey = `${owner}:${videoId}`;
    const activityMap = viewerAccess.get(activityKey);
    let renewed = 0, removed = 0;

    for (const [ip, timestamp] of viewers.entries()) {
        const lastAccess = activityMap ? (activityMap.get(ip) || 0) : 0;
        const hasRecentActivity = (now - lastAccess) <= ACTIVITY_TIMEOUT;

        if (hasRecentActivity) {
            viewers.set(ip, now);
            renewed++;
        } else if ((now - timestamp) > VIEWER_WINDOW_MS) {
            viewers.delete(ip);
            removed++;
            console.log(`[${key}] 🔌 IP ${ip} removido por inatividade`);
        }
    }

    if (renewed > 0 || removed > 0) {
        console.log(`[${key}] 🔄 Renovação: ${renewed} ativo(s), ${removed} expirado(s)`);
        saveOwnerViewers(ownerViewers);
    }
}

function getActiveDevicesForOwnerAndVideo(owner, videoId) {
    const key = `${owner}:${videoId}`;
    const viewers = ownerViewers.get(key);
    if (!viewers) return 0;
    const now = Date.now();
    let count = 0;
    for (const [ip, timestamp] of viewers.entries()) {
        if (now - timestamp <= VIEWER_WINDOW_MS) count++;
    }
    return count;
}

function getActiveViewerIPsForOwnerAndVideo(owner, videoId) {
    const key = `${owner}:${videoId}`;
    const viewers = ownerViewers.get(key);
    if (!viewers) return [];
    const now = Date.now();
    const ips = [];
    for (const [ip, timestamp] of viewers.entries()) {
        if (now - timestamp <= VIEWER_WINDOW_MS) ips.push(ip);
    }
    return ips;
}

function isIpActiveForOwnerAndVideo(owner, videoId, ip) {
    if (!owner || !videoId || isLocalIp(ip)) return true;
    const key = `${owner}:${videoId}`;
    const viewers = ownerViewers.get(key);
    if (!viewers) return false;
    return viewers.has(ip);
}

function getDeviceLimitForOwner(owner) {
    const clientes = getClientes();
    const cliente = clientes.find(c => c.login === owner);
    return cliente ? cliente.dispositivos : 0;
}

function getTotalViewers() {
    const now = Date.now();
    const uniqueIps = new Set();
    for (const viewers of ownerViewers.values()) {
        for (const [ip, timestamp] of viewers.entries()) {
            if (now - timestamp <= VIEWER_WINDOW_MS) uniqueIps.add(ip);
        }
    }
    return uniqueIps.size;
}

// ============================================================
// FILTRO DE QUALIDADE DO MANIFESTO MASTER
// ============================================================
function filterMasterByMaxHeight(masterContent, maxHeight) {
    if (!masterContent || !maxHeight) return masterContent;

    const lines = masterContent.split('\n');
    const filtered = [];
    let skipNext = false;
    let lastKeptResolution = null;
    let allResolutions = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('#EXT-X-STREAM-INF')) {
            const resMatch = line.match(/RESOLUTION=\d+x(\d+)/i);
            if (resMatch) {
                allResolutions.push(parseInt(resMatch[1], 10));
            }
        }
    }

    const validResolutions = allResolutions.filter(h => h <= maxHeight);
    const effectiveMax = validResolutions.length > 0
        ? maxHeight
        : Math.min(...allResolutions);

    if (effectiveMax !== maxHeight) {
        console.log(`[filterMaster] Nenhuma qualidade <= ${maxHeight}p, usando fallback ${effectiveMax}p`);
    }

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        if (line.startsWith('#EXT-X-STREAM-INF')) {
            const resMatch = line.match(/RESOLUTION=\d+x(\d+)/i);
            if (resMatch) {
                const height = parseInt(resMatch[1], 10);
                if (height <= effectiveMax) {
                    filtered.push(lines[i]);
                    lastKeptResolution = height;
                    skipNext = false;
                } else {
                    skipNext = true;
                }
            } else {
                filtered.push(lines[i]);
                skipNext = false;
            }
        } else if (skipNext && line !== '' && !line.startsWith('#')) {
            skipNext = false;
        } else {
            filtered.push(lines[i]);
            if (skipNext && line === '') skipNext = false;
        }
    }

    const result = filtered.join('\n');
    console.log(`[filterMaster] Qualidades mantidas até ${effectiveMax}p (última: ${lastKeptResolution}p)`);
    return result;
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
function runYtdlp(args, timeout = 30000) {
    return new Promise(async (resolve, reject) => {
        // Remove qualquer seleção de formato (-f) para evitar warnings
        const filteredArgs = args.filter((arg, index) => {
            if (arg === '-f' || arg === '--format') return false;
            if (index > 0 && (args[index-1] === '-f' || args[index-1] === '--format')) return false;
            return true;
        });

        // Detecta se é uma chamada para obter metadados
        const isMetadataCall = filteredArgs.includes('--dump-json') && 
                              filteredArgs.some(a => a.includes('youtube.com/watch'));

        let finalArgs = [...filteredArgs];

        if (isMetadataCall) {
            if (!finalArgs.includes('--flat-playlist')) {
                finalArgs.push('--flat-playlist');
            }
            if (!finalArgs.includes('--playlist-end')) {
                finalArgs.push('--playlist-end', '1');
            }
        }

        // Identifica qual cookie está sendo usado
        let cookieIndex = finalArgs.indexOf('--cookies');
        let cookiePath = null;
        if (cookieIndex !== -1 && finalArgs.length > cookieIndex + 1) {
            cookiePath = finalArgs[cookieIndex + 1];
        }

        // Se não houver cookie, tenta usar o cookie1.txt como padrão
        if (!cookiePath) {
            const defaultCookie = path.join(cookiesDir, 'cookie1.txt');
            if (fs.existsSync(defaultCookie)) {
                finalArgs.unshift('--cookies', defaultCookie);
                cookiePath = defaultCookie;
            }
        }

        console.log(`🔧 runYtdlp args: ${finalArgs.join(' ')}`);

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
            if (err.message.includes('No video formats found')) {
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
const M3U8_CACHE_TTL = parseInt(process.env.M3U8_CACHE_TTL) || 5000;

const REFRESH_WAIT_MS = 10000;
const STALE_SERVE_MAX_AGE_MS = parseInt(process.env.STALE_MAX_AGE_MS) || 60000;

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

// ============================================================
// CONTROLE DE VERBOSIDADE DOS LOGS (rate limiting)
// ============================================================
let requestLogCount = 0;
let lastLogTime = 0;
const LOG_INTERVAL_MS = 5000;

function logRequestSummary(videoId, ip, owner) {
    requestLogCount++;
    const now = Date.now();
    if (now - lastLogTime > LOG_INTERVAL_MS) {
        console.log(`[${videoId}] 📡 ${requestLogCount} requisições (último IP: ${ip}, owner: ${owner})`);
        requestLogCount = 0;
        lastLogTime = now;
    }
}

// ============================================================
// HANDLER DO PROXY M3U8 (com logs reduzidos)
// ============================================================
async function handleM3u8Proxy(videoId, owner, req, res, maxHeight) {
    const reqStart = Date.now();
    const queryOwner = owner || req.query.owner || null;

    logRequestSummary(videoId, req.ip, queryOwner);

    const allowedHeights = [144, 240, 360, 480, 720, 1080];
    const envMaxHeight = parseInt(process.env.VIDEO_MAX_HEIGHT, 10) || 1080;
    const urlMaxHeight = parseInt(req.query.max, 10);
    let finalMaxHeight = maxHeight || envMaxHeight;
    if (Number.isFinite(urlMaxHeight) && allowedHeights.includes(urlMaxHeight)) {
        finalMaxHeight = urlMaxHeight;
        console.log(`[${videoId}] 📺 Qualidade forçada via URL: ${finalMaxHeight}p`);
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
                    await converter.convert(entry.youtubeUrl, baseUrl, savedOwner);
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

    if (trackingOwner) {
        const rawIp = req.ip || req.socket.remoteAddress;
        const clientIp = normalizeIp(
            req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
            rawIp
        );

        if (!isLocalIp(clientIp)) {
            const isAuthorized = isIpActiveForOwnerAndVideo(trackingOwner, videoId, clientIp);
            if (!isAuthorized) {
                const activeDevices = getActiveDevicesForOwnerAndVideo(trackingOwner, videoId);
                const deviceLimit = getDeviceLimitForOwner(trackingOwner);
                if (deviceLimit > 0 && activeDevices >= deviceLimit) {
                    console.log(`[${trackingOwner}:${videoId}] 🚫 Dispositivo bloqueado: ${activeDevices} ativos, IP ${clientIp} excederia limite ${deviceLimit}`);
                    return res.status(429).json({
                        error: 'Limite de dispositivos excedido',
                        message: `Você atingiu o limite de ${deviceLimit} dispositivos simultâneos para esta live.`
                    });
                }
                console.log(`[${trackingOwner}:${videoId}] ➕ Adicionando novo IP ${clientIp}`);
                trackViewerByOwner(trackingOwner, clientIp, videoId);
            } else {
                trackViewerByOwner(trackingOwner, clientIp, videoId);
            }
        }
    } else {
        console.warn(`[${videoId}] Acesso sem owner definido - dispositivo não será rastreado.`);
    }

    const rawIpActivity = req.ip || req.socket.remoteAddress;
    const clientIpActivity = normalizeIp(
        req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
        rawIpActivity
    );
    trackViewer(trackingOwner, videoId, clientIpActivity);

    monitor._currentMaxHeight = finalMaxHeight;
    monitor.lastAccess = Date.now();

    if (monitor._masterContent && monitor._masterContent.isMaster) {
        const rawContent = monitor._masterContent.content;
        const filteredContent = filterMasterByMaxHeight(rawContent, finalMaxHeight);
        console.log(`[${videoId}] 📦 Servindo master artificial filtrado até ${finalMaxHeight}p`);
        res.writeHead(200, {
            'Content-Type': 'application/vnd.apple.mpegurl',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0',
            'X-Master': 'true',
            'X-Max-Height': String(finalMaxHeight)
        });
        res.end(filteredContent);
        return;
    }

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
            contentToServe = filterMasterByMaxHeight(contentToServe, finalMaxHeight);
            console.log(`[${videoId}] 📦 Servindo manifesto master filtrado até ${finalMaxHeight}p`);
        } else {
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
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0',
            'X-Cache': result.fromCache ? 'HIT' : 'MISS',
            'X-Master': isMaster ? 'true' : 'false',
            'X-Max-Height': isMaster ? String(finalMaxHeight) : 'N/A'
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
                        renewedContent = filterMasterByMaxHeight(renewedContent, finalMaxHeight);
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
                        'Cache-Control': 'no-cache, no-store, must-revalidate',
                        'Pragma': 'no-cache',
                        'Expires': '0',
                        'X-Master': isRenewedMaster ? 'true' : 'false',
                        'X-Max-Height': isRenewedMaster ? String(finalMaxHeight) : 'N/A'
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
                        'Cache-Control': 'no-cache, no-store, must-revalidate',
                        'Pragma': 'no-cache',
                        'Expires': '0',
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
}

// ============================================================
// ROTAS
// ============================================================
app.get('/converter.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/converter.html'));
});

app.post('/api/convert', async (req, res) => {
    const { youtubeUrl, owner } = req.body;
    if (!youtubeUrl) return res.status(400).json({ success: false, error: 'URL obrigatoria' });
    const baseUrl = process.env.BASE_URL || 'http://localhost:' + PORT;
    const result = await converter.convert(youtubeUrl, baseUrl, owner);
    if (result.success && result.videoId) {
        const token = getOrCreateToken(result.videoId, owner);
        result.token = token;
        result.serverUrl = `${baseUrl}/neonews/t/${token}.m3u8`;
    }
    res.json(result);
});

app.get('/api/public/device-status/:owner', (req, res) => {
    const owner = req.params.owner;
    if (!owner) {
        return res.status(400).json({ error: 'Owner não informado' });
    }

    const uniqueIps = new Set();
    const now = Date.now();

    for (const [key, viewers] of ownerViewers.entries()) {
        if (key.startsWith(owner + ':')) {
            for (const [ip, timestamp] of viewers.entries()) {
                if (now - timestamp <= VIEWER_WINDOW_MS) {
                    uniqueIps.add(ip);
                }
            }
        }
    }

    const allIps = Array.from(uniqueIps);
    const limit = getDeviceLimitForOwner(owner);
    const remaining = Math.max(0, limit - allIps.length);

    res.json({
        owner,
        limit,
        active: allIps.length,
        remaining,
        ips: allIps
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
        if (!viewers) return res.status(404).json({ error: 'Nenhum dispositivo ativo para esta live' });
        if (viewers.has(ip)) {
            viewers.delete(ip);
            console.log(`[${key}] 📱 IP ${ip} removido manualmente`);
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

app.get('/api/public/device-status-all', (req, res) => {
    const clientes = getClientes();
    const result = {};
    const now = Date.now();

    for (const cliente of clientes) {
        const owner = cliente.login;
        const uniqueIps = new Set();

        for (const [key, viewers] of ownerViewers.entries()) {
            if (key.startsWith(owner + ':')) {
                for (const [ip, timestamp] of viewers.entries()) {
                    if (now - timestamp <= VIEWER_WINDOW_MS) uniqueIps.add(ip);
                }
            }
        }

        result[owner] = { active: uniqueIps.size, limit: cliente.dispositivos };
    }
    res.json(result);
});

app.get('/api/public/monitors', (req, res) => {
    const monitors = [];
    if (converter && converter.activeMonitors) {
        for (const [key, monitor] of converter.activeMonitors.entries()) {
            const [videoId, owner] = key.split(':');
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
    salvarClientes(clientes);
    console.log(`🔄 Clientes sincronizados: ${clientes.length}`);
    res.json({ success: true, message: 'Clientes sincronizados' });
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

app.get('/api/keepalive', (req, res) => {
    const { owner, videoId } = req.query;
    const rawIp = req.ip || req.socket.remoteAddress;
    const ip = normalizeIp(
        req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
        rawIp
    );
    if (owner && videoId && !isLocalIp(ip)) {
        console.log(`[KEEPALIVE] ${owner}:${videoId} -> ${ip}`);
        trackViewerByOwner(owner, ip, videoId);
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
    await handleM3u8Proxy(videoId, queryOwner, req, res, maxHeight);
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
    await handleM3u8Proxy(videoId, owner, req, res, maxHeight);
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

app.get('/api/monitors', isAuthenticated, (req, res) => {
    const monitors = [];
    if (converter && converter.activeMonitors) {
        for (const [key, monitor] of converter.activeMonitors.entries()) {
            const [videoId, owner] = key.split(':');

            // --- LÓGICA DE REMOÇÃO AUTOMÁTICA DE LIVES ENCERRADAS ---
            // Se o monitor detectou que a live terminou (ENDED) ou está OFFLINE por muito tempo, removemos.
            if (monitor.liveState === 'ended' || monitor._liveEnded) {
                console.log(`[${key}] 🗑️ Removendo monitor de live encerrada detectada na API`);
                converter.removeMonitor(videoId, owner);
                continue; // Pula para o próximo, não exibe este
            }

            const activeDevices = owner ? getActiveDevicesForOwnerAndVideo(owner, videoId) : 0;
            const deviceIPs = owner ? getActiveViewerIPsForOwnerAndVideo(owner, videoId) : [];
            const token = getOrCreateToken(videoId, owner || null);
            monitors.push({
                videoId,
                youtubeUrl: monitor.youtubeUrl,
                owner: owner || null,
                token,
                status: monitor.liveState || (monitor.isLive ? 'online' : 'offline'),
                isLive: monitor.liveState === 'online',
                failCount: monitor.failCount || 0,
                lastRenewSuccess: monitor.lastSuccessTime || monitor.lastUpdate,
                health: monitor.health,
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
// 🔧 ROTA UPLOAD COOKIE (COM RESET DO ALERTA)
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

        // 🔧 SUBSTITUIÇÃO REALIZADA AQUI
        if (!isLegacy && converter && converter.cookieRotator) {
            const cookieKey = `cookie${targetType}.txt`;
            converter.cookieRotator.status[cookieKey] = {
                state: 'valid',
                failCount: 0,
                lastFailure: null,
                lastSuccess: new Date().toISOString(),
                reason: null,
                alertActive: false   // <-- ADICIONADO: desliga o alerta só aqui, na troca manual
            };
            converter.cookieRotator.saveStatus();
            console.log(`🔄 CookieRotator: ${cookieKey} marcado como 'valid' após upload (alerta desligado)`);
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
    const { owner } = req.body;

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

        if (!monitorFound && !owner) {
            for (const [key, mon] of converter.activeMonitors.entries()) {
                if (key.startsWith(videoId + ':')) {
                    monitorFound = mon;
                    keyFound = key;
                    actualOwner = key.split(':')[1];
                    break;
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

        if (actualOwner && actualOwner !== owner) {
            return res.status(403).json({ success: false, message: 'Você não tem permissão para parar esta live' });
        }

        monitorFound.stopMonitoring();
        converter.activeMonitors.delete(keyFound);
        removePersistedMapping(videoId, actualOwner);

        if (actualOwner) {
            const key = `${actualOwner}:${videoId}`;
            ownerViewers.delete(key);
            saveOwnerViewers(ownerViewers);
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

// 👇 Função que revoga o token associado a um videoId+owner
const revokeTokenFn = (videoId, owner) => {
    for (const [token, info] of Object.entries(tokenMap)) {
        if (info.videoId === videoId && info.owner === owner) {
            revokeToken(token);
            console.log(`🗑️ Token revogado para ${videoId}:${owner}`);
            break;
        }
    }
};

converter = new ConvertAPI(emailAlerts, null, revokeTokenFn);

if (emailAlerts && converter.cookieRotator) {
    emailAlerts.setCookieRotator(converter.cookieRotator);
    console.log('📧 CookieRotator injetado no EmailAlerts');
} else {
    console.log('⚠️ Não foi possível injetar CookieRotator no EmailAlerts');
}

// ============================================================
// ✅ VALIDAÇÃO ATIVA DOS COOKIES NA INICIALIZAÇÃO (usando LIVE CONTÍNUA)
// ============================================================
(async function validateCookiesOnStartup() {
    if (!converter || !converter.cookieRotator) return;
    console.log('🔍 Validando cookies na inicialização (teste com live contínua)...');
    const cookieFiles = ['cookie1.txt', 'cookie2.txt', 'cookie3.txt'];
    // Usar uma live que fica 24/7 no ar para capturar o erro "No video formats found"
    const TEST_URL = 'https://www.youtube.com/watch?v=aSXLerQStXA'; // live atual
    let anyInvalid = false;
    const invalidList = [];
    for (const file of cookieFiles) {
        const fullPath = path.join(cookiesDir, file);
        if (!fs.existsSync(fullPath)) {
            console.log(`⚠️ ${file} não encontrado, ignorando.`);
            continue;
        }
        try {
            console.log(`🔍 Testando ${file} com live contínua...`);
            await runYtdlp([
                '--cookies', fullPath,
                '--flat-playlist',
                '--playlist-end', '1',
                '--dump-json',
                TEST_URL
            ], 20000);
            // Se não lançou erro, está válido
            const cookieKey = file;
            if (converter.cookieRotator.status[cookieKey]) {
                converter.cookieRotator.status[cookieKey].state = 'valid';
                converter.cookieRotator.status[cookieKey].failCount = 0;
                converter.cookieRotator.status[cookieKey].lastFailure = null;
                converter.cookieRotator.status[cookieKey].reason = null;
                converter.cookieRotator.status[cookieKey].alertActive = false;
                converter.cookieRotator.saveStatus();
            }
            console.log(`✅ ${file} válido (live teste OK)`);
        } catch (err) {
            console.log(`❌ ${file} inválido: ${err.message}`);
            anyInvalid = true;
            const cookieKey = file;
            if (converter.cookieRotator.status[cookieKey]) {
                converter.cookieRotator.status[cookieKey].state = 'invalid';
                converter.cookieRotator.status[cookieKey].failCount = (converter.cookieRotator.status[cookieKey].failCount || 0) + 1;
                converter.cookieRotator.status[cookieKey].lastFailure = new Date().toISOString();
                converter.cookieRotator.status[cookieKey].reason = err.message;
                converter.cookieRotator.status[cookieKey].alertActive = true;
                converter.cookieRotator.saveStatus();
            }
            invalidList.push({ file, error: err.message });
        }
    }

    // Se houver algum cookie inválido, envia um e-mail de resumo imediatamente
    if (anyInvalid) {
        console.log('📧 Enviando alerta de inicialização com cookies inválidos...');
        if (emailAlerts) {
            const invalidOnes = Object.entries(converter.cookieRotator.status)
                .filter(([, v]) => v.state !== 'valid')
                .map(([name, v]) => [name, v]);
            if (invalidOnes.length > 0) {
                emailAlerts.sendCookieFailureSummaryAlert(invalidOnes);
            }
        }
    } else {
        console.log('✅ Todos os cookies válidos na inicialização.');
    }

    // 🔥 INICIAR A VERIFICAÇÃO PERIÓDICA APENAS AGORA, DEPOIS DA VALIDAÇÃO
    if (emailAlerts && emailAlerts.checkCookiesHealthAlert) {
        setTimeout(() => {
            console.log('🔄 Iniciando verificação periódica de cookies após validação...');
            emailAlerts.checkCookiesHealthAlert();
        }, 1000);
    }
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

app.listen(PORT, () => {
    console.log('========================================');
    console.log('NeoNews Live Converter V3 - SSOT + GlobalScheduler + Tokens');
    console.log('========================================');
    console.log(`Conversor público: http://localhost:${PORT}/converter.html`);
    console.log(`Dashboard protegido: http://localhost:${PORT}/dashboard`);
    console.log(`API Health: http://localhost:${PORT}/health`);
    console.log(`Métricas: http://localhost:${PORT}/metrics`);
    console.log(`Timeout de dispositivos: ${VIEWER_WINDOW_MS}ms (${VIEWER_WINDOW_MS / 3600000}h)`);
    console.log('========================================\n');
});