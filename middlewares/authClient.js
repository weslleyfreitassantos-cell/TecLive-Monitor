// middlewares/authClient.js
const jwt = require('jsonwebtoken');
const db = require('../database/schema');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    console.error('❌ JWT_SECRET não configurado no .env');
    process.exit(1);
}

function generateToken(clientId, email) {
    return jwt.sign({ clientId, email }, JWT_SECRET, { expiresIn: '7d' });
}

async function verifyToken(req, res, next) {
    const token = req.headers['authorization']?.split(' ')[1];
    
    if (!token) {
        return res.status(401).json({ error: 'Token não fornecido' });
    }
    
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.clientId = decoded.clientId;
        req.clientEmail = decoded.email;
        next();
    } catch (error) {
        return res.status(401).json({ error: 'Token inválido ou expirado' });
    }
}

async function getClientById(clientId) {
    return new Promise((resolve, reject) => {
        db.get('SELECT * FROM clients WHERE id = ?', [clientId], (err, row) => {
            if (err) reject(err);
            resolve(row);
        });
    });
}

async function getClientLives(clientId) {
    return new Promise((resolve, reject) => {
        db.all(`
            SELECT ls.* FROM live_sources ls
            JOIN user_live_subscriptions uls ON uls.live_source_id = ls.id
            WHERE uls.user_id = ?
        `, [clientId], (err, rows) => {
            if (err) reject(err);
            resolve(rows || []);
        });
    });
}

async function canAddLive(clientId) {
    return new Promise((resolve) => {
        db.get(`
            SELECT p.max_lives, COUNT(uls.live_source_id) as current_lives
            FROM clients c
            LEFT JOIN subscriptions s ON s.client_id = c.id
            LEFT JOIN plans p ON p.id = s.plan_id
            LEFT JOIN user_live_subscriptions uls ON uls.user_id = c.id
            WHERE c.id = ?
            GROUP BY c.id
        `, [clientId], (err, row) => {
            if (err || !row) {
                resolve({ allowed: true, maxLives: 3, currentLives: 0 });
            } else {
                resolve({
                    allowed: row.current_lives < (row.max_lives || 3),
                    maxLives: row.max_lives || 3,
                    currentLives: row.current_lives || 0
                });
            }
        });
    });
}

// Middleware para verificar se cliente está ativo
async function checkClientActive(req, res, next) {
    try {
        const client = await getClientById(req.clientId);
        if (!client || client.status !== 'active') {
            return res.status(403).json({ error: 'Conta suspensa. Entre em contato com o administrador.' });
        }
        next();
    } catch (error) {
        console.error('Erro ao verificar status do cliente:', error);
        res.status(500).json({ error: 'Erro ao verificar status da conta' });
    }
}

module.exports = { 
    generateToken, 
    verifyToken, 
    getClientById, 
    getClientLives,
    canAddLive,
    checkClientActive
};