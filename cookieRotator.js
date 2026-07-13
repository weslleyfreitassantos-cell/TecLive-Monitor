const fs = require('fs');
const path = require('path');

const TERMINAL_AVAILABILITY_CLASSIFICATIONS = new Set([
    'live_ended',
    'video_private',
    'video_unavailable',
    'video_removed',
    'age_restricted',
    'members_only',
    'geo_restricted'
]);

const STREAM_CAPABILITY_FAILURE_CLASSIFICATIONS = new Set([
    'no_formats',
    'invalid_hls',
    'dash_only',
    'player_response_invalid',
    'youtube_changed'
]);

const TRANSIENT_EXTRACTION_CLASSIFICATIONS = new Set([
    'timeout',
    'network',
    'server_5xx',
    'rate_limit',
    'unknown'
]);

class CookieRotator {
    constructor(cookiesDir, statusFilePath = null) {
        this.cookiesDir = cookiesDir;
        this.statusFilePath = statusFilePath || path.join(cookiesDir, 'cookieStatus.json');
        this.cookies = ['cookie1.txt', 'cookie2.txt', 'cookie3.txt'];
        this.currentIndex = 0;
        this.emailAlerts = null;
        this.refreshQueue = null;
        this.loadStatus();
    }

    setEmailAlerts(emailAlerts) {
        this.emailAlerts = emailAlerts;
    }

    setRefreshQueue(refreshQueue) {
        this.refreshQueue = refreshQueue;
    }

    loadStatus() {
        try {
            if (fs.existsSync(this.statusFilePath)) {
                const data = fs.readFileSync(this.statusFilePath, 'utf8');
                const parsed = JSON.parse(data);
                this.status = parsed;
                let normalized = false;
                for (const cookie of this.cookies) {
                    normalized = this._ensureStatusFields(cookie) || normalized;
                }
                if (normalized) this.saveStatus();
                console.log('📁 Estado dos cookies carregado de', this.statusFilePath);
            } else {
                this.initDefaultStatus();
            }
        } catch (err) {
            console.error('❌ Erro ao carregar cookieStatus.json:', err.message);
            this.initDefaultStatus();
        }
    }

    initDefaultStatus() {
        this.status = {};
        for (const cookie of this.cookies) {
            this.status[cookie] = this._defaultCookieStatus();
        }
        this.saveStatus();
    }

    _defaultCookieStatus() {
        return {
            state: 'valid',
            authValid: true,
            extractionValid: true,
            streamValid: true,
            failCount: 0,
            lastFailure: null,
            lastSuccess: new Date().toISOString(),
            lastExtractionCheck: null,
            lastExtractionFailure: null,
            lastStreamSuccess: null,
            lastStreamSuccessAt: null,
            lastStreamFailureAt: null,
            lastStreamFailureClassification: null,
            lastProbeVideoId: null,
            lastProbeAt: null,
            consecutiveStreamFailures: 0,
            streamFailureVideoIds: [],
            metadataValid: null,
            formatsValid: null,
            hlsValid: null,
            streamProbeStatus: 'unknown',
            streamProbeReason: null,
            extractionClassification: null,
            reason: null,
            alertActive: false
        };
    }

    _reasonLooksLikeTerminalAvailability(reason) {
        const value = String(reason || '').toLowerCase();
        if (!value) return false;
        return [
            'live_ended',
            'live ended',
            'this live event has ended',
            'video_private',
            'private video',
            'video_unavailable',
            'video unavailable',
            'video_removed',
            'removed',
            'members_only',
            'members-only',
            'members only',
            'geo_restricted',
            'geo restricted',
            'age_restricted',
            'age restricted'
        ].some(pattern => value.includes(pattern));
    }

