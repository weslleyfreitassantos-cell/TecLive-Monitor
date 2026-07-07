// monitor/liveMonitor.js - Versão com ABR (master artificial) e suporte a maxHeight por requisição
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const CookieRotator = require('../cookieRotator');

// ============================================================
// ✅ AGENTES HTTP COM KEEPALIVE E MAX SOCKETS ALTO
// ============================================================
const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 30000
});
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 30000
});

// ============================================================

let systemState = null;
try { systemState = require('../systemState'); } catch(e) {}

// ========== CONSTANTES GLOBAIS ==========
const YTDLP_TIMEOUT = 180000; // 3 minutos (já ajustado)
const METADATA_TTL = 15000;
const LIVE_STALL_TIME = 60000;

const LiveState = {
    ONLINE: 'online',
    DEGRADED: 'degraded',
    OFFLINE: 'offline',
    ENDED: 'ended'
};

const ComponentStatus = {
    OK: 'ok',
    WARNING: 'warning',
    ERROR: 'error',
    CRITICAL: 'critical'
};

class LiveMonitor {
    constructor(youtubeUrl, emailAlerts, activeMonitorsMap = null, scheduler = null, cookieRotator = null, onEnd = null) {
        this.youtubeUrl = youtubeUrl;
        this.emailAlerts = emailAlerts;
        this.videoId = this.extractVideoId(youtubeUrl);
        this.m3u8Url = null;
        this.isLive = false;
        this.intervalMs = 15000; // Aumentado para 15s
        this.maxStallTimeMs = LIVE_STALL_TIME;
        
        this._activeMonitors = activeMonitorsMap;
        this._scheduler = scheduler;
        this._cookieRotator = cookieRotator;
        this._onEnd = onEnd;
        
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
        this._liveEndedAt = null;
        this._stableCycles = 0;
        this._currentIntervalMs = this.intervalMs;
        
        this._cachedMetadata = null;
        this._metadataCacheTime = 0;
        this._metadataTTL = METADATA_TTL;
        
        if (!this._cookieRotator) {
            this._cookieRotator = new CookieRotator(this.cookiesDir);
        }
        
        this.needsRefresh = false;
        this.refreshPromise = null;
        this.lastRefreshReq = null;
        this._liveEndedFirstDetection = null;
        this.lastRefreshFailedAt = 0;
        
        // ✅ Armazenar URLs das playlists de qualidade (altura -> URL)
        this._playlistUrls = {};
        // Armazenar master artificial (se gerado)
        this._masterContent = null;
    }

    // ... (todos os outros métodos permanecem iguais)

    extractHlsUrl(metadata, maxHeight = null) {
        if (!metadata.formats || !Array.isArray(metadata.formats)) return null;

        const effectiveMax = maxHeight !== null ? maxHeight : parseInt(process.env.VIDEO_MAX_HEIGHT, 10) || 720;
        const forceArtificial = (maxHeight !== null);

        // 1. Tenta usar master original (se existir) APENAS se não for forçado
        if (!forceArtificial) {
            const masterFormat = metadata.formats.find(f =>
                f.protocol === 'm3u8_native' &&
                f.url &&
                !f.height &&
                f.format_note && f.format_note.toLowerCase().includes('master')
            );
            if (masterFormat) {
                this._masterContent = null;
                console.log(`[${this.videoId}] 📺 Usando master original do YouTube.`);
                this._populatePlaylistUrls(metadata.formats);
                return masterFormat.url;
            }
        } else {
            console.log(`[${this.videoId}] 📺 Forçando construção artificial devido ao parâmetro max.`);
        }

        // 2. Construir master artificial a partir das variantes
        let hlsFormats = metadata.formats.filter(f => 
            (f.protocol === 'm3u8_native' || (f.url && f.url.includes('.m3u8'))) && 
            f.vcodec !== 'none' && 
            f.acodec !== 'none' &&
            f.height
        );

        if (hlsFormats.length === 0) return null;

        hlsFormats = hlsFormats.filter(f => (f.height || 0) <= effectiveMax);
        if (hlsFormats.length === 0) {
            hlsFormats = metadata.formats.filter(f => 
                (f.protocol === 'm3u8_native' || (f.url && f.url.includes('.m3u8'))) && 
                f.vcodec !== 'none' && 
                f.acodec !== 'none' &&
                f.height
            );
            hlsFormats.sort((a, b) => (a.height || 0) - (b.height || 0));
            const fallback = hlsFormats[0];
            console.log(`[${this.videoId}] ⚠️ Nenhum formato ≤ ${effectiveMax}p, usando fallback ${fallback.height}p.`);
            this._masterContent = null;
            this._populatePlaylistUrls(hlsFormats);
            return fallback.url;
        }

        hlsFormats.sort((a, b) => (a.height || 0) - (b.height || 0));

        console.log(`[${this.videoId}] 🛠️ Construindo manifesto master artificial com ${hlsFormats.length} qualidades (max ${effectiveMax}p).`);

        // Preencher playlistUrls
        const playlistUrls = {};
        hlsFormats.forEach(f => {
            const height = f.height || 360;
            playlistUrls[height] = f.url;
        });
        this._playlistUrls = playlistUrls;

        const bestVariant = hlsFormats[hlsFormats.length - 1];
        const bestUrl = bestVariant.url;

        const masterLines = hlsFormats.map(f => {
            const height = f.height || 360;
            const width = f.width || Math.round(height * 16/9);
            const fps = f.fps || 30;
            let bandwidth = 0;
            if (height <= 240) bandwidth = 300000;
            else if (height <= 360) bandwidth = 600000;
            else if (height <= 480) bandwidth = 1200000;
            else if (height <= 720) bandwidth = 2500000;
            else if (height <= 1080) bandwidth = 5000000;
            else bandwidth = 8000000;
            return `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${width}x${height},FRAME-RATE=${fps}\n${f.url}`;
        });

        const masterContent = '#EXTM3U\n' + masterLines.join('\n');

        this._masterContent = {
            isMaster: true,
            content: masterContent,
            urls: hlsFormats.map(f => f.url)
        };

        return bestUrl;
    }

    _populatePlaylistUrls(formats) {
        const playlistUrls = {};
        (formats || []).forEach(f => {
            if (f.url && (f.protocol === 'm3u8_native' || f.url.includes('.m3u8')) && f.height) {
                const height = f.height || 360;
                playlistUrls[height] = f.url;
            }
        });
        this._playlistUrls = playlistUrls;
    }

    // ... (restante do arquivo inalterado)
}

module.exports = LiveMonitor;