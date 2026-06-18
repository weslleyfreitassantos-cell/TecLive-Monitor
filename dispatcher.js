// dispatcher.js - Distribui tarefas entre workers
const { fork } = require('child_process');
const os = require('os');

class Dispatcher {
    constructor(maxWorkers = null) {
        // Número de workers = número de CPUs ou valor especificado
        this.maxWorkers = maxWorkers || os.cpus().length;
        this.workers = [];
        this.taskQueue = [];
        this.activeTasks = 0;
        this.stats = {
            totalTasks: 0,
            completedTasks: 0,
            failedTasks: 0,
            queueSize: 0,
            activeWorkers: 0
        };
        this._initWorkers();
        // Monitora a fila periodicamente
        setInterval(() => this._processQueue(), 100);
    }

    _initWorkers() {
        for (let i = 0; i < this.maxWorkers; i++) {
            const worker = fork('./worker.js');
            worker.on('message', (msg) => this._onWorkerMessage(msg, worker));
            worker.on('error', (err) => console.error(`Worker ${i} error:`, err));
            this.workers.push({ worker, busy: false, id: i });
        }
        console.log(`✅ Dispatcher inicializado com ${this.maxWorkers} workers`);
    }

    _onWorkerMessage(msg, worker) {
        // Marca o worker como livre
        const w = this.workers.find(w => w.worker === worker);
        if (w) w.busy = false;
        this.activeTasks--;
        this.stats.completedTasks++;
        if (msg.success) {
            console.log(`[Dispatcher] Tarefa ${msg.videoId} concluída com sucesso`);
        } else {
            this.stats.failedTasks++;
            console.error(`[Dispatcher] Tarefa ${msg.videoId} falhou: ${msg.error}`);
        }
        // Processa próximo item da fila
        this._processQueue();
    }

    _processQueue() {
        if (this.taskQueue.length === 0) return;
        // Encontra um worker livre
        const freeWorker = this.workers.find(w => !w.busy);
        if (!freeWorker) return;
        const task = this.taskQueue.shift();
        freeWorker.busy = true;
        this.activeTasks++;
        this.stats.totalTasks++;
        freeWorker.worker.send(task);
    }

    dispatch(task) {
        this.taskQueue.push(task);
        this.stats.queueSize = this.taskQueue.length;
        this.stats.activeWorkers = this.workers.filter(w => w.busy).length;
        this._processQueue();
    }

    getStats() {
        return {
            ...this.stats,
            queueSize: this.taskQueue.length,
            activeWorkers: this.stats.activeWorkers,
            totalWorkers: this.maxWorkers
        };
    }
}

module.exports = Dispatcher;