    _clearTerminalAvailabilityResidue(cookie) {
        let changed = false;
        const hasTerminalClassification =
            TERMINAL_AVAILABILITY_CLASSIFICATIONS.has(cookie.extractionClassification) ||
            TERMINAL_AVAILABILITY_CLASSIFICATIONS.has(cookie.lastStreamFailureClassification);
        const hasTerminalReason = this._reasonLooksLikeTerminalAvailability(cookie.reason) ||
            this._reasonLooksLikeTerminalAvailability(cookie.streamProbeReason);

        if (!hasTerminalClassification && !hasTerminalReason) return false;

        if (cookie.extractionClassification !== null &&
            TERMINAL_AVAILABILITY_CLASSIFICATIONS.has(cookie.extractionClassification)) {
            cookie.extractionClassification = null;
            changed = true;
        }
        if (cookie.lastStreamFailureClassification !== null &&
            TERMINAL_AVAILABILITY_CLASSIFICATIONS.has(cookie.lastStreamFailureClassification)) {
            cookie.lastStreamFailureClassification = null;
            changed = true;
        }
        if (this._reasonLooksLikeTerminalAvailability(cookie.reason)) {
            cookie.reason = null;
            changed = true;
        }
        if (this._reasonLooksLikeTerminalAvailability(cookie.streamProbeReason)) {
            cookie.streamProbeReason = null;
            changed = true;
        }
        if ((Number(cookie.consecutiveStreamFailures) || 0) > 0) {
            cookie.consecutiveStreamFailures = 0;
            changed = true;
        }
        if (Array.isArray(cookie.streamFailureVideoIds) && cookie.streamFailureVideoIds.length > 0) {
            cookie.streamFailureVideoIds = [];
            changed = true;
        }
        if (cookie.lastExtractionFailure !== null) {
            cookie.lastExtractionFailure = null;
            changed = true;
        }
        if (cookie.lastStreamFailureAt !== null) {
            cookie.lastStreamFailureAt = null;
            changed = true;
        }
        if (cookie.extractionValid === false) {
            cookie.extractionValid = true;
            changed = true;
        }
        if (cookie.streamValid === false) {
            cookie.streamValid = true;
            changed = true;
        }
        if (cookie.hlsValid === false) {
            cookie.hlsValid = cookie.lastStreamSuccess || cookie.lastStreamSuccessAt ? true : null;
            changed = true;
        }
        if (cookie.streamProbeStatus === 'error' || cookie.streamProbeStatus === 'degraded') {
            cookie.streamProbeStatus = cookie.lastStreamSuccess || cookie.lastStreamSuccessAt ? 'ok' : 'unknown';
            changed = true;
        }

        return changed;
    }

    _ensureStatusFields(cookieName) {
        let changed = false;
        if (!this.status[cookieName]) {
            this.status[cookieName] = this._defaultCookieStatus();
            return true;
        }

        const cookie = this.status[cookieName];
        if (cookie.failCount === undefined && cookie.faiCount !== undefined) {
            cookie.failCount = cookie.faiCount;
            changed = true;
        }
        if (cookie.faiCount !== undefined) {
            delete cookie.faiCount;
            changed = true;
        }

        if (cookie.state === undefined) {
            cookie.state = 'valid';
            changed = true;
        }
        const normalizedFailCount = Number(cookie.failCount);
        if (!Number.isFinite(normalizedFailCount) || normalizedFailCount < 0) {
            cookie.failCount = 0;
            changed = true;
        } else if (cookie.failCount !== normalizedFailCount) {
            cookie.failCount = normalizedFailCount;
            changed = true;
        }
        if (cookie.lastFailure === undefined) {
            cookie.lastFailure = null;
            changed = true;
        }
        if (cookie.lastSuccess === undefined) {
            cookie.lastSuccess = null;
            changed = true;
        }
        if (cookie.reason === undefined) {
            cookie.reason = null;
            changed = true;
        }
        if (cookie.alertActive === undefined) {
            cookie.alertActive = false;
            changed = true;
        }
        if (cookie.authValid === undefined) {
            cookie.authValid = cookie.state !== 'invalid';
            changed = true;
        }
        if (cookie.extractionValid === undefined) {
            cookie.extractionValid = true;
            changed = true;
        }
        if (cookie.streamValid === undefined) {
            cookie.streamValid = true;
            changed = true;
        }
        if (cookie.lastExtractionCheck === undefined) {
            cookie.lastExtractionCheck = null;
            changed = true;
        }
        if (cookie.lastExtractionFailure === undefined) {
            cookie.lastExtractionFailure = null;
            changed = true;
        }
        if (cookie.lastStreamSuccess === undefined) {
            cookie.lastStreamSuccess = null;
            changed = true;
        }
        if (cookie.lastStreamSuccessAt === undefined) {
            cookie.lastStreamSuccessAt = cookie.lastStreamSuccess || null;
            changed = true;
        }
        if (cookie.lastStreamFailureAt === undefined) {
            cookie.lastStreamFailureAt = null;
            changed = true;
        }
        if (cookie.lastStreamFailureClassification === undefined) {
            cookie.lastStreamFailureClassification = null;
            changed = true;
        }
        if (cookie.lastProbeVideoId === undefined) {
            cookie.lastProbeVideoId = null;
            changed = true;
        }
        if (cookie.lastProbeAt === undefined) {
            cookie.lastProbeAt = null;
            changed = true;
        }
        if (cookie.consecutiveStreamFailures === undefined) {
            cookie.consecutiveStreamFailures = 0;
            changed = true;
        }
        if (!Array.isArray(cookie.streamFailureVideoIds)) {
            cookie.streamFailureVideoIds = [];
            changed = true;
        }
        if (cookie.metadataValid === undefined) {
            cookie.metadataValid = null;
            changed = true;
        }
        if (cookie.formatsValid === undefined) {
            cookie.formatsValid = null;
            changed = true;
        }
        if (cookie.hlsValid === undefined) {
            cookie.hlsValid = null;
            changed = true;
        }
        if (cookie.streamProbeStatus === undefined) {
            cookie.streamProbeStatus = cookie.extractionValid === false || cookie.streamValid === false
                ? 'degraded'
                : 'unknown';
            changed = true;
        }
        if (cookie.streamProbeReason === undefined) {
            cookie.streamProbeReason = null;
            changed = true;
        }
        if (cookie.extractionClassification === undefined) {
            cookie.extractionClassification = null;
            changed = true;
        }
        if (cookie.state === 'valid' && this._clearTerminalAvailabilityResidue(cookie)) {
            changed = true;
        }

        return changed;
    }

