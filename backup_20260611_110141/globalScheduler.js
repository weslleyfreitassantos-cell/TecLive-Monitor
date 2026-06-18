// globalScheduler.js
const EventEmitter = require('events');

class GlobalScheduler extends EventEmitter {
    constructor(intervalMs = 30000) {
        super();
        this.intervalMs = intervalMs;
        this.monitors = new Map();
        this.timer = null;
        this._running = false;
        this._processing = false;
    }

    register(monitor) {
        if (!monitor.videoId) return false;
        this.monitors.set(monitor.videoId, monitor);
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
        this.timer = setInterval(() => this._tick(), this.intervalMs);
        console.log(`🕒 GlobalScheduler iniciado com intervalo de ${this.intervalMs/1000}s`);
    }

    async _tick() {
        if (this._processing) return;
        this._processing = true;
        const start = Date.now();
        const monitorsToRun = Array.from(this.monitors.values());
        console.log(`🔄 Scheduler tick: executando ${monitorsToRun.length} monitores...`);
        
        await Promise.all(monitorsToRun.map(async (monitor) => {
            if (monitor._running || monitor._monitorStopped || monitor._liveEnded) return;
            try {
                await monitor.checkAndRenew();
            } catch (err) {
                console.error(`[${monitor.videoId}] Erro no scheduler:`, err.message);
            }
        }));
        
        const elapsed = Date.now() - start;
        console.log(`✅ Scheduler tick concluído em ${elapsed}ms`);
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
            running: this._running
        };
    }
}

module.exports = GlobalScheduler;