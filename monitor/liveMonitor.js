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
    selectHlsStream,
    safeUrlPreview,
    sanitizeYtdlpMessage,
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

let systemState = null;
try { systemState = require('../systemState'); } catch(e) {}

// ========== CONSTANTES GLOBAIS ==========
const YTDLP_TIMEOUT = 180000; // 3 minutos (ajustado)
const METADATA_TTL = 15000;
const LIVE_STALL_TIME = 60000;

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

class LiveMonitor {
    constructor(youtubeUrl, emailAlerts, activeMonitorsMap = null, scheduler = null, cookieRotator = null, onEnd = null) {
        this.youtubeUrl = youtubeUrl;
        this.emailAlerts = emailAlerts;
        this.videoId = this.extractVideoId(youtubeUrl); // ✅ agora o método existe
        this.m3u8Url = null;
        this.isLive = false;
        this.intervalMs = 8000;
        this.maxStallTimeMs = LIVE_STALL_TIME;
        
        this._activeMonitors = activeMonitorsMap;
        this._scheduler = scheduler;
        this._cookieRotator = cookieRotator;
        this._onEnd = onEnd;
        
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
        
        // ✅ Armazenar URLs das playlists de qualidade (altura -> URL)
        this._playlistUrls = {};
        // Armazenar master artificial (se gerado)
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
        this.lastExtractionSuccessAt = null;
    }

