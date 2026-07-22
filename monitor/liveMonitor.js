// monitor/liveMonitor.js - Versão com ABR (master artificial) e suporte a maxHeight por requisição
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const CookieRotator = require('../cookieRotator');
const {
    CLASSIFICATION,
    classifyYtdlpError,
    isCookieAuthClassification,
    getYtdlpDiagnostics,
    buildYtdlpArgsForSource,
    buildYtdlpDumpJsonArgs,
    selectHlsStream,
    safeUrlPreview,
    sanitizeYtdlpMessage,
    shouldAttemptPublicFallback,
    isGlobalExtractionOutagePattern,
    isPotentialHlsFormat
} = require('../services/ytdlpStreamSelector');
const {
    DEFAULT_COOKIE_FILES,
    buildCookieAttemptOrder,
    resolveCookiePath,
    applyExtractionFailure,
    resetExtractionBackoff,
    getBackoffDelayMs,
    shouldApplyExtractionBackoff,
    shouldLogBackoffSuppression,
    createExtractionBackoffState
} = require('../services/extractionRetryPolicy');

// ============================================================
// ✅ AGENTES HTTP COM KEEPALIVE E MAX SOCKETS ALTO
// ============================================================
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
// ✅ COMPARTILHADO ENTRE INSTÂNCIAS (single-flight + backoff)
// ============================================================
const _metadataFlights = new Map();
const _metadataBackoffs = new Map();
const _BACKOFF_DELAYS = [60000, 120000, 300000, 600000, 900000];
const PUBLIC_TRANSIENT = 'public_transient_rate_limit';

function _isRateLimitedMsg(msg) {
    const m = (msg || '').toLowerCase();
    return m.includes("we're experiencing technical difficulties") || m.includes('technical difficulties');
}

function _calcBackoffMs(failCount) {
    const idx = Math.min(Math.max(0, failCount - 1), _BACKOFF_DELAYS.length - 1);
    const base = _BACKOFF_DELAYS[idx];
    const jitter = 1 + (Math.random() * 0.2 - 0.1);
    return Math.round(base * jitter);
}

function _openBackoff(videoId, reason, failCount) {
    const ms = _calcBackoffMs(failCount);
    _metadataBackoffs.set(videoId, {
        failureCount: failCount,
        reason,
        backoffUntil: Date.now() + ms,
        delayMs: ms,
        openedAt: Date.now(),
        _lastLogAt: 0
    });
}

function _closeBackoff(videoId) {
    _metadataBackoffs.delete(videoId);
}

function _backoffRemainingMs(videoId) {
    const s = _metadataBackoffs.get(videoId);
    if (!s) return 0;
    const r = s.backoffUntil - Date.now();
    return r > 0 ? r : 0;
}

function _logBackoffOnce(videoId) {
    const s = _metadataBackoffs.get(videoId);
    if (!s) return false;
    const now = Date.now();
    if (now - s._lastLogAt >= 30000) {
        s._lastLogAt = now;
        return true;
    }
    return false;
}

// ============================================================

let systemState = null;
try { systemState = require('../systemState'); } catch(e) {}

// ========== CONSTANTES GLOBAIS ==========
const YTDLP_TIMEOUT = 180000; // 3 minutos (ajustado)
const METADATA_TTL = 15000;
const LIVE_STALL_TIME = 60000;
const PUBLIC_COOKIE_RECHECK_INTERVAL_MS = Math.max(
    60000,
    (parseInt(process.env.YTDLP_PUBLIC_COOKIE_RECHECK_MINUTES, 10) || 15) * 60 * 1000
);

const LiveState = {
    ONLINE: 'online',
    DEGRADED: 'degraded',
    OFFLINE: 'offline',
    ENDED: 'ended'
};

const ComponentStatus = {
    OK: 'ok',
    WARNING: 'warning',
    ERROR: 'error',
    CRITICAL: 'critical'
};

const TERMINAL_LIVE_CLASSIFICATIONS = new Set([
    CLASSIFICATION.LIVE_ENDED,
    CLASSIFICATION.VIDEO_UNAVAILABLE,
    CLASSIFICATION.VIDEO_REMOVED
]);

class LiveMonitor {
    constructor(youtubeUrl, emailAlerts, activeMonitorsMap = null, scheduler = null, cookieRotator = null, onEnd = null, onGlobalExtractionOutage = null) {
        this.youtubeUrl = youtubeUrl;
        this.emailAlerts = emailAlerts;
        this.videoId = this.extractVideoId(youtubeUrl);
        this.m3u8Url = null;
        this.isLive = false;
        this.intervalMs = 8000;
        this.maxStallTimeMs = LIVE_STALL_TIME;
        
        this._activeMonitors = activeMonitorsMap;
        this._scheduler = scheduler;
        this._cookieRotator = cookieRotator;
        this._onEnd = onEnd;
        this._onGlobalExtractionOutage = onGlobalExtractionOutage;
        
        this.metadataFails = 0;
        this.segmentFails = 0;
        this.urlFails = 0;
        this.networkFailCount = 0;
        this.consecutiveUnknownFails = 0;
        this.maxFails = 5;
        this.maxNetworkWarnings = 3;
        this.maxNetworkErrors = 10;
        this.maxUnknownFails = 10;
        
        this.cookiesDir = path.join(__dirname, '../cookies');
        this.lastSuccessTime = null;
        this.lastError = null;
        this.liveState = LiveState.ONLINE;
        
        this._criticalSent = false;
        this._failoverSent = false;
        this._backupExpiredSent = false;
        this._recoverySent = false;
        this._mainMissingSent = false;
        this._mainRestoredSent = false;
        
        this.lastMediaSequence = null;
        this.stalledCount = 0;
        this.maxSegmentRepeats = this.calculateMaxRepeats();
        
        this.health = {
            network: { status: ComponentStatus.OK, lastCheck: null, message: '', failCount: 0 },
            metadata: { status: ComponentStatus.OK, lastCheck: null, message: '', failCount: 0 },
            playlist: { status: ComponentStatus.OK, lastCheck: null, message: '', failCount: 0 },
            cookies: { status: ComponentStatus.OK, lastCheck: null, message: '', failCount: 0 }
        };
        
        this._monitorStopped = false;
        this._liveEnded = false;
        this._liveEndedAt = null;
        this._stableCycles = 0;
        this._currentIntervalMs = this.intervalMs;
        
        this._cachedMetadata = null;
        this._metadataCacheTime = 0;
        this._metadataTTL = METADATA_TTL;
        
        if (!this._cookieRotator) {
            this._cookieRotator = new CookieRotator(this.cookiesDir);
        }
        
        this.needsRefresh = false;
        this.refreshPromise = null;
        this.lastRefreshReq = null;
        this._liveEndedFirstDetection = null;
        this.lastRefreshFailedAt = 0;
        
        this._playlistUrls = {};
        this._masterContent = null;
        this.lastExtractionFailureClassification = null;
        this.lastExtractionDiagnostics = null;
        this.extractionBackoff = createExtractionBackoffState();
        this.consecutiveExtractionFailures = 0;
        this.lastExtractionFailureAt = null;
        this.lastFailureClassification = null;
        this.nextRetryAt = 0;
        this.backoffSeconds = 0;
        this.lastSuccessfulCookie = null;
        this.lastSuccessfulExtractionSource = null;
        this._lastMetadataExtractionSource = null;
        this.lastExtractionSuccessAt = null;
        this.lastPublicCookieRecheckAt = 0;

        this._lastBackoffJoinLogAt = 0;
    }

