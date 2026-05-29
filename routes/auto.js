const express = require('express');
const router = express.Router();
const { getM3U8 } = require('../services/youtube');
const liveMonitor = require('../services/liveMonitor');

let autoMonitoringActive = false;

router.get('/start', async (req, res) => {
    try {
        const youtubeUrl = req.query.url;
        
        if (!youtubeUrl) {
            return res.status(400).json({ error: 'Envie a URL da live' });
        }

        console.log('\n🚀 INICIANDO SISTEMA AUTOMÁTICO');
        console.log(`📺 Live: ${youtubeUrl}`);
        
        // 1. Extrair o M3U8 inicial
        console.log('📡 Extraindo link M3U8...');
        const initialM3U8 = await getM3U8(youtubeUrl);
        
        // 2. Iniciar monitoramento automático
        console.log('🔍 Iniciando monitoramento...');
        liveMonitor.startMonitoring(youtubeUrl, 5000);
        
        // 3. Configurar para enviar atualizações em tempo real
        res.setHeader('Content-Type', 'text/plain');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        
        res.write(`✅ SISTEMA INICIADO COM SUCESSO!\n`);
        res.write(`📺 Live: ${youtubeUrl}\n`);
        res.write(`🎬 Link M3U8 inicial:\n${initialM3U8}\n\n`);
        res.write(`🔄 Monitorando mudanças... (verificando a cada 5 segundos)\n`);
        res.write(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`);
        
        // 4. Função para enviar atualizações
        let lastChangeCount = 0;
        
        const checkAndNotify = async () => {
            const status = liveMonitor.getLiveStatus(youtubeUrl);
            
            if (status.monitoring && status.changesCount > lastChangeCount) {
                const changeCount = status.changesCount;
                lastChangeCount = changeCount;
                
                res.write(`\n🔄 [${new Date().toLocaleTimeString()}] LINK MUDOU! (${changeCount}ª vez)\n`);
                res.write(`📌 Novo link M3U8:\n${status.currentM3U8}\n`);
                res.write(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`);
            }
        };
        
        // Verificar a cada 3 segundos e enviar atualizações
        const intervalId = setInterval(checkAndNotify, 3000);
        
        // Quando o cliente fechar a conexão, para o monitoramento
        req.on('close', () => {
            clearInterval(intervalId);
            liveMonitor.stopMonitoring(youtubeUrl);
            console.log(`\n🛑 Monitoramento encerrado para: ${youtubeUrl}`);
            res.end();
        });
        
    } catch (error) {
        console.error('Erro:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;