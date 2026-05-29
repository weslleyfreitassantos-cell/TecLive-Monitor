const express = require('express');
const router = express.Router();
const liveMonitor = require('../services/liveMonitor');

// Endpoint fixo para o NEOnews consultar SEMPRE o link mais atual
router.get('/stream', (req, res) => {
    const { url } = req.query;
    
    if (!url) {
        return res.status(400).json({ error: 'URL da live é obrigatória' });
    }
    
    // Pega o status atual da live sendo monitorada
    const status = liveMonitor.getLiveStatus(url);
    
    if (!status.monitoring) {
        return res.status(404).json({ 
            error: 'Live não está sendo monitorada. Inicie o monitoramento primeiro.' 
        });
    }
    
    if (!status.currentM3U8) {
        return res.status(503).json({ 
            error: 'Link M3U8 ainda não disponível. Aguarde alguns segundos.' 
        });
    }
    
    // Retorna o link MAIS ATUALIZADO
    res.json({
        live_url: status.currentM3U8,
        last_check: status.lastCheck,
        changes: status.changesCount
    });
});

// Endpoint que redireciona diretamente para o link M3U8
router.get('/play', (req, res) => {
    const { url } = req.query;
    const status = liveMonitor.getLiveStatus(url);
    
    if (status.monitoring && status.currentM3U8) {
        // Redireciona diretamente para o link mais atual
        res.redirect(status.currentM3U8);
    } else {
        res.status(404).send('Live não disponível');
    }
});

module.exports = router;