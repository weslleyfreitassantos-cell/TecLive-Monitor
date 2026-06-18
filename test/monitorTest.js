// test/monitorTest.js
const LiveMonitor = require('../monitor/liveMonitor');
const LiveMonitorV3 = require('../monitor/liveMonitorV3');

console.log('=== Teste de Monitores ===\n');

console.log('📡 Versão atual (v2):');
const monitorV2 = new LiveMonitor('https://www.youtube.com/watch?v=jNQXAC9IVRw', null, new Map());
monitorV2.startMonitoring(30);

setTimeout(() => {
    console.log('\n📡 Versão V3 (modular):');
    const monitorV3 = new LiveMonitorV3('https://www.youtube.com/watch?v=jNQXAC9IVRw', null, new Map());
    monitorV3.startMonitoring(30);
}, 5000);

setTimeout(() => {
    console.log('\n✅ Teste concluído - ambas as versões rodando');
    console.log('⚠️ Para parar, pressione Ctrl+C');
}, 10000);
