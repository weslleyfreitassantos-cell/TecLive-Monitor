// globalScheduler.js
// Scheduler global único para todos os monitores
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
        if (!monitor || !monitor.videoId) return false;
        if (!this.monitors.has(monitor.videoId)) {
            this.monitors.set(monitor.videoId, monitor);
            console.log(`📝 Monitor registrado no scheduler: ${monitor.videoId}`);
            this._startIfNeeded();
        }
        return true;
    }

    unregister(videoId) {
        this.monitors.delete(videoId);
        if (this.monitors.size === 0 && this.timer) {
            clearInterval(this.timer);
            this.timer = null;
            this._running = false;
            console.log('🕒 Scheduler parado (nenhum monitor ativo)');
        }
    }

    _startIfNeeded() {
        if (this._running || this.monitors.size === 0) return;
        this._running = true;
        this.timer = setInterval(() => this._tick(), this.intervalMs);
        console.log(`🕒 GlobalScheduler iniciado com intervalo ${this.intervalMs/1000}s (${this.monitors.size} monitores)`);
    }

    async _tick() {
        if (this._processing) return;
        this._processing = true;
        const start = Date.now();
        const monitorsToRun = Array.from(this.monitors.values()).filter(m => !m._running && !m._monitorStopped && !m._liveEnded);
        if (monitorsToRun.length) {
            console.log(`🔄 Scheduler tick: ${monitorsToRun.length}/${this.monitors.size} monitores ativos`);
            await Promise.allSettled(monitorsToRun.map(m => m.checkAndRenew().catch(e => console.error(`[${m.videoId}] Erro no tick: ${e.message}`))));
            console.log(`✅ Scheduler tick concluído em ${Date.now()-start}ms`);
        } else {
            console.log(`⏭️ Scheduler tick: nenhum monitor pronto para executar`);
        }
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
        return { activeMonitors: this.monitors.size, intervalMs: this.intervalMs, running: this._running };
    }
}

module.exports = GlobalScheduler;
