// routes/adminClients.js
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../database/schema');
const liveMonitor = require('../services/liveMonitor');

// Middleware de autenticação admin (implementado internamente)
function adminAuth(req, res, next) {
    const token = req.headers['authorization']?.split(' ')[1];
    
    if (!token) {
        return res.status(401).json({ error: 'Token não fornecido' });
    }
    
    db.get('SELECT * FROM admin_sessions WHERE token = ? AND expires_at > ?', 
        [token, new Date().toISOString()], 
        (err, row) => {
            if (err || !row) {
                return res.status(401).json({ error: 'Não autorizado' });
            }
            next();
        }
    );
}

// Listar todos os clientes
router.get('/clients', adminAuth, (req, res) => {
    db.all(`
        SELECT c.id, c.name, c.email, c.status, c.created_at, c.last_login,
               p.name as plan_name,
               COUNT(uls.live_source_id) as lives_count
        FROM clients c
        LEFT JOIN subscriptions s ON s.client_id = c.id
        LEFT JOIN plans p ON p.id = s.plan_id
        LEFT JOIN user_live_subscriptions uls ON uls.user_id = c.id
        GROUP BY c.id
        ORDER BY c.created_at DESC
    `, (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
        } else {
            res.json({ clients: rows });
        }
    });
});

// Criar novo cliente
router.post('/clients', adminAuth, async (req, res) => {
    const { name, email, password, planId = 1 } = req.body;
    
    if (!name || !email || !password) {
        return res.status(400).json({ error: 'Nome, email e senha obrigatórios' });
    }
    
    const password_hash = bcrypt.hashSync(password, 10);
    
    db.run(
        'INSERT INTO clients (name, email, password_hash) VALUES (?, ?, ?)',
        [name, email, password_hash],
        function(err) {
            if (err) {
                if (err.message.includes('UNIQUE')) {
                    res.status(400).json({ error: 'Email já cadastrado' });
                } else {
                    res.status(500).json({ error: err.message });
                }
            } else {
                const clientId = this.lastID;
                // Criar assinatura para o cliente
                db.run(
                    'INSERT INTO subscriptions (client_id, plan_id, expires_at) VALUES (?, ?, DATE("now", "+30 days"))',
                    [clientId, planId],
                    (err2) => {
                        if (err2) {
                            res.status(500).json({ error: err2.message });
                        } else {
                            res.json({ success: true, id: clientId, message: 'Cliente criado com sucesso' });
                        }
                    }
                );
            }
        }
    );
});

// Suspender cliente (e parar suas lives)
router.put('/clients/:id/suspend', adminAuth, async (req, res) => {
    const clientId = req.params.id;
    
    // Buscar todas as lives do cliente
    db.all(`
        SELECT ls.* FROM live_sources ls
        JOIN user_live_subscriptions uls ON uls.live_source_id = ls.id
        WHERE uls.user_id = ?
    `, [clientId], async (err, lives) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        
        let livesRemoved = 0;
        
        // Para cada live, processar
        for (const live of lives) {
            // Remover associação do cliente
            db.run('DELETE FROM user_live_subscriptions WHERE user_id = ? AND live_source_id = ?', 
                [clientId, live.id]);
            
            // Decrementar subscribers
            db.run('UPDATE live_sources SET subscribers = subscribers - 1 WHERE id = ?', [live.id]);
            
            // Verificar se ainda tem assinantes
            db.get('SELECT subscribers FROM live_sources WHERE id = ?', [live.id], (err3, row) => {
                if (row && row.subscribers <= 0) {
                    // Parar monitoramento
                    liveMonitor.stopMonitoring(live.youtube_url);
                    console.log(`🛑 Live ${live.youtube_url} parada (sem assinantes)`);
                }
                livesRemoved++;
            });
        }
        
        // Aguardar um pouco para processar as remoções
        setTimeout(() => {
            // Atualizar status do cliente
            db.run('UPDATE clients SET status = "suspended" WHERE id = ?', [clientId], (err2) => {
                if (err2) {
                    res.status(500).json({ error: err2.message });
                } else {
                    res.json({ 
                        success: true, 
                        message: `Cliente suspenso. ${lives.length} lives removidas.`,
                        livesRemoved: lives.length
                    });
                }
            });
        }, 500);
    });
});

// Reativar cliente
router.put('/clients/:id/activate', adminAuth, (req, res) => {
    db.run('UPDATE clients SET status = "active" WHERE id = ?', [req.params.id], (err) => {
        if (err) {
            res.status(500).json({ error: err.message });
        } else {
            res.json({ 
                success: true, 
                message: 'Cliente reativado. As lives precisam ser readicionadas.' 
            });
        }
    });
});

// Excluir cliente e suas associações
router.delete('/clients/:id', adminAuth, (req, res) => {
    // Primeiro buscar as lives do cliente para parar monitoramento
    db.all(`
        SELECT ls.* FROM live_sources ls
        JOIN user_live_subscriptions uls ON uls.live_source_id = ls.id
        WHERE uls.user_id = ?
    `, [req.params.id], (err, lives) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        
        db.serialize(() => {
            db.run('DELETE FROM user_live_subscriptions WHERE user_id = ?', [req.params.id]);
            db.run('DELETE FROM subscriptions WHERE client_id = ?', [req.params.id]);
            db.run('DELETE FROM payments WHERE client_id = ?', [req.params.id]);
            db.run('DELETE FROM clients WHERE id = ?', [req.params.id], (err2) => {
                if (err2) {
                    res.status(500).json({ error: err2.message });
                } else {
                    // Atualizar subscribers e possivelmente parar monitoramento
                    for (const live of lives) {
                        db.run('UPDATE live_sources SET subscribers = subscribers - 1 WHERE id = ?', [live.id]);
                        db.get('SELECT subscribers FROM live_sources WHERE id = ?', [live.id], (err3, row) => {
                            if (row && row.subscribers <= 0) {
                                liveMonitor.stopMonitoring(live.youtube_url);
                                console.log(`🛑 Live ${live.youtube_url} parada (sem assinantes)`);
                            }
                        });
                    }
                    res.json({ success: true, message: 'Cliente removido' });
                }
            });
        });
    });
});

// Obter lives de um cliente específico
router.get('/clients/:id/lives', adminAuth, (req, res) => {
    db.all(`
        SELECT ls.* FROM live_sources ls
        JOIN user_live_subscriptions uls ON uls.live_source_id = ls.id
        WHERE uls.user_id = ?
    `, [req.params.id], (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
        } else {
            res.json({ lives: rows });
        }
    });
});

// Obter planos disponíveis
router.get('/plans', adminAuth, (req, res) => {
    db.all('SELECT * FROM plans ORDER BY price', (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
        } else {
            res.json({ plans: rows });
        }
    });
});

module.exports = router;