const fs = require('fs');
const path = require('path');

class CookieRotator {
    constructor(cookiesDir, statusFilePath = null) {
        this.cookiesDir = cookiesDir;
        this.statusFilePath = statusFilePath || path.join(cookiesDir, 'cookieStatus.json');
        this.cookies = ['cookie1.txt', 'cookie2.txt', 'cookie3.txt'];
        this.currentIndex = 0;
        this.emailAlerts = null;
        this.loadStatus();
    }

    setEmailAlerts(emailAlerts) {
        this.emailAlerts = emailAlerts;
    }

    loadStatus() {
        try {
            if (fs.existsSync(this.statusFilePath)) {
                const data = fs.readFileSync(this.statusFilePath, 'utf8');
                const parsed = JSON.parse(data);
                this.status = parsed;
                for (const cookie of this.cookies) {
                    this._ensureAlertField(cookie);
                }
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
            this.status[cookie] = {
                state: 'valid',
                failCount: 0,
                lastFailure: null,
                lastSuccess: Date.now(),
                reason: null,
                alertActive: false
            };
        }
        this.saveStatus();
    }

    _ensureAlertField(cookieName) {
        if (this.status[cookieName] && this.status[cookieName].alertActive === undefined) {
            this.status[cookieName].alertActive = false;
        }
    }

    saveStatus() {
        try {
            fs.writeFileSync(this.statusFilePath, JSON.stringify(this.status, null, 2), 'utf8');
        } catch (err) {
            console.error('❌ Erro ao salvar cookieStatus.json:', err.message);
        }
    }

    markFailure(cookieName, errorMsg, videoId = null) {
        if (!this.status[cookieName]) return;
        this._ensureAlertField(cookieName);

        const cookie = this.status[cookieName];
        cookie.failCount++;
        cookie.lastFailure = new Date().toISOString();
        cookie.reason = errorMsg;
        cookie.alertActive = true;

        if (cookie.failCount >= 3 && (cookie.state === 'valid' || cookie.state === 'suspect')) {
            cookie.state = 'invalid';
            cookie.failCount = 0;
            this.sendInvalidAlert(cookieName, errorMsg);
            console.log(`❌ Cookie ${cookieName} invalidado após 3 falhas.`);
        } else if (cookie.failCount >= 1 && cookie.failCount < 3 && cookie.state === 'valid') {
            cookie.state = 'suspect';
            console.log(`⚠️ Cookie ${cookieName} está suspeito (${cookie.failCount}/3 falhas).`);
        }
        this.saveStatus();
    }

    /**
     * Marca sucesso para um cookie.
     * NUNCA REATIVA automaticamente. Apenas atualiza lastSuccess.
     * Se o cookie estiver com problema (suspect/invalid), mantém o estado e alerta.
     */
    markSuccess(cookieName) {
        if (!this.status[cookieName]) return;
        this._ensureAlertField(cookieName);

        const cookie = this.status[cookieName];
        const previousState = cookie.state;

        cookie.lastSuccess = new Date().toISOString();

        if (previousState === 'invalid' || previousState === 'suspect') {
            console.log(`ℹ️ Cookie ${cookieName} funcionou, mas mantém estado '${previousState}' até substituição manual.`);
            this.saveStatus();
            return;
        }

        // Se já era válido, apenas mantém e desliga alerta se houver
        cookie.alertActive = false;
        cookie.reason = null;
        console.log(`✅ Cookie ${cookieName} já estava válido. Alerta mantido desligado.`);
        this.saveStatus();
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
        cookie.failCount = 0;
        cookie.reason = null;
        cookie.lastFailure = null;
        cookie.alertActive = false;
        cookie.lastSuccess = new Date().toISOString();
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
            result[key] = {
                state: this.status[cookie]?.state || 'unknown',
                valid: this.status[cookie]?.state === 'valid' && fileExists,
                failCount: this.status[cookie]?.failCount || 0,
                lastFailure: this.status[cookie]?.lastFailure,
                lastSuccess: this.status[cookie]?.lastSuccess,
                reason: this.status[cookie]?.reason,
                fileExists,
                alertActive: this.status[cookie]?.alertActive || false
            };
        }
        return result;
    }
}

module.exports = CookieRotator;