    extractVideoId(url) {
        const match = url.match(/(?:v=|\/)([0-9A-Za-z_-]{11})(?:[?&]|$)/);
        return match ? match[1] : 'url_invalida';
    }

    calculateMaxRepeats() {
        return Math.max(6, Math.ceil(this.maxStallTimeMs / this.intervalMs));
    }

    getCookiePath() {
        const cookiePath = this._cookieRotator.getNextCookiePath();
        if (cookiePath) return cookiePath;
        return this._cookieRotator.getFallbackCookiePath();
    }

    _isCookieAuthError(errorMsg) {
        return !!(this._cookieRotator &&
            this._cookieRotator.isCookieAuthError &&
            this._cookieRotator.isCookieAuthError(errorMsg));
    }

    _syncExtractionBackoffFields() {
        this.consecutiveExtractionFailures = this.extractionBackoff.consecutiveExtractionFailures;
        this.lastExtractionFailureAt = this.extractionBackoff.lastExtractionFailureAt;
        this.lastFailureClassification = this.extractionBackoff.lastFailureClassification;
        this.nextRetryAt = this.extractionBackoff.nextRetryAt;
        this.backoffSeconds = this.extractionBackoff.backoffSeconds;
        this.lastSuccessfulCookie = this.extractionBackoff.lastSuccessfulCookie;
        this.lastSuccessfulExtractionSource = this.extractionBackoff.lastSuccessfulExtractionSource;
        this.lastExtractionSuccessAt = this.extractionBackoff.lastExtractionSuccessAt;
    }

    _recordExtractionFailure(classification) {
        if (TERMINAL_LIVE_CLASSIFICATIONS.has(classification)) {
            this._syncExtractionBackoffFields();
            return;
        }
        if (!shouldApplyExtractionBackoff(classification)) {
            this._syncExtractionBackoffFields();
            return;
        }
        applyExtractionFailure(this.extractionBackoff, classification || CLASSIFICATION.UNKNOWN, Date.now(), {
            terminalBackoffSeconds: 120
        });
        this._syncExtractionBackoffFields();
        const retryIso = this.nextRetryAt ? new Date(this.nextRetryAt).toISOString() : 'n/a';
        console.log(`[${this.videoId}] extracao falhou [${this.lastFailureClassification}] falhasConsecutivas=${this.consecutiveExtractionFailures} backoff=${this.backoffSeconds}s proximoRetry=${retryIso}`);
    }

    _recordExtractionSuccess(cookieName, source = null) {
        const now = Date.now();
        const recovered = resetExtractionBackoff(this.extractionBackoff, cookieName, now, source);
        if (source === 'public') {
            this.lastPublicCookieRecheckAt = now;
        }
        this._syncExtractionBackoffFields();
        if (recovered) {
            console.log(`[${this.videoId}] extracao recuperada com ${this.lastSuccessfulExtractionSource || this.lastSuccessfulCookie || 'origem desconhecida'}`);
        }
    }

    getExtractionBackoffDelayMs(now = Date.now()) {
        return getBackoffDelayMs(this.extractionBackoff, now);
    }

    logExtractionBackoffSuppressed(now = Date.now()) {
        if (!shouldLogBackoffSuppression(this.extractionBackoff, now)) return false;
        const retrySeconds = Math.ceil(getBackoffDelayMs(this.extractionBackoff, now) / 1000);
        console.log(`[${this.videoId}] em backoff; proxima tentativa em ${retrySeconds}s`);
        return true;
    }

    isExtractionBackoffActive(now = Date.now()) {
        return this.getExtractionBackoffDelayMs(now) > 0;
    }

    _runYtdlp(args, timeout = YTDLP_TIMEOUT) {
        return new Promise(async (resolve, reject) => {
            const filteredArgs = args.filter((arg, index) => {
                if (arg === '-f' || arg === '--format') return false;
                if (index > 0 && (args[index-1] === '-f' || args[index-1] === '--format')) return false;
                return true;
            });

            let finalArgs = buildYtdlpArgsForSource(filteredArgs, { source: 'public' });
            let cookieIndex = filteredArgs.indexOf('--cookies');
            let selectedCookiePath = null;
            if (cookieIndex !== -1 && filteredArgs.length > cookieIndex + 1) {
                selectedCookiePath = filteredArgs[cookieIndex + 1];
            }

            if (!selectedCookiePath) {
                const defaultCookie = path.join(this.cookiesDir, 'cookie1.txt');
                if (fs.existsSync(defaultCookie)) {
                    selectedCookiePath = defaultCookie;
                }
            }

            const cookieAttemptOrder = buildCookieAttemptOrder({
                lastSuccessfulCookie: this.lastSuccessfulCookie,
                selectedCookiePath,
                cookieFiles: DEFAULT_COOKIE_FILES,
                cookieExists: cookieName => {
                    const cookiePath = resolveCookiePath(this.cookiesDir, cookieName);
                    return Boolean(cookiePath && fs.existsSync(cookiePath));
                }
            });

            const ytCmd = process.platform === 'win32' ? '.\\yt-dlp.exe' : 'yt-dlp';
            let cookieFailureAlreadyHandled = false;

            const execWithCookie = (cookieName) => {
                return new Promise((resolveExec, rejectExec) => {
                    const cookiePath = resolveCookiePath(this.cookiesDir, cookieName);
                    const argsWithCookie = buildYtdlpArgsForSource(finalArgs, {
                        source: cookiePath ? 'cookie' : 'public',
                        cookiePath
                    });

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
                            rejectExec(new Error(errorMsg));
                        }
                    });
                    child.on('error', (err) => {
                        clearTimeout(timeoutId);
                        if (killTimeoutId) clearTimeout(killTimeoutId);
                        rejectExec(err);
                    });
                });
            };

