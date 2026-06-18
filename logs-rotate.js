// logs-rotate.js - Rotação automática de logs
const fs = require('fs');
const path = require('path');

const LOGS_DIR = path.join(__dirname, 'logs');

function rotateLogs() {
    if (!fs.existsSync(LOGS_DIR)) return;
    
    const files = fs.readdirSync(LOGS_DIR);
    const now = Date.now();
    const maxAge = 30 * 24 * 60 * 60 * 1000; // 30 dias
    
    files.forEach(file => {
        const filePath = path.join(LOGS_DIR, file);
        const stats = fs.statSync(filePath);
        
        if (now - stats.mtimeMs > maxAge) {
            fs.unlinkSync(filePath);
            console.log(`🗑️ Log antigo removido: ${file}`);
        }
    });
}

// Rotação a cada 24 horas
setInterval(rotateLogs, 24 * 60 * 60 * 1000);
console.log('🔄 Sistema de rotação de logs iniciado');
