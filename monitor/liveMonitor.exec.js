// monitor/liveMonitor.js
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');

let systemState = null;
try {
    systemState = require('../systemState');
} catch(e) {}

// Estados da Live
const LiveState = {
    ONLINE: 'online',
    DEGRADED: 'degraded',
    OFFLINE: 'offline',
    ENDED: 'ended'
};

// Estados de componentes (infraestrutura)
const ComponentStatus = {
    OK: 'ok',
    WARNING: 'warning',
    ERROR: 'error',
    CRITICAL: 'critical'
};

class LiveMonitor {
    constructor(youtubeUrl, emailAlerts, liveCache = null) {
        this.youtubeUrl = youtubeUrl;
        this.emailAlerts = emailAlerts;
        this.videoId = this.extractVideoId(youtubeUrl);
        this.m3u8Url = null;
        this.isLive = false;
        this.timeoutId = null;
        this.intervalMs = 30000;
        this.maxStallTimeMs = 180000;
        
        this._injectedCache = liveCache;
        
        this.metadataFails = 0;
        this.segmentFails = 0;
        this.urlFails = 0;
        this.networkFailCount = 0;
        this.consecutiveUnknownFails = 0;
        
        this.maxFails = 5;
        this.maxNetworkWarnings = 3;
        this.maxNetworkErrors = 10;
        this.maxUnknownFails = 10;
        
        this.cookiesDir = path.join(__dirname, '../cookies');
        this.lastSuccessTime = null;
        this.lastError = null;
        this.liveState = LiveState.ONLINE;
        
        this._criticalSent = false;
        this._failoverSent = false;
        this._backupExpiredSent = false;
        this._recoverySent = false;
        this._mainMissingSent = false;
        this._mainRestoredSent = false;
        
        this.lastMediaSequence = null;
        this.stalledCount = 0;
        this.maxSegmentRepeats = this.calculateMaxRepeats();
        
        this.health = {
            network: { status: ComponentStatus.OK, lastCheck: null, message: '', failCount: 0 },
            metadata: { status: ComponentStatus.OK, lastCheck: null, message: '', failCount: 0 },
            playlist: { status: ComponentStatus.OK, lastCheck: null, message: '', failCount: 0 },
            cookies: { status: ComponentStatus.OK, lastCheck: null, message: '', failCount: 0 }
        };
        
        this._monitorStopped = false;
        this._liveEnded = false;
        this._running = false;
    }

