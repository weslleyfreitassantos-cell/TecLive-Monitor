const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('users.db');

db.serialize(() => {
    // Tabela de usuários
    db.run(\CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE,
        refresh_token TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )\);
    
    // Tabela de lives fontes (compartilhadas)
    db.run(\CREATE TABLE IF NOT EXISTS live_sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        youtube_id TEXT UNIQUE,
        youtube_url TEXT UNIQUE,
        current_m3u8 TEXT,
        last_check DATETIME,
        status TEXT DEFAULT 'active',
        subscribers INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )\);
    
    // Tabela de associação usuário → live
    db.run(\CREATE TABLE IF NOT EXISTS user_live_subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        live_source_id INTEGER,
        added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id),
        FOREIGN KEY(live_source_id) REFERENCES live_sources(id),
        UNIQUE(user_id, live_source_id)
    )\);
    
    console.log('✅ Banco de dados recriado com sucesso!');
    db.close();
});
