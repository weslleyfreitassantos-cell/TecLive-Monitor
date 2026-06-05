// scripts/init-prod.js
const bcrypt = require('bcryptjs');
const db = require('../database/schema');

async function initProduction() {
    console.log('🚀 Inicializando ambiente de produção...');
    
    // Verificar se JWT_SECRET está configurado
    if (!process.env.JWT_SECRET) {
        console.error('❌ JWT_SECRET não configurado no .env');
        console.error('⚠️ O sistema não pode iniciar sem uma chave JWT segura');
        process.exit(1);
    }
    
    // Verificar se ADMIN_PASSWORD está configurado
    if (!process.env.ADMIN_PASSWORD) {
        console.error('❌ ADMIN_PASSWORD não configurado no .env');
        console.error('⚠️ O sistema não pode iniciar sem uma senha de admin');
        process.exit(1);
    }
    
    // Criar admin manualmente se não existir
    const adminHash = bcrypt.hashSync(process.env.ADMIN_PASSWORD, 10);
    db.run(`INSERT OR IGNORE INTO clients (name, email, password_hash, status) VALUES (?, ?, ?, 'active')`,
        ['Administrador', 'admin@admin.com', adminHash],
        (err) => {
            if (err) {
                console.error('❌ Erro ao criar admin:', err.message);
            } else {
                console.log('✅ Admin verificado/criado');
            }
        }
    );
    
    console.log('✅ Ambiente de produção pronto!');
}

// Executar apenas em produção
if (process.env.NODE_ENV === 'production') {
    initProduction();
} else {
    console.log('⚠️ Ambiente de desenvolvimento. Pule inicialização de produção.');
}

module.exports = { initProduction };