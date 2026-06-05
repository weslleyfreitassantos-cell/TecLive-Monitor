const email = require('./email-resend');

async function test() {
    console.log('📧 Testando alerta de falha do cookie...');
    await email.sendCookieFailureAlert(5, '04/06/2026 10:30:00', 12, 'Cookie expirado');
    
    console.log('✅ Teste concluído! Verifique seu email em alguns segundos.');
}

test();
