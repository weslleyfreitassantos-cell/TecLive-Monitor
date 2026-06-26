const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const GlobalScheduler = require('../globalScheduler');
const CookieRotator = require('../cookieRotator');

class ConvertAPI {
    constructor(emailAlerts, orchestrator) {
        this.emailAlerts = emailAlerts;
        this.orchestrator = orchestrator;
        this.activeMonitors = new Map();
        this.liveCache = new Map();
        
        const cookiesDir = path.join(__dirname, '../cookies');
        this.cookieRotator = new CookieRotator(cookiesDir);
        
        if (this.emailAlerts && this.cookieRotator.setEmailAlerts) {
            this.cookieRotator.setEmailAlerts(this.emailAlerts);
        }
        
        this.scheduler = new GlobalScheduler(30000, 6, this.cookieRotator);
        
        this.pendingConversions = new Map();
    }

    getCookiePath() {
        return this.cookieRotator.getNextCookiePath() || this.cookieRotator.getFallbackCookiePath();
    }

    _persistMapping(videoId, youtubeUrl) {
        const cookiesDir = path.join(__dirname, '../cookies');
        const mappingFile = path.join(cookiesDir, 'monitors.json');
        if (!fs.existsSync(cookiesDir)) fs.mkdirSync(cookiesDir, { recursive: true });
        let map = {};
        try { map = JSON.parse(fs.readFileSync(mappingFile, 'utf8')); } catch (e) {}
        map[videoId] = youtubeUrl;
        fs.writeFileSync(mappingFile, JSON.stringify(map, null, 2));
    }

    _removePersistedMapping(videoId) {
        const cookiesDir = path.join(__dirname, '../cookies');
        const mappingFile = path.join(cookiesDir, 'monitors.json');
        try {
            const map = JSON.parse(fs.readFileSync(mappingFile, 'utf8'));
            delete map[videoId];
            fs.writeFileSync(mappingFile, JSON.stringify(map, null, 2));
        } catch (e) {}
    }

    _runYtdlp(args, timeout = 60000) {
        return new Promise((resolve, reject) => {
            const ytCmd = process.platform === 'win32' ? '.\\yt-dlp.exe' : 'yt-dlp';
            const child = spawn(ytCmd, args);
            let stdout = '';
            let stderr = '';
            let timedOut = false;
            const timeoutId = setTimeout(() => {
                timedOut = true;
                child.kill('SIGTERM');
                setTimeout(() => {
                    if (!child.killed) {
                        console.warn(`⚠️ yt-dlp (pid ${child.pid}) não respondeu a SIGTERM, forçando SIGKILL`);
                        try { child.kill('SIGKILL'); } catch (e) {}
                    }
                }, 5000);
                reject(new Error(`Timeout após ${timeout}ms`));
            }, timeout);
            child.stdout.on('data', (data) => { stdout += data.toString(); });
            child.stderr.on('data', (data) => { stderr += data.toString(); });
            child.on('close', (code) => {
                clearTimeout(timeoutId);
                if (timedOut) return;
                if (code === 0) resolve(stdout.trim());
                else reject(new Error(stderr.trim() || `Código de saída: ${code}`));
            });
            child.on('error', (err) => {
                clearTimeout(timeoutId);
                reject(err);
            });
        });
    }