    _ensureAlertField(cookieName) {
        this._ensureStatusFields(cookieName);
    }

    saveStatus() {
        try {
            fs.writeFileSync(this.statusFilePath, JSON.stringify(this.status, null, 2), 'utf8');
        } catch (err) {
            console.error('❌ Erro ao salvar cookieStatus.json:', err.message);
        }
    }

    _shortError(errorMsg) {
        return String(errorMsg || '').replace(/\s+/g, ' ').trim().slice(0, 180);
    }

    _queueCookieName(cookieName) {
        return String(cookieName || '').replace(/\.txt$/i, '');
    }

    _enqueueRefreshIfAvailable(cookieName, reason) {
        if (!this.refreshQueue || typeof this.refreshQueue.enqueue !== 'function') return;
        try {
            const result = this.refreshQueue.enqueue(this._queueCookieName(cookieName), 'automatic', this._shortError(reason));
            if (result?.created) {
                console.log(`🧾 Tarefa automática de atualização criada para ${cookieName}: ${result.job.id}`);
            } else {
                console.log(`ℹ️ Tarefa ativa já existe para ${cookieName}; nova tarefa automática não foi criada.`);
            }
        } catch (err) {
            console.error(`⚠️ Falha ao criar tarefa automática para ${cookieName}: ${err.message}`);
        }
    }

    _cancelPendingRefreshIfAvailable(cookieName) {
        if (!this.refreshQueue || typeof this.refreshQueue.cancelPendingForCookie !== 'function') return;
        try {
            const cancelled = this.refreshQueue.cancelPendingForCookie(
                this._queueCookieName(cookieName),
                'cookie revalidado antes da execução'
            );
            if (cancelled.length > 0) {
                console.log(`🧾 ${cancelled.length} tarefa(s) pendente(s) cancelada(s) para ${cookieName} após revalidação.`);
            }
        } catch (err) {
            console.error(`⚠️ Falha ao cancelar tarefa pendente para ${cookieName}: ${err.message}`);
        }
    }

    _isKnownNonCookieError(errorMsg) {
        const msg = String(errorMsg || '').toLowerCase();
        const nonCookiePatterns = [
            'private video',
            'video unavailable',
            'this video is unavailable',
            'this video is private',
            'not available',
            'has been removed',
            'removed by the uploader',
            'copyright claim',
            'copyright',
            'this live event has ended',
            'live event has ended',
            'recording is not available',
            'premiere will begin',
            'premieres in',
            'not currently live',
            'members-only',
            'members only',
            'network is unreachable',
            'econnreset',
            'etimedout',
            'enotfound',
            'eai_again',
            'socket hang up',
            'tls connection',
            'timeout',
            'timed out',
            'http error 500',
            'http error 502',
            'http error 503',
            'http error 504'
        ];

        return nonCookiePatterns.some(pattern => msg.includes(pattern));
    }

