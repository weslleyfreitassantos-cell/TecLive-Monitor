const express = require('express');
const router = express.Router();
const liveMonitor = require('../services/liveMonitor');
const https = require('https');
const http = require('http');

// Helper function para obter o link atual
async function getCurrentM3U8(url) {
    let status = liveMonitor.getLiveStatus(url);
    
    if (!status.monitoring) {
        console.log(`🚀 Iniciando monitoramento automático para: ${url}`);
        // 🔥 ALTERADO PARA 30 SEGUNDOS
        liveMonitor.startMonitoring(url, 30000);
        
        let tentativas = 0;
        while (!liveMonitor.getLiveStatus(url).currentM3U8 && tentativas < 10) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            tentativas++;
        }
    }
    
    const updatedStatus = liveMonitor.getLiveStatus(url);
    return updatedStatus.currentM3U8;
}

// Função para baixar o conteúdo do M3U8
function downloadM3U8(m3u8Url) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(m3u8Url);
        const protocol = urlObj.protocol === 'https:' ? https : http;
        
        const options = {
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        };
        
        const request = protocol.get(options, (response) => {
            let data = '';
            response.on('data', (chunk) => { data += chunk; });
            response.on('end', () => {
                resolve(data);
            });
        });
        
        request.on('error', (error) => {
            reject(error);
        });
    });
}

// Endpoint para VLC, navegador e players comuns (com redirecionamento)
router.get('/live.m3u8', async (req, res) => {
    const { url } = req.query;
    
    if (!url) {
        return res.status(400).send('URL da live é obrigatória');
    }
    
    // 🔥 ATUALIZA O LAST ACCESS (timeout)
    liveMonitor.updateLastAccess(url);
    
    const m3u8Url = await getCurrentM3U8(url);
    
    if (!m3u8Url) {
        return res.status(503).send('Link M3U8 ainda não disponível');
    }
    
    res.redirect(m3u8Url);
});

// Endpoint ESPECÍFICO para NEOnews (retorna o CONTEÚDO do M3U8)
router.get('/neonews.m3u8', async (req, res) => {
    const { url } = req.query;
    
    if (!url) {
        return res.status(400).send('URL da live é obrigatória');
    }
    
    // 🔥 ATUALIZA O LAST ACCESS (timeout)
    liveMonitor.updateLastAccess(url);
    
    const m3u8Url = await getCurrentM3U8(url);
    
    if (!m3u8Url) {
        return res.status(503).send('Link M3U8 ainda não disponível');
    }
    
    try {
        const m3u8Content = await downloadM3U8(m3u8Url);
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.send(m3u8Content);
    } catch (error) {
        console.error('Erro ao baixar M3U8:', error);
        res.status(500).send('Erro ao obter o stream');
    }
});

// Endpoint original /play (mantido para compatibilidade)
router.get('/play', async (req, res) => {
    const { url } = req.query;
    
    if (!url) {
        return res.status(400).send('URL da live é obrigatória');
    }
    
    // 🔥 ATUALIZA O LAST ACCESS (timeout)
    liveMonitor.updateLastAccess(url);
    
    const m3u8Url = await getCurrentM3U8(url);
    
    if (!m3u8Url) {
        return res.status(503).send('Link M3U8 ainda não disponível');
    }
    
    res.redirect(m3u8Url);
});

// Endpoint /stream (retorna JSON)
router.get('/stream', (req, res) => {
    const { url } = req.query;
    
    if (!url) {
        return res.status(400).json({ error: 'URL da live é obrigatória' });
    }
    
    const status = liveMonitor.getLiveStatus(url);
    
    if (!status.monitoring) {
        return res.status(404).json({
            error: 'Live não está sendo monitorada',
            solution: 'POST /monitor/start'
        });
    }
    
    res.json({
        live_url: status.currentM3U8,
        last_check: status.lastCheck,
        changes: status.changesCount,
        monitoring: true
    });
});

module.exports = router;