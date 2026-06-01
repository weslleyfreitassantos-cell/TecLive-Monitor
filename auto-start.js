const liveMonitor = require('./services/liveMonitor');

// Lista de lives para monitorar automaticamente
const lives = [
    'https://www.youtube.com/watch?v=dGiMBVU3j8s',
    'https://www.youtube.com/watch?v=bK03WDeq5SI',
    // Adicione mais lives aqui
];

// 🔥 ALTERADO PARA 30 SEGUNDOS
const CHECK_INTERVAL = 30000; // 30 segundos

console.log('=' .repeat(50));
console.log('🚀 INICIANDO MONITORAMENTO AUTOMÁTICO');
console.log('=' .repeat(50));
console.log(`📡 Total de lives: ${lives.length}`);
console.log(`⏱️  Intervalo de verificação: ${CHECK_INTERVAL / 1000} segundos`);
console.log('');

lives.forEach((url, index) => {
    setTimeout(() => {
        console.log(`[${index + 1}] Iniciando monitoramento...`);
        console.log(`    📺 URL: ${url.substring(0, 60)}...`);
        liveMonitor.startMonitoring(url, CHECK_INTERVAL);
        console.log(`    ✅ Monitoramento ativo!`);
    }, index * 3000);
});

console.log('');
console.log('✅ AGENDADO!');
console.log('=' .repeat(50));