// engine/healthEngine.js
const config = require('../config/monitorConfig');

// Estados da Live
const LiveState = {
    ONLINE: 'online',
    DEGRADED: 'degraded',
    OFFLINE: 'offline',
    ENDED: 'ended'
};

class HealthEngine {
    constructor() {
        this._healthScore = {
            network: 100,
            metadata: 100,
            playlist: 100,
            cookies: 100,
            lastUpdate: Date.now()
        };
        
        this._offlineScore = { network: 0, metadata: 0, signal: 0 };
        this._confirmedState = LiveState.ONLINE;
        this._stateChangeTime = Date.now();
    }
    
    updateHealth(component, status) {
        const oldScore = this._healthScore[component];
        let newScore = oldScore;
        
        if (status === 'ok') {
            newScore = Math.min(100, oldScore + config.healthScore.recoveryRate);
        } else if (status === 'warning') {
            newScore = Math.max(50, oldScore - config.healthScore.warningPenalty);
        } else if (status === 'error') {
            newScore = Math.max(20, oldScore - config.healthScore.errorPenalty);
        } else if (status === 'critical') {
            newScore = config.healthScore.criticalScore;
        }
        
        this._healthScore[component] = newScore;
        this._healthScore.lastUpdate = Date.now();
        
        return { oldScore, newScore };
    }
    
    observe(metadata, healthScore, streamOk, networkOk) {
        const live = metadata?.live_status === 'is_live' || metadata?.is_live === true;
        const metadataOk = healthScore.metadata > 30;
        
        return { live, metadataOk, networkOk, streamOk };
    }
    
    decide(observed, timeInCurrentState) {
        const now = Date.now();
        
        // ENDED detection
        if (this._healthScore.metadata === 0) {
            if (this._confirmedState !== LiveState.ENDED) {
                this._confirmedState = LiveState.ENDED;
                this._stateChangeTime = now;
            }
            return LiveState.ENDED;
        }
        
        if (this._confirmedState === LiveState.ENDED) return LiveState.ENDED;
        
        // ONLINE
        if (observed.live && observed.streamOk && observed.metadataOk) {
            if (this._confirmedState !== LiveState.ONLINE) {
                this._confirmedState = LiveState.ONLINE;
                this._stateChangeTime = now;
                this._offlineScore = { network: 0, metadata: 0, signal: 0 };
            }
            return LiveState.ONLINE;
        }
        
        // DEGRADED
        if (observed.live && !observed.streamOk) {
            if (this._confirmedState === LiveState.ONLINE && timeInCurrentState < config.minDegradedTimeMs) {
                return LiveState.ONLINE;
            }
            if (this._confirmedState !== LiveState.DEGRADED) {
                this._confirmedState = LiveState.DEGRADED;
                this._stateChangeTime = now;
            }
            return LiveState.DEGRADED;
        }
        
        // OFFLINE score
        if (!observed.networkOk) this._offlineScore.network++;
        if (!observed.metadataOk) this._offlineScore.metadata++;
        if (!observed.live && !observed.streamOk) this._offlineScore.signal++;
        
        const maxScore = Math.max(this._offlineScore.network, this._offlineScore.metadata, this._offlineScore.signal);
        
        if (maxScore >= config.offlineThreshold && timeInCurrentState > config.minOfflineTimeMs) {
            if (this._confirmedState !== LiveState.OFFLINE) {
                this._confirmedState = LiveState.OFFLINE;
                this._stateChangeTime = now;
            }
            return LiveState.OFFLINE;
        }
        
        return this._confirmedState;
    }
    
    getState() {
        return this._confirmedState;
    }
    
    getHealthScore() {
        return { ...this._healthScore };
    }
}

module.exports = { HealthEngine, LiveState };
