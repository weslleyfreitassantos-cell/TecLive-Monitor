const liveMonitor = require('./services/liveMonitor');

// Lista de lives para monitorar automaticamente
const lives = [
    'https://www.youtube.com/watch?v=dGiMBVU3j8s',
    // Adicione outras lives aqui
];

// Intervalo de verificação (15 segundos é mais estável)
const CHECK_INTERVAL = 15000; // 15 segundos

console.log('=' .repeat(50));
console.log('🚀 INICIANDO MONITORAMENTO AUTOMÁTICO');
console.log('=' .repeat(50));
console.log(`📡 Total de lives: ${lives.length}`);
console.log(`⏱️  Intervalo de verificação: ${CHECK_INTERVAL / 1000} segundos`);
console.log('');

// Iniciar cada live com delay de 3 segundos
lives.forEach((url, index) => {
    setTimeout(() => {
        console.log(`[${index + 1}] Iniciando monitoramento...`);
        console.log(`    📺 URL: ${url.substring(0, 60)}...`);
        try {
            liveMonitor.startMonitoring(url, CHECK_INTERVAL);
            console.log(`    ✅ Monitoramento ativo!`);
        } catch (error) {
            console.error(`    ❌ Erro: ${error.message}`);
        }
    }, index * 3000);
});

console.log('');
console.log('✅ AGENDADO! Lives serão monitoradas em sequência');
console.log('=' .repeat(50));