    // ✅ MÉTODO CORRIGIDO (estava faltando)
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
        this.lastExtractionSuccessAt = this.extractionBackoff.lastExtractionSuccessAt;
    }

    _recordExtractionFailure(classification) {
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

    _recordExtractionSuccess(cookieName) {
        const recovered = resetExtractionBackoff(this.extractionBackoff, cookieName);
        this._syncExtractionBackoffFields();
        if (recovered) {
            console.log(`[${this.videoId}] extracao recuperada com ${this.lastSuccessfulCookie || 'cookie desconhecido'}`);
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

            let finalArgs = [...filteredArgs];
            let cookieIndex = finalArgs.indexOf('--cookies');
            let selectedCookiePath = null;
            if (cookieIndex !== -1 && finalArgs.length > cookieIndex + 1) {
                selectedCookiePath = finalArgs[cookieIndex + 1];
                finalArgs.splice(cookieIndex, 2);
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
                    const argsWithCookie = [...finalArgs];
                    const cookiePath = resolveCookiePath(this.cookiesDir, cookieName);
                    if (cookiePath) argsWithCookie.unshift('--cookies', cookiePath);

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

            const attempts = cookieAttemptOrder.length > 0 ? cookieAttemptOrder : [null];
            console.log(`[${this.videoId}] ordem de cookies da rodada: ${attempts.filter(Boolean).join(' -> ') || 'sem cookie'}`);

            try {
                for (const cookieName of attempts) {
                    try {
                        const result = await execWithCookie(cookieName);
                        if (this._cookieRotator && cookieName) {
                            this._cookieRotator.markSuccess(cookieName);
                        }
                        if (cookieName) {
                            this.lastSuccessfulCookie = cookieName;
                            this.extractionBackoff.lastSuccessfulCookie = cookieName;
                            this._syncExtractionBackoffFields();
                        }
                        resolve(result.stdout);
                        return;
                    } catch (err) {
                        const errorMsg = err.message || '';
                        const classification = classifyYtdlpError(errorMsg);
                        const isCookieAuth = isCookieAuthClassification(classification) || this._isCookieAuthError(errorMsg);

                        if (isCookieAuth && this._cookieRotator && cookieName) {
                            console.log(`🔴 Marcando falha para ${cookieName}: ${sanitizeYtdlpMessage(errorMsg).slice(0, 100)}`);
                            cookieFailureAlreadyHandled = this._cookieRotator.markFailure(cookieName, errorMsg, this.videoId) ||
                                cookieFailureAlreadyHandled;
                        }

                        if (isCookieAuth) {
                            console.log(`${cookieName || 'sem cookie'} falhou: ${classification}`);
                            continue;
                        }

                        err.classification = classification;
                        reject(err);
                        return;
                    }
                }
                const finalError = new Error('Todos os cookies falharam por autenticação/cookie');
                finalError.classification = CLASSIFICATION.AUTH_COOKIE;
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
        if (!force && this._cachedMetadata && (agora - this._metadataCacheTime) < this._metadataTTL) {
            console.log(`[${this.videoId}] 📦 Usando cache de metadados (${((agora - this._metadataCacheTime)/1000).toFixed(1)}s)`);
            return { success: true, metadata: this._cachedMetadata };
        }
        let cookiePath = null;
        try {
            cookiePath = this.getCookiePath();
            const args = ['--dump-json', '--skip-download', '--no-playlist', this.youtubeUrl];
            if (cookiePath) args.unshift('--cookies', cookiePath);
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
            
            return { success: true, metadata };
        } catch (error) {
            const safeErrorMessage = sanitizeYtdlpMessage(error.message);
            console.error(`[${this.videoId}] ❌ Erro spawn: ${safeErrorMessage}`);
            const errorMsg = error.message.toLowerCase();
            const classification = error.classification || classifyYtdlpError(error.message);
            this._recordExtractionFailure(classification);
            const isLiveEnded = errorMsg.includes('video unavailable') || 
                               errorMsg.includes('not available') || 
                               errorMsg.includes('recording is not available') ||
                               errorMsg.includes('this live event has ended');
            
            if (isCookieAuthClassification(classification) || this._isCookieAuthError(error.message)) {
                if (this._cookieRotator && cookiePath) {
                    const cookieName = path.basename(cookiePath);
                    if (!error.cookieFailureAlreadyHandled) {
                        this._cookieRotator.markFailure(cookieName, error.message, this.videoId);
                    }
                }
                this.updateHealthComponent('cookies', ComponentStatus.ERROR, 'Cookie inválido');
                this.updateHealthComponent('metadata', ComponentStatus.WARNING, 'Erro de autenticação');
            } else if (isLiveEnded) {
                this.updateHealthComponent('metadata', ComponentStatus.CRITICAL, 'Live encerrada');
            } else if (classification === CLASSIFICATION.TIMEOUT) {
                this.updateHealthComponent('metadata', ComponentStatus.WARNING, 'Timeout');
            } else {
                this.updateHealthComponent('metadata', ComponentStatus.WARNING, `Erro ${classification}: ${safeErrorMessage}`);
            }
            
            this.metadataFails++;
            return { success: false, error: safeErrorMessage, errorType: classification, classification, isLiveEnded };
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

    // ============================================================
    // extractHlsUrl – recebe maxHeight por parâmetro (não armazena)
    // ============================================================
    extractHlsUrl(metadata, maxHeight = null) {
        const effectiveMax = maxHeight !== null ? maxHeight : parseInt(process.env.VIDEO_MAX_HEIGHT, 10) || 1080;
        const selection = selectHlsStream(metadata, {
            maxHeight: maxHeight !== null ? effectiveMax : null,
            forceArtificial: maxHeight !== null
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

    // ============================================================
    // extractMediaSequence (com agentes)
    // ============================================================
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

    async _forceRenew() {
        if (this.isExtractionBackoffActive()) {
            this.logExtractionBackoffSuppressed();
            return false;
        }
        console.log(`[${this.videoId}] 🔄 Forçando renovação da URL HLS...`);
        try {
            const metadataResult = await this.getLiveMetadata(true);
            if (!metadataResult.success) {
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
            this._recordExtractionSuccess(this.lastSuccessfulCookie);
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

        if (this.isExtractionBackoffActive()) {
            this.logExtractionBackoffSuppressed();
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
        this._recordExtractionSuccess(this.lastSuccessfulCookie);
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
}

module.exports = LiveMonitor;
