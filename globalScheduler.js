const EventEmitter = require('events');

class WorkerPool {
    constructor(concurrency = 8) {
        this.concurrency = concurrency;
        this.running = 0;
        this.queue = [];
    }

    async run(task) {
        if (this.running >= this.concurrency) {
            await new Promise(resolve => this.queue.push(resolve));
        }
        this.running++;
        try {
            return await task();
        } finally {
            this.running--;
            if (this.queue.length) {
                const next = this.queue.shift();
                next();
            }
        }
    }

    getStats() {
        return { concurrency: this.concurrency, running: this.running, queued: this.queue.length };
    }
}

class GlobalScheduler extends EventEmitter {
    constructor(intervalMs = 30000, concurrency = 8, cookieRotator = null) {
        super();
        this.intervalMs = intervalMs;
        this.pool = new WorkerPool(concurrency);
        this.monitors = new Map(); // videoId -> monitor
        this.timer = null;
        this._running = false;
        this._processing = false;
        this.cookieRotator = cookieRotator; // armazena o rotator de cookies
    }

    register(monitor) {
        if (!monitor.videoId) return false;
        this.monitors.set(monitor.videoId, monitor);
        // Inicializa nextCheck (agora ou em breve)
        if (!monitor.nextCheck) monitor.nextCheck = Date.now() + (monitor.intervalMs || 30000);
        this._startIfNeeded();
        return true;
    }

    unregister(videoId) {
        this.monitors.delete(videoId);
        if (this.monitors.size === 0 && this.timer) {
            clearInterval(this.timer);
            this.timer = null;
            this._running = false;
        }
    }

    _startIfNeeded() {
        if (this._running || this.monitors.size === 0) return;
        this._running = true;
        // Verifica a cada 1 segundo quais monitores estão prontos (granularidade)
        this.timer = setInterval(() => this._tick(), 1000);
        console.log(`🚀 GlobalScheduler iniciado com pool de ${this.pool.concurrency} workers e verificação a cada 1s.`);
    }

    async _tick() {
        if (this._processing) return;
        this._processing = true;
        const now = Date.now();
        const monitorsToRun = [];
        for (const monitor of this.monitors.values()) {
            if (monitor.nextCheck && monitor.nextCheck <= now && !monitor._running && !monitor._monitorStopped && !monitor._liveEnded) {
                monitorsToRun.push(monitor);
            }
        }
        if (monitorsToRun.length === 0) {
            this._processing = false;
            return;
        }
        console.log(`🔁 Scheduler: ${monitorsToRun.length} monitores prontos (pool: ${this.pool.getStats().running}/${this.pool.concurrency} executando, ${this.pool.getStats().queued} na fila)`);
        const start = Date.now();
        
        await Promise.all(monitorsToRun.map(monitor =>
            this.pool.run(async () => {
                const execStart = Date.now();
                try {
                    await monitor.checkAndRenew();
                } catch (err) {
                    console.error(`[${monitor.videoId}] Erro no worker:`, err.message);
                } finally {
                    // Atualiza nextCheck baseado no intervalo atual do monitor (pode ser ajustado dinamicamente)
                    const duration = Date.now() - execStart;
                    let nextInterval = monitor._currentIntervalMs || monitor.intervalMs || 30000;
                    // Se a live está online e estável, aumenta um pouco o intervalo (já existe lógica no monitor)
                    // Se o monitor teve erro ou está degradado, reduz o intervalo
                    if (monitor.liveState === 'online') {
                        // Mantém o intervalo atual (pode ser maior que o base)
                    } else if (monitor.liveState === 'degraded') {
                        nextInterval = Math.max(15000, nextInterval * 0.8);
                    } else {
                        nextInterval = 30000;
                    }
                    monitor.nextCheck = Date.now() + nextInterval;
                    console.log(`[${monitor.videoId}] Próxima verificação em ${(nextInterval/1000).toFixed(1)}s (execução levou ${(duration/1000).toFixed(1)}s)`);
                }
            })
        ));
        
        const elapsed = Date.now() - start;
        console.log(`✅ Scheduler concluído em ${elapsed}ms. Pool: ${this.pool.getStats().running}/${this.pool.concurrency}, fila: ${this.pool.getStats().queued}`);
        this._processing = false;
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this._running = false;
        console.log('🛑 GlobalScheduler parado.');
    }

    getStats() {
        return {
            activeMonitors: this.monitors.size,
            intervalMs: this.intervalMs,
            running: this._running,
            pool: this.pool.getStats()
        };
    }
}

module.exports = GlobalScheduler;