// routes/liveSecure.js
const express = require('express');
const router = express.Router();
const db = require('../database/schema');
const liveMonitor = require('../services/liveMonitor');
const { verifyToken, checkClientActive } = require('../middlewares/authClient');

// 🔒 Endpoint protegido para NEOnews (com ID interno)
router.get('/:id.m3u8', verifyToken, checkClientActive, async (req, res) => {
    try {
        const liveId = req.params.id;
        const clientId = req.clientId;
        
        // Verificar se o cliente tem acesso a esta live
        db.get(`
            SELECT ls.* FROM live_sources ls
            JOIN user_live_subscriptions uls ON uls.live_source_id = ls.id
            WHERE ls.id = ? AND uls.user_id = ?
        `, [liveId, clientId], async (err, live) => {
            if (err || !live) {
                return res.status(403).send('Acesso negado');
            }
            
            if (!live.current_m3u8) {
                return res.status(503).send('Live ainda não disponível');
            }
            
            // Atualizar lastAccess para timeout
            liveMonitor.updateLastAccess(live.youtube_url);
            
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            res.send(live.current_m3u8);
        });
    } catch (error) {
        console.error('Erro no endpoint live seguro:', error);
        res.status(500).send('Erro interno');
    }
});

module.exports = router;