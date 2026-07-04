const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

class EmailAlerts {
    constructor() {
        console.log('📧 Inicializando EmailAlerts...');
        this.transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS
            }
        });
        
        this.adminEmail = process.env.ADMIN_EMAIL || 'weslleyfreitassantos@gmail.com';
        this.cookieRotator = null;
        this._lastAlert = {};
        this._lastOkAlert = null;
        this._lastFailureAlert = null;
        this._lastInvalidTime = {};
        
        console.log(`📧 EmailAlerts configurado. Admin: ${this.adminEmail}`);
    }

    setCookieRotator(rotator) {
        console.log('🔄 [DIAG] setCookieRotator chamado');
        this.cookieRotator = rotator;
        if (!rotator) {
            console.warn('⚠️ [DIAG] rotator é null/undefined');
            return;
        }
        
        // Intercepta markFailure e markSuccess para manter sincronia,
        // mas a lógica principal já está no CookieRotator.
        // Aqui apenas registramos e chamamos os métodos originais.
        console.log('✅ [DIAG] CookieRotator vinculado ao EmailAlerts.');
    }

    // ================== E-MAILS ESPECÍFICOS ==================

    sendCookieWarningAlert(cookieName, errorMsg, failCount) {
        const key = `warning_${cookieName}`;
        if (this._lastAlert[key] && (Date.now() - this._lastAlert[key]) < 3600000) {
            console.log(`⏳ [DIAG] Alerta de warning para ${cookieName} suprimido (1h)`);
            return;
        }
        console.log(`⚠️ [ENVIO] sendCookieWarningAlert: cookie=${cookieName}, falhas=${failCount}`);
        const subject = `⚠️ Cookie ${cookieName} suspeito - ${failCount}/3 falhas`;
        const message = `O cookie ${cookieName} apresentou falha de autenticação.\n\nErro: ${errorMsg}\n\nFalhas consecutivas: ${failCount}/3\n\nSe atingir 3 falhas, será invalidado e removido da rotação.`;
        this.sendEmailAlert(subject, message, 'cookie_warning');
        this._lastAlert[key] = Date.now();
    }

    sendCookieInvalidAlert(cookieName, errorMsg) {
        const key = `invalid_${cookieName}`;
        if (this._lastAlert[key] && (Date.now() - this._lastAlert[key]) < 3600000) {
            console.log(`⏳ [DIAG] Alerta de inválido para ${cookieName} suprimido (1h)`);
            return;
        }
        console.log(`🔴 [ENVIO] sendCookieInvalidAlert: cookie=${cookieName}`);
        const subject = `🔴 Cookie ${cookieName} inválido - NeoNews Monitor`;
        const message = `O cookie ${cookieName} foi invalidado após 3 falhas consecutivas.\n\nÚltimo erro: ${errorMsg}\n\nAcesse o dashboard e substitua apenas este cookie.`;
        this.sendEmailAlert(subject, message, 'cookie_invalid');
        this._lastAlert[key] = Date.now();
    }

    // E-mail de recuperação automática (suspect → valid)
    sendCookieRecoveredAlert(cookieName) {
        const key = `recovered_${cookieName}`;
        if (this._lastAlert[key] && (Date.now() - this._lastAlert[key]) < 3600000) {
            console.log(`⏳ [DIAG] Alerta de recuperação para ${cookieName} suprimido (1h)`);
            return;
        }
        console.log(`🟢 [ENVIO] sendCookieRecoveredAlert: cookie=${cookieName}`);
        const subject = `🟢 Cookie ${cookieName} recuperado automaticamente - NeoNews Monitor`;
        const message = `O cookie ${cookieName} voltou a funcionar (suspect → valid) e foi reinserido na rotação.\n\nRedundância restaurada.`;
        this.sendEmailAlert(subject, message, 'cookie_recovered');
        this._lastAlert[key] = Date.now();
    }

    // E-mail de recuperação MANUAL (invalid → valid via reactivateCookie)
    sendCookieManualRecoveredAlert(cookieName) {
        const key = `manual_recovered_${cookieName}`;
        // Permite enviar mesmo sem supressão, pois é uma ação manual do usuário
        // Mas ainda evita spam se o usuário clicar várias vezes em sequência
        if (this._lastAlert[key] && (Date.now() - this._lastAlert[key]) < 60000) { // 1 minuto
            console.log(`⏳ [DIAG] Alerta de recuperação manual para ${cookieName} suprimido (1 minuto)`);
            return;
        }
        console.log(`🔄 [ENVIO] sendCookieManualRecoveredAlert: cookie=${cookieName} (reativação manual)`);
        const subject = `🟢 Cookie ${cookieName} reativado MANUALMENTE - NeoNews Monitor`;
        const message = `O cookie ${cookieName} foi reativado manualmente via dashboard.\n\nEstado: invalid → valid\n\nCookie substituído e voltando à rotação.`;
        this.sendEmailAlert(subject, message, 'cookie_manual_recovered');
        this._lastAlert[key] = Date.now();
    }

    // ================== E-MAILS PERIÓDICOS DE SAÚDE (a cada 4h) ==================

    checkCookiesHealthAlert() {
        if (!this.cookieRotator) {
            console.warn('⚠️ [DIAG] checkCookiesHealthAlert: cookieRotator não disponível');
            return;
        }
        console.log('🔍 [DIAG] Executando verificação periódica de cookies...');
        const status = this.cookieRotator.getFunctionalStatus();
        const entries = Object.entries(status);
        console.log(`📊 [DIAG] Status dos cookies:`, entries.map(([k, v]) => `${k}=${v.state}(${v.valid ? 'ok' : 'fail'})`).join(', '));

        const allValid = entries.every(([, v]) => v.valid === true && v.state === 'valid');
        const hasValid = entries.some(([, v]) => v.valid === true && v.state === 'valid');
        const invalidOnes = entries.filter(([, v]) => !(v.valid === true && v.state === 'valid'));

        const now = Date.now();
        const fourHours = 4 * 60 * 60 * 1000;

        if (allValid) {
            console.log('🟢 [DIAG] Todos os cookies válidos.');
            if (!this._lastOkAlert || (now - this._lastOkAlert) >= fourHours) {
                this.sendCookiesOkAlert(entries);
                this._lastOkAlert = now;
            } else {
                console.log(`ℹ️ [DIAG] Alerta OK já enviado há menos de 4h, aguardando.`);
            }
            this._lastFailureAlert = null;
        } else if (!hasValid) {
            console.log('🔴 [DIAG] Nenhum cookie válido detectado.');
            if (!this._lastFailureAlert || (now - this._lastFailureAlert) >= fourHours) {
                this.sendNoCookieAlert();
                this._lastFailureAlert = now;
            } else {
                console.log(`ℹ️ [DIAG] Alerta de falha já enviado há menos de 4h, aguardando.`);
            }
        } else {
            console.log('🟡 [DIAG] Pelo menos um cookie com falha.');
            if (!this._lastFailureAlert || (now - this._lastFailureAlert) >= fourHours) {
                this.sendCookieFailureSummaryAlert(invalidOnes);
                this._lastFailureAlert = now;
            } else {
                console.log(`ℹ️ [DIAG] Alerta de falha já enviado há menos de 4h, aguardando.`);
            }
        }

        const nextCheck = 600000; // 10 minutos
        console.log(`⏱️ [DIAG] Próxima verificação em ${nextCheck/1000} segundos`);
        setTimeout(() => this.checkCookiesHealthAlert(), nextCheck);
    }

    sendCookiesOkAlert(entries) {
        console.log(`🟢 [ENVIO] sendCookiesOkAlert: todos os cookies válidos`);
        const subject = `🟢 Cookies verificados e OK - NeoNews Monitor`;
        const lines = entries.map(([name, v]) => `- ${name}: válido (última checagem com sucesso em ${v.lastSuccess || 'N/A'})`);
        const message = `Verificação periódica de cookies (a cada 4h):\n\n${lines.join('\n')}\n\nTodos os cookies estão funcionando normalmente.`;
        this.sendEmailAlert(subject, message, 'cookies_ok');
    }

    sendCookieFailureSummaryAlert(invalidOnes) {
        console.log(`🟡 [ENVIO] sendCookieFailureSummaryAlert: ${invalidOnes.map(([k]) => k).join(', ')}`);
        const subject = `⚠️ Cookie(s) com falha - NeoNews Monitor`;
        const lines = invalidOnes.map(([name, v]) => `- ${name}: ${v.state} (motivo: ${v.reason || 'desconhecido'})`);
        const message = `Verificação periódica de cookies (a cada 4h):\n\nOs seguintes cookies estão com problema e precisam ser substituídos:\n\n${lines.join('\n')}\n\nAcesse o dashboard para substituir.`;
        this.sendEmailAlert(subject, message, 'cookie_failure_summary');
    }

    sendNoCookieAlert() {
        console.log(`🔴 [ENVIO] sendNoCookieAlert: nenhum cookie válido`);
        const subject = `🔴 EMERGÊNCIA - Nenhum cookie válido - NeoNews Monitor`;
        const message = `O sistema não possui nenhum cookie funcionalmente válido.\n\n⚠️ Acesso a lives que exigem autenticação pode falhar.\n\nAção necessária: faça upload de pelo menos um cookie válido (cookie1.txt, cookie2.txt ou cookie3.txt) no dashboard.`;
        this.sendEmailAlert(subject, message, 'no_cookie');
    }

    // ================== MÉTODO BASE DE ENVIO ==================

    sendEmailAlert(subject, message, type) {
        console.log(`📧 [EMAIL] Enviando e-mail tipo=${type}: "${subject}"`);
        const mailOptions = {
            from: `"YouTube Live Monitor V3" <${process.env.EMAIL_USER}>`,
            to: this.adminEmail,
            subject: subject,
            text: message,
            html: `<div style="font-family: monospace; background: #1a1a2e; color: #e0e0e0; padding: 20px;"><pre>${message}</pre></div>`
        };
        this.transporter.sendMail(mailOptions, (error, info) => {
            if (error) {
                console.error(`❌ [EMAIL] Erro ao enviar e-mail: ${error.message}`);
            } else {
                console.log(`✅ [EMAIL] E-mail enviado com sucesso. ID: ${info.messageId}`);
            }
        });
    }

    // ================== MÉTODOS LEGACY (apenas logs) ==================

    evaluateAndAlert(liveCount) { console.log(`📊 [DIAG] evaluateAndAlert chamado (legacy, liveCount=${liveCount}) - ignorado`); }
    getCookieStatus() { console.log(`📊 [DIAG] getCookieStatus chamado (legacy)`); return { cookie1Valid: false, cookie2Valid: false, cookie3Valid: false }; }
    liveDown(videoId, youtubeUrl, duration) { console.log(`📉 [DIAG] liveDown chamado (legacy): ${videoId}`); }
    liveUp(videoId, youtubeUrl) { console.log(`📈 [DIAG] liveUp chamado (legacy): ${videoId}`); }
    monitorFailed(videoId, error) { console.log(`❌ [DIAG] monitorFailed chamado (legacy): ${videoId} - ${error?.message}`); }
    sistemaSemCookie(youtubeUrl) { console.log(`🍪 [DIAG] sistemaSemCookie chamado (legacy): ${youtubeUrl}`); }
    sendFailoverAlert(liveCount) { console.log(`🔄 [DIAG] sendFailoverAlert chamado (legacy), liveCount=${liveCount}`); }
    sendBackupExpiredAlert(liveCount) { console.log(`⏰ [DIAG] sendBackupExpiredAlert chamado (legacy), liveCount=${liveCount}`); }
    sendCriticalAlert(liveCount) { console.log(`🔴 [DIAG] sendCriticalAlert chamado (legacy), liveCount=${liveCount}`); }
    sendRecoveryAlert(liveCount, downtimeMinutes) { console.log(`🟢 [DIAG] sendRecoveryAlert chamado (legacy), liveCount=${liveCount}, downtime=${downtimeMinutes}min`); }
}

module.exports = EmailAlerts;