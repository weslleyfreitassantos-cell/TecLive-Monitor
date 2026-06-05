const nodemailer = require('nodemailer');

// Configuração para Outlook (funciona sem senha de app)
const transporter = nodemailer.createTransport({
    host: 'smtp-mail.outlook.com',
    port: 587,
    secure: false,
    auth: {
        user: 'SEU_EMAIL@outlook.com',
        pass: 'SUA_SENHA_DO_OUTLOOK'
    },
    tls: {
        ciphers: 'SSLv3'
    }
});

function sendEmailAlert(subject, message) {
    const mailOptions = {
        from: 'SEU_EMAIL@outlook.com',
        to: 'weslleyfreitassantos@gmail.com',
        subject: `?? YOUTUBE MONITOR - ${subject}`,
        text: message
    };
    
    transporter.sendMail(mailOptions, (error, info) => {
        if (error) {
            console.log('? Erro ao enviar email:', error.message);
        } else {
            console.log('? Email enviado:', info.response);
        }
    });
}

function sendCookieFailureAlert(failCount, lastSuccess, activeLives, lastError) {
    const subject = '?? COOKIE FALHOU - Ação Necessária!';
    const message = `
?? ALERTA CRÍTICO - YOUTUBE LIVE MONITOR ??

? Cookie falhou ${failCount}x consecutivas
?? Último sucesso: ${lastSuccess || 'Nunca'}
?? Lives: ${activeLives}

?? Envie novo cookies.txt no admin
?? ${new Date().toLocaleString('pt-BR')}
    `;
    sendEmailAlert(subject, message);
}

function sendCookieRecoveredAlert() {
    const subject = '? COOKIE RECUPERADO';
    const message = `? Cookie voltou a funcionar\n?? ${new Date().toLocaleString('pt-BR')}`;
    sendEmailAlert(subject, message);
}

function sendSystemStartAlert() {
    const subject = '?? SISTEMA INICIADO';
    const message = `?? Sistema online\n?? ${new Date().toLocaleString('pt-BR')}`;
    sendEmailAlert(subject, message);
}

module.exports = {
    sendCookieFailureAlert,
    sendCookieRecoveredAlert,
    sendSystemStartAlert
};
