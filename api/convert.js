const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');
const GlobalScheduler = require('../globalScheduler');
const CookieRotator = require('../cookieRotator');

class ConvertAPI {
    constructor(emailAlerts, orchestrator, revokeTokenFn = null) {
        this.emailAlerts = emailAlerts;
        this.orchestrator = orchestrator;
        this.activeMonitors = new Map();
        this.liveCache = new Map();
        this._revokeTokenFn = revokeTokenFn;
        
        const cookiesDir = path.join(__dirname, '../cookies');
        this.cookieRotator = new CookieRotator(cookiesDir);
        
        if (this.emailAlerts && this.cookieRotator.setEmailAlerts) {
            this.cookieRotator.setEmailAlerts(this.emailAlerts);
        }
        
        // ============================================================
        // 🔧 ALTERADO: Aumentado o intervalo do scheduler para 60s
        // ============================================================
        this.scheduler = new GlobalScheduler(60000, 6, this.cookieRotator);
        this.pendingConversions = new Map();
    }

    removeMonitor(videoId, owner) {
        const key = this._getCompositeKey(videoId, owner);
        if (this.activeMonitors.has(key)) {
            const monitor = this.activeMonitors.get(key);
            monitor.stopMonitoring();
            this.activeMonitors.delete(key);
            this._removePersistedMapping(videoId, owner);
            if (this._revokeTokenFn) {
                this._revokeTokenFn(videoId, owner);
            }
            console.log(`🗑️ Monitor removido automaticamente (live encerrada): ${key}`);
            return true;
        }
        return false;
    }

    getCookiePath() {
        const cookiePath = this.cookieRotator.getNextCookiePath();
        if (!cookiePath) {
            return { path: null, name: null };
        }
        const name = path.basename(cookiePath);
        return { path: cookiePath, name };
    }

    _getCompositeKey(videoId, owner) {
        return owner ? `${videoId}:${owner}` : videoId;
    }

    _persistMapping(videoId, youtubeUrl, owner, metadata) {
        const cookiesDir = path.join(__dirname, '../cookies');
        const mappingFile = path.join(cookiesDir, 'monitors.json');
        if (!fs.existsSync(cookiesDir)) fs.mkdirSync(cookiesDir, { recursive: true });
        let map = {};
        try { map = JSON.parse(fs.readFileSync(mappingFile, 'utf8')); } catch (e) {}
        const key = this._getCompositeKey(videoId, owner);
        map[key] = { youtubeUrl, owner, metadata: metadata || null };
        fs.writeFileSync(mappingFile, JSON.stringify(map, null, 2));
    }

    _removePersistedMapping(videoId, owner) {
        const cookiesDir = path.join(__dirname, '../cookies');
        const mappingFile = path.join(cookiesDir, 'monitors.json');
        try {
            const map = JSON.parse(fs.readFileSync(mappingFile, 'utf8'));
            const key = this._getCompositeKey(videoId, owner);
            delete map[key];
            fs.writeFileSync(mappingFile, JSON.stringify(map, null, 2));
        } catch (e) {}
    }