    calculateMaxRepeats() {
        return Math.max(3, Math.ceil(this.maxStallTimeMs / this.intervalMs));
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

    updateHealthComponent(component, status, message = '') {
        if (this.health[component]) {
            const oldStatus = this.health[component].status;
            this.health[component] = {
                status,
                lastCheck: new Date(),
                message,
                failCount: status === ComponentStatus.OK ? 0 : (this.health[component].failCount || 0) + 1
            };
            
            if (oldStatus !== status) {
                console.log(`[${this.videoId}] 🔄 Health[${component}]: ${oldStatus} → ${status} (${message})`);
            }
        }
    }

    updateNetworkHealth(isSuccess) {
        if (isSuccess) {
            if (this.networkFailCount > 0) {
                console.log(`[${this.videoId}] 🌐 Rede recuperada após ${this.networkFailCount} falhas`);
            }
            this.networkFailCount = 0;
            this.updateHealthComponent('network', ComponentStatus.OK, 'Conectividade normal');
            return;
        }
        
        this.networkFailCount++;
        
        if (this.networkFailCount >= this.maxNetworkErrors) {
            this.updateHealthComponent('network', ComponentStatus.ERROR, `${this.networkFailCount} falhas consecutivas`);
        } else if (this.networkFailCount >= this.maxNetworkWarnings) {
            this.updateHealthComponent('network', ComponentStatus.WARNING, `${this.networkFailCount} falhas consecutivas`);
        } else {
            this.updateHealthComponent('network', ComponentStatus.OK, `${this.networkFailCount} falhas, ainda tolerável`);
        }
    }

    deriveLiveState() {
        const networkStatus = this.health.network.status;
        const metadataStatus = this.health.metadata.status;
        const playlistStatus = this.health.playlist.status;
        
        if (metadataStatus === ComponentStatus.CRITICAL) {
            return LiveState.ENDED;
        }
        
        if (playlistStatus === ComponentStatus.CRITICAL) {
            return LiveState.DEGRADED;
        }
        
        if (networkStatus === ComponentStatus.ERROR ||
            metadataStatus === ComponentStatus.ERROR ||
            playlistStatus === ComponentStatus.ERROR) {
            return LiveState.OFFLINE;
        }
        
        if (networkStatus === ComponentStatus.WARNING ||
            metadataStatus === ComponentStatus.WARNING ||
            playlistStatus === ComponentStatus.WARNING) {
            return LiveState.DEGRADED;
        }
        
        return LiveState.ONLINE;
    }

    applyDerivedState() {
        const newState = this.deriveLiveState();
        
        if (this.liveState !== newState) {
            console.log(`[${this.videoId}] 🔄 Estado alterado: ${this.liveState} → ${newState}`);
            this.liveState = newState;
            this.updateCache(this.liveState);
            
            if (newState === LiveState.ENDED) {
                console.log(`[${this.videoId}] 🛑 Live encerrada, parando monitor`);
                this._liveEnded = true;
            }
        }
        
        this.isLive = this.liveState === LiveState.ONLINE;
        return newState;
    }

    // 🔥 CORREÇÃO: Aumentar maxBuffer e adicionar isLiveEnded
    async getLiveMetadata() {
        try {
            const cookiePath = this.getCookiePath();
            const ytCmd = process.platform === 'win32' ? '.\\yt-dlp.exe' : 'yt-dlp';
            
            const command = cookiePath
                ? `${ytCmd} --cookies "${cookiePath}" --dump-json "${this.youtubeUrl}"`
                : `${ytCmd} --dump-json "${this.youtubeUrl}"`;

            const { stdout } = await execPromise(command, { 
                timeout: 30000,
                maxBuffer: 20 * 1024 * 1024   // 20 MB
            });
            const metadata = JSON.parse(stdout);
            
            this.updateHealthComponent('metadata', ComponentStatus.OK, 'Metadados obtidos com sucesso');
            this.metadataFails = 0;
            
            if (cookiePath) {
                this.updateHealthComponent('cookies', ComponentStatus.OK, 'Cookie funcionando');
            }
            
            return { success: true, metadata };
            
        } catch (error) {
            console.error(`[${this.videoId}] ❌ Erro ao obter metadados: ${error.message}`);
            
            const errorMsg = error.message.toLowerCase();
            const isLiveEnded = errorMsg.includes('video unavailable') || 
                                errorMsg.includes('not available') ||
                                errorMsg.includes('recording is not available');
            
            // Buffer estourado não é erro crítico da live
            if (errorMsg.includes('maxbuffer') || errorMsg.includes('stdout maxBuffer')) {
                console.warn(`[${this.videoId}] ⚠️ Buffer insuficiente para metadados. Tente novamente.`);
                return { success: false, error: error.message, isLiveEnded: false };
            }
            
            if (isLiveEnded) {
                this.updateHealthComponent('metadata', ComponentStatus.CRITICAL, `Live encerrada: ${error.message}`);
            } else if (errorMsg.includes('403') || errorMsg.includes('401') || errorMsg.includes('sign in')) {
                this.updateHealthComponent('cookies', ComponentStatus.ERROR, `Cookie inválido: ${error.message}`);
                this.updateHealthComponent('metadata', ComponentStatus.WARNING, `Erro de autenticação`);
            } else if (errorMsg.includes('timeout') || errorMsg.includes('etimedout')) {
                this.updateHealthComponent('metadata', ComponentStatus.WARNING, `Timeout: ${error.message}`);
            } else {
                this.updateHealthComponent('metadata', ComponentStatus.WARNING, `Erro: ${error.message}`);
            }
            
            this.metadataFails++;
            return { success: false, error: error.message, isLiveEnded: isLiveEnded };
        }
    }

    validateMetadata(metadata) {
        const liveStatus = metadata.live_status;
        const wasLive = metadata.was_live === true;
        const isLive = metadata.is_live === true;
        
        console.log(`[${this.videoId}] 📊 Status:`, {
            live_status: liveStatus,
            is_live: isLive,
            was_live: wasLive,
            availability: metadata.availability
        });

        if (liveStatus === 'was_live' || liveStatus === 'post_live' || liveStatus === 'not_live') {
            this.updateHealthComponent('metadata', ComponentStatus.CRITICAL, `Live encerrada: ${liveStatus}`);
            return false;
        }
        
        if (wasLive && !isLive) {
            this.updateHealthComponent('metadata', ComponentStatus.CRITICAL, `Live encerrada: was_live=true, is_live=false`);
            return false;
        }

        if (liveStatus === 'is_live' || isLive) {
            this.updateHealthComponent('metadata', ComponentStatus.OK, `Live ativa: ${liveStatus}`);
            return true;
        }

        this.updateHealthComponent('metadata', ComponentStatus.WARNING, `Status desconhecido: ${liveStatus}`);
        this.consecutiveUnknownFails++;
        
        if (this.consecutiveUnknownFails >= this.maxUnknownFails) {
            this.updateHealthComponent('metadata', ComponentStatus.ERROR, `${this.consecutiveUnknownFails} status desconhecidos consecutivos`);
        }
        
        return null;
    }

    extractHlsUrl(metadata) {
        if (!metadata.formats || !Array.isArray(metadata.formats)) {
            return null;
        }
        
        const hlsFormats = metadata.formats.filter(f => 
            (f.protocol === 'm3u8_native' || 
             (f.url && f.url.includes('.m3u8'))) &&
            f.vcodec !== 'none' &&
            f.acodec !== 'none'
        );
        
        if (hlsFormats.length === 0) {
            return null;
        }
        
        hlsFormats.sort((a, b) => {
            const scoreA = (a.height || 0) * 100000 + (a.fps || 0) * 1000 + (a.tbr || 0);
            const scoreB = (b.height || 0) * 100000 + (b.fps || 0) * 1000 + (b.tbr || 0);
            return scoreB - scoreA;
        });
        
        const bestFormat = hlsFormats[0];
        console.log(`[${this.videoId}] 📺 Selecionado formato HLS: ${bestFormat.height}p (${bestFormat.fps || '?'}fps, bitrate: ${bestFormat.tbr || '?'})`);
        
        return bestFormat.url;
    }

    async extractMediaSequence(m3u8Url) {
        if (!m3u8Url) return null;

        return new Promise((resolve) => {
            let resolved = false;
            let timeoutId = null;
            
            const finish = (value) => {
                if (resolved) return;
                resolved = true;
                if (timeoutId) clearTimeout(timeoutId);
                resolve(value);
            };
            
            const urlObj = new URL(m3u8Url);
            const protocol = urlObj.protocol === 'https:' ? https : http;
            
            const request = protocol.get(m3u8Url, (res) => {
                if (res.statusCode !== 200) {
                    finish(null);
                    return;
                }
                
                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    const seqMatch = data.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/);
                    if (seqMatch) {
                        finish(parseInt(seqMatch[1]));
                    } else {
                        const lines = data.split('\n');
                        let lastTs = null;
                        for (let i = lines.length - 1; i >= 0; i--) {
                            const line = lines[i].trim();
                            if (line && !line.startsWith('#') && (line.endsWith('.ts') || line.includes('.ts?'))) {
                                lastTs = line;
                                break;
                            }
                        }
                        finish(lastTs);
                    }
                });
            });
            
            timeoutId = setTimeout(() => {
                request.destroy();
                finish(null);
            }, 10000);
            
            request.on('error', () => finish(null));
        });
    }

    async checkPlaylistProgress(m3u8Url) {
        if (!m3u8Url) {
            this.updateHealthComponent('playlist', ComponentStatus.ERROR, 'URL vazia');
            return false;
        }

        const currentSequence = await this.extractMediaSequence(m3u8Url);
        
        if (currentSequence === null) {
            this.stalledCount = 0;
            this.updateHealthComponent('playlist', ComponentStatus.ERROR, 'Não foi possível obter sequência');
            return false;
        }

        if (this.lastMediaSequence === null) {
            this.lastMediaSequence = currentSequence;
            this.updateHealthComponent('playlist', ComponentStatus.OK, `Primeira sequência: ${currentSequence}`);
            return true;
        }

        if (typeof currentSequence === 'number' && typeof this.lastMediaSequence === 'number') {
            if (currentSequence > this.lastMediaSequence) {
                this.stalledCount = 0;
                this.lastMediaSequence = currentSequence;
                this.updateHealthComponent('playlist', ComponentStatus.OK, `Avançou: ${currentSequence}`);
                return true;
            } else if (currentSequence === this.lastMediaSequence) {
                if (currentSequence === 0) {
                    console.log(`[${this.videoId}] ⚠️ MEDIA-SEQUENCE fixo em 0, ignorando freeze (playlist master)`);
                    this.updateHealthComponent('playlist', ComponentStatus.WARNING, `Sequence em 0 - playlist master`);
                    return true;
                }
                
                this.stalledCount++;
                console.log(`[${this.videoId}] 📊 Media sequence parado: ${currentSequence} (${this.stalledCount}/${this.maxSegmentRepeats})`);
                
                if (this.stalledCount >= this.maxSegmentRepeats) {
                    this.updateHealthComponent('playlist', ComponentStatus.CRITICAL, `Stream congelado após ${this.stalledCount} verificações`);
                    return false;
                }
                this.updateHealthComponent('playlist', ComponentStatus.WARNING, `Sequence parado (${this.stalledCount}/${this.maxSegmentRepeats})`);
                return true;
            }
        }
        
        if (currentSequence === this.lastMediaSequence) {
            if (currentSequence === 0) {
                console.log(`[${this.videoId}] ⚠️ MEDIA-SEQUENCE fixo em 0, ignorando freeze`);
                return true;
            }
            
            this.stalledCount++;
            if (this.stalledCount >= this.maxSegmentRepeats) {
                this.updateHealthComponent('playlist', ComponentStatus.CRITICAL, 'Segmentos congelados');
                return false;
            }
            return true;
        } else {
            this.stalledCount = 0;
            this.lastMediaSequence = currentSequence;
            return true;
        }
    }

    updateCache(state, additionalData = {}) {
        let cacheUpdated = false;
        
        if (this._injectedCache && this._injectedCache instanceof Map) {
            for (const [url, data] of this._injectedCache.entries()) {
                if (data.videoId === this.videoId || data.monitor === this) {
                    data.isLive = state === LiveState.ONLINE;
                    data.status = state;
                    data.lastUpdate = new Date();
                    data.health = JSON.parse(JSON.stringify(this.health));
                    Object.assign(data, additionalData);
                    cacheUpdated = true;
                    break;
                }
            }
            
            if (!cacheUpdated) {
                this._injectedCache.set(this.youtubeUrl, {
                    videoId: this.videoId,
                    status: state,
                    isLive: state === LiveState.ONLINE,
                    monitor: this,
                    lastUpdate: new Date(),
                    ...additionalData
                });
                cacheUpdated = true;
            }
        }
        
        if (!cacheUpdated && global.converter && global.converter.liveCache) {
            for (const [url, data] of global.converter.liveCache.entries()) {
                if (data.videoId === this.videoId || data.monitor === this) {
                    data.isLive = state === LiveState.ONLINE;
                    data.status = state;
                    data.lastUpdate = new Date();
                    data.health = JSON.parse(JSON.stringify(this.health));
                    Object.assign(data, additionalData);
                    cacheUpdated = true;
                    break;
                }
            }
            
            if (!cacheUpdated) {
                global.converter.liveCache.set(this.youtubeUrl, {
                    videoId: this.videoId,
                    status: state,
                    isLive: state === LiveState.ONLINE,
                    monitor: this,
                    lastUpdate: new Date(),
                    ...additionalData
                });
                cacheUpdated = true;
            }
        }
        
        if (!cacheUpdated) {
            console.warn(`[${this.videoId}] ⚠️ NENHUM cache disponível!`);
        }
    }

    async checkAndRenew() {
        if (this._running) {
            return;
        }
        
        if (this._monitorStopped || this._liveEnded) {
            return;
        }
        
        this._running = true;
        
        try {
            console.log(`[${this.videoId}] 🔍 Ciclo de verificação...`);

            const metadataResult = await this.getLiveMetadata();
            
            if (!metadataResult.success) {
                if (metadataResult.isLiveEnded) {
                    console.log(`[${this.videoId}] 📺 LIVE ENCERRADA (evidência positiva)`);
                    this.updateHealthComponent('metadata', ComponentStatus.CRITICAL, 'Live encerrada');
                    this.applyDerivedState();
                    return;
                }
                
                if (metadataResult.errorType !== 'network') {
                    this.updateNetworkHealth(true);
                }
                
                this.applyDerivedState();
                return;
            }

            this.updateNetworkHealth(true);
            
            const metadata = metadataResult.metadata;
            
            const isValid = this.validateMetadata(metadata);
            
            if (isValid === false) {
                this.applyDerivedState();
                return;
            }
            
            const newUrl = this.extractHlsUrl(metadata);
            
            if (!newUrl) {
                console.log(`[${this.videoId}] ⚠️ URL HLS não encontrada`);
                this.urlFails++;
                this.updateHealthComponent('playlist', ComponentStatus.WARNING, 'URL não encontrada');
                
                if (this.urlFails >= this.maxFails) {
                    this.updateHealthComponent('playlist', ComponentStatus.ERROR, `${this.urlFails} falhas consecutivas`);
                }
                this.applyDerivedState();
                return;
            }
            
            this.urlFails = 0;
            
            if (newUrl !== this.m3u8Url) {
                this.m3u8Url = newUrl;
                console.log(`[${this.videoId}] ✅ URL atualizada`);
            }
            
            const isPlaylistAdvancing = await this.checkPlaylistProgress(this.m3u8Url);
            
            if (!isPlaylistAdvancing) {
                console.log(`[${this.videoId}] ⚠️ Playlist não avança`);
                const stillLive = (metadata.live_status === 'is_live' || metadata.is_live === true);
                
                if (stillLive) {
                    console.log(`[${this.videoId}] ⚠️ Playlist parada, mas YouTube confirma que a live continua. Mantendo como DEGRADED.`);
                    this.updateHealthComponent('playlist', ComponentStatus.WARNING, 'Playlist congelada temporariamente');
                    this.liveState = LiveState.DEGRADED;
                    this.applyDerivedState();
                    return;
                }
                
                this.segmentFails++;
                
                if (this.segmentFails >= this.maxFails) {
                    this.updateHealthComponent('playlist', ComponentStatus.ERROR, `${this.segmentFails} falhas consecutivas`);
                }
                this.applyDerivedState();
                return;
            }
            
            this.segmentFails = 0;
            this.consecutiveUnknownFails = 0;
            this.applyDerivedState();
            this.lastError = null;
            this.lastSuccessTime = new Date();
            
            if (systemState) {
                systemState.registerSuccess();
            }
            
            this.checkCookieRedundancy();
            
            console.log(`[${this.videoId}] ✅ Estado: ${this.liveState} | Health:`, {
                network: this.health.network.status,
                metadata: this.health.metadata.status,
                playlist: this.health.playlist.status,
                cookies: this.health.cookies.status
            });
            
        } catch (error) {
            console.error(`[${this.videoId}] ❌ Erro inesperado: ${error.message}`);
            this.applyDerivedState();
        } finally {
            this._running = false;
            if (!this._monitorStopped && !this._liveEnded) {
                this.scheduleNext();
            }
        }
    }

    scheduleNext() {
        if (this.timeoutId) {
            clearTimeout(this.timeoutId);
        }
        
        this.timeoutId = setTimeout(() => {
            this.checkAndRenew();
        }, this.intervalMs);
    }

    checkCookieRedundancy() {
        const mainPathFile = path.join(this.cookiesDir, 'main.txt');
        const backupPathFile = path.join(this.cookiesDir, 'backup.txt');
        const MIN_SIZE = 5000;
        
        const mainFileExists = fs.existsSync(mainPathFile);
        const backupFileExists = fs.existsSync(backupPathFile);
        
        let mainValid = false;
        let backupValid = false;
        
        if (mainFileExists) {
            mainValid = fs.statSync(mainPathFile).size > MIN_SIZE;
        }
        if (backupFileExists) {
            backupValid = fs.statSync(backupPathFile).size > MIN_SIZE;
        }
        
        if (mainValid && backupValid) {
            this.updateHealthComponent('cookies', ComponentStatus.OK, 'Principal e backup OK');
        } else if (!mainValid && backupValid) {
            this.updateHealthComponent('cookies', ComponentStatus.WARNING, 'Apenas backup disponível');
        } else if (!mainValid && !backupValid) {
            this.updateHealthComponent('cookies', ComponentStatus.ERROR, 'Nenhum cookie válido');
        }
        
        let liveCount = 0;
        if (global.converter && global.converter.liveCache) {
            liveCount = global.converter.liveCache.size;
        } else if (this._injectedCache) {
            liveCount = this._injectedCache.size;
        }
        
        if (!mainValid && !backupValid && !this._criticalSent) {
            if (this.emailAlerts && this.emailAlerts.sendCriticalAlert) {
                this.emailAlerts.sendCriticalAlert(liveCount);
            } else if (this.emailAlerts) {
                this.emailAlerts.cookieExpired();
            }
            this._criticalSent = true;
            this._failoverSent = false;
            this._backupExpiredSent = false;
            this._recoverySent = false;
        } else if (!mainValid && backupValid && !this._failoverSent) {
            if (this.emailAlerts && this.emailAlerts.sendFailoverAlert) {
                this.emailAlerts.sendFailoverAlert(liveCount);
            }
            this._failoverSent = true;
            this._criticalSent = false;
            this._backupExpiredSent = false;
        } else if (mainValid && !backupValid && !this._backupExpiredSent) {
            if (this.emailAlerts && this.emailAlerts.sendBackupExpiredAlert) {
                this.emailAlerts.sendBackupExpiredAlert(liveCount);
            }
            this._backupExpiredSent = true;
            this._criticalSent = false;
            this._failoverSent = false;
        } else if (mainValid && backupValid && (this._criticalSent || this._failoverSent || this._backupExpiredSent) && !this._recoverySent) {
            if (!this._mainRestoredSent) {
                if (this.emailAlerts && this.emailAlerts.sendRecoveryAlert) {
                    this.emailAlerts.sendRecoveryAlert(liveCount);
                }
                this._recoverySent = true;
            }
            this._criticalSent = false;
            this._failoverSent = false;
            this._backupExpiredSent = false;
        }
    }

    startMonitoring(intervalSeconds = 30) {
        this.intervalMs = intervalSeconds * 1000;
        this.maxSegmentRepeats = this.calculateMaxRepeats();
        this._monitorStopped = false;
        this._liveEnded = false;
        console.log(`🔄 Monitor iniciado para ${this.videoId} (intervalo: ${intervalSeconds}s, stallTimeout: ${this.maxStallTimeMs/1000}s, maxRepeats: ${this.maxSegmentRepeats})`);
        console.log(`[${this.videoId}] 🔍 Cache injetado: ${!!this._injectedCache}`);
        this.checkAndRenew();
    }

    stopMonitoring() {
        this._monitorStopped = true;
        if (this.timeoutId) {
            clearTimeout(this.timeoutId);
            this.timeoutId = null;
        }
        console.log(`⏹️ Monitor parado para ${this.videoId}`);
        this.updateCache(this.liveState);
    }
}

module.exports = LiveMonitor;