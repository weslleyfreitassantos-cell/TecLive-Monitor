const EventEmitter = require('events');

class WorkerPool {
    // ✅ ALTERADO: taskTimeoutMs aumentado de 90000ms para 120000ms (2 minutos)
    constructor(concurrency = 6, taskTimeoutMs = 120000) {
        this.concurrency = concurrency;
        this.running = 0;
        this.queue = [];
        this.taskTimeoutMs = taskTimeoutMs;
    }

    async run(task) {
        if (this.running >= this.concurrency) {
            await new Promise(resolve => this.queue.push(resolve));
        }
        this.running++;
        try {
            return await this._withTimeout(task());
        } finally {
            this.running--;
            if (this.queue.length) {
                const next = this.queue.shift();
                next();
            }
        }
    }

    _withTimeout(promise) {
        let timeoutId;
        const timeout = new Promise((_, reject) => {
            timeoutId = setTimeout(
                () => reject(new Error(`WorkerPool: task excedeu o timeout de ${this.taskTimeoutMs}ms`)),
                this.taskTimeoutMs
            );
        });
        return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
    }

    getStats() {
        return { concurrency: this.concurrency, running: this.running, queued: this.queue.length };
    }
}

class GlobalScheduler extends EventEmitter {
    // ✅ ALTERADO: concurrency padrão de 8 para 6
    constructor(intervalMs = 30000, concurrency = 6, cookieRotator = null) {
        super();
        this.intervalMs = intervalMs;
        this.pool = new WorkerPool(concurrency);
        this.monitors = new Map();
        this.timer = null;
        this._running = false;
        this.cookieRotator = cookieRotator;

        this._lastTickActivity = Date.now();
        this._watchdogTimer = null;
    }

    register(monitor) {
        if (!monitor.videoId) return false;
        this.monitors.set(monitor.videoId, monitor);
        if (!monitor.nextCheck) monitor.nextCheck = Date.now() + (monitor.intervalMs || 8000);
        this._startIfNeeded();
        return true;
    }

    unregister(videoId) {
        this.monitors.delete(videoId);
        if (this.monitors.size === 0) {
            this._stop();
        }
    }

    _startIfNeeded() {
        if (this._running || this.monitors.size === 0) return;
        this._running = true;
        this.timer = setInterval(() => this._tick(), 1000);

        this._watchdogTimer = setInterval(() => {
            const silence = Date.now() - this._lastTickActivity;
            if (silence > 3 * 60 * 1000) {
                console.warn(`⚠️ [Watchdog] Scheduler sem atividade há ${(silence/1000).toFixed(0)}s. Monitores: ${this.monitors.size}`);
                for (const monitor of this.monitors.values()) {
                    if (monitor._running) {
                        const stuckMs = Date.now() - (monitor._runningStartedAt || 0);
                        if (stuckMs > 90000) {
                            console.warn(`⚠️ [Watchdog] Resetando _running travado do monitor ${monitor.videoId} (${(stuckMs/1000).toFixed(0)}s)`);
                            monitor._running = false;
                            monitor.nextCheck = Date.now();
                        }
                    }
                }
            }
        }, 2 * 60 * 1000);

        console.log(`🚀 GlobalScheduler iniciado com pool de ${this.pool.concurrency} workers e verificação a cada 1s.`);
    }

    _stop() {
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
        if (this._watchdogTimer) { clearInterval(this._watchdogTimer); this._watchdogTimer = null; }
        this._running = false;
        console.log('🛑 GlobalScheduler parado.');
    }

    async _tick() {
        const now = Date.now();
        this._lastTickActivity = now;

        const monitorsToRun = [];
        for (const monitor of this.monitors.values()) {
            if (
                monitor.nextCheck &&
                monitor.nextCheck <= now &&
                !monitor._running &&
                !monitor._monitorStopped &&
                !monitor._liveEnded
            ) {
                monitorsToRun.push(monitor);
            }
        }

        if (monitorsToRun.length === 0) return;

        console.log(`🔁 Scheduler: ${monitorsToRun.length} monitores prontos (pool: ${this.pool.getStats().running}/${this.pool.concurrency} executando, ${this.pool.getStats().queued} na fila)`);

        for (const monitor of monitorsToRun) {
            monitor._running = true;
            this._runMonitor(monitor);
        }
    }

    _runMonitor(monitor) {
        this.pool.run(async () => {
            const execStart = Date.now();
            monitor._runningStartedAt = execStart;
            try {
                await monitor.checkAndRenew();
            } catch (err) {
                console.error(`[${monitor.videoId}] Erro no worker:`, err.message);
            } finally {
                const duration = Date.now() - execStart;
                let nextInterval = monitor._currentIntervalMs || monitor.intervalMs || 8000;

                if (monitor.liveState === 'degraded') {
                    nextInterval = Math.max(8000, nextInterval * 0.8);
                } else if (monitor.liveState !== 'online') {
                    nextInterval = 30000;
                }

                monitor.nextCheck = Date.now() + nextInterval;
                monitor._runningStartedAt = null;
                monitor._running = false;

                // ✅ ALTERADO: limite de warning aumentado de 15000ms para 30000ms
                if (duration > 30000) {
                    console.warn(`[${monitor.videoId}] ⚠️ checkAndRenew demorou ${(duration/1000).toFixed(1)}s — considere aumentar o timeout do yt-dlp ou reduzir monitores simultâneos.`);
                } else {
                    console.log(`[${monitor.videoId}] Próxima verificação em ${(nextInterval/1000).toFixed(1)}s (execução levou ${(duration/1000).toFixed(1)}s)`);
                }
            }
        }).catch(err => {
            console.error(`[${monitor.videoId}] Erro crítico no pool:`, err.message);
            monitor._running = false;
            monitor.nextCheck = Date.now() + 30000;
        });
    }

    stop() {
        this._stop();
    }

    getStats() {
        return {
            activeMonitors: this.monitors.size,
            intervalMs: this.intervalMs,
            running: this._running,
            pool: this.pool.getStats(),
            lastTickActivity: this._lastTickActivity,
            secondsSinceLastActivity: ((Date.now() - this._lastTickActivity) / 1000).toFixed(1)
        };
    }
}

module.exports = GlobalScheduler;