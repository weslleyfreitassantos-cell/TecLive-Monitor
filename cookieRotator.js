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

    // 🔧 CORREÇÃO: ao recuperar, desliga o alerta automaticamente e limpa o histórico
    markSuccess(cookieName) {
        if (!this.status[cookieName]) return;
        this._ensureAlertField(cookieName);

        const cookie = this.status[cookieName];
        const wasProblem = cookie.state === 'invalid' || cookie.state === 'suspect';

        if (wasProblem) {
            cookie.state = 'valid';
            cookie.failCount = 0;
            cookie.reason = null;
            cookie.lastFailure = null;
            cookie.alertActive = false;  // 🔥 DESLIGA O ALERTA AUTOMATICAMENTE
            this.sendRecoveryAlert(cookieName);
            console.log(`✅ Cookie ${cookieName} recuperado e alerta desligado.`);
        } else {
            // Se já estava válido, apenas garante que o alerta esteja desligado
            cookie.alertActive = false;
            cookie.reason = null;
            cookie.lastFailure = null;
            console.log(`✅ Cookie ${cookieName} já estava válido. Alerta mantido desligado.`);
        }
        cookie.lastSuccess = new Date().toISOString();
        this.saveStatus();
    }

    sendInvalidAlert(cookieName, errorMsg) {
        if (!this.emailAlerts) return;
        const subject = `🔴 Cookie ${cookieName} inválido - NeoNews Monitor`;
        const message = `O cookie ${cookieName} foi invalidado após 3 falhas consecutivas.\n\nÚltimo erro: ${errorMsg}\n\nAcesse o dashboard e substitua apenas este cookie.`;
        this.emailAlerts.sendEmailAlert(subject, message, 'cookie_invalid');
    }

    sendRecoveryAlert(cookieName) {
        if (!this.emailAlerts) return;
        const subject = `🟢 Cookie ${cookieName} recuperado - NeoNews Monitor`;
        const message = `O cookie ${cookieName} voltou a funcionar e o alerta foi removido automaticamente.`;
        this.emailAlerts.sendEmailAlert(subject, message, 'cookie_recovered');
    }

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

    async replaceCookie(cookieName, newCookiePath) {
        const targetPath = path.join(this.cookiesDir, cookieName);
        if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
        fs.renameSync(newCookiePath, targetPath);
        this.status[cookieName] = {
            state: 'valid',
            failCount: 0,
            lastFailure: null,
            lastSuccess: Date.now(),
            reason: null,
            alertActive: false
        };
        this.saveStatus();
        console.log(`🔄 Cookie ${cookieName} substituído e marcado como válido. Alerta desligado.`);
    }

    clearAlert(cookieName) {
        if (!this.status[cookieName]) return;
        this.status[cookieName].alertActive = false;
        this.saveStatus();
        console.log(`🔕 Alerta de ${cookieName} desligado manualmente.`);
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