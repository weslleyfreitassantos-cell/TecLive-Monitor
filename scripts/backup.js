// scripts/backup.js
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'database', 'users.db');
const BACKUP_DIR = path.join(__dirname, '..', 'backups');

// Criar pasta de backups se não existir
if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function createBackup() {
    if (!fs.existsSync(DB_PATH)) {
        console.log('⚠️ Banco de dados não encontrado. Backup ignorado.');
        return;
    }
    
    const date = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(BACKUP_DIR, `users-${date}.db`);
    
    fs.copyFileSync(DB_PATH, backupPath);
    console.log(`✅ Backup criado: ${backupPath}`);
    
    // Manter apenas últimos 30 backups
    const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.db'));
    if (files.length > 30) {
        const oldest = files.sort()[0];
        fs.unlinkSync(path.join(BACKUP_DIR, oldest));
        console.log(`🗑️ Backup antigo removido: ${oldest}`);
    }
}

// Executar backup manual se chamado diretamente
if (require.main === module) {
    createBackup();
}

module.exports = { createBackup };