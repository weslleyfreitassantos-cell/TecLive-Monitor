// alerts/emailAlerts.js
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

class EmailAlerts {
    constructor() {
        this.transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS
            }
        });
        
        this.adminEmail = process.env.ADMIN_EMAIL || 'weslleyfreitassantos@gmail.com';
        this.lastAlert = {};
        this.cookiesDir = path.join(__dirname, '../cookies');
        
        // ✅ CORREÇÃO: inicializa o estado anterior com o estado REAL dos cookies
        // Evita disparar e-mails de "recuperação" logo na primeira execução
        const { cookie1Valid, cookie2Valid, cookie3Valid } = this.getCookieStatus();
        this.lastCookieState = {
            cookie1: cookie1Valid,
            cookie2: cookie2Valid,
            cookie3: cookie3Valid
        };
    }

    // Retorna status detalhado dos três cookies
    getCookieStatus() {
        const cookie1Path = path.join(this.cookiesDir, 'cookie1.txt');
        const cookie2Path = path.join(this.cookiesDir, 'cookie2.txt');
        const cookie3Path = path.join(this.cookiesDir, 'cookie3.txt');
        const MIN_SIZE = 5000;
        
        const cookie1Valid = fs.existsSync(cookie1Path) && fs.statSync(cookie1Path).size > MIN_SIZE;
        const cookie2Valid = fs.existsSync(cookie2Path) && fs.statSync(cookie2Path).size > MIN_SIZE;
        const cookie3Valid = fs.existsSync(cookie3Path) && fs.statSync(cookie3Path).size > MIN_SIZE;
        
        // Para compatibilidade com código antigo que espera main/backup
        const mainValid = cookie1Valid;
        const backupValid = cookie2Valid || cookie3Valid;
        
        return { cookie1Valid, cookie2Valid, cookie3Valid, mainValid, backupValid };
    }

    // Avalia o estado atual e dispara alertas conforme a gravidade
    evaluateAndAlert(liveCount) {
        const { cookie1Valid, cookie2Valid, cookie3Valid } = this.getCookieStatus();
        const validCount = [cookie1Valid, cookie2Valid, cookie3Valid].filter(Boolean).length;
        
        // Verifica mudanças individuais (para recuperação parcial)
        const previousState = this.lastCookieState;
        const nowState = { cookie1: cookie1Valid, cookie2: cookie2Valid, cookie3: cookie3Valid };
        
        // Para cada cookie que estava inválido e agora ficou válido -> alerta de recuperação individual
        for (let i = 1; i <= 3; i++) {
            const cookieKey = `cookie${i}`;
            if (!previousState[cookieKey] && nowState[cookieKey]) {
                this.sendCookieRecoveredAlert(i, validCount);
            }
        }
        this.lastCookieState = { ...nowState };
        
        // Alerta por nível de severidade (com cooldown para evitar spam)
        const now = Date.now();
        if (validCount === 3) {
            if (this.lastAlert.allOk && (now - this.lastAlert.allOk) < 3600000) return;
            this.sendAllOperationalAlert(liveCount);
            this.lastAlert.allOk = now;
        } 
        else if (validCount === 2) {
            if (this.lastAlert.attention && (now - this.lastAlert.attention) < 3600000) return;
            const invalidCookie = !cookie1Valid ? 'cookie1' : (!cookie2Valid ? 'cookie2' : 'cookie3');
            this.sendAttentionAlert(invalidCookie, validCount, liveCount);
            this.lastAlert.attention = now;
        }
        else if (validCount === 1) {
            if (this.lastAlert.critical && (now - this.lastAlert.critical) < 3600000) return;
            const activeCookie = cookie1Valid ? 'cookie1' : (cookie2Valid ? 'cookie2' : 'cookie3');
            this.sendCriticalLevelAlert(activeCookie, validCount, liveCount);
            this.lastAlert.critical = now;
        }
        else if (validCount === 0) {
            if (this.lastAlert.emergency && (now - this.lastAlert.emergency) < 1800000) return; // 30 min cooldown
            this.sendEmergencyAlert(liveCount);
            this.lastAlert.emergency = now;
        }
    }

    // 🟢 TODOS OS COOKIES OPERACIONAIS
    sendAllOperationalAlert(liveCount) {
        const message = `
NeoNews Live Monitor

STATUS: TOTALMENTE OPERACIONAL

Todos os 3 cookies estão válidos e funcionando.

📊 Detalhes:

Cookie1: ✅ válido
Cookie2: ✅ válido
Cookie3: ✅ válido
Lives monitoradas: ${liveCount}
Redundância: COMPLETA

✅ Nenhuma ação necessária.

⏰ Horário: ${new Date().toLocaleString('pt-BR')}

Sistema de monitoramento - NeoNews Live Converter V3
        `;
        this.sendEmailAlert('🟢 SISTEMA 100% - Todos os 3 cookies ativos', message, 'all_ok');
        console.log('📧 Alerta de todos os cookies operacionais enviado');
    }

    // 🟡 ATENÇÃO - 1 cookie falhou (2 ainda funcionam)
    sendAttentionAlert(failedCookie, validCount, liveCount) {
        const message = `
NeoNews Live Monitor

STATUS: ATENÇÃO - REDUNDÂNCIA PARCIAL

Um dos cookies expirou ou está inválido, mas o sistema continua operando com os outros dois.

📊 Detalhes:

Cookie afetado: ${failedCookie} (❌ inválido)
Cookies remanescentes válidos: ${validCount}
Lives monitoradas: ${liveCount}
Impacto operacional: NENHUM (redundância ainda ativa)

📋 Ação recomendada:
Renove ou substitua o cookie inválido (${failedCookie}) o quanto antes para restaurar a redundância total.

⏰ Horário do evento: ${new Date().toLocaleString('pt-BR')}

Sistema de monitoramento - NeoNews Live Converter V3
        `;
        this.sendEmailAlert('🟡 ATENÇÃO - 1 cookie expirou (sistema operacional)', message, 'attention');
        console.log('📧 Alerta de atenção (1 cookie falhou) enviado');
    }

    // 🟠 CRÍTICO - Resta apenas 1 cookie válido
    sendCriticalLevelAlert(activeCookie, validCount, liveCount) {
        const message = `
NeoNews Live Monitor

STATUS: CRÍTICO - REDUNDÂNCIA MÍNIMA

Resta apenas 1 cookie válido no sistema. O sistema está operando sem backup ativo.

📊 Detalhes:

Único cookie ativo: ${activeCookie} (✅ válido)
Cookies inválidos: os outros dois
Lives monitoradas: ${liveCount}
Impacto operacional: ALTO - sem redundância, uma nova falha para o sistema.

🚨 Ação imediata necessária:

1. Substituir imediatamente os cookies inválidos (cookie1, cookie2 e/ou cookie3)
2. Restaurar a redundância para evitar parada total

⏰ Horário do evento: ${new Date().toLocaleString('pt-BR')}

Sistema de monitoramento - NeoNews Live Converter V3
        `;
        this.sendEmailAlert('🟠 CRÍTICO - Apenas 1 cookie restante', message, 'critical_level');
        console.log('📧 Alerta crítico (apenas 1 cookie) enviado');
    }

    // 🔴 EMERGÊNCIA - 0 cookies válidos
    sendEmergencyAlert(liveCount) {
        const message = `
NeoNews Live Monitor

STATUS: EMERGÊNCIA - NENHUM COOKIE VÁLIDO

Todos os 3 cookies estão inválidos ou expirados.

📊 Detalhes:

Cookie1: ❌ inválido
Cookie2: ❌ inválido
Cookie3: ❌ inválido
Lives monitoradas: ${liveCount}
Renovação de URLs: FALHOU COMPLETAMENTE
Impacto operacional: GRAVE

O sistema NÃO CONSEGUE renovar streams do YouTube. As URLs atuais podem parar de funcionar.

🚨 AÇÃO IMEDIATA OBRIGATÓRIA:

1. Gerar NOVOS cookies válidos (todos os 3)
2. Substituir os arquivos na pasta /cookies
3. Reiniciar o servidor após a substituição

⚠️ O sistema está inoperante até que pelo menos 1 cookie seja restaurado.

⏰ Horário do evento: ${new Date().toLocaleString('pt-BR')}

Sistema de monitoramento - NeoNews Live Converter V3
        `;
        this.sendEmailAlert('🔴 EMERGÊNCIA - Nenhum cookie válido', message, 'emergency');
        console.log('📧 Alerta de emergência (0 cookies) enviado');
    }

    // 🟢 RECUPERAÇÃO PARCIAL - Um cookie que estava inválido voltou a funcionar
    sendCookieRecoveredAlert(cookieNumber, currentValidCount) {
        const message = `
NeoNews Live Monitor

STATUS: RECUPERAÇÃO PARCIAL

O cookie ${cookieNumber} voltou a ser válido.

📊 Detalhes:

Cookie recuperado: cookie${cookieNumber}
Total de cookies válidos agora: ${currentValidCount} / 3
Lives monitoradas: N/A (sistema segue normal)

✅ A redundância do sistema melhorou.

Nenhuma ação adicional necessária se todos os outros cookies já estiverem válidos.
Caso ainda haja outros inválidos, recomenda-se restaurá-los também.

⏰ Horário da recuperação: ${new Date().toLocaleString('pt-BR')}

Sistema de monitoramento - NeoNews Live Converter V3
        `;
        this.sendEmailAlert(`🟢 RECUPERAÇÃO - Cookie${cookieNumber} reativado`, message, 'recovery_partial');
        console.log(`📧 Alerta de recuperação do cookie${cookieNumber} enviado`);
    }

    // ========== MÉTODOS LEGACY (compatibilidade) ==========
    sendFailoverAlert(liveCount) {
        const { cookie1Valid, cookie2Valid, cookie3Valid } = this.getCookieStatus();
        if (!cookie1Valid && (cookie2Valid || cookie3Valid)) {
            this.sendAttentionAlert('cookie1', (cookie2Valid?1:0)+(cookie3Valid?1:0), liveCount);
        }
    }

    sendBackupExpiredAlert(liveCount) {
        const { cookie1Valid, cookie2Valid, cookie3Valid } = this.getCookieStatus();
        if (cookie1Valid && (!cookie2Valid || !cookie3Valid)) {
            this.sendAttentionAlert('cookie2 e/ou cookie3', 1, liveCount);
        }
    }

    sendCriticalAlert(liveCount) {
        const validCount = this.getCookieStatus().cookie1Valid + this.getCookieStatus().cookie2Valid + this.getCookieStatus().cookie3Valid;
        if (validCount === 0) this.sendEmergencyAlert(liveCount);
        else if (validCount === 1) this.sendCriticalLevelAlert('único', validCount, liveCount);
    }

    sendRecoveryAlert(liveCount, downtimeMinutes = null) {
        const { cookie1Valid, cookie2Valid, cookie3Valid } = this.getCookieStatus();
        if (cookie1Valid && cookie2Valid && cookie3Valid) {
            const downtimeText = downtimeMinutes ? `\nTempo total de indisponibilidade: ${downtimeMinutes} minutos` : '';
            const message = `
NeoNews Live Monitor

STATUS: RECUPERAÇÃO TOTAL

Todos os 3 cookies estão válidos novamente. O sistema voltou à operação normal com redundância total.

📊 Detalhes:
Cookie1, Cookie2, Cookie3: todos OK
Lives monitoradas: ${liveCount}
Impacto operacional: RESOLVIDO

✅ Nenhuma ação adicional necessária.

⏰ Horário da recuperação: ${new Date().toLocaleString('pt-BR')}${downtimeText}
            `;
            this.sendEmailAlert('🟢 RECUPERAÇÃO TOTAL - Sistema 100% normalizado', message, 'recovery_total');
        }
    }

    // Método principal de envio de e-mail
    sendEmailAlert(subject, message, type = 'info') {
        const mailOptions = {
            from: `"YouTube Live Monitor V3" <${process.env.EMAIL_USER}>`,
            to: this.adminEmail,
            subject: subject,
            text: message,
            html: `
                <div style="font-family: 'Segoe UI', Arial, sans-serif; padding: 20px; background: #1a1a2e; color: #e0e0e0; max-width: 600px; margin: 0 auto;">
                    <div style="border-bottom: 1px solid #2ecc71; padding-bottom: 10px; margin-bottom: 20px;">
                        <h2 style="color: #2ecc71; margin: 0;">NeoNews Live Monitor</h2>
                        <p style="color: #888; margin: 5px 0 0;">NOC - Network Operations Center</p>
                    </div>
                    <div style="background: #16213e; padding: 20px; border-radius: 10px;">
                        <pre style="color: #e0e0e0; font-family: monospace; white-space: pre-wrap; word-wrap: break-word; margin: 0;">${message}</pre>
                    </div>
                    <div style="margin-top: 20px; padding-top: 10px; border-top: 1px solid #333; font-size: 11px; color: #666; text-align: center;">
                        <p>Este é um e-mail automático do sistema de monitoramento.<br>NeoNews Live Converter V3 - Central de Operações</p>
                    </div>
                </div>
            `
        };

        this.transporter.sendMail(mailOptions, (error, info) => {
            if (error) console.log('❌ Erro ao enviar email:', error.message);
            else console.log('✅ Email enviado:', info.response);
        });
    }

    // Métodos legacy adicionais
    liveDown(videoId, youtubeUrl, duration) {
        console.log(`📺 Live ${videoId} encerrada - notificação não enviada (apenas dashboard)`);
    }
    liveUp(videoId, youtubeUrl) {}
    monitorFailed(videoId, error) {}
    sistemaSemCookie(youtubeUrl) {}
}

module.exports = EmailAlerts;