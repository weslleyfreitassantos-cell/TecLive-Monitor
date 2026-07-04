const nodemailer = require('nodemailer');

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
        console.log(`📧 EmailAlerts configurado. Admin: ${this.adminEmail}`);
    }

    setCookieRotator(rotator) {
        this.cookieRotator = rotator;
        console.log('✅ [DIAG] CookieRotator vinculado ao EmailAlerts.');
    }

    sendCookieWarningAlert(cookieName, errorMsg, failCount) {
        const key = `warning_${cookieName}`;
        if (this._lastAlert[key] && (Date.now() - this._lastAlert[key]) < 3600000) {
            console.log(`⏳ Alerta de warning para ${cookieName} suprimido (1h)`);
            return;
        }
        console.log(`⚠️ [ENVIO] Cookie ${cookieName} suspeito (${failCount}/3)`);
        const subject = `⚠️ Cookie ${cookieName} suspeito - ${failCount}/3 falhas`;
        const message = `O cookie ${cookieName} apresentou falha.\n\nErro: ${errorMsg}\n\nFalhas: ${failCount}/3\n\n⚠️ ATENÇÃO: Este cookie NÃO será reativado automaticamente. Substitua manualmente no dashboard.`;
        this.sendEmailAlert(subject, message, 'cookie_warning');
        this._lastAlert[key] = Date.now();
    }

    sendCookieInvalidAlert(cookieName, errorMsg) {
        const key = `invalid_${cookieName}`;
        if (this._lastAlert[key] && (Date.now() - this._lastAlert[key]) < 3600000) {
            console.log(`⏳ Alerta de inválido para ${cookieName} suprimido (1h)`);
            return;
        }
        console.log(`🔴 [ENVIO] Cookie ${cookieName} invalidado`);
        const subject = `🔴 Cookie ${cookieName} inválido - NeoNews Monitor`;
        const message = `O cookie ${cookieName} foi invalidado após 3 falhas.\n\nÚltimo erro: ${errorMsg}\n\n⚠️ IMPORTANTE: Substitua manualmente no dashboard. Após a substituição, o sistema reativará automaticamente.`;
        this.sendEmailAlert(subject, message, 'cookie_invalid');
        this._lastAlert[key] = Date.now();
    }

    sendCookieManualRecoveredAlert(cookieName) {
        const key = `manual_recovered_${cookieName}`;
        if (this._lastAlert[key] && (Date.now() - this._lastAlert[key]) < 60000) {
            console.log(`⏳ Alerta de recuperação manual para ${cookieName} suprimido (1 minuto)`);
            return;
        }
        console.log(`🔄 [ENVIO] Cookie ${cookieName} reativado manualmente`);
        const subject = `🟢 Cookie ${cookieName} reativado MANUALMENTE - NeoNews Monitor`;
        const message = `O cookie ${cookieName} foi reativado manualmente via dashboard.\n\nEstado: invalid/suspect → valid\n\nCookie substituído e voltando à rotação.`;
        this.sendEmailAlert(subject, message, 'cookie_manual_recovered');
        this._lastAlert[key] = Date.now();
    }

    // ========== Verificação periódica de saúde (a cada 4h) ==========
    checkCookiesHealthAlert() {
        if (!this.cookieRotator) return;
        const status = this.cookieRotator.getFunctionalStatus();
        const entries = Object.entries(status);
        const allValid = entries.every(([, v]) => v.valid && v.state === 'valid');
        const hasValid = entries.some(([, v]) => v.valid && v.state === 'valid');
        const invalidOnes = entries.filter(([, v]) => !(v.valid && v.state === 'valid'));

        const now = Date.now();
        const fourHours = 4 * 60 * 60 * 1000;

        if (allValid) {
            if (!this._lastOkAlert || (now - this._lastOkAlert) >= fourHours) {
                this.sendCookiesOkAlert(entries);
                this._lastOkAlert = now;
            }
            this._lastFailureAlert = null;
        } else if (!hasValid) {
            if (!this._lastFailureAlert || (now - this._lastFailureAlert) >= fourHours) {
                this.sendNoCookieAlert();
                this._lastFailureAlert = now;
            }
        } else {
            if (!this._lastFailureAlert || (now - this._lastFailureAlert) >= fourHours) {
                this.sendCookieFailureSummaryAlert(invalidOnes);
                this._lastFailureAlert = now;
            }
        }

        setTimeout(() => this.checkCookiesHealthAlert(), 600000);
    }

    sendCookiesOkAlert(entries) {
        const subject = '🟢 Cookies verificados e OK - NeoNews Monitor';
        const lines = entries.map(([name, v]) => `- ${name}: válido (última checagem em ${v.lastSuccess || 'N/A'})`);
        this.sendEmailAlert(subject, lines.join('\n'), 'cookies_ok');
    }

    sendCookieFailureSummaryAlert(invalidOnes) {
        const subject = '⚠️ Cookie(s) com falha - NeoNews Monitor';
        const lines = invalidOnes.map(([name, v]) => `- ${name}: ${v.state} (motivo: ${v.reason || 'desconhecido'})`);
        const message = `Os seguintes cookies estão com problema e precisam ser substituídos manualmente:\n\n${lines.join('\n')}\n\nAcesse o dashboard para substituir.`;
        this.sendEmailAlert(subject, message, 'cookie_failure_summary');
    }

    sendNoCookieAlert() {
        const subject = '🔴 EMERGÊNCIA - Nenhum cookie válido - NeoNews Monitor';
        const message = 'O sistema não possui nenhum cookie funcionalmente válido.\n\nAção necessária: faça upload de pelo menos um cookie válido no dashboard.';
        this.sendEmailAlert(subject, message, 'no_cookie');
    }

    // ========== Método base ==========
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
            if (error) console.error(`❌ [EMAIL] Erro: ${error.message}`);
            else console.log(`✅ [EMAIL] Enviado. ID: ${info.messageId}`);
        });
    }

    // ========== Métodos legados ==========
    evaluateAndAlert(liveCount) {}
    getCookieStatus() { return { cookie1Valid: false, cookie2Valid: false, cookie3Valid: false }; }
    liveDown(videoId, youtubeUrl, duration) {}
    liveUp(videoId, youtubeUrl) {}
    monitorFailed(videoId, error) {}
    sistemaSemCookie(youtubeUrl) {}
    sendFailoverAlert(liveCount) {}
    sendBackupExpiredAlert(liveCount) {}
    sendCriticalAlert(liveCount) {}
    sendRecoveryAlert(liveCount, downtimeMinutes) {}
}

module.exports = EmailAlerts;