    async convert(youtubeUrl, baseUrl) {
        const videoId = this.extractVideoId(youtubeUrl);
        
        if (this.pendingConversions.has(videoId)) {
            console.log(`[${videoId}] Conversão em andamento, aguardando...`);
            return this.pendingConversions.get(videoId);
        }

        if (this.activeMonitors.has(videoId)) {
            const monitor = this.activeMonitors.get(videoId);
            return {
                success: true,
                videoId: videoId,
                serverUrl: `${baseUrl}/neonews/${videoId}.m3u8`,
                isLive: monitor.liveState === 'online',
                cached: true,
                message: 'Live já está sendo monitorada'
            };
        }
        
        console.log(`[${new Date().toISOString()}] Requisição: ${youtubeUrl}`);
        
        const cookiePath = this.getCookiePath();
        const args = ['-g', '--format', 'best', youtubeUrl];
        if (cookiePath) {
            args.unshift('--cookies', cookiePath);
            console.log(`🍪 Usando cookie: ${path.basename(cookiePath)}`);
        } else {
            console.log('⚠️ Nenhum cookie encontrado, tentando sem autenticação');
        }

        const conversionPromise = (async () => {
            try {
                const stdout = await this._runYtdlp(args, 60000);
                const streamUrl = stdout.trim().split('\n')[0];
                if (!streamUrl || (!streamUrl.includes('.m3u8') && !streamUrl.includes('manifest'))) {
                    throw new Error('URL retornada não é um stream HLS válido');
                }
                
                console.log(`✅ Stream capturada para ${videoId}`);
                const LiveMonitor = require('../monitor/liveMonitor');
                const monitor = new LiveMonitor(
                    youtubeUrl,
                    this.emailAlerts,
                    this.activeMonitors,
                    this.scheduler,
                    this.cookieRotator
                );
                monitor.m3u8Url = streamUrl;
                monitor.isLive = true;
                monitor.startMonitoring(30);
                
                this.activeMonitors.set(videoId, monitor);
                this._persistMapping(videoId, youtubeUrl);
                
                this.liveCache.set(youtubeUrl, {
                    videoId: videoId,
                    youtubeUrl: youtubeUrl,
                    monitor: monitor,
                    createdAt: Date.now(),
                    hits: 1
                });
                
                console.log(`✅ Live salva. Total de monitores ativos: ${this.activeMonitors.size}`);
                return {
                    success: true,
                    videoId: videoId,
                    serverUrl: `${baseUrl}/neonews/${videoId}.m3u8`,
                    isLive: true,
                    cached: false,
                    message: 'Live detectada com sucesso'
                };
            } catch (error) {
                console.error(`❌ Erro na conversão: ${error.message}`);
                const LiveMonitor = require('../monitor/liveMonitor');
                const monitor = new LiveMonitor(
                    youtubeUrl,
                    this.emailAlerts,
                    this.activeMonitors,
                    this.scheduler,
                    this.cookieRotator
                );
                monitor.isLive = false;
                monitor.liveState = 'offline';
                monitor.failCount = 1;
                monitor.startMonitoring(30);
                this.activeMonitors.set(videoId, monitor);
                this._persistMapping(videoId, youtubeUrl);
                this.liveCache.set(youtubeUrl, {
                    videoId: videoId,
                    youtubeUrl: youtubeUrl,
                    monitor: monitor,
                    createdAt: Date.now(),
                    hits: 1
                });
                return {
                    success: false,
                    videoId: videoId,
                    error: error.message,
                    message: 'Falha ao processar live, mas monitor foi criado'
                };
            } finally {
                this.pendingConversions.delete(videoId);
            }
        })();

        this.pendingConversions.set(videoId, conversionPromise);
        return conversionPromise;
    }

    extractVideoId(url) {
        const match = url.match(/(?:v=|\/)([0-9A-Za-z_-]{11})(?:[?&]|$)/);
        return match ? match[1] : "url_invalida";
    }

    getLiveStats() {
        const stats = { totalMonitors: this.activeMonitors.size, lives: [] };
        for (const [videoId, monitor] of this.activeMonitors.entries()) {
            stats.lives.push({
                videoId: videoId,
                url: monitor.youtubeUrl,
                isLive: monitor.liveState === 'online',
                lastAccess: monitor.lastAccess ? new Date(monitor.lastAccess).toISOString() : null,
                createdAt: monitor.createdAt ? new Date(monitor.createdAt).toISOString() : null
            });
        }
        return stats;
    }
}

module.exports = ConvertAPI;