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
            extractionClassification: null,
            reason: null,
            alertActive: false
        };
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
        if (cookie.extractionClassification === undefined) {
            cookie.extractionClassification = null;
            changed = true;
        }
        if (
            cookie.state === 'valid' &&
            TERMINAL_AVAILABILITY_CLASSIFICATIONS.has(cookie.extractionClassification) &&
            (cookie.extractionValid === false || cookie.streamValid === false)
        ) {
            cookie.extractionValid = true;
            cookie.streamValid = true;
            cookie.lastExtractionFailure = null;
            cookie.extractionClassification = null;
            if (String(cookie.reason || '').includes('live_ended') || String(cookie.reason || '').includes('video_')) {
                cookie.reason = null;
            }
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
        cookie.extractionClassification = 'auth_cookie';

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
        cookie.lastExtractionFailure = null;
        cookie.extractionClassification = null;
        cookie.lastFailure = null;
        cookie.reason = null;
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

    markExtractionFailure(cookieName, classification, errorMsg = '', context = null) {
        if (!this.status[cookieName]) return false;
        this._ensureStatusFields(cookieName);
        const cookie = this.status[cookieName];
        const nowIso = new Date().toISOString();
        const normalizedClassification = classification || 'unknown';
        cookie.lastExtractionCheck = nowIso;
        if (TERMINAL_AVAILABILITY_CLASSIFICATIONS.has(normalizedClassification)) {
            const suffix = context ? ` (${context})` : '';
            console.log(`ℹ️ Cookie ${cookieName} preservado${suffix}: ${normalizedClassification} pertence ao video de validacao, nao ao cookie.`);
            this.saveStatus();
            return false;
        }
        cookie.lastExtractionFailure = nowIso;
        cookie.extractionClassification = normalizedClassification;
        cookie.extractionValid = false;
        cookie.streamValid = false;
        if (normalizedClassification === 'auth_cookie') {
            cookie.authValid = false;
        }
        cookie.reason = errorMsg || cookie.reason;
        const suffix = context ? ` (${context})` : '';
        console.log(`⚠️ Cookie ${cookieName} sem stream valida${suffix}: ${cookie.extractionClassification} - ${this._shortError(errorMsg)}`);
        this.saveStatus();
        return true;
    }

    markExtractionSuccess(cookieName) {
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
        cookie.extractionClassification = null;
        cookie.alertActive = false;
        cookie.lastSuccess = new Date().toISOString();
        cookie.lastExtractionCheck = cookie.lastSuccess;
        cookie.lastStreamSuccess = cookie.lastSuccess;
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
            result[key] = {
                state: status.state || 'unknown',
                authValid,
                extractionValid,
                streamValid,
                valid: status.state === 'valid' && fileExists && authValid && extractionValid && streamValid,
                failCount: status.failCount || 0,
                lastFailure: status.lastFailure,
                lastSuccess: status.lastSuccess,
                lastExtractionCheck: status.lastExtractionCheck || null,
                lastExtractionFailure: status.lastExtractionFailure || null,
                lastStreamSuccess: status.lastStreamSuccess || null,
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
