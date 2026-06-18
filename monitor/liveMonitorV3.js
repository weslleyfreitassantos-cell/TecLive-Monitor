// monitor/liveMonitorV3.js - VERSÃO PARA TESTES
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const fs = require('fs');
const path = require('path');
const { HealthEngine, LiveState } = require('../engine/healthEngine');
const TelemetryEngine = require('../engine/telemetryEngine');
const CircuitBreaker = require('../engine/circuitBreaker');
const config = require('../config/monitorConfig');

class LiveMonitorV3 {
    constructor(youtubeUrl, emailAlerts, liveCache = null) {
        this.youtubeUrl = youtubeUrl;
        this.emailAlerts = emailAlerts;
        this.videoId = this.extractVideoId(youtubeUrl);
        this.m3u8Url = null;
        this._injectedCache = liveCache;
        
        this.healthEngine = new HealthEngine();
        this.telemetry = new TelemetryEngine();
        this.circuitBreaker = new CircuitBreaker();
        
        this.health = {
            network: { status: 'ok' },
            metadata: { status: 'ok' },
            playlist: { status: 'ok' },
            cookies: { status: 'ok' }
        };
        
        this.liveState = LiveState.ONLINE;
        this.isLive = false;
        this._running = false;
        this._monitorStopped = false;
        this._liveEnded = false;
        this.timeoutId = null;
        this.currentIntervalMs = config.baseIntervalMs;
        
        this._observed = {
            live: false,
            metadataOk: false,
            networkOk: false,
            streamOk: false,
            lastProgressTime: Date.now(),
            lastStreamCheck: Date.now()
        };
        
        this.lastMediaSequence = null;
        this.stalledCount = 0;
        this.maxSegmentRepeats = Math.max(3, Math.ceil(180000 / this.currentIntervalMs));
        
        this.cookiesDir = path.join(__dirname, '../cookies');
        this._lastMetadata = null;
    }
    
    extractVideoId(url) {
        const match = url.match(/(?:v=|\/)([0-9A-Za-z_-]{11})(?:[?&]|$)/);
        return match ? match[1] : 'url_invalida';
    }
    
    getCookiePath() {
        const mainPath = path.join(this.cookiesDir, 'main.txt');
        const backupPath = path.join(this.cookiesDir, 'backup.txt');
        
        if (fs.existsSync(mainPath) && fs.statSync(mainPath).size > 5000) {
            return mainPath;
        } else if (fs.existsSync(backupPath) && fs.statSync(backupPath).size > 5000) {
            return backupPath;
        }
        return null;
    }
    
    updateHealthComponent(component, status) {
        const result = this.healthEngine.updateHealth(component, status);
        this.health[component] = { status };
        this.telemetry.emit('health:changed', { component, ...result });
    }
    
    async getLiveMetadata() {
        if (this.circuitBreaker.isOpen()) {
            return { success: false, error: 'Circuit breaker open' };
        }
        
        try {
            const cookiePath = this.getCookiePath();
            const ytCmd = process.platform === 'win32' ? '.\\yt-dlp.exe' : 'yt-dlp';
            
            const command = cookiePath
                ? `${ytCmd} --cookies "${cookiePath}" --dump-json "${this.youtubeUrl}"`
                : `${ytCmd} --dump-json "${this.youtubeUrl}"`;
            
            const { stdout } = await execPromise(command, { timeout: 30000 });
            const metadata = JSON.parse(stdout);
            
            this._lastMetadata = metadata;
            this.updateHealthComponent('metadata', 'ok');
            this.circuitBreaker.recordSuccess();
            
            if (cookiePath) {
                this.updateHealthComponent('cookies', 'ok');
            }
            
            return { success: true, metadata };
            
        } catch (error) {
            this.circuitBreaker.recordFailure();
            this.updateHealthComponent('metadata', 'warning');
            return { success: false, error: error.message };
        }
    }
    
    async checkAndRenew() {
        if (this._running || this._monitorStopped || this._liveEnded) return;
        
        this._running = true;
        
        try {
            const metadataResult = await this.getLiveMetadata();
            
            if (!metadataResult.success) {
                this._applyState();
                return;
            }
            
            const metadata = metadataResult.metadata;
            const formats = metadata.formats || [];
            const hlsFormat = formats.find(f => f.protocol === 'm3u8_native' || f.url?.includes('.m3u8'));
            
            if (hlsFormat?.url) {
                this.m3u8Url = hlsFormat.url;
            }
            
            this._observed.streamOk = true;
            this._observed.live = metadata.live_status === 'is_live';
            this._observed.metadataOk = true;
            this._observed.networkOk = true;
            
            this._applyState();
            
        } catch (error) {
            console.error(`[${this.videoId}] ❌ Erro: ${error.message}`);
        } finally {
            this._running = false;
            this._scheduleNext();
        }
    }
    
    _applyState() {
        const now = Date.now();
        const timeInState = now - (this._stateChangeTime || now);
        const observed = this.healthEngine.observe(
            this._lastMetadata,
            this.healthEngine.getHealthScore(),
            this._observed.streamOk,
            this._observed.networkOk
        );
        
        const newState = this.healthEngine.decide(observed, timeInState);
        
        if (this.liveState !== newState) {
            console.log(`[${this.videoId}] 🔄 Estado: ${this.liveState} → ${newState}`);
            this.liveState = newState;
            this._stateChangeTime = now;
            this.telemetry.emit('state:changed', { from: this.liveState, to: newState });
            this._updateCache();
        }
        
        this.isLive = this.liveState === LiveState.ONLINE;
        this.telemetry.takeSnapshot(this.videoId, this.liveState, observed, this.healthEngine.getHealthScore());
    }
    
    _updateCache() {
        if (this._injectedCache) {
            for (const [url, data] of this._injectedCache.entries()) {
                if (data.videoId === this.videoId) {
                    data.status = this.liveState;
                    data.isLive = this.isLive;
                    data.lastUpdate = new Date();
                    break;
                }
            }
        }
    }
    
    _scheduleNext() {
        if (this.timeoutId) clearTimeout(this.timeoutId);
        if (!this._monitorStopped && !this._liveEnded) {
            this.timeoutId = setTimeout(() => this.checkAndRenew(), this.currentIntervalMs);
        }
    }
    
    startMonitoring(intervalSeconds = 30) {
        this.currentIntervalMs = intervalSeconds * 1000;
        this._monitorStopped = false;
        this._liveEnded = false;
        console.log(`🔄 Monitor V3 iniciado para ${this.videoId}`);
        this.checkAndRenew();
    }
    
    stopMonitoring() {
        this._monitorStopped = true;
        if (this.timeoutId) clearTimeout(this.timeoutId);
        this.telemetry.stop();
        console.log(`⏹️ Monitor V3 parado para ${this.videoId}`);
    }
}

module.exports = LiveMonitorV3;
