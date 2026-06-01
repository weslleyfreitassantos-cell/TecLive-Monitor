const EventEmitter = require('events');
const { getM3U8 } = require('./youtube');

class LiveMonitorService extends EventEmitter {
    constructor() {
        super();
        this.activeLives = new Map();
        // 🔥 TIMEOUT: 1 hora sem acesso = para a live
        this.TIMEOUT_MS = 60 * 60 * 1000; // 1 hora
        // Verifica lives órfãs a cada 5 minutos
        this.timeoutChecker = setInterval(() => this.checkTimeouts(), 5 * 60 * 1000);
    }

    // 🔥 ALTERADO: valor padrão de 5000 (5s) para 30000 (30s)
    startMonitoring(url, checkInterval = 30000) {
        if (this.activeLives.has(url)) {
            console.log(`📡 Live já está sendo monitorada: ${url}`);
            return;
        }

        console.log(`🎬 Iniciando monitoramento da live: ${url}`);
        console.log(`⏱️  Verificando a cada ${checkInterval / 1000} segundos`);
        
        const liveData = {
            currentM3U8: null,
            lastCheck: null,
            lastAccess: Date.now(), // 🔥 Última vez que foi acessada
            interval: null,
            changes: [],
            startTime: Date.now(),
        };

        const checkLive = async () => {
            try {
                const newM3U8 = await getM3U8(url);
                const oldM3U8 = liveData.currentM3U8;
                
                if (oldM3U8 && oldM3U8 !== newM3U8) {
                    const change = {
                        oldM3U8,
                        newM3U8,
                        timestamp: new Date(),
                        changeId: liveData.changes.length + 1,
                    };
                    
                    liveData.changes.push(change);
                    console.log(`🔄 LINK MUDOU! (${liveData.changes.length}ª alteração)`);
                    console.log(`⏰ ${new Date().toLocaleTimeString()}`);
                    
                    this.emit('linkChanged', { url, ...change });
                }

                liveData.currentM3U8 = newM3U8;
                liveData.lastCheck = new Date();
                
            } catch (error) {
                console.error(`❌ Erro ao verificar live ${url}:`, error.message);
            }
        };

        const intervalId = setInterval(checkLive, checkInterval);
        liveData.interval = intervalId;
        
        checkLive();
        this.activeLives.set(url, liveData);
        
        return liveData;
    }

    // 🔥 Atualiza o último acesso (chamado quando o NEOnews consulta)
    updateLastAccess(url) {
        const liveData = this.activeLives.get(url);
        if (liveData) {
            liveData.lastAccess = Date.now();
            console.log(`📊 LastAccess atualizado: ${url.substring(0, 50)}...`);
        }
    }

    // 🔥 Verifica lives que expiraram (sem acesso por mais de 1 hora)
    checkTimeouts() {
        const now = Date.now();
        
        for (const [url, data] of this.activeLives.entries()) {
            const timeSinceLastAccess = now - data.lastAccess;
            
            if (timeSinceLastAccess > this.TIMEOUT_MS) {
                console.log(`⏰ Live removida por timeout (${Math.floor(timeSinceLastAccess / 60000)} min sem acesso): ${url.substring(0, 50)}...`);
                this.stopMonitoring(url);
            }
        }
    }

    stopMonitoring(url) {
        const liveData = this.activeLives.get(url);
        
        if (!liveData) {
            console.log(`⚠️ Live não está sendo monitorada: ${url}`);
            return false;
        }
        
        clearInterval(liveData.interval);
        this.activeLives.delete(url);
        
        console.log(`🛑 Monitoramento interrompido: ${url.substring(0, 50)}...`);
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
            lastAccess: liveData.lastAccess, // 🔥 Mostra último acesso
            changesCount: liveData.changes.length,
            uptime: Date.now() - liveData.startTime,
        };
    }

    listMonitoredLives() {
        const lives = [];
        for (const [url, data] of this.activeLives.entries()) {
            lives.push({
                url,
                changesCount: data.changes.length,
                lastCheck: data.lastCheck,
                lastAccess: data.lastAccess,
                uptime: Date.now() - data.startTime,
                idleMinutes: Math.floor((Date.now() - data.lastAccess) / 60000),
            });
        }
        return lives;
    }
}

module.exports = new LiveMonitorService();