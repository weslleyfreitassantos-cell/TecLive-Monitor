const express = require('express');
const router = express.Router();
const liveMonitor = require('../services/liveMonitor');
const { getM3U8 } = require('../services/youtube');
const https = require('https');
const http = require('http');
const db = require('../database/schema');

// Helper function para obter o link atual
async function getCurrentM3U8(url, userEmail = null) {
    // Se for URL do YouTube, monitora diretamente
    if (url.includes('youtube.com/watch') || url.includes('youtu.be')) {
        let status = liveMonitor.getLiveStatus(url);

        if (!status.monitoring) {
            console.log(`🚀 Iniciando monitoramento automático para: ${url}`);
            console.log(`👤 Usuário: ${userEmail || 'modo local'}`);

            liveMonitor.startMonitoring(url, 30000);

            let tentativas = 0;
            while (!liveMonitor.getLiveStatus(url).currentM3U8 && tentativas < 10) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                tentativas++;
            }
        }

        const updatedStatus = liveMonitor.getLiveStatus(url);
        return updatedStatus.currentM3U8;
    }
    
    // Se for link seguro do sistema (live/xxx.m3u8)
    if (url.includes('/live/') && url.includes('.m3u8')) {
        try {
            // Faz a requisição para o link seguro
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`Erro ${response.status}: Link inválido`);
            }
            const m3u8Content = await response.text();
            return m3u8Content;
        } catch (error) {
            console.error('Erro ao acessar link seguro:', error.message);
            return null;
        }
    }
    
    return null;
}

// Função para baixar o conteúdo do M3U8
function downloadM3U8(m3u8Url) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(m3u8Url);
        const protocol = urlObj.protocol === 'https:' ? https : http;

        const options = {
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        };

        const request = protocol.get(options, (response) => {
            let data = '';
            response.on('data', (chunk) => { data += chunk; });
            response.on('end', () => {
                resolve(data);
            });
        });

        request.on('error', (error) => {
            reject(error);
        });
    });
}

// ============================================================
// ROTAS DO NEOnews
// ============================================================

// Endpoint para VLC, navegador e players (redirecionamento)
router.get('/live.m3u8', async (req, res) => {
    const { url, user } = req.query;

    if (!url) {
        return res.status(400).send('URL da live é obrigatória');
    }

    liveMonitor.updateLastAccess(url);
    const m3u8Url = await getCurrentM3U8(url, user);

    if (!m3u8Url) {
        return res.status(404).send('Link inválido ou indisponível');
    }

    // Se for URL do YouTube, redireciona para o M3U8 real
    if (url.includes('youtube.com/watch') || url.includes('youtu.be')) {
        res.redirect(m3u8Url);
    } else {
        // Se for link seguro, retorna o conteúdo
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.send(m3u8Url);
    }
});

// Endpoint específico para NEOnews (retorna o CONTEÚDO do M3U8)
router.get('/neonews.m3u8', async (req, res) => {
    const { url, user } = req.query;

    if (!url) {
        return res.status(400).send('URL da live é obrigatória');
    }

    liveMonitor.updateLastAccess(url);
    const m3u8Url = await getCurrentM3U8(url, user);

    if (!m3u8Url) {
        return res.status(404).send('Link inválido ou indisponível');
    }

    try {
        // Se for URL do YouTube, baixa o conteúdo do M3U8
        if (url.includes('youtube.com/watch') || url.includes('youtu.be')) {
            const m3u8Content = await downloadM3U8(m3u8Url);
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            res.send(m3u8Content);
        } else {
            // Se for link seguro, já é o conteúdo
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            res.send(m3u8Url);
        }
    } catch (error) {
        console.error('Erro ao baixar M3U8:', error);
        res.status(500).send('Erro ao obter o stream');
    }
});

// ============================================================
// PÁGINAS HTML DO NEOnews
// ============================================================

