const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { spawn } = require('child_process');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3002;

app.use(express.json());
app.use(express.static('public'));

// ========== CONFIGURACAO ==========
const cookiesDir = path.join(__dirname, 'cookies');
if (!fs.existsSync(cookiesDir)) {
    fs.mkdirSync(cookiesDir, { recursive: true });
}

// ========== CONTROLE DE CONCORRÊNCIA ==========
let uploadInProgress = false;
let lastCookieValidation = null;
let lastCookieValid = false;

// ========== CONFIGURACAO DO MULTER COM NOME ÚNICO ==========
const storage = multer.diskStorage({
    destination: cookiesDir,
    filename: (req, file, cb) => {
        const uniqueName = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.txt`;
        cb(null, uniqueName);
    }
});
const upload = multer({ storage: storage });

// ========== MIDDLEWARE DE ERRO DO MULTER ==========
app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        console.error(`❌ Erro Multer: ${err.message}`);
        return res.status(400).json({ success: false, message: err.message });
    }
    next(err);
});

let converter = null;

// ========== FUNÇÃO PARA EXECUTAR YT-DLP COM SPAWN ==========
function runYtdlp(args, timeout = 30000) {
    return new Promise((resolve, reject) => {
        const ytCmd = process.platform === 'win32' ? '.\\yt-dlp.exe' : 'yt-dlp';
        const child = spawn(ytCmd, args);
        
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        
        const timeoutId = setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
            reject(new Error(`Timeout após ${timeout}ms`));
        }, timeout);
        
        child.stdout.on('data', (data) => { stdout += data.toString(); });
        child.stderr.on('data', (data) => { stderr += data.toString(); });
        
        child.on('close', (code) => {
            clearTimeout(timeoutId);
            if (timedOut) return;
            
            if (code === 0) {
                resolve(stdout.trim());
            } else {
                reject(new Error(stderr.trim() || `Código de saída: ${code}`));
            }
        });
        
        child.on('error', (err) => {
            clearTimeout(timeoutId);
            reject(err);
        });
    });
}

// ========== VALIDACAO SIMPLIFICADA ==========
async function validateCookieSimple(cookiePath) {
    const stats = fs.statSync(cookiePath);
    if (stats.size < 5000) {
        throw new Error(`Arquivo muito pequeno (${stats.size} bytes)`);
    }
    
    const content = fs.readFileSync(cookiePath, 'utf8');
    if (!content.includes('.youtube.com') && !content.includes('youtube.com')) {
        throw new Error('Cookie inválido - domínio YouTube não encontrado');
    }
    
    console.log('✅ Estrutura do cookie OK');
    
    try {
        console.log('🔍 Testando autenticação do cookie...');
        await runYtdlp([
            '--cookies', cookiePath,
            '--flat-playlist',
            '--playlist-end', '1',
            '--dump-json',
            'https://www.youtube.com/feed/subscriptions'
        ], 20000);
        console.log('✅ Cookie válido (autenticação confirmada)');
        return true;
    } catch (error) {
        throw new Error('Cookie inválido: ' + error.message);
    }
}

// ========== ROTAS DE COOKIE ==========

// Rota para teste (usa o cookie ativo – compatibilidade)
app.post('/api/cookie/test', async (req, res) => {
    let activePath = null;
    for (let i = 1; i <= 3; i++) {
        const testPath = path.join(cookiesDir, `cookie${i}.txt`);
        if (fs.existsSync(testPath) && fs.statSync(testPath).size > 5000) {
            activePath = testPath;
            break;
        }
    }
    if (!activePath) {
        const mainPath = path.join(cookiesDir, 'main.txt');
        if (fs.existsSync(mainPath)) activePath = mainPath;
    }
    
    if (!activePath) {
        return res.json({ valid: false, error: 'Nenhum cookie configurado' });
    }
    
    const cacheTime = 5 * 60 * 1000;
    if (lastCookieValidation && (Date.now() - lastCookieValidation) < cacheTime) {
        console.log('📦 Usando cache de validação do cookie');
        return res.json({ valid: lastCookieValid, message: lastCookieValid ? 'Cookie válido (cache)' : 'Cookie inválido (cache)' });
    }
    
    try {
        await validateCookieSimple(activePath);
        lastCookieValid = true;
        lastCookieValidation = Date.now();
        res.json({ valid: true, message: 'Cookie válido' });
    } catch (error) {
        lastCookieValid = false;
        lastCookieValidation = Date.now();
        res.json({ valid: false, error: error.message });
    }
});

// Rota de upload – compatível com o sistema antigo (sobe como main.txt) e também
// aceita parâmetro ?type=1,2,3 para salvar como cookie1.txt, cookie2.txt, cookie3.txt
app.post('/api/cookie/upload', upload.single('cookie'), async (req, res) => {
    const startTime = Date.now();
    
    if (uploadInProgress) {
        console.log('⚠️ Upload já em andamento, rejeitando requisição');
        return res.status(409).json({ 
            success: false, 
            message: 'Já existe um upload em andamento. Aguarde alguns segundos.' 
        });
    }
    
    uploadInProgress = true;
    
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'Nenhum arquivo enviado' });
        }
        
        const tempPath = req.file.path;
        
        let targetType = req.query.type || '1';
        let targetPath;
        let isLegacy = false;
        
        if (targetType === '1') targetPath = path.join(cookiesDir, 'cookie1.txt');
        else if (targetType === '2') targetPath = path.join(cookiesDir, 'cookie2.txt');
        else if (targetType === '3') targetPath = path.join(cookiesDir, 'cookie3.txt');
        else {
            isLegacy = true;
            targetPath = path.join(cookiesDir, 'main.txt');
        }
        
        console.log(`📁 Upload: ${req.file.originalname} (${req.file.size} bytes) -> ${path.basename(targetPath)}`);
        
        await validateCookieSimple(tempPath);
        
        console.log(`✅ Cookie validado em ${Date.now() - startTime}ms`);
        
        let backupCreated = false;
        if (isLegacy && fs.existsSync(targetPath)) {
            const backupPath = path.join(cookiesDir, 'backup.txt');
            fs.copyFileSync(targetPath, backupPath);
            backupCreated = true;
            console.log('📁 Backup do main.txt criado');
        }
        
        if (fs.existsSync(targetPath)) {
            fs.unlinkSync(targetPath);
        }
        fs.renameSync(tempPath, targetPath);
        
        if (!isLegacy && targetType === '1') {
            try {
                fs.copyFileSync(targetPath, path.join(cookiesDir, 'main.txt'));
                console.log('🔄 Compatibilidade: cookie1.txt copiado para main.txt');
            } catch (e) { console.warn('Não foi possível criar main.txt:', e.message); }
        }
        
        lastCookieValidation = Date.now();
        lastCookieValid = true;
        
        console.log(`✅ Cookie ${isLegacy ? 'legacy' : `cookie${targetType}`} atualizado com sucesso! Tempo total: ${Date.now() - startTime}ms`);
        
        res.json({ 
            success: true, 
            message: `Cookie ${isLegacy ? 'principal' : `cookie${targetType}`} atualizado com sucesso`,
            backupCreated: backupCreated,
            elapsedMs: Date.now() - startTime
        });
        
    } catch (error) {
        console.error(`❌ Erro no upload: ${error.message}`);
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }
        res.status(400).json({ success: false, message: error.message });
    } finally {
        uploadInProgress = false;
    }
});

// Rota de status – retorna os três cookies reais (conteúdos) e mantém os campos antigos
app.get('/api/cookie/status', (req, res) => {
    const cookie1Path = path.join(cookiesDir, 'cookie1.txt');
    const cookie2Path = path.join(cookiesDir, 'cookie2.txt');
    const cookie3Path = path.join(cookiesDir, 'cookie3.txt');
    const mainPath = path.join(cookiesDir, 'main.txt');
    const backupPath = path.join(cookiesDir, 'backup.txt');
    const MIN_SIZE = 5000;
    
    const cookie1Valid = fs.existsSync(cookie1Path) && fs.statSync(cookie1Path).size > MIN_SIZE;
    const cookie2Valid = fs.existsSync(cookie2Path) && fs.statSync(cookie2Path).size > MIN_SIZE;
    const cookie3Valid = fs.existsSync(cookie3Path) && fs.statSync(cookie3Path).size > MIN_SIZE;
    
    let cookie1Content = 'nenhum';
    let cookie2Content = 'nenhum';
    let cookie3Content = 'nenhum';
    
    if (cookie1Valid) cookie1Content = fs.readFileSync(cookie1Path, 'utf8');
    if (cookie2Valid) cookie2Content = fs.readFileSync(cookie2Path, 'utf8');
    if (cookie3Valid) cookie3Content = fs.readFileSync(cookie3Path, 'utf8');
    
    let activeCookie = 'nenhum';
    if (cookie1Valid) activeCookie = 'cookie1';
    else if (cookie2Valid) activeCookie = 'cookie2';
    else if (cookie3Valid) activeCookie = 'cookie3';
    
    const mainValid = fs.existsSync(mainPath) && fs.statSync(mainPath).size > MIN_SIZE;
    const backupValid = fs.existsSync(backupPath) && fs.statSync(backupPath).size > MIN_SIZE;
    
    let finalActive = activeCookie;
    let finalActiveName = finalActive !== 'nenhum' ? (finalActive === 'cookie1' ? 'cookie1.txt' : finalActive === 'cookie2' ? 'cookie2.txt' : 'cookie3.txt') : 'nenhum';
    let finalHealthy = finalActive !== 'nenhum';
    let finalHasBackup = false;
    
    if (finalActive === 'cookie1' && (cookie2Valid || cookie3Valid)) finalHasBackup = true;
    else if (finalActive === 'cookie2' && (cookie1Valid || cookie3Valid)) finalHasBackup = true;
    else if (finalActive === 'cookie3' && (cookie1Valid || cookie2Valid)) finalHasBackup = true;
    
    if (!finalHealthy && mainValid) {
        finalActive = 'main.txt';
        finalActiveName = 'main.txt';
        finalHealthy = true;
        finalHasBackup = backupValid;
        if (cookie1Content === 'nenhum') cookie1Content = fs.readFileSync(mainPath, 'utf8');
    }
    
    let activeSize = 0;
    if (finalActive === 'cookie1') activeSize = fs.statSync(cookie1Path).size;
    else if (finalActive === 'cookie2') activeSize = fs.statSync(cookie2Path).size;
    else if (finalActive === 'cookie3') activeSize = fs.statSync(cookie3Path).size;
    else if (finalActive === 'main.txt') activeSize = fs.statSync(mainPath).size;
    
    const consecutiveFailures = 0;
    
    res.json({
        cookie1: cookie1Content,
        cookie2: cookie2Content,
        cookie3: cookie3Content,
        consecutiveFailures: consecutiveFailures,
        lastCookieCheck: new Date().toISOString(),
        cookieStatus: finalHealthy ? 'valid' : 'invalid',
        healthy: finalHealthy,
        hasBackup: finalHasBackup,
        activeCookie: finalActiveName,
        cookieSize: activeSize,
        lastCheck: new Date().toISOString()
    });
});

// ========== SISTEMA PRINCIPAL ==========
const EmailAlerts = require('./alerts/emailAlerts');
const ConvertAPI = require('./api/convert');

const emailAlerts = new EmailAlerts();
converter = new ConvertAPI(emailAlerts);

// ========== MONITORAMENTO PERIÓDICO DE COOKIES (ALERTAS) ==========
// A cada 2 minutos verifica o estado dos 3 cookies e dispara e-mails conforme os níveis:
// - Atenção (2 válidos)
// - Crítico (1 válido)
// - Emergência (0 válido)
// - Recuperação parcial/individual
// - Recuperação total (3 válidos)
setInterval(() => {
    if (converter && converter.liveCache && emailAlerts && typeof emailAlerts.evaluateAndAlert === 'function') {
        const liveCount = converter.liveCache.size;
        emailAlerts.evaluateAndAlert(liveCount);
    }
}, 120000); // 120 segundos = 2 minutos (ajuste conforme necessidade)

// ========== ROTAS ADICIONAIS ==========
app.post('/api/convert', async (req, res) => {
    const { youtubeUrl } = req.body;
    if (!youtubeUrl) {
        return res.status(400).json({ success: false, error: 'URL obrigatoria' });
    }
    const baseUrl = process.env.BASE_URL || 'http://localhost:' + PORT;
    const result = await converter.convert(youtubeUrl, baseUrl);
    res.json(result);
});

app.get('/api/monitors', (req, res) => {
    const monitors = [];
    
    if (converter && converter.liveCache) {
        for (const [url, data] of converter.liveCache.entries()) {
            let status = data.status;
            let failCount = 0;
            
            if (data.monitor) {
                status = data.monitor.liveState || data.monitor.status || data.status;
                failCount = data.monitor.failCount || 0;
            }
            
            if (!status) {
                status = data.isLive ? 'online' : 'offline';
            }
            
            monitors.push({
                videoId: data.videoId,
                youtubeUrl: url,
                status: status,
                isLive: status === 'online',
                failCount: failCount,
                lastRenewSuccess: data.lastUpdate || data.lastRenewSuccess
            });
        }
    }
    
    if (monitors.length > 0) {
        const offlineCount = monitors.filter(m => m.status !== 'online').length;
        if (offlineCount > 0) {
            console.log(`📊 /api/monitors: ${monitors.length} lives (${offlineCount} offline/ended)`);
            monitors.forEach(m => {
                if (m.status !== 'online') {
                    console.log(`   - ${m.videoId}: ${m.status}`);
                }
            });
        }
    }
    
    res.json({ totalMonitors: monitors.length, monitors });
});

app.get('/neonews/:videoId.m3u8', async (req, res) => {
    const videoId = req.params.videoId;
    let streamUrl = null;
    
    if (converter && converter.liveCache) {
        for (const [url, data] of converter.liveCache.entries()) {
            if (data.videoId === videoId) {
                streamUrl = data.m3u8Url || data.streamUrl;
                break;
            }
        }
    }
    
    if (!streamUrl) {
        return res.status(404).send('Stream not found');
    }
    
    const https = require('https');
    const http = require('http');
    
    try {
        const urlObj = new URL(streamUrl);
        const protocol = urlObj.protocol === 'https:' ? https : http;
        
        protocol.get(streamUrl, (proxyRes) => {
            let m3u8Content = '';
            
            if (proxyRes.statusCode !== 200) {
                return res.status(502).send('Stream error');
            }
            
            proxyRes.on('data', (chunk) => { m3u8Content += chunk; });
            proxyRes.on('end', () => {
                res.writeHead(200, {
                    'Content-Type': 'application/vnd.apple.mpegurl',
                    'Access-Control-Allow-Origin': '*',
                    'Cache-Control': 'no-cache'
                });
                res.end(m3u8Content);
            });
        }).on('error', (err) => {
            res.status(500).send('Error');
        });
    } catch (err) {
        res.status(500).send('Invalid URL');
    }
});

app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        version: '3.0.0',
        uptime: process.uptime(),
        cachedLives: converter && converter.liveCache ? converter.liveCache.size : 0
    });
});

app.get('/stats', (req, res) => {
    res.json(converter.getLiveStats());
});

app.get('/admin/cookie', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/admin/cookie.html'));
});

app.get('/', (req, res) => {
    res.redirect('/dashboard.html');
});

app.post('/admin/test-recovery', async (req, res) => {
    try {
        const systemState = require('./systemState');
        if (systemState && systemState.sendRecoveryEmail) {
            let liveCount = converter && converter.liveCache ? converter.liveCache.size : 1;
            await systemState.sendRecoveryEmail(emailAlerts, liveCount);
            res.json({ success: true, message: 'E-mail de recuperação enviado!' });
        } else {
            res.json({ success: false, message: 'SystemState não disponível' });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ========== INICIAR SERVIDOR ==========
const scheduler = require('./scheduler');
app.get('/api/scheduler/stats', (req, res) => {
    res.json(scheduler.getStats());
});

app.listen(PORT, () => {
    console.log('\n========================================');
    console.log('NeoNews Live Converter V3');
    console.log('========================================');
    console.log('Dashboard: http://localhost:' + PORT + '/dashboard.html');
    console.log('Conversor: http://localhost:' + PORT + '/converter.html');
    console.log('API Health: http://localhost:' + PORT + '/health');
    console.log('========================================\n');
});