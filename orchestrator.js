// orchestrator.js - Camada de orquestração para múltiplos monitores
const os = require('os');
const EventEmitter = require('events');

class MonitorOrchestrator extends EventEmitter {
    constructor(options = {}) {
        super();
        this.maxConcurrent = options.maxConcurrent || 8;      // máximo de spawn simultâneos
        this.baseIntervalMs = options.baseIntervalMs || 30000;
        this.staggerStartMs = options.staggerStartMs || 1000; // delay entre inícios de monitores
        this.adaptivePolling = options.adaptivePolling !== false;
        this.systemHealthEnabled = options.systemHealthEnabled !== false;
        
        this.monitors = new Map();           // videoId -> monitor
        this.queuedJobs = [];                // fila de jobs pendentes
        this.runningJobs = 0;
        this.jobQueueInterval = null;
        
        // Métricas do sistema
        this.systemHealth = {
            cpuUsage: 0,
            freeMem: 0,
            totalMem: 0,
            loadAvg: 0,
            lastCheck: Date.now(),
            status: 'ok' // ok, warning, critical
        };
        
        // Circuit breaker global
        this.globalFailures = 0;
        this.globalFailureThreshold = 20;    // falhas em 1 min
        this.globalFailureWindowMs = 60000;
        this.globalFailureResetTime = null;
        this.globalCircuitState = 'closed';   // closed, open, half-open
        
        // Intervalos
        this.systemHealthInterval = null;
        this.statsLogInterval = null;
        
        this._init();
    }
    
    _init() {
        // Inicia monitoramento de saúde do sistema
        if (this.systemHealthEnabled) {
            this.systemHealthInterval = setInterval(() => this._updateSystemHealth(), 5000);
            this.statsLogInterval = setInterval(() => this._logStats(), 60000);
        }
        
        // Processa a fila de jobs a cada 100ms (não bloqueante)
        this.jobQueueInterval = setInterval(() => this._processQueue(), 100);
    }
    
    // Atualiza métricas do sistema
    _updateSystemHealth() {
        const cpus = os.cpus();
        const totalCpu = cpus.reduce((acc, cpu) => {
            const total = Object.values(cpu.times).reduce((a, b) => a + b, 0);
            const idle = cpu.times.idle;
            return acc + (1 - idle / total);
        }, 0);
        this.systemHealth.cpuUsage = (totalCpu / cpus.length) * 100;
        this.systemHealth.freeMem = os.freemem();
        this.systemHealth.totalMem = os.totalmem();
        this.systemHealth.loadAvg = os.loadavg()[0];
        this.systemHealth.lastCheck = Date.now();
        
        // Determinar status
        if (this.systemHealth.cpuUsage > 80 || this.systemHealth.loadAvg > os.cpus().length * 0.8) {
            this.systemHealth.status = 'critical';
        } else if (this.systemHealth.cpuUsage > 60 || this.systemHealth.loadAvg > os.cpus().length * 0.5) {
            this.systemHealth.status = 'warning';
        } else {
            this.systemHealth.status = 'ok';
        }
        
        // Emitir evento
        this.emit('systemHealth', this.systemHealth);
    }
    
    _logStats() {
        console.log(`[Orchestrator] Stats: running=${this.runningJobs}, queued=${this.queuedJobs.length}, monitors=${this.monitors.size}, cpu=${this.systemHealth.cpuUsage.toFixed(1)}%, circuit=${this.globalCircuitState}`);
    }
    
    // Registrar um monitor no orquestrador
    registerMonitor(monitor, videoId) {
        this.monitors.set(videoId, monitor);
        console.log(`[Orchestrator] Monitor registrado: ${videoId} (total: ${this.monitors.size})`);
        
        // Agendar o primeiro ciclo com stagger (para espalhar os inícios)
        const staggerDelay = this.monitors.size * this.staggerStartMs;
        setTimeout(() => {
            this._scheduleMonitorCycle(monitor, videoId);
        }, staggerDelay);
    }
    