    isCookieAuthError(errorMsg) {
        const msg = String(errorMsg || '').toLowerCase();
        if (!msg || this._isKnownNonCookieError(msg)) return false;

        const cookieAuthPatterns = [
            'cookies are no longer valid',
            'cookie file is invalid',
            'invalid cookie',
            'invalid cookies',
            'cookie header is invalid',
            'cookiefile',
            'use --cookies',
            'pass cookies',
            'export cookies',
            'login required',
            'authentication required',
            'requires authentication',
            'autenticação/cookie',
            'autenticacao/cookie',
            'sign in to confirm',
            'sign in to verify',
            'confirm you’re not a bot',
            "confirm you're not a bot",
            'not a bot',
            'protect our community'
        ];

        return cookieAuthPatterns.some(pattern => msg.includes(pattern));
    }

    markFailure(cookieName, errorMsg, videoId = null) {
        if (!this.status[cookieName]) return false;
        this._ensureStatusFields(cookieName);

        if (!this.isCookieAuthError(errorMsg)) {
            console.log(`ℹ️ Falha de ${cookieName} não alterou estado: não parece erro de cookie/autenticação. Erro: ${this._shortError(errorMsg)}`);
            return false;
        }

        const cookie = this.status[cookieName];
        const previousState = cookie.state || 'valid';
        const previousFailCount = Number(cookie.failCount) || 0;
        const context = videoId ? ` (${videoId})` : '';

        cookie.failCount = previousState === 'invalid'
            ? Math.max(previousFailCount, 3)
            : previousFailCount + 1;
        cookie.lastFailure = new Date().toISOString();
        cookie.reason = errorMsg;
        cookie.alertActive = true;
        cookie.authValid = false;
        cookie.extractionValid = false;
        cookie.streamValid = false;
        cookie.lastExtractionCheck = cookie.lastFailure;
        cookie.lastExtractionFailure = cookie.lastFailure;
        cookie.lastProbeAt = cookie.lastFailure;
        cookie.lastProbeVideoId = videoId || cookie.lastProbeVideoId || null;
        cookie.consecutiveStreamFailures = Number(cookie.consecutiveStreamFailures) || 0;
        cookie.extractionClassification = 'auth_cookie';
        cookie.metadataValid = false;
        cookie.formatsValid = false;
        cookie.hlsValid = false;
        cookie.streamProbeStatus = 'error';
        cookie.streamProbeReason = errorMsg;
        cookie.lastStreamFailureAt = cookie.lastFailure;
        cookie.lastStreamFailureClassification = 'auth_cookie';

        console.log(`⚠️ Cookie ${cookieName} falhou${context}: ${this._shortError(errorMsg)} (${Math.min(cookie.failCount, 3)}/3)`);

        if (cookie.failCount >= 3) {
            cookie.state = 'invalid';
            if (previousState !== 'invalid') {
                this.sendInvalidAlert(cookieName, errorMsg);
                console.log(`❌ Cookie ${cookieName} foi invalidado após ${cookie.failCount} falhas de autenticação/cookie.`);
                this._enqueueRefreshIfAvailable(cookieName, errorMsg);
            } else {
                console.log(`❌ Cookie ${cookieName} permanece invalid após nova falha de autenticação/cookie.`);
            }
        } else {
            cookie.state = 'suspect';
            if (previousState !== 'suspect') {
                console.log(`⚠️ Cookie ${cookieName} ficou suspect (${cookie.failCount}/3 falhas).`);
            } else {
                console.log(`⚠️ Cookie ${cookieName} continua suspect (${cookie.failCount}/3 falhas).`);
            }
        }
        this.saveStatus();
        return true;
    }

