const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');
const GlobalScheduler = require('../globalScheduler');
const CookieRotator = require('../cookieRotator');
const {
    CLASSIFICATION,
    classifyYtdlpError,
    isCookieAuthClassification,
    getYtdlpDiagnostics,
    selectHlsStream,
    sanitizeYtdlpMessage,
    shouldAttemptPublicFallback,
    isGlobalExtractionOutagePattern
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

function getDefaultMaxHeight() {
    const value = parseInt(process.env.VIDEO_MAX_HEIGHT, 10);
    return Number.isFinite(value) && value > 0 ? value : 720;
}

function positiveIntegerEnv(name, fallback) {
    const value = parseInt(process.env[name], 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

function globalCircuitBreakerSeconds() {
    return positiveIntegerEnv('YTDLP_GLOBAL_EXTRACTION_CIRCUIT_BREAKER_SECONDS', 15 * 60);
}

function cookieFileToQueueName(file) {
    return String(file || '').replace(/\.txt$/i, '');
}

function getGlobalExtractionBackoffFile() {
    return process.env.GLOBAL_EXTRACTION_BACKOFF_FILE ||
        path.join(__dirname, '../data/global-extraction-backoff.json');
}

function sanitizeGlobalExtractionBackoffState(state = {}, critical = false) {
    const snapshot = createExtractionBackoffState(state);
    return {
        version: 1,
        critical: Boolean(critical),
        updatedAt: new Date().toISOString(),
        state: {
            consecutiveExtractionFailures: snapshot.consecutiveExtractionFailures,
            lastExtractionFailureAt: snapshot.lastExtractionFailureAt,
            lastFailureClassification: snapshot.lastFailureClassification,
            nextRetryAt: snapshot.nextRetryAt,
            backoffSeconds: snapshot.backoffSeconds,
            lastSuccessfulCookie: snapshot.lastSuccessfulCookie,
            lastSuccessfulExtractionSource: snapshot.lastSuccessfulExtractionSource,
            lastExtractionSuccessAt: snapshot.lastExtractionSuccessAt,
            lastAutomaticCookieRefreshQueuedAt: snapshot.lastAutomaticCookieRefreshQueuedAt,
            automaticCookieRefreshReason: snapshot.automaticCookieRefreshReason,
            automaticCookieRefreshJobs: snapshot.automaticCookieRefreshJobs,
            lastGlobalOutageAlertAt: snapshot.lastGlobalOutageAlertAt,
            globalOutageAlertReason: snapshot.globalOutageAlertReason,
            lastCircuitBreakerOpenedAt: snapshot.lastCircuitBreakerOpenedAt,
            globalCircuitBreakerSeconds: snapshot.globalCircuitBreakerSeconds
        }
    };
}

function readGlobalExtractionBackoff(filePath = getGlobalExtractionBackoffFile()) {
    try {
        if (!fs.existsSync(filePath)) {
            return { critical: false, state: createExtractionBackoffState() };
        }
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return {
            critical: Boolean(parsed?.critical),
            state: createExtractionBackoffState(parsed?.state || {})
        };
    } catch (err) {
        console.warn(`[GLOBAL] estado persistido de extracao ignorado: ${err.message}`);
        return { critical: false, state: createExtractionBackoffState() };
    }
}

function writeGlobalExtractionBackoff(filePath, state, critical) {
    try {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
        fs.writeFileSync(
            tmpPath,
            JSON.stringify(sanitizeGlobalExtractionBackoffState(state, critical), null, 2),
            'utf8'
        );
        fs.renameSync(tmpPath, filePath);
        return true;
    } catch (err) {
        console.warn(`[GLOBAL] falha ao persistir circuit breaker de extracao: ${err.message}`);
        return false;
    }
}

class ConvertAPI {
    constructor(emailAlerts, orchestrator, revokeTokenFn = null, options = {}) {
        this.emailAlerts = emailAlerts;
        this.orchestrator = orchestrator;
        this.activeMonitors = new Map();
        this.liveCache = new Map();
        this._revokeTokenFn = revokeTokenFn;
        
        const cookiesDir = path.join(__dirname, '../cookies');
        this.cookieRotator = new CookieRotator(cookiesDir);
        
        if (this.emailAlerts && this.cookieRotator.setEmailAlerts) {
            this.cookieRotator.setEmailAlerts(this.emailAlerts);
        }
        
        this.scheduler = new GlobalScheduler(60000, 6, this.cookieRotator);
        this.extractionBackoff = new Map();
        this.globalExtractionBackoffFile = options.globalExtractionBackoffFile || getGlobalExtractionBackoffFile();
        const persistedGlobalBackoff = readGlobalExtractionBackoff(this.globalExtractionBackoffFile);
        this.globalExtractionBackoff = persistedGlobalBackoff.state;
        this.globalExtractionCritical = persistedGlobalBackoff.critical ||
            Boolean(this.globalExtractionBackoff.lastFailureClassification || this.globalExtractionBackoff.consecutiveExtractionFailures);
        if (this.globalExtractionCritical && getBackoffDelayMs(this.globalExtractionBackoff) > 0) {
            const retrySeconds = Math.ceil(getBackoffDelayMs(this.globalExtractionBackoff) / 1000);
            console.log(`[GLOBAL] circuit breaker de extracao restaurado; retry em ${retrySeconds}s`);
        }
        if (typeof this.scheduler.setGlobalExtractionBackoffProvider === 'function') {
            this.scheduler.setGlobalExtractionBackoffProvider(() => this.globalExtractionBackoff);
        }
    }

    removeMonitor(videoId, owner) {
        const key = this._getCompositeKey(videoId, owner);
        if (this.activeMonitors.has(key)) {
            const monitor = this.activeMonitors.get(key);
            monitor.stopMonitoring();
            this.activeMonitors.delete(key);
            this.clearExtractionBackoff(videoId, owner);
            this._removePersistedMapping(videoId, owner);
            if (this._revokeTokenFn) {
                this._revokeTokenFn(videoId, owner);
            }
            console.log(`🗑️ Monitor removido automaticamente (live encerrada): ${key}`);
            return true;
        }
        return false;
    }

    _getCompositeKey(videoId, owner) {
        return owner ? `${videoId}:${owner}` : videoId;
    }

    _getExtractionState(key) {
        if (!this.extractionBackoff.has(key)) {
            this.extractionBackoff.set(key, createExtractionBackoffState());
        }
        return this.extractionBackoff.get(key);
    }

    clearExtractionBackoff(videoId, owner) {
        return this.extractionBackoff.delete(this._getCompositeKey(videoId, owner));
    }

    _logConvertBackoff(key, videoId, state, now = Date.now()) {
        if (!shouldLogBackoffSuppression(state, now)) return;
        const retrySeconds = Math.ceil(getBackoffDelayMs(state, now) / 1000);
        console.log(`[${videoId}] em backoff; proxima tentativa em ${retrySeconds}s (${state.lastFailureClassification})`);
    }

    _recordConvertFailure(key, videoId, classification, now = Date.now(), scope = 'todos os cookies falharam') {
        const state = this._getExtractionState(key);
        if (!shouldApplyExtractionBackoff(classification)) return state;
        applyExtractionFailure(state, classification || CLASSIFICATION.UNKNOWN, now);
        const retryIso = state.nextRetryAt ? new Date(state.nextRetryAt).toISOString() : 'n/a';
        console.log(`[${videoId}] ${scope} [${state.lastFailureClassification}] falhasConsecutivas=${state.consecutiveExtractionFailures} backoff=${state.backoffSeconds}s proximoRetry=${retryIso}`);
        return state;
    }

    _recordGlobalExtractionFailure(videoId, classification, now = Date.now()) {
        const state = this.globalExtractionBackoff;
        const circuitBreakerSeconds = globalCircuitBreakerSeconds();
        const parsedMaxSeconds = parseInt(process.env.YTDLP_GLOBAL_EXTRACTION_BACKOFF_MAX_SECONDS, 10);
        const extractionMaxSeconds = Number.isFinite(parsedMaxSeconds) && parsedMaxSeconds > 0
            ? parsedMaxSeconds
            : circuitBreakerSeconds;

        applyExtractionFailure(state, classification || CLASSIFICATION.NO_FORMATS, now, {
            extractionMaxSeconds
        });

        const enforcedSeconds = Math.min(circuitBreakerSeconds, extractionMaxSeconds);
        if (state.backoffSeconds < enforcedSeconds) {
            state.backoffSeconds = enforcedSeconds;
            state.nextRetryAt = now + enforcedSeconds * 1000;
        }
        state.lastCircuitBreakerOpenedAt = now;
        state.globalCircuitBreakerSeconds = state.backoffSeconds;
        this.globalExtractionCritical = true;

        const retryIso = state.nextRetryAt ? new Date(state.nextRetryAt).toISOString() : 'n/a';
        console.log(`[GLOBAL] circuit breaker de extracao apos ${videoId}: ${state.lastFailureClassification} backoff=${state.backoffSeconds}s proximoRetry=${retryIso}`);
        this._queueCookieRefreshAfterGlobalExtractionFailure(videoId, state, now);
        this._sendGlobalExtractionOutageAlert(videoId, state, now);
        this._persistGlobalExtractionState();
        return state;
    }

    _queueCookieRefreshAfterGlobalExtractionFailure(videoId, state, now = Date.now()) {
        const refreshQueue = this.cookieRotator?.refreshQueue;
        if (!refreshQueue || typeof refreshQueue.enqueue !== 'function') return [];

        const threshold = positiveIntegerEnv('COOKIE_EXTRACTION_AUTO_REFRESH_FAILURES', 1);
        const cooldownMs = positiveIntegerEnv('COOKIE_EXTRACTION_AUTO_REFRESH_COOLDOWN_MS', 30 * 60 * 1000);
        const consecutiveFailures = Number(state?.consecutiveExtractionFailures) || 0;
        if (consecutiveFailures < threshold) return [];

        const lastQueuedAt = Number(state?.lastAutomaticCookieRefreshQueuedAt) || 0;
        if (lastQueuedAt > 0 && now - lastQueuedAt < cooldownMs) {
            return [];
        }

        const classification = state?.lastFailureClassification || CLASSIFICATION.NO_FORMATS;
        const reason = `extracao global critica: ${classification}`;
        const results = [];
        for (const file of DEFAULT_COOKIE_FILES) {
            const cookie = cookieFileToQueueName(file);
            try {
                const result = refreshQueue.enqueue(cookie, 'automatic', reason, {
                    requestedBy: 'global-extraction-watch'
                });
                results.push({
                    cookie,
                    created: Boolean(result?.created),
                    jobId: result?.job?.id || null
                });
            } catch (err) {
                console.warn(`[GLOBAL] falha ao solicitar renovacao automatica de ${cookie}: ${err.message}`);
                results.push({ cookie, created: false, error: 'enqueue_failed' });
            }
        }

        state.lastAutomaticCookieRefreshQueuedAt = now;
        state.automaticCookieRefreshReason = reason;
        state.automaticCookieRefreshJobs = results;
        const created = results.filter(item => item.created).map(item => item.cookie);
        const reused = results.filter(item => !item.created && !item.error).map(item => item.cookie);
        console.log(`[GLOBAL] renovacao automatica de cookies solicitada apos falha confirmada em ${videoId}: criadas=${created.join(',') || '0'} existentes=${reused.join(',') || '0'}`);
        return results;
    }

    _sendGlobalExtractionOutageAlert(videoId, state, now = Date.now()) {
        if (!this.emailAlerts || typeof this.emailAlerts.sendGlobalExtractionOutageAlert !== 'function') return false;
        const cooldownMs = positiveIntegerEnv('GLOBAL_EXTRACTION_ALERT_COOLDOWN_MS', 60 * 60 * 1000);
        const lastAlertAt = Number(state?.lastGlobalOutageAlertAt) || 0;
        if (lastAlertAt > 0 && now - lastAlertAt < cooldownMs) return false;

        state.lastGlobalOutageAlertAt = now;
        state.globalOutageAlertReason = `extracao global critica: ${state.lastFailureClassification || CLASSIFICATION.NO_FORMATS}`;
        this.emailAlerts.sendGlobalExtractionOutageAlert({
            videoId,
            classification: state.lastFailureClassification || CLASSIFICATION.NO_FORMATS,
            retryAfterSeconds: Math.ceil(getBackoffDelayMs(state, now) / 1000),
            consecutiveFailures: Number(state.consecutiveExtractionFailures) || 0,
            automaticCookieRefreshQueuedAt: state.lastAutomaticCookieRefreshQueuedAt || null,
            automaticCookieRefreshJobs: state.automaticCookieRefreshJobs || []
        });
        return true;
    }

    _recordGlobalExtractionSuccess(now = Date.now()) {
        const recovered = resetExtractionBackoff(this.globalExtractionBackoff, null, now, 'stream');
        this.globalExtractionCritical = false;
        this._persistGlobalExtractionState();
        return recovered;
    }

    _persistGlobalExtractionState() {
        return writeGlobalExtractionBackoff(
            this.globalExtractionBackoffFile,
            this.globalExtractionBackoff,
            this.globalExtractionCritical
        );
    }

    _recordConvertSuccess(key, videoId, cookieName, source = null, now = Date.now()) {
        const state = this._getExtractionState(key);
        const recovered = resetExtractionBackoff(state, cookieName, now, source);
        if (recovered) {
            console.log(`[${videoId}] extracao recuperada com ${state.lastSuccessfulExtractionSource || state.lastSuccessfulCookie || 'origem desconhecida'}`);
        }
        return state;
    }

    _persistMapping(videoId, youtubeUrl, owner, metadata) {
        const cookiesDir = path.join(__dirname, '../cookies');
        const mappingFile = path.join(cookiesDir, 'monitors.json');
        if (!fs.existsSync(cookiesDir)) fs.mkdirSync(cookiesDir, { recursive: true });
        let map = {};
        try { map = JSON.parse(fs.readFileSync(mappingFile, 'utf8')); } catch (e) {}
        const key = this._getCompositeKey(videoId, owner);
        map[key] = { youtubeUrl, owner, metadata: metadata || null };
        fs.writeFileSync(mappingFile, JSON.stringify(map, null, 2));
    }

    _removePersistedMapping(videoId, owner) {
        const cookiesDir = path.join(__dirname, '../cookies');
        const mappingFile = path.join(cookiesDir, 'monitors.json');
        try {
            const map = JSON.parse(fs.readFileSync(mappingFile, 'utf8'));
            const key = this._getCompositeKey(videoId, owner);
            delete map[key];
            fs.writeFileSync(mappingFile, JSON.stringify(map, null, 2));
        } catch (e) {}
    }

    _runYtdlp(args, timeout = 60000) {
        return new Promise((resolve, reject) => {
            const ytCmd = process.platform === 'win32' ? '.\\yt-dlp.exe' : 'yt-dlp';
            const child = spawn(ytCmd, args);
            let stdout = '';
            let stderr = '';
            let timedOut = false;
            const timeoutId = setTimeout(() => {
                timedOut = true;
                child.kill('SIGTERM');
                setTimeout(() => {
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

    /**
     * Obtém metadados via oEmbed (Alternativa rápida e sem 429)
     */
    async _getMetadataOembed(videoId) {
        return new Promise((resolve) => {
            const url = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
            const req = https.get(url, (res) => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    try {
                        if (res.statusCode === 200) {
                            const data = JSON.parse(body);
                            resolve({
                                title: data.title || null,
                                channel: data.author_name || null,
                                thumbnail: data.thumbnail_url || null
                            });
                        } else {
                            resolve(null);
                        }
                    } catch (e) {
                        resolve(null);
                    }
                });
            });
            req.on('error', () => resolve(null));
            req.setTimeout(5000, () => {
                req.destroy();
                resolve(null);
            });
        });
    }

    async _getVideoMetadata(youtubeUrl) {
        const videoId = this.extractVideoId(youtubeUrl);
        
        // 1. Tenta oEmbed primeiro (rápido, oficial e evita erro 429)
        console.log(`🔍 Buscando metadados via oEmbed para ${videoId}...`);
        const oembedData = await this._getMetadataOembed(videoId);
        if (oembedData) {
            console.log(`✅ Metadados obtidos via oEmbed: ${oembedData.title}`);
            return oembedData;
        }

        // 2. Fallback para yt-dlp se oEmbed falhar (ex: vídeo privado ou erro de rede)
        try {
            console.log(`⚠️ oEmbed falhou ou retornou vazio, tentando yt-dlp como fallback...`);
            const args = ['--dump-json', '--skip-download', '--flat-playlist', '--playlist-end', '1', youtubeUrl];
            
            // Tenta usar o primeiro cookie disponível para evitar 429 no fallback
            const cookiePath = this.cookieRotator.getNextCookiePath();
            if (cookiePath && fs.existsSync(cookiePath)) {
                args.unshift('--cookies', cookiePath);
            }

            const stdout = await this._runYtdlp(args, 15000);
            const data = JSON.parse(stdout);
            return {
                title: data.title || null,
                channel: data.channel || data.uploader || null,
                thumbnail: data.thumbnail || null,
                duration: data.duration || null,
                viewCount: data.view_count || null,
                uploadDate: data.upload_date || null
            };
        } catch (error) {
            console.warn(`❌ Erro ao obter metadados para ${youtubeUrl}:`, error.message);
            return null;
        }
    }

    async convert(youtubeUrl, baseUrl, owner = null, options = {}) {
        const videoId = this.extractVideoId(youtubeUrl);
        const key = this._getCompositeKey(videoId, owner);
        const bypassGlobalBackoff = options.bypassGlobalBackoff === true;
        
        if (this.activeMonitors.has(key)) {
            const monitor = this.activeMonitors.get(key);
            return {
                success: true,
                videoId: videoId,
                serverUrl: `${baseUrl}/neonews/${videoId}.m3u8`,
                isLive: monitor.liveState === 'online',
                cached: true,
                metadata: monitor.metadata || null,
                message: 'Live já está sendo monitorada para este usuário'
            };
        }
        
        const extractionState = this._getExtractionState(key);
        const backoffDelayMs = getBackoffDelayMs(extractionState);
        if (backoffDelayMs > 0) {
            this._logConvertBackoff(key, videoId, extractionState);
            return {
                success: false,
                videoId: videoId,
                error: 'Extracao em backoff',
                classification: extractionState.lastFailureClassification || CLASSIFICATION.UNKNOWN,
                retryAfterSeconds: Math.ceil(backoffDelayMs / 1000),
                message: 'A extracao desta live esta em backoff temporario; tente novamente apos o proximo retry.'
            };
        }

        const globalBackoffDelayMs = getBackoffDelayMs(this.globalExtractionBackoff);
        if (!bypassGlobalBackoff && globalBackoffDelayMs > 0) {
            const retryAfterSeconds = Math.ceil(globalBackoffDelayMs / 1000);
            console.log(`[GLOBAL] extracao em backoff; ${videoId} suprimido por ${retryAfterSeconds}s`);
            return {
                success: false,
                videoId,
                error: 'A extracao do YouTube esta temporariamente indisponivel.',
                classification: this.globalExtractionBackoff.lastFailureClassification || CLASSIFICATION.NO_FORMATS,
                retryAfterSeconds,
                globalExtractionCritical: true,
                message: 'A extracao do YouTube esta temporariamente indisponivel. Tente novamente em alguns minutos.'
            };
        }

        console.log(`[${new Date().toISOString()}] Requisição: ${youtubeUrl} (owner: ${owner})`);
        
        const metadata = await this._getVideoMetadata(youtubeUrl);
        if (metadata) {
            console.log(`🎬 Título: ${metadata.title}`);
            console.log(`📺 Canal: ${metadata.channel}`);
        }

        const cookiesDir = path.join(__dirname, '../cookies');
        const selectedCookiePath = this.cookieRotator ? this.cookieRotator.getNextCookiePath() : null;
        const cookieAttemptOrder = buildCookieAttemptOrder({
            lastSuccessfulCookie: extractionState.lastSuccessfulCookie,
            selectedCookiePath,
            cookieFiles: DEFAULT_COOKIE_FILES,
            cookieExists: cookieName => {
                const cookiePath = resolveCookiePath(cookiesDir, cookieName);
                return Boolean(cookiePath && fs.existsSync(cookiePath));
            }
        });
        let streamUrl = null;
        let workingCookie = null;
        let extractionSource = null;
        let streamSelection = null;
        let streamMetadata = null;
        const failedCookies = [];
        let publicFallbackFailure = null;

        console.log(`[${videoId}] ordem de cookies da rodada: ${cookieAttemptOrder.join(' -> ') || 'nenhum cookie disponivel'}`);
        for (const file of cookieAttemptOrder) {
            const fullPath = resolveCookiePath(cookiesDir, file);
            const argsWithCookie = ['--cookies', fullPath, '--dump-json', '--skip-download', '--no-playlist', youtubeUrl];
            try {
                console.log(`🍪 Tentando ${file}...`);
                const stdout = await this._runYtdlp(argsWithCookie, 60000);
                const ytMetadata = JSON.parse(stdout);
                const diagnostics = getYtdlpDiagnostics(ytMetadata);
                console.log(`[${videoId}] yt-dlp JSON (${file}): formats=${diagnostics.formatCount}, protocols=${diagnostics.protocols.join('|') || 'nenhum'}, requested=${diagnostics.requestedFormatsCount}, live=${diagnostics.liveStatus || 'n/a'}`);
                const selection = selectHlsStream(ytMetadata, {
                    maxHeight: getDefaultMaxHeight(),
                    forceArtificial: true
                });
                if (selection.ok) {
                    streamUrl = selection.url;
                    workingCookie = file;
                    extractionSource = file.replace(/\.txt$/i, '');
                    streamSelection = selection;
                    streamMetadata = ytMetadata;
                    console.log(`Sucesso com ${file}: HLS ${selection.type} (${selection.urlPreview})`);
                    break;
                }
                const extractionError = new Error(`Falha de extração de stream: ${selection.classification}`);
                extractionError.classification = selection.classification;
                extractionError.diagnostics = selection.diagnostics;
                throw extractionError;
            } catch (error) {
                const classification = error.classification || classifyYtdlpError(error.message);
                const safeErrorMessage = sanitizeYtdlpMessage(error.message);
                console.log(`${file} falhou: ${classification} - ${safeErrorMessage}`);
                if (error.diagnostics) {
                    console.log(`[${videoId}] Diagnóstico seguro (${file}): ${JSON.stringify(error.diagnostics)}`);
                }
                failedCookies.push({ file, error: safeErrorMessage, classification });
                const isCookieError = this.cookieRotator &&
                    (isCookieAuthClassification(classification) || this.cookieRotator.isCookieAuthError(error.message));
                if (isCookieError && this.cookieRotator) {
                    this.cookieRotator.markFailure(file, error.message, videoId);
                } else {
                    if (this.cookieRotator && typeof this.cookieRotator.markExtractionFailure === 'function') {
                        const diagnostics = error.diagnostics || null;
                        this.cookieRotator.markExtractionFailure(file, classification, safeErrorMessage, videoId, {
                            probeVideoId: videoId,
                            metadataValid: diagnostics ? true : undefined,
                            formatsValid: diagnostics ? diagnostics.formatCount > 0 : undefined,
                            hlsValid: false
                        });
                    }
                    console.log(`[COOKIE] ${file}: ${classification} nao altera estado do cookie.`);
                }
                continue;
            }
        }

        if (!streamUrl && shouldAttemptPublicFallback(failedCookies)) {
            const publicArgs = ['--dump-json', '--skip-download', '--no-playlist', youtubeUrl];
            try {
                console.log(`[${videoId}] ordem de extracao final: ${cookieAttemptOrder.join(' -> ') || 'sem cookies'} -> public`);
                console.log(`[${videoId}] tentando extracao publica sem cookie...`);
                const stdout = await this._runYtdlp(publicArgs, 60000);
                const ytMetadata = JSON.parse(stdout);
                const diagnostics = getYtdlpDiagnostics(ytMetadata);
                console.log(`[${videoId}] yt-dlp JSON (public): formats=${diagnostics.formatCount}, protocols=${diagnostics.protocols.join('|') || 'nenhum'}, requested=${diagnostics.requestedFormatsCount}, live=${diagnostics.liveStatus || 'n/a'}`);
                const selection = selectHlsStream(ytMetadata, {
                    maxHeight: getDefaultMaxHeight(),
                    forceArtificial: true
                });
                if (selection.ok) {
                    streamUrl = selection.url;
                    workingCookie = null;
                    extractionSource = 'public';
                    streamSelection = selection;
                    streamMetadata = ytMetadata;
                    console.log(`[${videoId}] sucesso publico: HLS ${selection.type} (${selection.urlPreview})`);
                } else {
                    const publicError = new Error(`Falha de extracao publica: ${selection.classification}`);
                    publicError.classification = selection.classification;
                    publicError.diagnostics = selection.diagnostics;
                    throw publicError;
                }
            } catch (error) {
                const classification = error.classification || classifyYtdlpError(error.message);
                const safeErrorMessage = sanitizeYtdlpMessage(error.message);
                console.log(`[${videoId}] public falhou: ${classification} - ${safeErrorMessage}`);
                if (error.diagnostics) {
                    console.log(`[${videoId}] Diagnostico seguro (public): ${JSON.stringify(error.diagnostics)}`);
                }
                publicFallbackFailure = { file: 'public', error: safeErrorMessage, classification };
            }
        }

        // Se nenhum cookie funcionou
        if (!streamUrl) {
            const allFailures = publicFallbackFailure ? failedCookies.concat(publicFallbackFailure) : failedCookies;
            if (publicFallbackFailure) {
                console.error(`Todos os cookies e fallback publico falharam para ${videoId}`);
            }
            console.error(`❌ Todos os cookies falharam para ${videoId}`);
            const cookieErrorCount = this.cookieRotator
                ? failedCookies.filter(({ error, classification }) =>
                    isCookieAuthClassification(classification) || this.cookieRotator.isCookieAuthError(error)
                ).length
                : 0;
            const onlyCookieAuthFailures = failedCookies.length > 0 &&
                cookieErrorCount === failedCookies.length;
            const globalExtractionOutage = failedCookies.length >= cookieAttemptOrder.length &&
                isGlobalExtractionOutagePattern(failedCookies, publicFallbackFailure);
            const publicRestrictedClassification = !globalExtractionOutage && publicFallbackFailure &&
                !shouldAttemptPublicFallback([publicFallbackFailure])
                ? publicFallbackFailure.classification
                : null;
            const primaryClassification = allFailures.find(({ classification }) =>
                !isCookieAuthClassification(classification)
                )?.classification || failedCookies[0]?.classification || CLASSIFICATION.UNKNOWN;
            const responseClassification = globalExtractionOutage ? CLASSIFICATION.NO_FORMATS : publicRestrictedClassification ||
                (onlyCookieAuthFailures ? CLASSIFICATION.AUTH_COOKIE : primaryClassification);
            const failureScope = publicFallbackFailure
                ? 'todos os cookies e fallback publico falharam'
                : 'todos os cookies falharam';
            this._recordConvertFailure(key, videoId, responseClassification, Date.now(), failureScope);
            let globalRetryAfterSeconds = 0;
            if (globalExtractionOutage) {
                const globalState = this._recordGlobalExtractionFailure(videoId, responseClassification);
                globalRetryAfterSeconds = Math.ceil(getBackoffDelayMs(globalState) / 1000);
            }
            return {
                success: false,
                videoId: videoId,
                error: globalExtractionOutage
                    ? 'A extracao do YouTube esta temporariamente indisponivel.'
                    : 'Não foi possível extrair a transmissão do YouTube neste momento.',
                classification: responseClassification,
                globalExtractionCritical: globalExtractionOutage,
                retryAfterSeconds: globalExtractionOutage ? globalRetryAfterSeconds : undefined,
                failedCookies,
                publicFallback: publicFallbackFailure,
                metadata: metadata,
                message: onlyCookieAuthFailures
                    ? 'Falha de autenticacao/cookie. Verifique os cookies.'
                    : globalExtractionOutage
                        ? 'A extracao do YouTube esta temporariamente indisponivel. Tente novamente em alguns minutos.'
                        : 'Não foi possível extrair a transmissão do YouTube neste momento. Tente novamente em instantes ou atualize os cookies se o problema persistir.'
            };
        }

        if (this.cookieRotator && workingCookie) {
            console.log(`✅ Cookie ${workingCookie} funcionou para obtenção da stream.`);
            if (typeof this.cookieRotator.markExtractionSuccess === 'function') {
                this.cookieRotator.markExtractionSuccess(workingCookie, { probeVideoId: videoId });
            } else {
                this.cookieRotator.markSuccess(workingCookie);
            }
        }
        if (extractionSource === 'public') {
            console.log(`[${videoId}] extracao concluida via public; estado dos cookies preservado.`);
        }
        const successState = this._recordConvertSuccess(key, videoId, workingCookie, extractionSource);
        this._recordGlobalExtractionSuccess();

        console.log(`✅ Stream capturada para ${videoId}:${owner}`);
        const LiveMonitor = require('../monitor/liveMonitor');
        
        const monitor = new LiveMonitor(
            youtubeUrl,
            this.emailAlerts,
            this.activeMonitors,
            this.scheduler,
            this.cookieRotator,
            (vid, own) => {
                this.removeMonitor(vid, own);
            },
            (vid, classification) => {
                this._recordGlobalExtractionFailure(vid, classification || CLASSIFICATION.NO_FORMATS);
            }
        );
        monitor.m3u8Url = streamUrl;
        monitor.isLive = true;
        monitor.owner = owner;
        monitor.metadata = metadata || streamMetadata;
        monitor.lastSuccessfulCookie = workingCookie;
        monitor.lastSuccessfulExtractionSource = extractionSource;
        monitor.lastExtractionSuccessAt = successState.lastExtractionSuccessAt;
        if (extractionSource === 'public') {
            monitor.lastPublicCookieRecheckAt = successState.lastExtractionSuccessAt || Date.now();
        }
        if (monitor.extractionBackoff) {
            if (workingCookie) monitor.extractionBackoff.lastSuccessfulCookie = workingCookie;
            monitor.extractionBackoff.lastSuccessfulExtractionSource = extractionSource;
            monitor.extractionBackoff.lastExtractionSuccessAt = successState.lastExtractionSuccessAt;
            if (typeof monitor._syncExtractionBackoffFields === 'function') {
                monitor._syncExtractionBackoffFields();
            }
        }
        if (streamSelection) {
            monitor.lastExtractionDiagnostics = streamSelection.diagnostics;
            monitor._playlistUrls = streamSelection.playlistUrls || {};
            if (streamSelection.masterContent) {
                monitor._masterContent = {
                    isMaster: true,
                    content: streamSelection.masterContent,
                    urls: Object.values(streamSelection.playlistUrls || {})
                };
            }
        }
        monitor.startMonitoring(60);
        
        this.activeMonitors.set(key, monitor);
        this._persistMapping(videoId, youtubeUrl, owner, metadata);
        
        this.liveCache.set(youtubeUrl, {
            videoId: videoId,
            youtubeUrl: youtubeUrl,
            monitor: monitor,
            metadata: metadata,
            createdAt: Date.now(),
            hits: 1
        });
        
        console.log(`✅ Live salva para ${owner}. Total de monitores ativos: ${this.activeMonitors.size}`);
        return {
            success: true,
            videoId: videoId,
            serverUrl: `${baseUrl}/neonews/${videoId}.m3u8`,
            isLive: true,
            cached: false,
            metadata: metadata,
            extractionSource,
            message: 'Live detectada com sucesso'
        };
    }

    extractVideoId(url) {
        const match = url.match(/(?:v=|\/)([0-9A-Za-z_-]{11})(?:[?&]|$)/);
        return match ? match[1] : "url_invalida";
    }

    getLiveStats() {
        const stats = { totalMonitors: this.activeMonitors.size, lives: [] };
        for (const [key, monitor] of this.activeMonitors.entries()) {
            const [videoId, owner] = key.split(':');
            stats.lives.push({
                videoId: videoId,
                url: monitor.youtubeUrl,
                isLive: monitor.liveState === 'online',
                owner: owner || null,
                title: monitor.metadata?.title || null,
                channel: monitor.metadata?.channel || null,
                lastAccess: monitor.lastAccess ? new Date(monitor.lastAccess).toISOString() : null,
                createdAt: monitor.createdAt ? new Date(monitor.createdAt).toISOString() : null
            });
        }
        return stats;
    }
}

module.exports = ConvertAPI;
