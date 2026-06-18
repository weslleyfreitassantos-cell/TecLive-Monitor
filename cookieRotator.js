const fs = require('fs');
const path = require('path');

class CookieRotator {
    constructor(cookiesDir, statusFilePath = null) {
        this.cookiesDir = cookiesDir;
        this.statusFilePath = statusFilePath || path.join(cookiesDir, 'cookieStatus.json');
        this.cookies = ['cookie1.txt', 'cookie2.txt', 'cookie3.txt'];
        this.currentIndex = 0;
        this.emailAlerts = null; // Será injetado posteriormente
        
        // Carrega estado persistido ou inicializa novo
        this.loadStatus();
    }

    // Injeta o sistema de e-mail (para evitar dependência circular)
    setEmailAlerts(emailAlerts) {
        this.emailAlerts = emailAlerts;
    }

    // Carrega o estado do arquivo JSON
    loadStatus() {
        try {
            if (fs.existsSync(this.statusFilePath)) {
                const data = fs.readFileSync(this.statusFilePath, 'utf8');
                const parsed = JSON.parse(data);
                this.status = parsed;
                console.log('📁 Estado dos cookies carregado de', this.statusFilePath);
            } else {
                this.initDefaultStatus();
            }
        } catch (err) {
            console.error('❌ Erro ao carregar cookieStatus.json:', err.message);
            this.initDefaultStatus();
        }
    }

    // Inicializa estado padrão (todos válidos)
    initDefaultStatus() {
        this.status = {};
        for (const cookie of this.cookies) {
            this.status[cookie] = {
                state: 'valid',     // valid, suspect, invalid
                failCount: 0,
                lastFailure: null,
                lastSuccess: Date.now(),
                reason: null
            };
        }
        this.saveStatus();
    }

    // Salva estado no arquivo JSON
    saveStatus() {
        try {
            fs.writeFileSync(this.statusFilePath, JSON.stringify(this.status, null, 2), 'utf8');
        } catch (err) {
            console.error('❌ Erro ao salvar cookieStatus.json:', err.message);
        }
    }

    // Marca falha para um cookie
    markFailure(cookieName, errorMsg, videoId = null) {
        if (!this.status[cookieName]) return;

        const cookie = this.status[cookieName];
        cookie.failCount++;
        cookie.lastFailure = new Date().toISOString();
        cookie.reason = errorMsg;

        // Se atingiu 3 falhas consecutivas e ainda está válido ou suspeito, invalida
        if (cookie.failCount >= 3 && (cookie.state === 'valid' || cookie.state === 'suspect')) {
            cookie.state = 'invalid';
            cookie.failCount = 0; // reseta contagem (já está inválido)
            this.sendInvalidAlert(cookieName, errorMsg);
            console.log(`❌ Cookie ${cookieName} invalidado após 3 falhas.`);
        } else if (cookie.failCount >= 1 && cookie.failCount < 3 && cookie.state === 'valid') {
            cookie.state = 'suspect';
            console.log(`⚠️ Cookie ${cookieName} está suspeito (${cookie.failCount}/3 falhas).`);
        }
        this.saveStatus();
    }

    // Marca sucesso (cookie funcionou)
    markSuccess(cookieName) {
        if (!this.status[cookieName]) return;

        const cookie = this.status[cookieName];
        if (cookie.state === 'invalid') {
            cookie.state = 'valid';
            cookie.failCount = 0;
            cookie.lastFailure = null;
            cookie.reason = null;
            this.sendRecoveryAlert(cookieName);
            console.log(`✅ Cookie ${cookieName} recuperado (voltou a funcionar).`);
        } else if (cookie.state === 'suspect') {
            cookie.state = 'valid';
            cookie.failCount = 0;
            cookie.lastFailure = null;
            cookie.reason = null;
            console.log(`✅ Cookie ${cookieName} estabilizou (falhas resolvidas).`);
        }
        cookie.lastSuccess = new Date().toISOString();
        this.saveStatus();
    }

    // Envia e-mail de cookie inválido
    sendInvalidAlert(cookieName, errorMsg) {
        if (!this.emailAlerts) return;
        const subject = `🔴 Cookie ${cookieName} inválido - NeoNews Monitor`;
        const message = `O cookie ${cookieName} foi invalidado após 3 falhas consecutivas.\n\nÚltimo erro: ${errorMsg}\n\nAcesse o dashboard e substitua apenas este cookie.`;
        this.emailAlerts.sendEmailAlert(subject, message, 'cookie_invalid');
    }

    // Envia e-mail de recuperação
    sendRecoveryAlert(cookieName) {
        if (!this.emailAlerts) return;
        const subject = `🟢 Cookie ${cookieName} recuperado - NeoNews Monitor`;
        const message = `O cookie ${cookieName} voltou a funcionar e foi reinserido na rotação.\n\nRedundância restaurada.`;
        this.emailAlerts.sendEmailAlert(subject, message, 'cookie_recovered');
    }

    // Obtém o próximo cookie funcional (apenas válidos)
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
            reason: null
        };
        this.saveStatus();
        console.log(`🔄 Cookie ${cookieName} substituído e marcado como válido.`);
    }

    // ========== MÉTODO CORRIGIDO ==========
    // Remove a extensão .txt das chaves retornadas para compatibilidade com o dashboard
    getFunctionalStatus() {
        const result = {};
        for (const cookie of this.cookies) {
            const key = cookie.replace('.txt', ''); // "cookie1.txt" -> "cookie1"
            const cookiePath = path.join(this.cookiesDir, cookie);
            const fileExists = fs.existsSync(cookiePath) && fs.statSync(cookiePath).size > 5000;
            result[key] = {
                state: this.status[cookie]?.state || 'unknown',
                valid: this.status[cookie]?.state === 'valid' && fileExists,
                failCount: this.status[cookie]?.failCount || 0,
                lastFailure: this.status[cookie]?.lastFailure,
                lastSuccess: this.status[cookie]?.lastSuccess,
                reason: this.status[cookie]?.reason,
                fileExists
            };
        }
        return result;
    }
}

module.exports = CookieRotator;