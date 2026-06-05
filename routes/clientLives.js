const express = require('express');
const router = express.Router();
const db = require('../database/schema');
const liveMonitor = require('../services/liveMonitor');
const { verifyToken, checkClientActive } = require('../middlewares/authClient');
const crypto = require('crypto');

// 🔒 Remover uma live do cliente (apenas a que ele adicionou)
router.delete('/lives/:liveId', verifyToken, checkClientActive, async (req, res) => {
    try {
        const liveId = req.params.liveId;
        const clientId = req.clientId;
        
        console.log(`🗑️ Cliente ${clientId} solicitou remoção da live ${liveId}`);
        
        // Verificar se o cliente tem esta live
        db.get(`
            SELECT ls.* FROM live_sources ls
            JOIN user_live_subscriptions uls ON uls.live_source_id = ls.id
            WHERE ls.id = ? AND uls.user_id = ?
        `, [liveId, clientId], async (err, live) => {
            if (err || !live) {
                console.log(`⚠️ Live ${liveId} não encontrada para o cliente ${clientId}`);
                return res.status(404).json({ error: 'Live não encontrada ou não pertence a você' });
            }
            
            console.log(`✅ Live encontrada: ${live.youtube_url}`);
            
            // Remover associação do cliente
            db.run('DELETE FROM user_live_subscriptions WHERE user_id = ? AND live_source_id = ?', 
                [clientId, liveId], (err2) => {
                if (err2) {
                    console.error(`❌ Erro ao remover associação: ${err2.message}`);
                    return res.status(500).json({ error: 'Erro ao remover live' });
                }
                
                console.log(`✅ Associação removida para cliente ${clientId}`);
                
                // Decrementar subscribers
                db.run('UPDATE live_sources SET subscribers = subscribers - 1 WHERE id = ?', [liveId], (err3) => {
                    if (err3) {
                        console.error(`❌ Erro ao decrementar subscribers: ${err3.message}`);
                    }
                });
                
                // Verificar se ainda tem assinantes
                db.get('SELECT subscribers FROM live_sources WHERE id = ?', [liveId], (err3, row) => {
                    if (row && row.subscribers <= 0) {
                        liveMonitor.stopMonitoring(live.youtube_url);
                        console.log(`🛑 Live ${live.youtube_url} parada (sem assinantes)`);
                    } else {
                        console.log(`📊 Live ainda tem ${row?.subscribers || 0} assinante(s)`);
                    }
                });
                
                res.json({ success: true, message: 'Live removida com sucesso' });
            });
        });
    } catch (error) {
        console.error('❌ Erro ao remover live:', error);
        res.status(500).json({ error: 'Erro interno' });
    }
});

// 🔐 GERAR LINK SEGURO PARA A LIVE (formato: /live/:token.m3u8)
router.post('/generate-link/:liveId', verifyToken, checkClientActive, async (req, res) => {
    const clientId = req.clientId;
    const liveId = req.params.liveId;
    
    // Verificar se cliente tem acesso a esta live
    db.get(`
        SELECT * FROM user_live_subscriptions 
        WHERE user_id = ? AND live_source_id = ?
    `, [clientId, liveId], async (err, subscription) => {
        
        if (err || !subscription) {
            return res.status(403).json({ error: 'Você não tem acesso a esta live' });
        }
        
        // Gerar token único
        const token = crypto.randomBytes(16).toString('hex');
        
        // Salvar no banco
        db.run(`INSERT INTO stream_links (client_id, live_id, token, active) VALUES (?, ?, ?, 1)`,
            [clientId, liveId, token], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            
            // Link seguro (formato amigável)
            const secureLink = `${req.protocol}://${req.get('host')}/live/${token}.m3u8`;
            
            res.json({
                success: true,
                secure_link: secureLink,
                token: token,
                live_id: liveId,
                message: 'Link gerado com sucesso! Copie e cole no NEOnews.'
            });
        });
    });
});

module.exports = router;