            const attempts = cookieAttemptOrder;
            const failures = [];
            let publicFallbackFailure = null;
            let publicAttempted = false;
            const publicWasLastSuccess = this.lastSuccessfulExtractionSource === 'public' ||
                this.extractionBackoff.lastSuccessfulExtractionSource === 'public';
            const publicCookieRecheckDue = !this.lastPublicCookieRecheckAt ||
                (Date.now() - this.lastPublicCookieRecheckAt) >= PUBLIC_COOKIE_RECHECK_INTERVAL_MS;
            console.log(`[${this.videoId}] ordem de cookies da rodada: ${attempts.join(' -> ') || 'sem cookies'}`);

            try {
                if (publicWasLastSuccess && !publicCookieRecheckDue) {
                    publicAttempted = true;
                    try {
                        console.log(`[${this.videoId}] ultima origem public; tentando public antes dos cookies.`);
                        const result = await execWithCookie(null);
                        this.lastSuccessfulExtractionSource = 'public';
                        this._lastMetadataExtractionSource = 'public';
                        this.extractionBackoff.lastSuccessfulExtractionSource = 'public';
                        this._syncExtractionBackoffFields();
                        resolve(result.stdout);
                        return;
                    } catch (publicErr) {
                        const errorMsg = publicErr.message || '';
                        const classification = publicErr.classification || classifyYtdlpError(errorMsg);
                        publicFallbackFailure = {
                            file: 'public',
                            error: sanitizeYtdlpMessage(errorMsg),
                            classification
                        };
                        console.log(`[${this.videoId}] public falhou: ${classification} - ${publicFallbackFailure.error}; tentando cookies nesta rodada.`);
                    }
                } else if (publicWasLastSuccess && publicCookieRecheckDue) {
                    console.log(`[${this.videoId}] rechecagem periodica dos cookies apos sucesso public.`);
                }

                for (const cookieName of attempts) {
                    try {
                        const result = await execWithCookie(cookieName);
                        if (this._cookieRotator && cookieName) {
                            this._cookieRotator.markSuccess(cookieName);
                        }
                        if (cookieName) {
                            this.lastSuccessfulCookie = cookieName;
                            this.lastSuccessfulExtractionSource = cookieName.replace(/\.txt$/i, '');
                            this._lastMetadataExtractionSource = this.lastSuccessfulExtractionSource;
                            this.extractionBackoff.lastSuccessfulCookie = cookieName;
                            this.extractionBackoff.lastSuccessfulExtractionSource = this.lastSuccessfulExtractionSource;
                            this._syncExtractionBackoffFields();
                        }
                        resolve(result.stdout);
                        return;
                    } catch (err) {
                        const errorMsg = err.message || '';
                        const classification = classifyYtdlpError(errorMsg);
                        const isCookieAuth = isCookieAuthClassification(classification) || this._isCookieAuthError(errorMsg);
                        failures.push({ file: cookieName, error: sanitizeYtdlpMessage(errorMsg), classification });

                        if (isCookieAuth && this._cookieRotator && cookieName) {
                            console.log(`🔴 Marcando falha para ${cookieName}: ${sanitizeYtdlpMessage(errorMsg).slice(0, 100)}`);
                            cookieFailureAlreadyHandled = this._cookieRotator.markFailure(cookieName, errorMsg, this.videoId) ||
                                cookieFailureAlreadyHandled;
                        }

                        console.log(`${cookieName || 'sem cookie'} falhou: ${classification} - ${sanitizeYtdlpMessage(errorMsg)}`);
                        continue;
                    }
                }

                if (!publicAttempted && shouldAttemptPublicFallback(failures)) {
                    publicAttempted = true;
                    try {
                        console.log(`[${this.videoId}] ordem de extracao final: ${attempts.join(' -> ') || 'sem cookies'} -> public`);
                        console.log(`[${this.videoId}] tentando extracao publica sem cookie...`);
                        const result = await execWithCookie(null);
                        this.lastSuccessfulExtractionSource = 'public';
                        this._lastMetadataExtractionSource = 'public';
                        this.extractionBackoff.lastSuccessfulExtractionSource = 'public';
                        this._syncExtractionBackoffFields();
                        resolve(result.stdout);
                        return;
                    } catch (publicErr) {
                        const errorMsg = publicErr.message || '';
                        const classification = publicErr.classification || classifyYtdlpError(errorMsg);
                        publicFallbackFailure = {
                            file: 'public',
                            error: sanitizeYtdlpMessage(errorMsg),
                            classification
                        };
                        console.log(`[${this.videoId}] public falhou: ${classification} - ${publicFallbackFailure.error}`);
                    }
                }

                const allFailures = publicFallbackFailure ? failures.concat(publicFallbackFailure) : failures;
                const onlyCookieAuthFailures = failures.length > 0 &&
                    failures.every(({ classification }) => isCookieAuthClassification(classification));
                const globalExtractionOutage = failures.length >= attempts.length &&
                    isGlobalExtractionOutagePattern(failures, publicFallbackFailure);
                const publicRestrictedClassification = !globalExtractionOutage && publicFallbackFailure &&
                    !shouldAttemptPublicFallback([publicFallbackFailure])
                    ? publicFallbackFailure.classification
                    : null;
                const primaryClassification = allFailures.find(({ classification }) =>
                    !isCookieAuthClassification(classification)
                )?.classification || failures[0]?.classification || CLASSIFICATION.UNKNOWN;
                const finalClassification = globalExtractionOutage ? CLASSIFICATION.NO_FORMATS : publicRestrictedClassification ||
                    (onlyCookieAuthFailures ? CLASSIFICATION.AUTH_COOKIE : primaryClassification);
                const finalError = new Error(publicFallbackFailure
                    ? `Todos os cookies e fallback publico falharam: ${finalClassification}`
                    : `Todos os cookies falharam: ${finalClassification}`);
                finalError.classification = finalClassification;
                finalError.globalExtractionOutage = globalExtractionOutage;
                if (cookieFailureAlreadyHandled) {
                    finalError.cookieFailureAlreadyHandled = true;
                }
                reject(finalError);
            } catch (err) {
                reject(err);
            }
        });
    }

    async getLiveMetadata(force = false) {
        const agora = Date.now();
        const videoId = this.videoId;

        // 1) Check transient backoff
        const backoffMs = _backoffRemainingMs(videoId);
        if (backoffMs > 0) {
            if (_logBackoffOnce(videoId)) {
                console.log(`[${videoId}] metadata-backoff skip videoId=${videoId} reason=${_metadataBackoffs.get(videoId).reason} retryInMs=${backoffMs}`);
            }
            return {
                success: false,
                error: `metadata_backoff: ${_metadataBackoffs.get(videoId).reason}`,
                errorType: 'metadata_backoff',
                classification: PUBLIC_TRANSIENT,
                skipped: true,
                retryAt: _metadataBackoffs.get(videoId).backoffUntil
            };
        }

        // 2) Check metadata cache
        if (!force && this._cachedMetadata && (agora - this._metadataCacheTime) < this._metadataTTL) {
            console.log(`[${this.videoId}] 📦 Usando cache de metadados (${((agora - this._metadataCacheTime)/1000).toFixed(1)}s)`);
            return { success: true, metadata: this._cachedMetadata };
        }

        // 3) Single-flight: join existing extraction for same videoId
        const existingFlight = _metadataFlights.get(videoId);
        if (existingFlight) {
            const now = Date.now();
            if (now - this._lastBackoffJoinLogAt >= 30000) {
                this._lastBackoffJoinLogAt = now;
                console.log(`[${videoId}] metadata-singleflight join videoId=${videoId}`);
            }
            try {
                const result = await existingFlight;
                return result;
            } catch (err) {
                throw err;
            }
        }

        // 4) Create new single-flight extraction
        const flightPromise = (async () => {
            this._lastMetadataExtractionSource = null;
            let cookiePath = null;
            try {
                cookiePath = this.getCookiePath();
                const args = buildYtdlpDumpJsonArgs({
                    url: this.youtubeUrl,
                    source: cookiePath ? 'cookie' : 'public',
                    cookiePath
                });
                const stdout = await this._runYtdlp(args, YTDLP_TIMEOUT);
                const metadata = JSON.parse(stdout);
                const diagnostics = getYtdlpDiagnostics(metadata);
                this.lastExtractionDiagnostics = diagnostics;
                console.log(`[${this.videoId}] 📊 yt-dlp JSON: formats=${diagnostics.formatCount}, protocols=${diagnostics.protocols.join('|') || 'nenhum'}, requested=${diagnostics.requestedFormatsCount}, live=${diagnostics.liveStatus || 'n/a'}`);
                this._cachedMetadata = metadata;
                this._metadataCacheTime = agora;
                this.updateHealthComponent('metadata', ComponentStatus.OK, 'Metadados obtidos com sucesso');
                this.metadataFails = 0;
                if (this.lastSuccessfulCookie) this.updateHealthComponent('cookies', ComponentStatus.OK, 'Cookie funcionando');

                // Reset transient backoff on success
                if (_backoffRemainingMs(videoId) > 0) {
                    _closeBackoff(videoId);
                    console.log(`[${videoId}] metadata-backoff reset videoId=${videoId}`);
                }

                return { success: true, metadata };
            } catch (error) {
                const safeErrorMessage = sanitizeYtdlpMessage(error.message);
                console.error(`[${this.videoId}] ❌ Erro spawn: ${safeErrorMessage}`);
                const errorMsg = error.message.toLowerCase();
                const classification = error.classification || classifyYtdlpError(error.message);
                const isLiveEnded = errorMsg.includes('video unavailable') ||
                                   errorMsg.includes('not available') ||
                                   errorMsg.includes('recording is not available') ||
                                   errorMsg.includes('this live event has ended') ||
                                   TERMINAL_LIVE_CLASSIFICATIONS.has(classification);

                // Handle transient rate limit — open circuit breaker instead of counting failure
                if (_isRateLimitedMsg(errorMsg) || classification === CLASSIFICATION.RATE_LIMIT) {
                    const currentState = _metadataBackoffs.get(videoId);
                    const failCount = (currentState ? currentState.failureCount : 0) + 1;
                    _openBackoff(videoId, PUBLIC_TRANSIENT, failCount);
                    console.log(`[${videoId}] metadata-backoff open videoId=${videoId} reason=${PUBLIC_TRANSIENT} delayMs=${_metadataBackoffs.get(videoId).delayMs}`);
                    this.updateHealthComponent('metadata', ComponentStatus.WARNING, `Rate limit: ${safeErrorMessage}`);
                    return {
                        success: false,
                        error: safeErrorMessage,
                        errorType: PUBLIC_TRANSIENT,
                        classification: PUBLIC_TRANSIENT,
                        skipped: true,
                        retryAt: _metadataBackoffs.get(videoId).backoffUntil
                    };
                }

                if (isLiveEnded) {
                    this._recordExtractionFailure(classification);
                    this.updateHealthComponent('metadata', ComponentStatus.CRITICAL, 'Live encerrada');
                    return { success: false, error: safeErrorMessage, errorType: 'live_ended', isLiveEnded, classification };
                }

                this._recordExtractionFailure(classification);
                if (error.globalExtractionOutage && typeof this._onGlobalExtractionOutage === 'function') {
                    try {
                        this._onGlobalExtractionOutage(this.videoId, classification);
                    } catch (callbackError) {
                        console.warn(`[${this.videoId}] falha ao registrar pane global de extracao: ${callbackError.message}`);
                    }
                }

                if (isCookieAuthClassification(classification) || this._isCookieAuthError(error.message)) {
                    if (this._cookieRotator && cookiePath) {
                        const cookieName = path.basename(cookiePath);
                        if (!error.cookieFailureAlreadyHandled) {
                            this._cookieRotator.markFailure(cookieName, error.message, this.videoId);
                        }
                    }
                    this.updateHealthComponent('cookies', ComponentStatus.ERROR, 'Cookie inválido');
                    this.updateHealthComponent('metadata', ComponentStatus.WARNING, 'Erro de autenticação');
                } else if (classification === CLASSIFICATION.TIMEOUT) {
                    this.updateHealthComponent('metadata', ComponentStatus.WARNING, 'Timeout');
                } else {
                    this.updateHealthComponent('metadata', ComponentStatus.WARNING, `Erro ${classification}: ${safeErrorMessage}`);
                }

                this.metadataFails++;
                return { success: false, error: safeErrorMessage, errorType: classification, classification, isLiveEnded };
            }
        })();

        _metadataFlights.set(videoId, flightPromise);
        try {
            return await flightPromise;
        } finally {
            _metadataFlights.delete(videoId);
        }
    }

    validateMetadata(metadata) {
        const liveStatus = metadata.live_status;
        const wasLive = metadata.was_live === true;
        const isLive = metadata.is_live === true;
        console.log(`[${this.videoId}] 📊 Status:`, { live_status: liveStatus, is_live: isLive, was_live: wasLive, availability: metadata.availability });
        if (liveStatus === 'was_live' || liveStatus === 'post_live' || liveStatus === 'not_live') {
            this.updateHealthComponent('metadata', ComponentStatus.CRITICAL, `Live encerrada: ${liveStatus}`);
            return false;
        }
        if (wasLive && !isLive) {
            this.updateHealthComponent('metadata', ComponentStatus.CRITICAL, 'Live encerrada: was_live=true, is_live=false');
            return false;
        }
        if (liveStatus === 'is_live' || isLive) {
            this.updateHealthComponent('metadata', ComponentStatus.OK, `Live ativa: ${liveStatus}`);
            return true;
        }
        this.updateHealthComponent('metadata', ComponentStatus.WARNING, `Status desconhecido: ${liveStatus}`);
        this.consecutiveUnknownFails++;
        if (this.consecutiveUnknownFails >= this.maxUnknownFails) {
            this.updateHealthComponent('metadata', ComponentStatus.ERROR, `${this.consecutiveUnknownFails} status desconhecidos consecutivos`);
        }
        return null;
    }

    extractHlsUrl(metadata, maxHeight = null) {
        const effectiveMax = maxHeight !== null ? maxHeight : parseInt(process.env.VIDEO_MAX_HEIGHT, 10) || 1080;
        const selection = selectHlsStream(metadata, {
            maxHeight: effectiveMax,
            forceArtificial: true
        });

        this.lastExtractionDiagnostics = selection.diagnostics;
        if (!selection.ok) {
            this._masterContent = null;
            this._playlistUrls = {};
            this.lastExtractionFailureClassification = selection.classification;
            console.log(`[${this.videoId}] ⚠️ HLS não selecionado: ${selection.classification} | diagnostics=${JSON.stringify(selection.diagnostics)}`);
            return null;
        }

        this.lastExtractionFailureClassification = null;
        this._playlistUrls = selection.playlistUrls || {};
        if (selection.masterContent) {
            this._masterContent = {
                isMaster: true,
                content: selection.masterContent,
                urls: Object.values(this._playlistUrls)
            };
            console.log(`[${this.videoId}] 🛠️ Manifesto master artificial (${selection.type}) selecionado; height=${selection.selectedHeight || 'n/a'}; url=${selection.urlPreview}`);
        } else {
            this._masterContent = null;
            this._populatePlaylistUrls(metadata.formats);
            console.log(`[${this.videoId}] 📺 Stream HLS selecionada (${selection.type}); height=${selection.selectedHeight || 'n/a'}; url=${selection.urlPreview}`);
        }

        return selection.url;
    }

    _populatePlaylistUrls(formats) {
        const playlistUrls = {};
        (formats || []).forEach(f => {
            if (f.url && isPotentialHlsFormat(f) && f.height) {
                const height = f.height || 360;
                playlistUrls[height] = f.url;
            }
        });
        this._playlistUrls = playlistUrls;
    }

    async extractMediaSequence(m3u8Url) {
        if (!m3u8Url) return null;
        return new Promise((resolve) => {
            let resolved = false;
            let timeoutId = null;
            const finish = (v) => { if(resolved) return; resolved=true; if(timeoutId) clearTimeout(timeoutId); resolve(v); };
            const urlObj = new URL(m3u8Url);
            const protocol = urlObj.protocol === 'https:' ? https : http;
            const request = protocol.get(m3u8Url, {
                agent: urlObj.protocol === 'https:' ? httpsAgent : httpAgent
            }, (res) => {
                if(res.statusCode !== 200) { finish(null); return; }
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    const seqMatch = data.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/);
                    if(seqMatch) finish(parseInt(seqMatch[1]));
                    else {
                        const lines = data.split('\n');
                        let lastTs = null;
                        for(let i=lines.length-1;i>=0;i--) {
                            const line = lines[i].trim();
                            if(line && !line.startsWith('#') && (line.endsWith('.ts') || line.includes('.ts?'))) { lastTs = line; break; }
                        }
                        finish(lastTs);
                    }
                });
            });
            timeoutId = setTimeout(() => { request.destroy(); finish(null); }, 10000);
            request.on('error', () => finish(null));
        });
    }

    async checkPlaylistProgress(m3u8Url) {
        if (!m3u8Url) {
            this.updateHealthComponent('playlist', ComponentStatus.ERROR, 'URL vazia');
            return false;
        }
        const currentSequence = await this.extractMediaSequence(m3u8Url);
        if (currentSequence === null) {
            this.stalledCount = 0;
            this.updateHealthComponent('playlist', ComponentStatus.ERROR, 'Não foi possível obter sequência');
            return false;
        }
        if (this.lastMediaSequence === null) {
            this.lastMediaSequence = currentSequence;
            this.updateHealthComponent('playlist', ComponentStatus.OK, `Primeira sequência: ${currentSequence}`);
            return true;
        }
        if (typeof currentSequence === 'number' && typeof this.lastMediaSequence === 'number') {
            if (currentSequence > this.lastMediaSequence) {
                this.stalledCount = 0;
                this.lastMediaSequence = currentSequence;
                this.updateHealthComponent('playlist', ComponentStatus.OK, `Avançou: ${currentSequence}`);
                return true;
            } else if (currentSequence === this.lastMediaSequence) {
                if (currentSequence === 0) {
                    console.log(`[${this.videoId}] ℹ️ MEDIA-SEQUENCE = 0 (playlist master) – ignorando, mantendo status OK`);
                    return true;
                }
                this.stalledCount++;
                console.log(`[${this.videoId}] 📊 Media sequence parado: ${currentSequence} (${this.stalledCount}/${this.maxSegmentRepeats})`);
                if (this.stalledCount >= this.maxSegmentRepeats) {
                    this.updateHealthComponent('playlist', ComponentStatus.CRITICAL, `Stream congelado após ${this.stalledCount} verificações`);
                    return false;
                }
                this.updateHealthComponent('playlist', ComponentStatus.WARNING, `Sequence parado (${this.stalledCount}/${this.maxSegmentRepeats})`);
                return true;
            }
        }
        if (currentSequence === this.lastMediaSequence) {
            if (currentSequence === 0) return true;
            this.stalledCount++;
            if (this.stalledCount >= this.maxSegmentRepeats) {
                this.updateHealthComponent('playlist', ComponentStatus.CRITICAL, 'Segmentos congelados');
                return false;
            }
            return true;
        } else {
            this.stalledCount = 0;
            this.lastMediaSequence = currentSequence;
            return true;
        }
    }

    updateHealthComponent(component, status, message='') {
        if(this.health[component]) {
            const old = this.health[component].status;
            this.health[component] = { status, lastCheck: new Date(), message, failCount: status===ComponentStatus.OK?0:(this.health[component].failCount||0)+1 };
            if(old !== status) console.log(`[${this.videoId}] 🔄 Health[${component}]: ${old} → ${status} (${message})`);
        }
    }

    updateNetworkHealth(isSuccess) {
        if(isSuccess) { if(this.networkFailCount>0) console.log(`[${this.videoId}] 🌐 Rede recuperada`); this.networkFailCount=0; this.updateHealthComponent('network',ComponentStatus.OK,'Conectividade normal'); return; }
        this.networkFailCount++;
        if(this.networkFailCount >= this.maxNetworkErrors) this.updateHealthComponent('network',ComponentStatus.ERROR,`${this.networkFailCount} falhas`);
        else if(this.networkFailCount >= this.maxNetworkWarnings) this.updateHealthComponent('network',ComponentStatus.WARNING,`${this.networkFailCount} falhas`);
        else this.updateHealthComponent('network',ComponentStatus.OK,`${this.networkFailCount} falhas, ainda tolerável`);
    }

    deriveLiveState() {
        const n = this.health.network.status, m = this.health.metadata.status, p = this.health.playlist.status;
        if(m === ComponentStatus.CRITICAL) return LiveState.ENDED;
        if(p === ComponentStatus.CRITICAL) return LiveState.DEGRADED;
        if(n === ComponentStatus.ERROR || m === ComponentStatus.ERROR || p === ComponentStatus.ERROR) return LiveState.OFFLINE;
        if(n === ComponentStatus.WARNING || m === ComponentStatus.WARNING || p === ComponentStatus.WARNING) return LiveState.DEGRADED;
        return LiveState.ONLINE;
    }

    applyDerivedState() {
        const newState = this.deriveLiveState();
        if(this.liveState !== newState) {
            console.log(`[${this.videoId}] 🔄 Estado alterado: ${this.liveState} → ${newState}`);
            this.liveState = newState;
            if(newState === LiveState.ENDED) {
                console.log(`[${this.videoId}] 🛑 Live encerrada, parando monitor`);
                this._liveEnded = true;
                this._liveEndedAt = Date.now();
            }
        }
        this.isLive = this.liveState === LiveState.ONLINE;
        return newState;
    }

    static REFRESH_RETRY_BACKOFF_MS = 1500;

    async requestRefresh() {
        if (this.refreshPromise) return this.refreshPromise;

        const sinceLastFailure = Date.now() - (this.lastRefreshFailedAt || 0);
        if (this.lastRefreshFailedAt && sinceLastFailure < LiveMonitor.REFRESH_RETRY_BACKOFF_MS) {
            const waitMs = LiveMonitor.REFRESH_RETRY_BACKOFF_MS - sinceLastFailure;
            console.log(`[${this.videoId}] ⏳ Renovação falhou há pouco, aguardando ${waitMs}ms antes de tentar de novo...`);
            await new Promise(resolve => setTimeout(resolve, waitMs));
        }

        this.lastRefreshReq = Date.now();
        this.refreshPromise = this._forceRenew().finally(() => {
            this.refreshPromise = null;
            this.needsRefresh = false;
        });
        return this.refreshPromise;
    }

    async _forceRenew(bypassBackoff = false) {
        if (!bypassBackoff && this.isExtractionBackoffActive()) {
            this.logExtractionBackoffSuppressed();
            return false;
        }
        console.log(`[${this.videoId}] 🔄 Forçando renovação da URL HLS...`);
        try {
            const metadataResult = await this.getLiveMetadata(true);
            if (!metadataResult.success) {
                if (metadataResult.skipped) {
                    console.log(`[${this.videoId}] ⏳ Renovação adiada: ${metadataResult.error}`);
                    return false;
                }
                const metadataError = new Error(metadataResult.error);
                metadataError.classification = metadataResult.classification || metadataResult.errorType;
                metadataError.extractionFailureAlreadyRecorded = true;
                throw metadataError;
            }
            const newUrl = this.extractHlsUrl(metadataResult.metadata, null);
            if (!newUrl) {
                const selectionError = new Error('Nova URL não encontrada');
                selectionError.classification = this.lastExtractionFailureClassification || CLASSIFICATION.INVALID_HLS;
                throw selectionError;
            }
            this._recordExtractionSuccess(this.lastSuccessfulCookie, this._lastMetadataExtractionSource || this.lastSuccessfulExtractionSource);
            if (newUrl !== this.m3u8Url) {
                this.m3u8Url = newUrl;
                console.log(`[${this.videoId}] ✅ URL HLS forçada: ${safeUrlPreview(newUrl)}`);
            }
            this.lastRefreshFailedAt = 0;
            return true;
        } catch (err) {
            console.error(`[${this.videoId}] ❌ Falha na renovação forçada:`, sanitizeYtdlpMessage(err.message));
            if (!err.extractionFailureAlreadyRecorded) {
                this._recordExtractionFailure(err.classification || classifyYtdlpError(err.message));
            }
            this.lastRefreshFailedAt = Date.now();
            return false;
        }
    }

    _isUrlNearExpiry(url) {
        if (!url) return true;
        const match = url.match(/expire=(\d+)/);
        if (!match) return false;
        const expireTimestamp = parseInt(match[1]) * 1000;
        const tenMinutes = 10 * 60 * 1000;
        return (expireTimestamp - Date.now()) < tenMinutes;
    }

    async checkAndRenew() {
        if (this._monitorStopped || this._liveEnded) return;

        // Check existing instance-level extraction backoff
        if (this.isExtractionBackoffActive()) {
            this.logExtractionBackoffSuppressed();
            return;
        }

        // Check shared transient backoff (circuit breaker for rate limit)
        const backoffMs = _backoffRemainingMs(this.videoId);
        if (backoffMs > 0) {
            if (_logBackoffOnce(this.videoId)) {
                console.log(`[${this.videoId}] metadata-backoff skip videoId=${this.videoId} reason=${_metadataBackoffs.get(this.videoId).reason} retryInMs=${backoffMs}`);
            }
            return;
        }

        if (this.m3u8Url && this._isUrlNearExpiry(this.m3u8Url)) {
            console.log(`[${this.videoId}] ⏰ URL próxima do vencimento, invalidando cache e renovando...`);
            this._cachedMetadata = null;
            this._metadataCacheTime = 0;
            await this._forceRenew();
            return;
        }

        if (this.needsRefresh) {
            this.needsRefresh = false;
            this._cachedMetadata = null;
            this._metadataCacheTime = 0;
            await this._forceRenew();
            return;
        }

        console.log(`[${this.videoId}] 🔍 Ciclo de verificação (spawn)...`);
        const metadataResult = await this.getLiveMetadata();

        // Handle skipped (transient backoff) — return early, no failure counting
        if (!metadataResult.success && metadataResult.skipped) {
            console.log(`[${this.videoId}] ⏳ Verificação adiada: ${metadataResult.error}`);
            this.applyDerivedState();
            return;
        }

        if (!metadataResult.success) {
            if (metadataResult.isLiveEnded) {
                if (!this._liveEndedFirstDetection) {
                    this._liveEndedFirstDetection = Date.now();
                    console.log(`[${this.videoId}] ⏳ Live possivelmente encerrada. Aguardando 2min para confirmar...`);
                    this.updateHealthComponent('metadata', ComponentStatus.WARNING, 'Live possivelmente encerrada (aguardando confirmação 2min)');
                    this.liveState = LiveState.DEGRADED;
                    return;
                }
                const minutesWaiting = (Date.now() - this._liveEndedFirstDetection) / 60000;
                if (minutesWaiting < 2) {
                    console.log(`[${this.videoId}] ⏳ Confirmando encerramento... (${minutesWaiting.toFixed(1)}/2 min)`);
                    if (this.m3u8Url) {
                        await this._forceRenew().catch(() => {});
                    }
                    this.updateHealthComponent('metadata', ComponentStatus.WARNING, `Confirmando encerramento (${minutesWaiting.toFixed(1)}/2min)`);
                    this.liveState = LiveState.DEGRADED;
                    return;
                }
                console.log(`[${this.videoId}] 🛑 Live encerrada confirmada após 2min. Parando monitor.`);
                this.updateHealthComponent('metadata', ComponentStatus.CRITICAL, 'Live encerrada (confirmado)');
                this.applyDerivedState();
                if (this._onEnd) {
                    this._onEnd(this.videoId, this.owner);
                }
                return;
            }
            this._liveEndedFirstDetection = null;
            if (metadataResult.errorType !== 'network') this.updateNetworkHealth(true);
            this.applyDerivedState();
            return;
        }

        this._liveEndedFirstDetection = null;
        this.updateNetworkHealth(true);

        const metadata = metadataResult.metadata;
        const isValid = this.validateMetadata(metadata);
        if (isValid === false) {
            this.applyDerivedState();
            if (this.liveState === LiveState.ENDED && this._onEnd) {
                this._onEnd(this.videoId, this.owner);
            }
            return;
        }
        const newUrl = this.extractHlsUrl(metadata, null);
        if (!newUrl) {
            const classification = this.lastExtractionFailureClassification || CLASSIFICATION.INVALID_HLS;
            console.log(`[${this.videoId}] ⚠️ URL HLS não encontrada (${classification})`);
            this._recordExtractionFailure(classification);
            this.urlFails++;
            this.updateHealthComponent('playlist', ComponentStatus.WARNING, `Extração falhou: ${classification}`);
            if (this.urlFails >= this.maxFails) this.updateHealthComponent('playlist', ComponentStatus.ERROR, `${this.urlFails} falhas consecutivas`);
            this.applyDerivedState();
            return;
        }
        this._recordExtractionSuccess(this.lastSuccessfulCookie, this._lastMetadataExtractionSource || this.lastSuccessfulExtractionSource);
        this.urlFails = 0;
        if (newUrl !== this.m3u8Url) {
            this.m3u8Url = newUrl;
            console.log(`[${this.videoId}] ✅ URL HLS atualizada (spawn)`);
        }
        const isPlaylistAdvancing = await this.checkPlaylistProgress(this.m3u8Url);
        if (!isPlaylistAdvancing) {
            console.log(`[${this.videoId}] ⚠️ Playlist não avança`);
            const stillLive = (metadata.live_status === 'is_live' || metadata.is_live === true);
            if (stillLive) {
                console.log(`[${this.videoId}] ⚠️ Playlist parada, mas YouTube confirma live ativa. Mantendo DEGRADED.`);
                this.updateHealthComponent('playlist', ComponentStatus.WARNING, 'Playlist congelada temporariamente');
                this.liveState = LiveState.DEGRADED;
                this.applyDerivedState();
                return;
            }
            this.segmentFails++;
            if (this.segmentFails >= this.maxFails) this.updateHealthComponent('playlist', ComponentStatus.ERROR, `${this.segmentFails} falhas consecutivas`);
            this.applyDerivedState();
            return;
        }
        this.segmentFails = 0;
        this.consecutiveUnknownFails = 0;
        this.applyDerivedState();

        if (this.stalledCount >= this.maxSegmentRepeats) {
            console.log(`[${this.videoId}] 🔄 Playlist parada por ${this.stalledCount} ciclos, forçando renovação da URL...`);
            await this._forceRenew();
            const newSeq = await this.extractMediaSequence(this.m3u8Url);
            if (newSeq !== null && (this.lastMediaSequence === null || newSeq > this.lastMediaSequence)) {
                this.lastMediaSequence = newSeq;
                this.stalledCount = 0;
                this.updateHealthComponent('playlist', ComponentStatus.OK, 'Recuperado após renovação forçada');
                console.log(`[${this.videoId}] ✅ Playlist recuperada após renovação (nova seq: ${newSeq})`);
            } else {
                console.log(`[${this.videoId}] ⚠️ Mesmo após renovação, playlist não avançou.`);
                this.updateHealthComponent('playlist', ComponentStatus.WARNING, 'Playlist congelada mesmo após renovação');
                this.liveState = LiveState.DEGRADED;
            }
        }

        if (this.liveState === LiveState.ONLINE) {
            this._stableCycles++;
            if (this._stableCycles > 3) {
                const newInterval = Math.min(45000, this.intervalMs + 5000);
                if (newInterval !== this._currentIntervalMs) {
                    this._currentIntervalMs = newInterval;
                    console.log(`[${this.videoId}] 📈 Live estável, aumentando intervalo para ${(newInterval/1000).toFixed(0)}s`);
                }
            }
        } else {
            if (this._stableCycles > 0) {
                this._stableCycles = 0;
                this._currentIntervalMs = this.intervalMs;
                console.log(`[${this.videoId}] 🔄 Live instável, resetando intervalo para ${(this.intervalMs/1000).toFixed(0)}s`);
            }
        }
        this.lastError = null;
        this.lastSuccessTime = new Date();
        if (systemState) systemState.registerSuccess();
        this.checkCookieRedundancy();
        console.log(`[${this.videoId}] ✅ Estado: ${this.liveState} | Health:`, {
            network: this.health.network.status,
            metadata: this.health.metadata.status,
            playlist: this.health.playlist.status,
            cookies: this.health.cookies.status
        });
    }

    checkCookieRedundancy() {
        const cookiesDir = this.cookiesDir;
        const MIN_SIZE = 5000;
        let anyCookieValid = false;
        let mainValid = false;
        let backupValid = false;
        try {
            const files = fs.readdirSync(cookiesDir);
            const cookieFiles = files.filter(f => f.startsWith('cookie') && f.endsWith('.txt'));
            for (const file of cookieFiles) {
                const fullPath = path.join(cookiesDir, file);
                if (fs.existsSync(fullPath) && fs.statSync(fullPath).size > MIN_SIZE) {
                    anyCookieValid = true;
                    break;
                }
            }
        } catch (err) {}
        const mainPath = path.join(cookiesDir, 'main.txt');
        const backupPath = path.join(cookiesDir, 'backup.txt');
        if (fs.existsSync(mainPath) && fs.statSync(mainPath).size > MIN_SIZE) mainValid = true;
        if (fs.existsSync(backupPath) && fs.statSync(backupPath).size > MIN_SIZE) backupValid = true;
        const hasValidCookie = anyCookieValid || mainValid || backupValid;
        if (hasValidCookie) {
            this.updateHealthComponent('cookies', ComponentStatus.OK, 'Pelo menos um cookie válido');
        } else {
            this.updateHealthComponent('cookies', ComponentStatus.ERROR, 'Nenhum cookie válido');
        }
        const liveCount = this._activeMonitors?.size || 0;
        if (!mainValid && !backupValid && !anyCookieValid && !this._criticalSent) {
            if (this.emailAlerts) this.emailAlerts.sendCriticalAlert(liveCount);
            this._criticalSent = true;
        } else if (!mainValid && backupValid && !this._failoverSent) {
            if (this.emailAlerts) this.emailAlerts.sendFailoverAlert(liveCount);
            this._failoverSent = true;
        }
    }

    startMonitoring(intervalSeconds=8) {
        this.maxSegmentRepeats = this.calculateMaxRepeats();
        this._monitorStopped = false;
        this._liveEnded = false;

        if (this._scheduler && this.videoId) {
            this._scheduler.register(this);
        }

        console.log(`🔄 Monitor iniciado para ${this.videoId}${this.owner ? ':' + this.owner : ''} (scheduler global)`);
    }

    stopMonitoring() {
        this._monitorStopped = true;
        if (this._scheduler) {
            this._scheduler.unregister(this.videoId, this.owner);
        }
        console.log(`⏹️ Monitor parado para ${this.videoId}${this.owner ? ':' + this.owner : ''}`);
    }

    static getFlightStats() {
        return {
            activeFlights: _metadataFlights.size,
            videoIds: Array.from(_metadataFlights.keys()),
            activeBackoffs: Array.from(_metadataBackoffs.entries()).map(([id, s]) => ({
                videoId: id,
                failureCount: s.failureCount,
                reason: s.reason,
                remainingMs: _backoffRemainingMs(id)
            }))
        };
    }
}

module.exports = LiveMonitor;