    /**
     * Marca sucesso real para um cookie e reativa automaticamente.
     */
    markSuccess(cookieName) {
        if (!this.status[cookieName]) return false;
        this._ensureStatusFields(cookieName);

        const cookie = this.status[cookieName];
        const previousState = cookie.state;
        const hadFailureInfo = (Number(cookie.failCount) || 0) > 0 ||
            Boolean(cookie.lastFailure) ||
            Boolean(cookie.reason) ||
            cookie.alertActive === true;

        cookie.state = 'valid';
        cookie.authValid = true;
        cookie.extractionValid = true;
        cookie.streamValid = true;
        cookie.failCount = 0;
        cookie.lastSuccess = new Date().toISOString();
        cookie.lastExtractionCheck = cookie.lastSuccess;
        cookie.lastStreamSuccess = cookie.lastSuccess;
        cookie.lastStreamSuccessAt = cookie.lastSuccess;
        cookie.lastExtractionFailure = null;
        cookie.lastStreamFailureAt = null;
        cookie.lastStreamFailureClassification = null;
        cookie.extractionClassification = null;
        cookie.lastFailure = null;
        cookie.reason = null;
        cookie.streamProbeReason = null;
        cookie.metadataValid = true;
        cookie.formatsValid = true;
        cookie.hlsValid = true;
        cookie.streamProbeStatus = 'ok';
        cookie.consecutiveStreamFailures = 0;
        cookie.streamFailureVideoIds = [];
        cookie.alertActive = false;
        this.saveStatus();

        if (previousState === 'invalid' || previousState === 'suspect') {
            console.log(`✅ Cookie ${cookieName} foi revalidado após sucesso real do yt-dlp (${previousState} -> valid).`);
            this._cancelPendingRefreshIfAvailable(cookieName);
        } else if (hadFailureInfo) {
            console.log(`✅ Cookie ${cookieName} recuperado após sucesso real do yt-dlp; falhas anteriores zeradas.`);
            this._cancelPendingRefreshIfAvailable(cookieName);
        } else {
            console.log(`✅ Cookie ${cookieName} válido; sucesso registrado.`);
        }
        return true;
    }

    _rememberStreamFailureVideo(cookie, videoId) {
        if (!videoId) return;
        const current = Array.isArray(cookie.streamFailureVideoIds)
            ? cookie.streamFailureVideoIds
            : [];
        const withoutCurrent = current.filter(item => item !== videoId);
        withoutCurrent.unshift(videoId);
        cookie.streamFailureVideoIds = withoutCurrent.slice(0, 5);
    }

    markExtractionFailure(cookieName, classification, errorMsg = '', context = null, options = {}) {
        if (!this.status[cookieName]) return false;
        this._ensureStatusFields(cookieName);
        const cookie = this.status[cookieName];
        const nowIso = new Date().toISOString();
        const normalizedClassification = classification || 'unknown';
        const isTerminalAvailability = TERMINAL_AVAILABILITY_CLASSIFICATIONS.has(normalizedClassification);
        cookie.lastExtractionCheck = nowIso;
        cookie.lastProbeAt = nowIso;
        cookie.lastProbeVideoId = options.probeVideoId || options.videoId || cookie.lastProbeVideoId || null;

        if (isTerminalAvailability) {
            if (options.metadataValid === true) cookie.metadataValid = true;
            if (options.formatsValid === true) cookie.formatsValid = true;
            if (options.hlsValid === true) cookie.hlsValid = true;
            this._clearTerminalAvailabilityResidue(cookie);
            const suffix = context ? ` (${context})` : '';
            console.log(`ℹ️ Cookie ${cookieName} preservado${suffix}: ${normalizedClassification} pertence ao video de validacao, nao ao cookie.`);
            this.saveStatus();
            return false;
        }

        cookie.metadataValid = options.metadataValid ?? cookie.metadataValid;
        cookie.formatsValid = options.formatsValid ?? cookie.formatsValid;
        if (options.hlsValid !== undefined) {
            cookie.hlsValid = options.hlsValid;
        }
        cookie.extractionClassification = normalizedClassification;
        if (TRANSIENT_EXTRACTION_CLASSIFICATIONS.has(normalizedClassification)) {
            cookie.lastExtractionFailure = nowIso;
            cookie.streamProbeStatus = 'inconclusive';
            cookie.reason = errorMsg || cookie.reason;
            cookie.streamProbeReason = errorMsg || cookie.streamProbeReason;
            const suffix = context ? ` (${context})` : '';
            console.log(`ℹ️ Cookie ${cookieName} com validação de stream inconclusiva${suffix}: ${cookie.extractionClassification} - ${this._shortError(errorMsg)}`);
            this.saveStatus();
            return false;
        }

        cookie.lastExtractionFailure = nowIso;
        cookie.lastStreamFailureAt = nowIso;
        cookie.lastStreamFailureClassification = normalizedClassification;
        cookie.streamProbeReason = errorMsg || cookie.streamProbeReason;
        cookie.consecutiveStreamFailures = (Number(cookie.consecutiveStreamFailures) || 0) + 1;
        this._rememberStreamFailureVideo(cookie, cookie.lastProbeVideoId);
        if (STREAM_CAPABILITY_FAILURE_CLASSIFICATIONS.has(normalizedClassification)) {
            cookie.extractionValid = false;
            cookie.streamValid = false;
            cookie.hlsValid = false;
            cookie.streamProbeStatus = 'degraded';
        }
        if (normalizedClassification === 'auth_cookie') {
            cookie.authValid = false;
            cookie.extractionValid = false;
            cookie.streamValid = false;
            cookie.streamProbeStatus = 'error';
        }
        cookie.reason = errorMsg || cookie.reason;
        const suffix = context ? ` (${context})` : '';
        console.log(`⚠️ Cookie ${cookieName} sem stream valida${suffix}: ${cookie.extractionClassification} - ${this._shortError(errorMsg)}`);
        this.saveStatus();
        return true;
    }

