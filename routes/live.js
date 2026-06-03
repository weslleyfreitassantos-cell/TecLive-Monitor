const express = require('express');
const router = express.Router();
const liveRegistry = require('../services/liveRegistry');
const liveMonitor = require('../services/liveMonitor');
const logger = require('../utils/logger');

// Endpoint limpo para NEOnews: /live/:id.m3u8
router.get('/:id.m3u8', async (req, res) => {
    try {
        const liveId = req.params.id;
        
        const live = await liveRegistry.getLiveById(liveId);
        
        if (!live) {
            return res.status(404).send('Live não encontrada');
        }
        
        if (!live.current_m3u8) {
            return res.status(503).send('Live ainda não disponível. Aguarde alguns segundos.');
        }
        
        // Atualizar lastAccess (para timeout)
        liveMonitor.updateLastAccess(live.youtube_url);
        
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.send(live.current_m3u8);
        
    } catch (error) {
        logger.error(`Erro ao servir live: ${error.message}`);
        res.status(500).send('Erro interno');
    }
});

// Endpoint alternativo para compatibilidade com versão anterior
router.get('/neonews.m3u8', async (req, res) => {
    const { url, user } = req.query;
    
    if (!url) {
        return res.status(400).send('URL da live é obrigatória');
    }
    
    try {
        // Registrar ou buscar live existente
        const result = await liveRegistry.registerLive(url, user);
        
        // Redirecionar para o endpoint limpo
        res.redirect(`/live/${result.live.id}.m3u8`);
        
    } catch (error) {
        logger.error(`Erro: ${error.message}`);
        res.status(500).send('Erro ao processar live');
    }
});

module.exports = router;