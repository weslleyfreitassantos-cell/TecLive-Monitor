// routes/clientAuth.js
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../database/schema');
const { generateToken, verifyToken, checkClientActive, canAddLive } = require('../middlewares/authClient');

// Login do cliente
router.post('/login', (req, res) => {
    const { email, password } = req.body;
    
    if (!email || !password) {
        return res.status(400).json({ error: 'Email e senha obrigatórios' });
    }
    
    db.get('SELECT * FROM clients WHERE email = ?', [email], async (err, client) => {
        if (err || !client) {
            return res.status(401).json({ error: 'Email ou senha inválidos' });
        }
        
        if (client.status !== 'active') {
            return res.status(401).json({ error: 'Conta suspensa. Entre em contato com o administrador.' });
        }
        
        const validPassword = await bcrypt.compare(password, client.password_hash);
        if (!validPassword) {
            return res.status(401).json({ error: 'Email ou senha inválidos' });
        }
        
        // Atualizar último login
        db.run('UPDATE clients SET last_login = CURRENT_TIMESTAMP WHERE id = ?', [client.id]);
        
        // Buscar plano do cliente
        db.get(`
            SELECT p.* FROM plans p
            JOIN subscriptions s ON s.plan_id = p.id
            WHERE s.client_id = ?
        `, [client.id], (err, plan) => {
            const token = generateToken(client.id, client.email);
            
            res.json({
                success: true,
                token,
                client: {
                    id: client.id,
                    name: client.name,
                    email: client.email,
                    plan: plan || { name: 'Básico', max_lives: 3 }
                }
            });
        });
    });
});

// 🔒 Obter dados do cliente logado (com verificação de status)
router.get('/me', verifyToken, checkClientActive, async (req, res) => {
    db.get(`
        SELECT c.id, c.name, c.email, c.status, c.created_at,
               p.name as plan_name, p.max_lives,
               COUNT(uls.live_source_id) as current_lives
        FROM clients c
        LEFT JOIN subscriptions s ON s.client_id = c.id
        LEFT JOIN plans p ON p.id = s.plan_id
        LEFT JOIN user_live_subscriptions uls ON uls.user_id = c.id
        WHERE c.id = ?
        GROUP BY c.id
    `, [req.clientId], (err, client) => {
        if (err || !client) {
            return res.status(404).json({ error: 'Cliente não encontrado' });
        }
        res.json(client);
    });
});

// 🔒 Obter lives do cliente logado (com verificação de status)
router.get('/my-lives', verifyToken, checkClientActive, (req, res) => {
    db.all(`
        SELECT ls.* FROM live_sources ls
        JOIN user_live_subscriptions uls ON uls.live_source_id = ls.id
        WHERE uls.user_id = ?
    `, [req.clientId], (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
        } else {
            res.json({ total: rows.length, lives: rows });
        }
    });
});

module.exports = router;