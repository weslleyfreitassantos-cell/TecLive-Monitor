const express = require('express');
const router = express.Router();
const liveMonitor = require('../services/liveMonitor');

router.get('/play', async (req, res) => {
    const { url } = req.query;
    
    if (!url) {
        return res.status(400).send('URL da live é obrigatória');
    }
    
    // VERIFICA SE JÁ ESTÁ MONITORANDO
    const status = liveMonitor.getLiveStatus(url);
    
    // SE NÃO ESTIVER MONITORANDO, INICIA AUTOMATICAMENTE
    if (!status.monitoring) {
        console.log(`🚀 Iniciando monitoramento automático para: ${url}`);
        liveMonitor.startMonitoring(url, 5000);
        
        // Aguarda o primeiro link ser obtido (máximo 10 segundos)
        let tentativas = 0;
        while (!liveMonitor.getLiveStatus(url).currentM3U8 && tentativas < 10) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            tentativas++;
        }
    }
    
    // Pega o status atualizado
    const updatedStatus = liveMonitor.getLiveStatus(url);
    
    if (!updatedStatus.currentM3U8) {
        return res.status(503).send('Link M3U8 ainda não disponível. Aguarde alguns segundos.');
    }
    
    // Redireciona para o link mais atual
    res.redirect(updatedStatus.currentM3U8);
});

module.exports = router;