    markExtractionSuccess(cookieName, options = {}) {
        if (!this.status[cookieName]) return false;
        this._ensureStatusFields(cookieName);
        const cookie = this.status[cookieName];
        cookie.lastProbeVideoId = options.probeVideoId || options.videoId || cookie.lastProbeVideoId || null;
        cookie.metadataValid = true;
        cookie.formatsValid = true;
        cookie.hlsValid = true;
        cookie.streamProbeStatus = 'ok';
        cookie.streamProbeReason = null;
        cookie.lastStreamFailureAt = null;
        cookie.lastStreamFailureClassification = null;
        cookie.consecutiveStreamFailures = 0;
        cookie.streamFailureVideoIds = [];
        return this.markSuccess(cookieName);
    }

    /**
     * Reativa MANUALMENTE um cookie que está 'suspect' ou 'invalid'.
     * Deve ser chamado apenas quando o usuário substituir o arquivo e clicar no botão.
     */
    reactivateCookie(cookieName) {
        if (!this.status[cookieName]) return false;
        const cookie = this.status[cookieName];
        if (cookie.state !== 'invalid' && cookie.state !== 'suspect') {
            console.log(`ℹ️ Cookie ${cookieName} não está com problema, não é necessário reativar.`);
            return false;
        }

        const cookiePath = path.join(this.cookiesDir, cookieName);
        if (!fs.existsSync(cookiePath) || fs.statSync(cookiePath).size < 5000) {
            console.error(`❌ Arquivo ${cookieName} não existe ou está vazio. Não é possível reativar.`);
            return false;
        }

        cookie.state = 'valid';
        cookie.authValid = true;
        cookie.extractionValid = true;
        cookie.streamValid = true;
        cookie.failCount = 0;
        cookie.reason = null;
        cookie.lastFailure = null;
        cookie.lastExtractionFailure = null;
        cookie.lastStreamFailureAt = null;
        cookie.lastStreamFailureClassification = null;
        cookie.lastProbeAt = cookie.lastSuccess;
        cookie.lastProbeVideoId = null;
        cookie.consecutiveStreamFailures = 0;
        cookie.streamFailureVideoIds = [];
        cookie.metadataValid = true;
        cookie.formatsValid = true;
        cookie.hlsValid = true;
        cookie.streamProbeStatus = 'ok';
        cookie.streamProbeReason = null;
        cookie.extractionClassification = null;
        cookie.alertActive = false;
        cookie.lastSuccess = new Date().toISOString();
        cookie.lastExtractionCheck = cookie.lastSuccess;
        cookie.lastStreamSuccess = cookie.lastSuccess;
        cookie.lastStreamSuccessAt = cookie.lastSuccess;
        this.saveStatus();

        this.sendManualRecoveryAlert(cookieName);
        console.log(`🔁 Cookie ${cookieName} reativado manualmente.`);
        return true;
    }

    // ========== Envio de e-mails (delega ao EmailAlerts) ==========
    sendInvalidAlert(cookieName, errorMsg) {
        if (this.emailAlerts) {
            this.emailAlerts.sendCookieInvalidAlert(cookieName, errorMsg);
        }
    }