    _getPersistedEntry(videoId, owner) {
        try {
            const map = JSON.parse(fs.readFileSync(path.join(__dirname, '../cookies/monitors.json'), 'utf8'));
            const key = this._getCompositeKey(videoId, owner);
            return map[key] || null;
        } catch (e) { return null; }
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

    /**
     * Obtém metadados via oEmbed (Alternativa rápida e sem 429)
     */
    async _getMetadataOembed(videoId) {
        return new Promise((resolve) => {
            const url = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
            const req = https.get(url, (res) => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    try {
                        if (res.statusCode === 200) {
                            const data = JSON.parse(body);
                            resolve({
                                title: data.title || null,
                                channel: data.author_name || null,
                                thumbnail: data.thumbnail_url || null
                            });
                        } else {
                            resolve(null);
                        }
                    } catch (e) {
                        resolve(null);
                    }
                });
            });
            req.on('error', () => resolve(null));
            req.setTimeout(5000, () => {
                req.destroy();
                resolve(null);
            });
        });
    }

    async _getVideoMetadata(youtubeUrl) {
        const videoId = this.extractVideoId(youtubeUrl);
        
        // 1. Tenta oEmbed primeiro (rápido, oficial e evita erro 429)
        console.log(`🔍 Buscando metadados via oEmbed para ${videoId}...`);
        const oembedData = await this._getMetadataOembed(videoId);
        if (oembedData) {
            console.log(`✅ Metadados obtidos via oEmbed: ${oembedData.title}`);
            return oembedData;
        }

        // 2. Fallback para yt-dlp se oEmbed falhar (ex: vídeo privado ou erro de rede)
        try {
            console.log(`⚠️ oEmbed falhou ou retornou vazio, tentando yt-dlp como fallback...`);
            const args = ['--dump-json', '--skip-download', '--flat-playlist', '--playlist-end', '1', youtubeUrl];
            
            // Tenta usar o primeiro cookie disponível para evitar 429 no fallback
            const cookiePath = this.cookieRotator.getNextCookiePath();
            if (cookiePath && fs.existsSync(cookiePath)) {
                args.unshift('--cookies', cookiePath);
            }

            const stdout = await this._runYtdlp(args, 15000);
            const data = JSON.parse(stdout);
            return {
                title: data.title || null,
                channel: data.channel || data.uploader || null,
                thumbnail: data.thumbnail || null,
                duration: data.duration || null,
                viewCount: data.view_count || null,
                uploadDate: data.upload_date || null
            };
        } catch (error) {
            console.warn(`❌ Erro ao obter metadados para ${youtubeUrl}:`, error.message);
            return null;
        }
    }

    async convert(youtubeUrl, baseUrl, owner = null) {
        const videoId = this.extractVideoId(youtubeUrl);
        const key = this._getCompositeKey(videoId, owner);
        
        if (this.pendingConversions.has(key)) {
            console.log(`[${videoId}:${owner}] Conversão em andamento, aguardando...`);
            return this.pendingConversions.get(key);
        }

        if (this.activeMonitors.has(key)) {
            const monitor = this.activeMonitors.get(key);
            return {
                success: true,
                videoId: videoId,
                serverUrl: `${baseUrl}/neonews/${videoId}.m3u8`,
                isLive: monitor.liveState === 'online',
                cached: true,
                metadata: monitor.metadata || null,
                message: 'Live já está sendo monitorada para este usuário'
            };
        }
        
        console.log(`[${new Date().toISOString()}] Requisição: ${youtubeUrl} (owner: ${owner})`);
        
        const metadata = await this._getVideoMetadata(youtubeUrl);
        if (metadata) {
            console.log(`🎬 Título: ${metadata.title}`);
            console.log(`📺 Canal: ${metadata.channel}`);
        }

        // ============================================================
        // 🔧 CORREÇÃO: Fallback local com markSuccess apenas para o cookie que funcionou
        // ============================================================
        const cookiesDir = path.join(__dirname, '../cookies');
        const cookieFiles = ['cookie1.txt', 'cookie2.txt', 'cookie3.txt'];
        const args = ['-g', youtubeUrl];
        let streamUrl = null;
        let workingCookie = null;
        const failedCookies = [];

        // Tenta cada cookie em ordem
        for (const file of cookieFiles) {
            const fullPath = path.join(cookiesDir, file);
            if (!fs.existsSync(fullPath)) {
                console.log(`⚠️ ${file} não encontrado, pulando.`);
                continue;
            }
            const argsWithCookie = ['--cookies', fullPath, ...args];
            try {
                console.log(`🍪 Tentando ${file}...`);
                const stdout = await this._runYtdlp(argsWithCookie, 60000);
                const url = stdout.trim().split('\n')[0];
                if (url && (url.includes('.m3u8') || url.includes('manifest'))) {
                    streamUrl = url;
                    workingCookie = file;
                    console.log(`✅ Sucesso com ${file}`);
                    break;
                } else {
                    throw new Error('URL retornada não é um stream HLS válido');
                }
            } catch (error) {
                console.log(`❌ ${file} falhou: ${error.message}`);
                failedCookies.push({ file, error: error.message });
                const isCookieError = this.cookieRotator &&
                    this.cookieRotator.isCookieAuthError(error.message);
                if (isCookieError && this.cookieRotator) {
                    this.cookieRotator.markFailure(file, error.message, videoId);
                } else {
                    console.log(`[COOKIE] ${file}: erro nao classificado como falha de cookie; estado preservado.`);
                }
            }
        }

        // Se nenhum cookie funcionou
        if (!streamUrl || !workingCookie) {
            console.error(`❌ Todos os cookies falharam para ${videoId}`);
            const cookieErrorCount = this.cookieRotator
                ? failedCookies.filter(({ error }) => this.cookieRotator.isCookieAuthError(error)).length
                : 0;
            const onlyCookieAuthFailures = failedCookies.length > 0 &&
                cookieErrorCount === failedCookies.length;
            return {
                success: false,
                videoId: videoId,
                error: 'Todos os cookies falharam para obter a stream',
                metadata: metadata,
                message: onlyCookieAuthFailures
                    ? 'Falha de autenticacao/cookie. Verifique os cookies.'
                    : 'Nao foi possivel obter a stream; o erro parece relacionado ao video, disponibilidade ou rede, nao necessariamente aos cookies.'
            };
        }

        // ✅ Marca sucesso APENAS para o cookie que realmente funcionou
        if (this.cookieRotator) {
            console.log(`✅ Cookie ${workingCookie} funcionou para obtenção da stream.`);
            this.cookieRotator.markSuccess(workingCookie);
        }

        // Cria o monitor com a stream obtida
        console.log(`✅ Stream capturada para ${videoId}:${owner}`);
        const LiveMonitor = require('../monitor/liveMonitor');
        
        const monitor = new LiveMonitor(
            youtubeUrl,
            this.emailAlerts,
            this.activeMonitors,
            this.scheduler,
            this.cookieRotator,
            (vid, own) => {
                this.removeMonitor(vid, own);
            }
        );
        monitor.m3u8Url = streamUrl;
        monitor.isLive = true;
        monitor.owner = owner;
        monitor.metadata = metadata;
        // ============================================================
        // 🔧 ALTERADO: Aumentado o intervalo de verificação do monitor para 60s
        // ============================================================
        monitor.startMonitoring(60);
        
        this.activeMonitors.set(key, monitor);
        this._persistMapping(videoId, youtubeUrl, owner, metadata);
        
        this.liveCache.set(youtubeUrl, {
            videoId: videoId,
            youtubeUrl: youtubeUrl,
            monitor: monitor,
            metadata: metadata,
            createdAt: Date.now(),
            hits: 1
        });
        
        console.log(`✅ Live salva para ${owner}. Total de monitores ativos: ${this.activeMonitors.size}`);
        return {
            success: true,
            videoId: videoId,
            serverUrl: `${baseUrl}/neonews/${videoId}.m3u8`,
            isLive: true,
            cached: false,
            metadata: metadata,
            message: 'Live detectada com sucesso'
        };
    }

    extractVideoId(url) {
        const match = url.match(/(?:v=|\/)([0-9A-Za-z_-]{11})(?:[?&]|$)/);
        return match ? match[1] : "url_invalida";
    }

    getLiveStats() {
        const stats = { totalMonitors: this.activeMonitors.size, lives: [] };
        for (const [key, monitor] of this.activeMonitors.entries()) {
            const [videoId, owner] = key.split(':');
            stats.lives.push({
                videoId: videoId,
                url: monitor.youtubeUrl,
                isLive: monitor.liveState === 'online',
                owner: owner || null,
                title: monitor.metadata?.title || null,
                channel: monitor.metadata?.channel || null,
                lastAccess: monitor.lastAccess ? new Date(monitor.lastAccess).toISOString() : null,
                createdAt: monitor.createdAt ? new Date(monitor.createdAt).toISOString() : null
            });
        }
        return stats;
    }
}

module.exports = ConvertAPI;
