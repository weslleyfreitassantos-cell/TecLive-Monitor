const express = require('express');
const router = express.Router();
const liveMonitor = require('../services/liveMonitor');

router.post('/start', async (req, res) => {
    try {
        const { url, interval } = req.body;
        
        if (!url) {
            return res.status(400).json({ error: 'URL é obrigatória' });
        }
        
        const liveData = liveMonitor.startMonitoring(url, interval);
        
        res.json({
            success: true,
            message: 'Monitoramento iniciado',
            url,
            status: liveMonitor.getLiveStatus(url)
        });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

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
        res.status(500).json({ error: error.message });
    }
});

router.get('/status', (req, res) => {
    try {
        const { url } = req.query;
        
        if (!url) {
            return res.status(400).json({ error: 'URL é obrigatória' });
        }
        
        const status = liveMonitor.getLiveStatus(url);
        res.json(status);
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.get('/lives', (req, res) => {
    try {
        const lives = liveMonitor.listMonitoredLives();
        res.json({
            total: lives.length,
            lives
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;