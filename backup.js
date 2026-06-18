// backup.js - Backup automático do database.json
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'database.json');
const BACKUP_DIR = path.join(__dirname, 'backups');

// Criar pasta de backups se não existir
if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function createBackup() {
    if (!fs.existsSync(DB_PATH)) return;
    
    const date = new Date();
    const fileName = `database_backup_${date.toISOString().replace(/[:.]/g, '-')}.json`;
    const backupPath = path.join(BACKUP_DIR, fileName);
    
    fs.copyFileSync(DB_PATH, backupPath);
    console.log(`📦 Backup criado: ${fileName}`);
    
    // Manter apenas últimos 30 backups
    const files = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('database_backup_')).sort();
    while (files.length > 30) {
        const oldFile = files.shift();
        fs.unlinkSync(path.join(BACKUP_DIR, oldFile));
        console.log(`🗑️ Backup antigo removido: ${oldFile}`);
    }
}

// Backup a cada 6 horas
setInterval(createBackup, 6 * 60 * 60 * 1000);
console.log('🔄 Sistema de backup iniciado (a cada 6 horas)');

module.exports = { createBackup };
