// config/monitorConfig.js
module.exports = {
    // Intervalos
    baseIntervalMs: 30000,
    minIntervalMs: 15000,
    maxIntervalMs: 60000,
    
    // Tempos de confirmação
    minDegradedTimeMs: 30000,
    minOfflineTimeMs: 60000,
    streamTimeoutMs: 90000,
    
    // Health scores
    healthScore: {
        recoveryRate: 10,
        warningPenalty: 10,
        errorPenalty: 25,
        criticalScore: 0,
        okThreshold: 70
    },
    
    // Circuit breaker
    circuitBreaker: {
        failureThreshold: 5,
        timeoutMs: 60000,
        halfOpenAttempts: 1
    },
    
    // Eventos
    maxEventsPerSecond: 100,
    eventBatchSize: 50,
    eventBatchIntervalMs: 500,
    
    // Snapshots
    maxSnapshots: 1000,
    snapshotCompression: true,
    
    // Drift
    driftToleranceMs: 5000,
    
    // Offline
    offlineThreshold: 3
};
