const converter = require('./api/convert');

setTimeout(() => {
    console.log('=== INSPECIONANDO CACHE ===');
    if (converter && converter.liveCache) {
        for (const [url, data] of converter.liveCache.entries()) {
            console.log('URL:', url);
            console.log('videoId:', data.videoId);
            console.log('isLive:', data.isLive);
            console.log('monitor.status:', data.monitor ? data.monitor.status : 'SEM MONITOR');
            console.log('monitor.failCount:', data.monitor ? data.monitor.failCount : 0);
            console.log('---');
        }
    } else {
        console.log('Cache não encontrado');
    }
    process.exit(0);
}, 2000);