    // Agendar o próximo ciclo de um monitor
    _scheduleMonitorCycle(monitor, videoId) {
        if (monitor._monitorStopped || monitor._liveEnded) return;
        
        // Calcular intervalo adaptativo baseado no estado e na saúde do sistema
        let intervalMs = this.baseIntervalMs;
        
        if (this.adaptivePolling) {
            // Ajusta intervalo conforme estado da live
            if (monitor.liveState === 'online') {
                intervalMs = this.baseIntervalMs;
            } else if (monitor.liveState === 'degraded') {
                intervalMs = Math.max(15000, this.baseIntervalMs / 2); // mais frequente
            } else if (monitor.liveState === 'offline' || monitor.liveState === 'ended') {
                // não deve acontecer, mas se acontecer, reduz frequência
                intervalMs = this.baseIntervalMs * 2;
            }
            
            // Ajusta conforme saúde do sistema (se crítica, aumenta intervalo)
            if (this.systemHealth.status === 'critical') {
                intervalMs = Math.min(120000, intervalMs * 2);
            } else if (this.systemHealth.status === 'warning') {
                intervalMs = Math.min(90000, intervalMs * 1.5);
            }
        }
        
        // Agenda o próximo ciclo (usando setTimeout)
        const timer = setTimeout(() => {
            this._enqueueMonitorJob(monitor, videoId);
            this._scheduleMonitorCycle(monitor, videoId); // agenda o próximo
        }, intervalMs);
        
        // Guardar o timer para possível cancelamento
        if (monitor._orchestratorTimer) clearTimeout(monitor._orchestratorTimer);
        monitor._orchestratorTimer = timer;
    }
    
    // Enfileira o job do monitor (verificação)
    _enqueueMonitorJob(monitor, videoId) {
        this.queuedJobs.push({ monitor, videoId, ts: Date.now() });
        this._processQueue();
    }
    
    // Processa a fila respeitando o rate limit
    _processQueue() {
        // Verifica circuit breaker global
        if (this.globalCircuitState === 'open') {
            const now = Date.now();
            if (this.globalFailureResetTime && now >= this.globalFailureResetTime) {
                this.globalCircuitState = 'half-open';
                console.log('[Orchestrator] Circuit breaker half-open');
            } else {
                return; // não processa novos jobs
            }
        }
        
        // Respeita o limite de concorrência
        if (this.runningJobs >= this.maxConcurrent) return;
        if (this.queuedJobs.length === 0) return;
        
        const job = this.queuedJobs.shift();
        if (!job) return;
        
        this.runningJobs++;
        this._runMonitorJob(job.monitor, job.videoId).finally(() => {
            this.runningJobs--;
            this._processQueue(); // tenta próximo
        });
        
        // Se ainda tem jobs e ainda não atingiu o limite, chama novamente (recursivo)
        if (this.queuedJobs.length > 0 && this.runningJobs < this.maxConcurrent) {
            this._processQueue();
        }
    }
    
    async _runMonitorJob(monitor, videoId) {
        const start = Date.now();
        try {
            // Chama o método de verificação do monitor (checkAndRenew)
            if (monitor.checkAndRenew && typeof monitor.checkAndRenew === 'function') {
                await monitor.checkAndRenew();
            } else {
                console.warn(`[Orchestrator] Monitor ${videoId} não tem método checkAndRenew`);
            }
            
            // Sucesso: resetar falhas globais
            this.globalFailures = 0;
            if (this.globalCircuitState === 'half-open') {
                this.globalCircuitState = 'closed';
                console.log('[Orchestrator] Circuit breaker closed (recovered)');
            }
            
            const duration = Date.now() - start;
            if (duration > 5000) {
                console.log(`[Orchestrator] Job ${videoId} completed in ${duration}ms`);
            }
        } catch (error) {
            console.error(`[Orchestrator] Job ${videoId} failed: ${error.message}`);
            this.globalFailures++;
            
            // Verificar se deve abrir o circuit breaker global
            if (this.globalFailures >= this.globalFailureThreshold) {
                this.globalCircuitState = 'open';
                this.globalFailureResetTime = Date.now() + this.globalFailureWindowMs;
                console.log(`[Orchestrator] Circuit breaker OPEN após ${this.globalFailures} falhas`);
                this.emit('circuitOpen', { failures: this.globalFailures });
            }
        }
    }
    
    // Método para adicionar um monitor (chamado pelo convert.js)
    addMonitor(monitor, videoId) {
        this.registerMonitor(monitor, videoId);
    }
    
    // Parar todos os monitores e limpeza
    stop() {
        if (this.systemHealthInterval) clearInterval(this.systemHealthInterval);
        if (this.statsLogInterval) clearInterval(this.statsLogInterval);
        if (this.jobQueueInterval) clearInterval(this.jobQueueInterval);
        
        for (const [videoId, monitor] of this.monitors) {
            if (monitor._orchestratorTimer) clearTimeout(monitor._orchestratorTimer);
            if (monitor.stopMonitoring) monitor.stopMonitoring();
        }
        this.monitors.clear();
        this.queuedJobs = [];
    }
}

module.exports = MonitorOrchestrator;