    sendManualRecoveryAlert(cookieName) {
        if (this.emailAlerts) {
            this.emailAlerts.sendCookieManualRecoveredAlert(cookieName);
        }
    }

    // ========== Rotação ==========
    getNextCookiePath() {
        const validCookies = this.cookies.filter(cookie => {
            const cookiePath = path.join(this.cookiesDir, cookie);
            return this.status[cookie]?.state === 'valid' &&
                   fs.existsSync(cookiePath) &&
                   fs.statSync(cookiePath).size > 5000;
        });

        if (validCookies.length === 0) {
            for (const cookie of this.cookies) {
                const cookiePath = path.join(this.cookiesDir, cookie);
                if (fs.existsSync(cookiePath)) return cookiePath;
            }
            return this.getFallbackCookiePath();
        }

        let start = this.currentIndex % validCookies.length;
        const selected = validCookies[start];
        this.currentIndex = (start + 1) % validCookies.length;
        return path.join(this.cookiesDir, selected);
    }

    getFallbackCookiePath() {
        const mainPath = path.join(this.cookiesDir, 'main.txt');
        const backupPath = path.join(this.cookiesDir, 'backup.txt');
        if (fs.existsSync(mainPath) && fs.statSync(mainPath).size > 5000) return mainPath;
        if (fs.existsSync(backupPath) && fs.statSync(backupPath).size > 5000) return backupPath;
        return null;
    }

    hasValidCookies() {
        for (const cookie of this.cookies) {
            const cookiePath = path.join(this.cookiesDir, cookie);
            if (this.status[cookie]?.state === 'valid' &&
                fs.existsSync(cookiePath) &&
                fs.statSync(cookiePath).size > 5000) {
                return true;
            }
        }
        return false;
    }

    getFunctionalStatus() {
        const result = {};
        for (const cookie of this.cookies) {
            const key = cookie.replace('.txt', '');
            const cookiePath = path.join(this.cookiesDir, cookie);
            const fileExists = fs.existsSync(cookiePath) && fs.statSync(cookiePath).size > 5000;
            this._ensureAlertField(cookie);
            const status = this.status[cookie] || {};
            const authValid = status.authValid !== false && status.state === 'valid';
            const extractionValid = status.extractionValid !== false;
            const streamValid = status.streamValid !== false;
            const authReady = status.state === 'valid' && fileExists && authValid;
            const streamReady = authReady && extractionValid && streamValid && status.hlsValid !== false;
            const capabilityStatus = !authReady
                ? 'error'
                : streamReady
                    ? 'ok'
                    : status.streamProbeStatus === 'inconclusive'
                        ? 'inconclusive'
                        : 'degraded';
            result[key] = {
                state: status.state || 'unknown',
                authValid,
                extractionValid,
                streamValid,
                authReady,
                streamReady,
                capabilityStatus,
                valid: authReady,
                failCount: status.failCount || 0,
                lastFailure: status.lastFailure,
                lastSuccess: status.lastSuccess,
                lastExtractionCheck: status.lastExtractionCheck || null,
                lastExtractionFailure: status.lastExtractionFailure || null,
                lastStreamSuccess: status.lastStreamSuccess || null,
                lastStreamSuccessAt: status.lastStreamSuccessAt || null,
                lastStreamFailureAt: status.lastStreamFailureAt || null,
                lastStreamFailureClassification: status.lastStreamFailureClassification || null,
                lastProbeVideoId: status.lastProbeVideoId || null,
                lastProbeAt: status.lastProbeAt || null,
                consecutiveStreamFailures: Number(status.consecutiveStreamFailures) || 0,
                streamFailureVideoIds: Array.isArray(status.streamFailureVideoIds)
                    ? status.streamFailureVideoIds.slice(0, 5)
                    : [],
                metadataValid: status.metadataValid ?? null,
                formatsValid: status.formatsValid ?? null,
                hlsValid: status.hlsValid ?? null,
                streamProbeStatus: status.streamProbeStatus || 'unknown',
                streamProbeReason: status.streamProbeReason || null,
                extractionClassification: status.extractionClassification || null,
                reason: status.reason,
                fileExists,
                alertActive: status.alertActive || false
            };
        }
        return result;
    }
}

module.exports = CookieRotator;
