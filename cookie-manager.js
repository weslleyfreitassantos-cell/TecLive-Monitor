// cookie-manager.js - Gerenciamento de cookie principal e reserva
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

const COOKIES_DIR = path.join(__dirname, 'cookies');
const MAIN_COOKIE = path.join(COOKIES_DIR, 'main.txt');
const BACKUP_COOKIE = path.join(COOKIES_DIR, 'backup.txt');
const HISTORY_DIR = path.join(COOKIES_DIR, 'history');

// Status atual
let currentActiveCookie = 'main'; // 'main' ou 'backup'
let mainStatus = { valid: false, lastTest: null, failCount: 0 };
let backupStatus = { valid: false, lastTest: null, failCount: 0 };

// Testa um cookie específico
async function testCookie(cookiePath) {
    if (!fs.existsSync(cookiePath)) {
        return { valid: false, error: 'Arquivo não encontrado' };
    }
    
    const testVideoId = 'dQw4w9WgXcQ'; // Vídeo público para teste
    
    try {
        const { stdout, stderr } = await execPromise(
            `yt-dlp --cookies "${cookiePath}" --simulate --no-download "https://www.youtube.com/watch?v=${testVideoId}" --print "title"`,
            { timeout: 30000, windowsHide: true }
        );
        
        if (stdout && stdout.trim()) {
            return { valid: true, title: stdout.trim() };
        }
        return { valid: false, error: stderr || 'Resposta inválida' };
    } catch (error) {
        return { valid: false, error: error.message };
    }
}

// Verifica ambos os cookies e ativa fallback se necessário
async function checkAndFallback() {
    console.log('?? Verificando cookies...');
    
    // Testa cookie principal
    const mainResult = await testCookie(MAIN_COOKIE);
    mainStatus = {
        valid: mainResult.valid,
        lastTest: new Date().toISOString(),
        failCount: mainResult.valid ? 0 : mainStatus.failCount + 1
    };
    
    // Testa cookie reserva
    const backupResult = await testCookie(BACKUP_COOKIE);
    backupStatus = {
        valid: backupResult.valid,
        lastTest: new Date().toISOString(),
        failCount: backupResult.valid ? 0 : backupStatus.failCount + 1
    };
    
    console.log(`?? Principal: ${mainStatus.valid ? '? OK' : '? FALHOU'}`);
    console.log(`?? Reserva: ${backupStatus.valid ? '? OK' : '? FALHOU'}`);
    
    // Lógica de fallback
    if (!mainStatus.valid && backupStatus.valid && currentActiveCookie !== 'backup') {
        console.log('?? Ativando cookie reserva...');
        currentActiveCookie = 'backup';
        
        // Envia alerta
        const email = require('./email-resend');
        await email.sendCookieFailureAlert(
            mainStatus.failCount,
            mainStatus.lastTest,
            null,
            'Cookie principal falhou. Backup ativado automaticamente.'
        );
        
        return { fallbackActivated: true, activeCookie: 'backup' };
    }
    
    // Se ambos falharam, alerta crítico
    if (!mainStatus.valid && !backupStatus.valid) {
        console.log('?? AMBOS COOKIES FALHARAM!');
        const email = require('./email-resend');
        await email.sendAlert(
            'EMERGÊNCIA',
            'Ambos os cookies falharam! Ação imediata necessária.'
        );
        return { fallbackActivated: false, critical: true };
    }
    
    return { fallbackActivated: false, activeCookie: currentActiveCookie };
}

// Retorna o cookie ativo para uso
function getActiveCookiePath() {
    return currentActiveCookie === 'main' ? MAIN_COOKIE : BACKUP_COOKIE;
}

// Atualiza o cookie principal e move o antigo para histórico
async function updateMainCookie(newCookieContent, adminName = 'Admin') {
    // Salva o cookie atual no histórico
    if (fs.existsSync(MAIN_COOKIE)) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const historyPath = path.join(HISTORY_DIR, `main_${timestamp}.txt`);
        fs.copyFileSync(MAIN_COOKIE, historyPath);
    }
    
    // Salva o novo cookie principal
    fs.writeFileSync(MAIN_COOKIE, newCookieContent, 'utf8');
    
    // Testa o novo cookie
    const testResult = await testCookie(MAIN_COOKIE);
    
    if (testResult.valid) {
        // Se o backup ainda é válido, mantém
        if (backupStatus.valid) {
            currentActiveCookie = 'main';
            mainStatus.valid = true;
            mainStatus.failCount = 0;
            
            // Envia confirmação
            const email = require('./email-resend');
            await email.sendAlert(
                'Cookie Atualizado',
                `Novo cookie principal foi validado e está ativo. Admin: ${adminName}`
            );
            
            return { success: true, message: 'Cookie atualizado com sucesso!' };
        }
    }
    
    return { success: false, message: 'Cookie inválido! Não foi aplicado.' };
}

// Retorna status para o painel
function getStatus() {
    return {
        main: {
            valid: mainStatus.valid,
            lastTest: mainStatus.lastTest,
            failCount: mainStatus.failCount
        },
        backup: {
            valid: backupStatus.valid,
            lastTest: backupStatus.lastTest,
            failCount: backupStatus.failCount
        },
        active: currentActiveCookie,
        timestamp: new Date().toISOString()
    };
}

module.exports = {
    testCookie,
    checkAndFallback,
    getActiveCookiePath,
    updateMainCookie,
    getStatus,
    MAIN_COOKIE,
    BACKUP_COOKIE
};
