const email = require('./email-alert');

// Testa alerta de falha do cookie
email.sendCookieFailureAlert(5, '04/06/2026 10:30:00', 12, 'Cookie expirado');

console.log('Teste enviado! Verifique seu email em alguns segundos.');