// Página principal do NEOnews (para colar link seguro)
router.get('/player', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=yes">
    <title>NEOnews Player - YouTube Live Monitor</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
            background: #0a0a0a;
            color: white;
        }
        .container { max-width: 800px; margin: 0 auto; padding: 20px; }
        h1 { font-size: 24px; text-align: center; margin-bottom: 10px; }
        .subtitle { text-align: center; color: #888; margin-bottom: 30px; font-size: 14px; }
        .card { background: #1a1a1a; border-radius: 12px; padding: 20px; margin-bottom: 20px; }
        .card h3 { margin-bottom: 15px; color: #007bff; }
        input { 
            width: 100%; 
            padding: 14px; 
            font-size: 14px; 
            border: 1px solid #333; 
            border-radius: 8px; 
            background: #2a2a2a; 
            color: white;
            margin-bottom: 15px;
        }
        button { 
            width: 100%; 
            padding: 14px; 
            background: #007bff; 
            color: white; 
            border: none; 
            border-radius: 8px; 
            font-size: 16px;
            font-weight: bold;
            cursor: pointer;
        }
        button:hover { background: #0056b3; }
        .info { 
            background: #1a1a1a; 
            border-radius: 12px; 
            padding: 15px; 
            margin-top: 20px;
            border-left: 4px solid #007bff;
        }
        .info p { margin: 5px 0; font-size: 13px; color: #aaa; }
        video { width: 100%; border-radius: 8px; margin-top: 20px; background: black; }
        .status { margin-top: 10px; padding: 10px; border-radius: 8px; text-align: center; font-size: 14px; }
        .status.error { background: #dc3545; color: white; }
        .status.success { background: #28a745; color: white; }
        .status.loading { background: #ffc107; color: #333; }
        .footer { text-align: center; margin-top: 30px; color: #555; font-size: 12px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>📺 NEOnews Player</h1>
        <div class="subtitle">Cole o link gerado no painel do cliente</div>
        
        <div class="card">
            <h3>🔗 Link do Stream</h3>
            <input type="text" id="streamUrl" placeholder="Ex: https://seudominio.com/live/abc123def456.m3u8">
            <button onclick="play()">▶ Assistir Agora</button>
        </div>
        
        <div id="status" class="status" style="display: none;"></div>
        
        <video id="player" controls autoplay style="display: none;"></video>
        
        <div class="info">
            <p>📌 <strong>Como usar:</strong></p>
            <p>1. Faça login no <strong>Painel do Cliente</strong></p>
            <p>2. Cadastre a URL do YouTube desejada</p>
            <p>3. Clique em <strong>"Gerar Link"</strong></p>
            <p>4. Copie o link gerado (ex: /live/abc123.m3u8)</p>
            <p>5. Cole acima e clique em "Assistir Agora"</p>
        </div>
        
        <div class="footer">
            <p>YouTube Live Monitor - Sistema profissional de streaming</p>
        </div>
    </div>
    
    <script>
        async function play() {
            const urlInput = document.getElementById('streamUrl');
            let url = urlInput.value.trim();
            
            if (!url) {
                showStatus('Por favor, cole o link do stream', 'error');
                return;
            }
            
            // Se o link não começa com http, adiciona
            if (!url.startsWith('http')) {
                url = 'https://' + url;
            }
            
            showStatus('🔍 Verificando link...', 'loading');
            
            try {
                // Chama o endpoint do NEOnews
                const response = await fetch('/neonews/neonews.m3u8?url=' + encodeURIComponent(url));
                
                if (!response.ok) {
                    throw new Error('Link inválido ou indisponível');
                }
                
                const m3u8Content = await response.text();
                const blob = new Blob([m3u8Content], { type: 'application/vnd.apple.mpegurl' });
                const videoUrl = URL.createObjectURL(blob);
                
                const video = document.getElementById('player');
                video.style.display = 'block';
                video.src = videoUrl;
                video.play();
                
                showStatus('✅ Stream carregado com sucesso!', 'success');
                
            } catch (err) {
                showStatus('❌ Link inválido ou indisponível', 'error');
                document.getElementById('player').style.display = 'none';
            }
        }
        
        function showStatus(message, type) {
            const statusDiv = document.getElementById('status');
            statusDiv.style.display = 'block';
            statusDiv.className = 'status ' + type;
            statusDiv.innerHTML = message;
            
            if (type !== 'loading') {
                setTimeout(() => {
                    if (document.getElementById('status').innerHTML === message) {
                        statusDiv.style.display = 'none';
                    }
                }, 5000);
            }
        }
        
        // Suporte a Enter no input
        document.getElementById('streamUrl').addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                play();
            }
        });
    </script>
</body>
</html>
    `);
});

// Endpoint original /play (mantido para compatibilidade)
router.get('/play', async (req, res) => {
    const { url, user } = req.query;

    if (!url) {
        return res.status(400).send('URL da live é obrigatória');
    }

    liveMonitor.updateLastAccess(url);
    const m3u8Url = await getCurrentM3U8(url, user);

    if (!m3u8Url) {
        return res.status(404).send('Link inválido ou indisponível');
    }

    res.redirect(m3u8Url);
});

// Endpoint /stream (retorna JSON)
router.get('/stream', (req, res) => {
    const { url } = req.query;

    if (!url) {
        return res.status(400).json({ error: 'URL da live é obrigatória' });
    }

    const status = liveMonitor.getLiveStatus(url);

    if (!status.monitoring) {
        return res.status(404).json({
            error: 'Live não está sendo monitorada',
            solution: 'POST /monitor/start'
        });
    }

    res.json({
        live_url: status.currentM3U8,
        last_check: status.lastCheck,
        changes: status.changesCount,
        monitoring: true
    });
});

module.exports = router;