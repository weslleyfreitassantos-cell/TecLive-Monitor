const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const liveRegistry = require('../services/liveRegistry');
const liveMonitor = require('../services/liveMonitor');
const logger = require('../utils/logger');

// Rate limit para adicionar lives (protege contra abusos)
const addLiveLimiter = rateLimit({
    windowMs: 60 * 1000,  // 1 minuto
    max: 10,              // máximo 10 requisições por minuto
    message: { error: 'Muitas tentativas. Aguarde um momento.' }
});

// POST /monitor/start - Registrar uma live (reutiliza se existir)
router.post('/start', addLiveLimiter, async (req, res) => {
    try {
        const { url } = req.body;
        
        if (!url) {
            return res.status(400).json({ error: 'URL é obrigatória' });
        }
        
        console.log(`📢 Registrando live: ${url}`);
        
        // Registrar live (reutiliza se já existir)
        const result = await liveRegistry.registerLive(url);
        
        res.json({
            success: true,
            message: result.isNew ? 'Live adicionada com sucesso' : 'Live já existente',
            live: result.live,
            m3u8_url: result.m3u8Url
        });
        
    } catch (error) {
        logger.error(`Erro ao registrar live: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// GET /monitor/lives - Todas as lives ativas (COM TÍTULOS)
router.get('/lives', async (req, res) => {
    try {
        const lives = liveMonitor.listMonitoredLives();
        
        // Enriquecer com títulos do banco de dados
        const enrichedLives = [];
        for (const live of lives) {
            // Extrair ID do YouTube da URL
            const match = live.url.match(/(?:youtube\.com\/watch\?v=)([^&]+)/);
            const youtubeId = match ? match[1] : null;
            
            let title = null;
            if (youtubeId) {
                const liveSource = await liveRegistry.getLiveByYoutubeId(youtubeId);
                title = liveSource?.title || null;
            }
            
            enrichedLives.push({
                ...live,
                title: title
            });
        }
        
        res.json({ total: enrichedLives.length, lives: enrichedLives });
    } catch (error) {
        logger.error(`Erro ao listar lives: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// POST /monitor/stop - Parar monitoramento
router.post('/stop', (req, res) => {
    try {
        const { url } = req.body;
        
        if (!url) {
            return res.status(400).json({ error: 'URL é obrigatória' });
        }
        
        const stopped = liveMonitor.stopMonitoring(url);
        
        res.json({
            success: stopped,
            message: stopped ? 'Monitoramento interrompido' : 'Live não estava sendo monitorada'
        });
        
    } catch (error) {
        logger.error(`Erro ao parar monitoramento: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;