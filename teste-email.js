// teste-email.js - Teste for?ado de email
require('dotenv').config();
const EmailAlerts = require('./alerts/emailAlerts');

async function testEmail() {
    console.log('========================================');
    console.log('TESTE FORCADO DE EMAIL');
    console.log('========================================');
    
    const email = new EmailAlerts();
    
    console.log('1. Testando alertaCritico...');
    await email.alertaCritico({
        falhasConsecutivas: 5,
        ultimoErro: 'Cookie expirado - TESTE MANUAL',
        ultimoSucesso: new Date().toLocaleString(),
        totalLives: 1
    });
    
    console.log('\n2. Aguardando 2 segundos...');
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    console.log('\n3. Testando liveDown...');
    await email.liveDown('teste-id', 'https://youtube.com/watch?v=teste', '2h 30m');
    
    console.log('\n4. Testando cookieExpired...');
    await email.cookieExpired();
    
    console.log('\n? Testes conclu?dos! Verifique sua caixa de entrada.');
}

testEmail().catch(console.error);
