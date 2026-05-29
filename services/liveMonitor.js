const { getM3U8 } = require('./youtube');
const EventEmitter = require('events');

class LiveMonitor extends EventEmitter {
    constructor() {
        super();
        this.activeLives = new Map();
        this.checkInterval = 5000;
    }

    startMonitoring(url, checkInterval = null) {
        if (this.activeLives.has(url)) {
            console.log(`📡 Live já está sendo monitorada: ${url}`);
            return;
        }

        const interval = checkInterval || this.checkInterval;
        
        console.log(`🎬 Iniciando monitoramento da live: ${url}`);
        console.log(`⏱️  Verificando a cada ${interval/1000} segundos`);

        const liveData = {
            currentM3U8: null,
            lastCheck: null,
            interval: null,
            changes: [],
            url: url,
            startTime: Date.now()
        };

        const checkLive = async () => {
            try {
                const newM3U8 = await getM3U8(url);
                const oldM3U8 = liveData.currentM3U8;
                const checkTime = new Date();

                if (oldM3U8 && oldM3U8 !== newM3U8) {
                    const change = {
                        oldM3U8,
                        newM3U8,
                        timestamp: checkTime,
                        changeId: liveData.changes.length + 1
                    };
                    
                    liveData.changes.push(change);
                    
                    console.log(`🔄 LINK MUDOU! (${liveData.changes.length}ª alteração)`);
                    console.log(`⏰ ${checkTime.toLocaleString()}`);
                    
                    this.emit('linkChanged', {
                        url,
                        oldM3U8,
                        newM3U8,
                        changeCount: liveData.changes.length,
                        timestamp: checkTime
                    });
                }

                liveData.currentM3U8 = newM3U8;
                liveData.lastCheck = checkTime;

                this.emit('heartbeat', {
                    url,
                    m3u8: newM3U8,
                    lastCheck: checkTime,
                    isStable: oldM3U8 === newM3U8
                });

            } catch (error) {
                console.error(`❌ Erro ao verificar live ${url}:`, error.message);
            }
        };

        const intervalId = setInterval(checkLive, interval);
        liveData.interval = intervalId;
        
        checkLive();
        
        this.activeLives.set(url, liveData);
        
        return liveData;
    }

    stopMonitoring(url) {
        const liveData = this.activeLives.get(url);
        
        if (!liveData) {
            console.log(`⚠️ Live não está sendo monitorada: ${url}`);
            return false;
        }
        
        clearInterval(liveData.interval);
        this.activeLives.delete(url);
        
        console.log(`🛑 Monitoramento interrompido: ${url}`);
        console.log(`📊 Total de mudanças detectadas: ${liveData.changes.length}`);
        
        return true;
    }

    getLiveStatus(url) {
        const liveData = this.activeLives.get(url);
        
        if (!liveData) {
            return { monitoring: false };
        }
        
        return {
            monitoring: true,
            currentM3U8: liveData.currentM3U8,
            lastCheck: liveData.lastCheck,
            changesCount: liveData.changes.length,
            uptime: Date.now() - liveData.startTime,
            url: liveData.url
        };
    }

    listMonitoredLives() {
        const lives = [];
        
        for (const [url, data] of this.activeLives.entries()) {
            lives.push({
                url,
                changesCount: data.changes.length,
                lastCheck: data.lastCheck,
                uptime: Date.now() - data.startTime
            });
        }
        
        return lives;
    }
}

const liveMonitor = new LiveMonitor();

module.exports = liveMonitor;