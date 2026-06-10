$systemStatePath = "C:\Users\Weslley\Downloads\youtube-live-api-v3\systemState.js"

$fixedSystemState = @'
// systemState.js - Com persistência COMPLETA do estado
const fs = require('fs');
const path = require('path');

class SystemState {
    constructor() {
        this.state = {
            cookieStatus: 'unknown',
            lastCookieCheck: null,
            lastCookieCheckSuccess: null,
            lastCookieError: null,
            lastRenewSuccess: null,
            lastRenewSuccessDisplay: null,
            activeCookie: null,
            usingBackup: false,
            cookieValidated: false,
            consecutiveFailures: 0,
            maxFailures: 5,
            lastRecoveryEmailSent: null,
            lastWarningEmailSent: null,
            invalidSince: null,
            validSince: null,
            lastAttemptTime: null,
            lastAttemptError: null
        };
        
        this.cookiesDir = path.join(__dirname, 'cookies');
        this.emailAlerts = null;
        this.loadState();
    }

    setEmailAlerts(emailAlerts) {
        this.emailAlerts = emailAlerts;
        console.log('📧 Sistema de alertas configurado no SystemState');
    }

    loadState() {
        try {
            const stateFile = path.join(__dirname, '.system_state.json');
            if (fs.existsSync(stateFile)) {
                const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
                this.state = { ...this.state, ...saved };
                console.log(`📂 Estado carregado:`);
                console.log(`   - Status: ${this.state.cookieStatus}`);
                console.log(`   - Falhas: ${this.state.consecutiveFailures}/${this.state.maxFailures}`);
                console.log(`   - Última tentativa: ${this.state.lastAttemptTime || 'Nunca'}`);
                console.log(`   - Último sucesso: ${this.state.lastRenewSuccess || 'Nunca'}`);
            }
        } catch(e) {
            console.log('⚠️ Erro ao carregar estado persistido');
        }
    }

    saveState() {
        try {
            const stateFile = path.join(__dirname, '.system_state.json');
            const toSave = {
                cookieStatus: this.state.cookieStatus,
                lastRenewSuccess: this.state.lastRenewSuccess,
                lastRenewSuccessDisplay: this.state.lastRenewSuccessDisplay,
                consecutiveFailures: this.state.consecutiveFailures,
                maxFailures: this.state.maxFailures,
                invalidSince: this.state.invalidSince,
                validSince: this.state.validSince,
                lastAttemptTime: this.state.lastAttemptTime,
                lastAttemptError: this.state.lastAttemptError,
                lastCookieCheck: this.state.lastCookieCheck
            };
            fs.writeFileSync(stateFile, JSON.stringify(toSave, null, 2));
            console.log(`💾 Estado persistido: Falhas ${this.state.consecutiveFailures}/${this.state.maxFailures}`);
        } catch(e) {}
    }

    getState() {
        const mainPath = path.join(this.cookiesDir, 'main.txt');
        const backupPath = path.join(this.cookiesDir, 'backup.txt');
        
        let lastRenewDisplay = 'Nunca';
        let lastRenewTimeAgo = null;
        if (this.state.lastRenewSuccess) {
            const lastRenew = new Date(this.state.lastRenewSuccess);
            const now = new Date();
            const diffMinutes = Math.floor((now - lastRenew) / 60000);
            
            if (diffMinutes < 1) {
                lastRenewDisplay = `${new Date(this.state.lastRenewSuccess).toLocaleString()} (há poucos segundos)`;
            } else if (diffMinutes < 60) {
                lastRenewDisplay = `${new Date(this.state.lastRenewSuccess).toLocaleString()} (há ${diffMinutes} minutos)`;
            } else {
                const diffHours = Math.floor(diffMinutes / 60);
                const diffRemainingMinutes = diffMinutes % 60;
                lastRenewDisplay = `${new Date(this.state.lastRenewSuccess).toLocaleString()} (há ${diffHours}h ${diffRemainingMinutes}min)`;
            }
            lastRenewTimeAgo = diffMinutes;
        }
        
        return {
            ...this.state,
            fileExists: fs.existsSync(mainPath),
            backupExists: fs.existsSync(backupPath),
            lastCheck: new Date().toISOString(),
            lastRenewDisplay: lastRenewDisplay,
            lastRenewTimeAgo: lastRenewTimeAgo,
            failureProgress: `${this.state.consecutiveFailures} / ${this.state.maxFailures}`,
            failurePercent: (this.state.consecutiveFailures / this.state.maxFailures) * 100,
            lastAttemptDisplay: this.state.lastAttemptTime ? new Date(this.state.lastAttemptTime).toLocaleString() : 'Nunca'
        };
    }

    setCookieStatus(status, error = null) {
        const oldStatus = this.state.cookieStatus;
        const now = new Date().toISOString();
        
        this.state.cookieStatus = status;
        this.state.lastCookieCheck = now;
        this.state.lastAttemptTime = now;
        
        if (error) {
            this.state.lastAttemptError = error;
            this.state.lastCookieError = error;
        }
        
        if (status === 'invalid' && oldStatus !== 'invalid') {
            this.state.invalidSince = now;
            this.state.validSince = null;
        } else if (status === 'valid' && oldStatus !== 'valid') {
            this.state.validSince = now;
            this.state.invalidSince = null;
        }
        
        const mainPath = path.join(this.cookiesDir, 'main.txt');
        const backupPath = path.join(this.cookiesDir, 'backup.txt');
        
        if (fs.existsSync(mainPath) && status === 'valid') {
            this.state.activeCookie = 'main.txt';
            this.state.usingBackup = false;
        } else if (fs.existsSync(backupPath) && status === 'backup') {
            this.state.activeCookie = 'backup.txt';
            this.state.usingBackup = true;
        }
        
        console.log(`📊 Estado alterado: ${oldStatus} → ${status}`);
        this.saveState();
    }

