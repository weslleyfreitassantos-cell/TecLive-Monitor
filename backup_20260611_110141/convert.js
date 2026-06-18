const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const path = require('path');
const fs = require('fs');
const GlobalScheduler = require('../globalScheduler');

class ConvertAPI {
    constructor(emailAlerts, orchestrator) {
        this.emailAlerts = emailAlerts;
        this.orchestrator = orchestrator;
        this.activeMonitors = new Map();
        this.liveCache = new Map();
        this.scheduler = new GlobalScheduler(30000);
    }

    getCookiePath() {
        const cookiesDir = path.join(__dirname, '../cookies');
        const mainPath = path.join(cookiesDir, 'main.txt');
        const backupPath = path.join(cookiesDir, 'backup.txt');
        if (fs.existsSync(mainPath)) return mainPath;
        if (fs.existsSync(backupPath)) return backupPath;
        return null;
    }

    async convert(youtubeUrl, baseUrl) {
        const videoId = this.extractVideoId(youtubeUrl);
        
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
        const ytCmd = process.platform === 'win32' ? '.\\yt-dlp.exe' : 'yt-dlp';
        let command;
        if (cookiePath) {
            command = `${ytCmd} --cookies "${cookiePath}" -g --format best "${youtubeUrl}"`;
            console.log(`🍪 Usando cookie: ${path.basename(cookiePath)}`);
        } else {
            command = `${ytCmd} -g --format best "${youtubeUrl}"`;
            console.log(`⚠️ Nenhum cookie encontrado, tentando sem autenticação`);
        }
        
        try {
            const { stdout } = await execPromise(command, { timeout: 30000 });
            const streamUrl = stdout.trim().split('\n')[0];
            if (!streamUrl || (!streamUrl.includes('.m3u8') && !streamUrl.includes('manifest'))) {
                throw new Error('URL retornada não é um stream HLS válido');
            }
            
            console.log(`✅ Stream capturada`);
            const LiveMonitor = require('../monitor/liveMonitor');
            const monitor = new LiveMonitor(youtubeUrl, this.emailAlerts, this.activeMonitors, this.scheduler);
            monitor.m3u8Url = streamUrl;
            monitor.isLive = true;
            monitor.startMonitoring(30);
            
            this.activeMonitors.set(videoId, monitor);
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
            const monitor = new LiveMonitor(youtubeUrl, this.emailAlerts, this.activeMonitors, this.scheduler);
            monitor.isLive = false;
            monitor.liveState = 'offline';
            monitor.failCount = 1;
            monitor.startMonitoring(30);
            this.activeMonitors.set(videoId, monitor);
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
        }
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