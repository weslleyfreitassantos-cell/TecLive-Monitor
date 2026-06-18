// worker.js - Executa uma tarefa (ciclo de verificação de uma live)
const LiveMonitor = require('./monitor/liveMonitor');

// O worker recebe uma mensagem do dispatcher
process.on('message', async (task) => {
    const { youtubeUrl, emailAlerts, videoId, liveCache } = task;
    console.log(`[Worker] Iniciando tarefa para ${videoId}`);
    try {
        // Criamos um monitor temporário (ele usará o cache injetado)
        const monitor = new LiveMonitor(youtubeUrl, emailAlerts, liveCache);
        // Executa um ciclo completo
        await monitor.checkAndRenew();
        // Comunica sucesso
        process.send({ videoId, success: true });
    } catch (error) {
        console.error(`[Worker] Erro ao processar ${videoId}: ${error.message}`);
        process.send({ videoId, success: false, error: error.message });
    }
});