    registerFailure(error) {
        this.state.consecutiveFailures++;
        this.state.lastCookieError = error;
        this.state.lastCookieCheck = new Date().toISOString();
        this.state.lastAttemptTime = this.state.lastCookieCheck;
        this.state.lastAttemptError = error;
        
        console.log(`❌ Falha ${this.state.consecutiveFailures}/${this.state.maxFailures}`);
        
        if (this.state.consecutiveFailures === 3 && this.emailAlerts) {
            this.sendWarningEmail(this.emailAlerts);
        }
        
        if (this.state.consecutiveFailures >= this.state.maxFailures && this.state.cookieStatus !== 'invalid') {
            this.setCookieStatus('invalid', error);
        }
        
        this.saveState();
    }

    async sendWarningEmail(emailAlerts) {
        const now = Date.now();
        if (this.state.lastWarningEmailSent && (now - this.state.lastWarningEmailSent) < 3600000) {
            console.log('⏸️ E-mail de aviso em cooldown (1 hora)');
            return;
        }
        
        const message = `
⚠️ AVISO - COOKIE PRESTES A EXPIRAR

O cookie do YouTube está apresentando falhas consecutivas.

📊 Status atual:
- Falhas consecutivas: ${this.state.consecutiveFailures} / ${this.state.maxFailures}
- Último erro: ${this.state.lastCookieError || 'Desconhecido'}
- Data/Hora: ${new Date().toLocaleString('pt-BR')}

📋 Ações recomendadas:
1. Acesse o dashboard
2. Verifique o status do cookie
3. Prepare um novo cookie para substituição
4. Faça o upload antes que atinja ${this.state.maxFailures}/5

Se o problema persistir, um alerta crítico será enviado.

Sistema de monitoramento - NeoNews Live Converter V3
        `;
        
        emailAlerts.sendEmailAlert('⚠️ AVISO - Cookie com falhas detectadas', message, 'warning');
        this.state.lastWarningEmailSent = now;
        this.saveState();
        console.log('📧 E-mail de aviso preventivo enviado');
    }

    registerSuccess() {
        const wasInvalid = this.state.cookieStatus === 'invalid';
        const oldFailures = this.state.consecutiveFailures;
        const now = new Date().toISOString();
        
        this.state.consecutiveFailures = 0;
        this.state.lastRenewSuccess = now;
        this.state.lastCookieCheckSuccess = now;
        this.state.lastAttemptTime = now;
        this.state.lastCookieError = null;
        this.state.lastAttemptError = null;
        
        console.log(`✅ Sucesso na renovação! Resetando falhas (era ${oldFailures})`);
        console.log(`📅 Último sucesso: ${now}`);
        
        const mainPath = path.join(this.cookiesDir, 'main.txt');
        const backupPath = path.join(this.cookiesDir, 'backup.txt');
        const hasCookieFile = fs.existsSync(mainPath) || fs.existsSync(backupPath);
        
        if (wasInvalid && hasCookieFile) {
            this.setCookieStatus('valid');
            this.state.cookieValidated = true;
            console.log('🎉 Sistema recuperado! Cookie voltou a funcionar.');
            this.saveState();
            
            if (this.emailAlerts) {
                let liveCount = 1;
                try {
                    const stateFile = path.join(__dirname, '.system_state.json');
                    if (fs.existsSync(stateFile)) {
                        const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
                        liveCount = saved.liveCount || 1;
                    }
                } catch(e) {}
                
                this.sendRecoveryEmail(this.emailAlerts, liveCount);
            }
            
            return { recovered: true, previousFailures: oldFailures };
        }
        
        if (wasInvalid && !hasCookieFile) {
            console.log('ℹ️ Renovação bem-sucedida sem cookie. Nenhum e-mail de recuperação enviado.');
        }
        
        this.saveState();
        return { recovered: false, previousFailures: 0 };
    }

    async sendRecoveryEmail(emailAlerts, liveCount) {
        const mainPath = path.join(this.cookiesDir, 'main.txt');
        const hasCookie = fs.existsSync(mainPath);
        
        if (!hasCookie) {
            console.log('🔇 E-mail de recuperação não enviado: Nenhum cookie configurado');
            return;
        }
        
        const now = Date.now();
        if (this.state.lastRecoveryEmailSent && (now - this.state.lastRecoveryEmailSent) < 3600000) {
            console.log('⏸️ E-mail de recuperação em cooldown (1 hora)');
            return;
        }
        
        const message = `
🟢 SISTEMA RECUPERADO

O cookie do YouTube foi atualizado com sucesso.

📅 Data/Hora da recuperação:
${new Date().toLocaleString('pt-BR')}

📺 Lives monitoradas:
${liveCount}

🔄 Status:
Todas as renovações voltaram a funcionar normalmente.
O monitoramento foi restaurado automaticamente.

✅ Nenhuma ação adicional é necessária.
        `;
        
        emailAlerts.sendEmailAlert('SISTEMA RECUPERADO - COOKIE VÁLIDO', message, 'recovery');
        this.state.lastRecoveryEmailSent = now;
        this.saveState();
        console.log('📧 E-mail de recuperação enviado com sucesso!');
    }
}

module.exports = new SystemState();
'@

$fixedSystemState | Out-File -FilePath $systemStatePath -Encoding UTF8

Write-Host "✅ systemState.js completamente restaurado e corrigido!" -ForegroundColor Green