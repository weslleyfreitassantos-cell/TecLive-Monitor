const { Resend } = require('resend');

const resend = new Resend('re_89ZXAe5h_BdKQcQzwLrgF3pCtWyc3Nv4z');
const MEU_EMAIL = 'weslleyfreitassantos@gmail.com';

async function sendEmail(subject, htmlContent) {
    try {
        const { data, error } = await resend.emails.send({
            from: 'onboarding@resend.dev',
            to: [MEU_EMAIL],
            subject: subject,
            html: htmlContent
        });
        
        if (error) {
            console.log('Erro ao enviar email:', error.message);
            return false;
        }
        
        console.log('Alerta enviado com sucesso!');
        return true;
    } catch (err) {
        console.log('Erro:', err.message);
        return false;
    }
}

// Função genérica para alertas
async function sendAlert(subject, message) {
    const html = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>${subject}</title>
    <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; }
        .header { background-color: #007bff; color: white; padding: 15px; text-align: center; border-radius: 5px; }
        .content { padding: 15px; background-color: #f8f9fa; border-radius: 5px; margin: 15px 0; }
        .footer { font-size: 12px; color: #6c757d; text-align: center; margin-top: 20px; }
    </style>
</head>
<body>
    <div class="header">
        <h2>YOUTUBE LIVE MONITOR</h2>
    </div>
    <div class="content">
        <p>${message}</p>
        <p><strong>Data/Hora:</strong> ${new Date().toLocaleString('pt-BR')}</p>
    </div>
    <div class="footer">
        <p>Este é um alerta automático do seu monitor de lives.</p>
    </div>
</body>
</html>
    `;
    return await sendEmail(subject, html);
}

// Alerta de falha do cookie
async function sendCookieFailureAlert(failCount, lastSuccess, activeLives, lastError) {
    const subject = 'ALERTA CRITICO - Cookie do YouTube falhou!';
    
    const html = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Alerta Cookie</title>
    <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; }
        .alert { background-color: #dc3545; color: white; padding: 15px; border-radius: 5px; text-align: center; }
        .details { background-color: #f8f9fa; padding: 15px; border-radius: 5px; margin: 15px 0; }
        .action { background-color: #ffc107; padding: 15px; border-radius: 5px; margin: 15px 0; }
        .box { border: 1px solid #dee2e6; padding: 15px; border-radius: 5px; margin: 10px 0; }
        ul { margin: 0; padding-left: 20px; }
        li { margin: 8px 0; }
        hr { border: none; border-top: 1px solid #dee2e6; margin: 20px 0; }
        .footer { font-size: 12px; color: #6c757d; text-align: center; }
        .button { background-color: #007bff; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block; }
    </style>
</head>
<body>
    <div class="alert">
        <h2>ALERTA CRITICO</h2>
    </div>
    
    <div class="details">
        <h3>DETALHES DA FALHA</h3>
        <div class="box">
            <ul>
                <li><strong>Falhas consecutivas:</strong> ${failCount}</li>
                <li><strong>Ultimo sucesso:</strong> ${lastSuccess || 'Nunca'}</li>
                <li><strong>Lives monitoradas:</strong> ${activeLives || 'N/A'}</li>
                <li><strong>Ultimo erro:</strong> ${lastError || 'Desconhecido'}</li>
                <li><strong>Data/Hora:</strong> ${new Date().toLocaleString('pt-BR')}</li>
            </ul>
        </div>
    </div>
    
    <div class="action">
        <h3>ACAO NECESSARIA</h3>
        <p><strong>1.</strong> Acesse o painel administrativo:</p>
        <p style="text-align: center;">
            <a href="https://dicing-ought-salt.ngrok-free.dev/admin" class="button">
                ACESSAR PAINEL ADMIN
            </a>
        </p>
        <p><strong>2.</strong> Faca upload de um novo cookies.txt</p>
        <p><strong>3.</strong> O sistema vai validar antes de substituir</p>
    </div>
    
    <hr>
    
    <div class="footer">
        <p>Este e um alerta automatico do seu monitor de lives.</p>
        <p>Sistema Youtube Live Monitor</p>
    </div>
</body>
</html>
    `;
    
    return await sendEmail(subject, html);
}

// Alerta de recuperação do cookie
async function sendCookieRecoveredAlert() {
    const subject = 'COOKIE RECUPERADO - Sistema normalizado';
    
    const html = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Sistema Recuperado</title>
    <style>
        body { font-family: Arial, sans-serif; }
        .success { background-color: #28a745; color: white; padding: 15px; border-radius: 5px; text-align: center; }
        .box { border: 1px solid #dee2e6; padding: 15px; border-radius: 5px; margin: 15px 0; }
    </style>
</head>
<body>
    <div class="success">
        <h2>SISTEMA RECUPERADO</h2>
    </div>
    <div class="box">
        <p>Cookie tecnico voltou a funcionar normalmente.</p>
        <p><strong>Status:</strong> Operacional</p>
        <p><strong>Data/Hora:</strong> ${new Date().toLocaleString('pt-BR')}</p>
    </div>
</body>
</html>
    `;
    
    return await sendEmail(subject, html);
}

// Alerta de sistema iniciado
async function sendSystemStartAlert() {
    const subject = 'SISTEMA INICIADO - Monitor online';
    
    const html = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Sistema Iniciado</title>
    <style>
        body { font-family: Arial, sans-serif; }
        .info { background-color: #17a2b8; color: white; padding: 15px; border-radius: 5px; text-align: center; }
        .box { border: 1px solid #dee2e6; padding: 15px; border-radius: 5px; margin: 15px 0; }
    </style>
</head>
<body>
    <div class="info">
        <h2>SISTEMA INICIADO</h2>
    </div>
    <div class="box">
        <p><strong>Youtube Live Monitor</strong> esta online!</p>
        <p><strong>Inicio:</strong> ${new Date().toLocaleString('pt-BR')}</p>
        <p><strong>Acesso:</strong> <a href="https://dicing-ought-salt.ngrok-free.dev">https://dicing-ought-salt.ngrok-free.dev</a></p>
    </div>
</body>
</html>
    `;
    
    return await sendEmail(subject, html);
}

// Alerta de limite de lives atingido
async function sendLimitAlert(clientName, currentLives, maxLives) {
    const subject = 'LIMITE DE LIVES ATINGIDO';
    
    const html = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Limite Atingido</title>
    <style>
        body { font-family: Arial, sans-serif; }
        .warning { background-color: #ff9800; color: white; padding: 15px; border-radius: 5px; text-align: center; }
        .box { border: 1px solid #dee2e6; padding: 15px; border-radius: 5px; margin: 15px 0; }
    </style>
</head>
<body>
    <div class="warning">
        <h2>ATENCAO - Limite Atingido</h2>
    </div>
    <div class="box">
        <p><strong>Cliente:</strong> ${clientName}</p>
        <p><strong>Lives atuais:</strong> ${currentLives}</p>
        <p><strong>Limite maximo:</strong> ${maxLives}</p>
        <p>Considere fazer upgrade do plano do cliente.</p>
        <p>Data/Hora: ${new Date().toLocaleString('pt-BR')}</p>
    </div>
</body>
</html>
    `;
    
    return await sendEmail(subject, html);
}

module.exports = {
    sendEmail,
    sendAlert,
    sendCookieFailureAlert,
    sendCookieRecoveredAlert,
    sendSystemStartAlert,
    sendLimitAlert
};
