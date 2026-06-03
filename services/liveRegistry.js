// services/liveRegistry.js
const { exec } = require('child_process');
const db = require('../database/schema');
const liveMonitor = require('./liveMonitor');

class LiveRegistry {
    extractVideoId(url) {
        const match = url.match(/(?:youtube\.com\/watch\?v=)([^&]+)/);
        return match ? match[1] : null;
    }

    // 🔥 NOVO: Buscar título da live
    async getVideoTitle(url) {
        return new Promise((resolve) => {
            const command = `yt-dlp --print title "${url}"`;
            exec(command, { timeout: 10000 }, (error, stdout) => {
                if (error) {
                    console.log(`⚠️ Não foi possível obter título: ${error.message}`);
                    resolve(null);
                } else {
                    const title = stdout.trim();
                    // Limitar tamanho do título
                    resolve(title.length > 80 ? title.substring(0, 80) + '...' : title);
                }
            });
        });
    }

    async registerLive(youtubeUrl) {
        const youtubeId = this.extractVideoId(youtubeUrl);
        if (!youtubeId) throw new Error('URL inválida');

        let live = await this.getLiveByYoutubeId(youtubeId);
        
        if (live) {
            console.log(`📺 Live ${youtubeId} já existe. Reutilizando.`);
            
            if (!liveMonitor.isMonitoring(live.youtube_url)) {
                console.log(`🎬 Iniciando monitoramento para live existente: ${youtubeId}`);
                liveMonitor.startMonitoring(live.youtube_url);
            }
            
            return { isNew: false, live, m3u8Url: `/live/${live.id}.m3u8` };
        }
        
        // 🔥 Buscar título antes de criar
        console.log(`🔍 Buscando título para: ${youtubeUrl}`);
        const title = await this.getVideoTitle(youtubeUrl);
        console.log(`📺 Título obtido: ${title || 'não disponível'}`);
        
        const newLive = await this.createLiveSource(youtubeId, youtubeUrl, title);
        liveMonitor.startMonitoring(youtubeUrl);
        
        return { isNew: true, live: newLive, m3u8Url: `/live/${newLive.id}.m3u8` };
    }
    
    getLiveByYoutubeId(youtubeId) {
        return new Promise((resolve, reject) => {
            db.get('SELECT * FROM live_sources WHERE youtube_id = ?', [youtubeId], (err, row) => {
                if (err) reject(err);
                resolve(row);
            });
        });
    }
    
    getLiveById(id) {
        return new Promise((resolve, reject) => {
            db.get('SELECT * FROM live_sources WHERE id = ?', [id], (err, row) => {
                if (err) reject(err);
                resolve(row);
            });
        });
    }
    
    // 🔥 MODIFICADO: Adicionar campo title
    createLiveSource(youtubeId, youtubeUrl, title = null) {
        return new Promise((resolve, reject) => {
            db.run(
                'INSERT INTO live_sources (youtube_id, youtube_url, title) VALUES (?, ?, ?)',
                [youtubeId, youtubeUrl, title],
                function(err) {
                    if (err) reject(err);
                    resolve({ 
                        id: this.lastID, 
                        youtube_id: youtubeId, 
                        youtube_url: youtubeUrl,
                        title: title
                    });
                }
            );
        });
    }
    
    // 🔥 Buscar título por ID
    async getTitleByLiveId(liveId) {
        const live = await this.getLiveById(liveId);
        return live ? live.title : null;
    }
}

module.exports = new LiveRegistry();