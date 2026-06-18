// engine/telemetryEngine.js
const EventEmitter = require('events');
const config = require('../config/monitorConfig');

class TelemetryEngine extends EventEmitter {
    constructor() {
        super();
        this._eventQueue = [];
        this._snapshots = [];
        this._eventsPerSecond = 0;
        this._lastEventReset = Date.now();
        this._batchTimer = null;
        this._startBatchProcessor();
    }
    
    _startBatchProcessor() {
        this._batchTimer = setInterval(() => {
            this._processBatch();
        }, config.eventBatchIntervalMs);
    }
    
    _processBatch() {
        if (this._eventQueue.length === 0) return;
        
        const now = Date.now();
        if (now - this._lastEventReset >= 1000) {
            this._eventsPerSecond = 0;
            this._lastEventReset = now;
        }
        
        const batchSize = Math.min(config.eventBatchSize, config.maxEventsPerSecond - this._eventsPerSecond);
        if (batchSize <= 0) return;
        
        const batch = this._eventQueue.splice(0, batchSize);
        this._eventsPerSecond += batch.length;
        
        for (const item of batch) {
            super.emit(item.event, item.data);
        }
    }
    
    emit(event, data) {
        this._eventQueue.push({ event, data, timestamp: Date.now() });
        if (this._eventQueue.length > 10000) {
            console.warn('⚠️ Event queue overflow, dropping oldest');
            this._eventQueue = this._eventQueue.slice(-5000);
        }
    }
    
    takeSnapshot(videoId, state, observed, healthScore) {
        const snapshot = {
            timestamp: Date.now(),
            videoId,
            state,
            observed: { ...observed },
            healthScore: { ...healthScore }
        };
        
        this._snapshots.push(snapshot);
        if (this._snapshots.length > config.maxSnapshots) {
            this._snapshots.shift();
        }
        
        return snapshot;
    }
    
    getSnapshots(limit = 100) {
        return this._snapshots.slice(-limit);
    }
    
    stop() {
        if (this._batchTimer) {
            clearInterval(this._batchTimer);
            this._batchTimer = null;
        }
    }
}

module.exports = TelemetryEngine;
