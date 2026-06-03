const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const db = new sqlite3.Database(path.join(__dirname, 'users.db'));

db.serialize(() => {
    // ========================================
    // TABELAS EXISTENTES
    // ========================================
    
    // Tabela de usuários
    const sql1 = `CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE,
        refresh_token TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`;
    db.run(sql1);
    
    // Tabela de lives por usuário (antiga - manter para compatibilidade)
    const sql2 = `CREATE TABLE IF NOT EXISTS user_lives (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        live_url TEXT,
        channel_name TEXT,
        active BOOLEAN DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id)
    )`;
    db.run(sql2);
    
    // ========================================
    // NOVAS TABELAS (SISTEMA COMPARTILHADO)
    // ========================================
    
    // Tabela de lives fontes (uma por live do YouTube)
    const sql3 = `CREATE TABLE IF NOT EXISTS live_sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        youtube_id TEXT UNIQUE,
        youtube_url TEXT UNIQUE,
        title TEXT,
        current_m3u8 TEXT,
        last_check DATETIME,
        status TEXT DEFAULT 'active',
        subscribers INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`;
    db.run(sql3, (err) => {
        if (err) console.error('Erro ao criar live_sources:', err.message);
        else console.log('✅ Tabela live_sources criada/verificada');
    });
    
    // Se a tabela já existia, adicionar a coluna title (para migrations)
    db.run(`ALTER TABLE live_sources ADD COLUMN title TEXT`, (err) => {
        if (err && err.message.includes('duplicate column')) {
            // Coluna já existe, ignorar
        } else if (err) {
            console.log('⚠️ Coluna title já existe ou erro:', err.message);
        } else {
            console.log('✅ Coluna title adicionada à tabela live_sources');
        }
    });
    
    // Tabela de associação usuário → live
    const sql4 = `CREATE TABLE IF NOT EXISTS user_live_subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        live_source_id INTEGER,
        added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id),
        FOREIGN KEY(live_source_id) REFERENCES live_sources(id),
        UNIQUE(user_id, live_source_id)
    )`;
    db.run(sql4, (err) => {
        if (err) console.error('Erro ao criar user_live_subscriptions:', err.message);
        else console.log('✅ Tabela user_live_subscriptions criada/verificada');
    });
    
    // ========================================
    // NOVAS TABELAS (ADMIN E EVENTOS)
    // ========================================
    
    // Tabela de sessões admin
    const sql5 = `CREATE TABLE IF NOT EXISTS admin_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token TEXT UNIQUE,
        expires_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`;
    db.run(sql5, (err) => {
        if (err) console.error('Erro ao criar admin_sessions:', err.message);
        else console.log('✅ Tabela admin_sessions criada/verificada');
    });
    
    // Tabela de eventos (log do sistema)
    const sql6 = `CREATE TABLE IF NOT EXISTS live_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        live_source_id INTEGER,
        event_type TEXT,
        message TEXT,
        metadata TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(live_source_id) REFERENCES live_sources(id)
    )`;
    db.run(sql6, (err) => {
        if (err) console.error('Erro ao criar live_events:', err.message);
        else console.log('✅ Tabela live_events criada/verificada');
    });
    
    // Tabela de saúde do cookie (estado atual - apenas 1 registro)
    const sql7 = `CREATE TABLE IF NOT EXISTS cookie_health (
        id INTEGER PRIMARY KEY DEFAULT 1,
        status TEXT DEFAULT 'unknown',
        consecutive_failures INTEGER DEFAULT 0,
        last_success DATETIME,
        last_failure DATETIME,
        last_test DATETIME,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`;
    db.run(sql7, (err) => {
        if (err) console.error('Erro ao criar cookie_health:', err.message);
        else console.log('✅ Tabela cookie_health criada/verificada');
    });
    
    // Inserir registro inicial de cookie_health se não existir
    db.run(`INSERT OR IGNORE INTO cookie_health (id) VALUES (1)`);
    
    console.log('✅ Banco de dados inicializado');
});

module.exports = db;