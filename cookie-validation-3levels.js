// ========== VALIDA??O DE COOKIE EM 3 N?VEIS ==========

// Fun??o de valida??o completa
async function validateCookie(cookiePath, liveUrl) {
    // N?VEL 1: Validar estrutura do arquivo
    const content = fs.readFileSync(cookiePath, 'utf8');
    
    if (content.length < 5000) {
        throw new Error('Arquivo muito pequeno (' + content.length + ' bytes) - Cookie incompleto');
    }
    
    if (!content.includes('.youtube.com') && !content.includes('youtube.com')) {
        throw new Error('Arquivo n?o cont?m dom?nios do YouTube');
    }
    
    if (!content.includes('# Netscape HTTP Cookie File')) {
        console.log('?? Arquivo n?o est? no formato Netscape, mas pode funcionar');
    }
    
    console.log('? N?vel 1: Estrutura b?sica OK');
    
    // N?VEL 2: Teste com --simulate (metadados)
    const ytCmd = process.platform === 'win32' ? '.\\yt-dlp.exe' : 'yt-dlp';
    
    try {
        await execPromise(`${ytCmd} --cookies "${cookiePath}" --simulate "${liveUrl}"`, { timeout: 20000 });
        console.log('? N?vel 2: Simula??o OK');
    } catch (error) {
        throw new Error('Falha na simula??o: ' + error.message);
    }
    
    // N?VEL 3: Extrair URL HLS (-g)
    try {
        const { stdout } = await execPromise(`${ytCmd} --cookies "${cookiePath}" -g --format best "${liveUrl}"`, { timeout: 30000 });
        const hlsUrl = stdout.trim();
        
        if (!hlsUrl.includes('.m3u8') && !hlsUrl.includes('manifest')) {
            throw new Error('Resposta n?o cont?m URL HLS');
        }
        
        console.log('? N?vel 3: Extra??o HLS OK');
        return { valid: true, hlsUrl: hlsUrl };
        
    } catch (error) {
        throw new Error('Falha na extra??o HLS: ' + error.message);
    }
}

// Obter primeira live monitorada para teste
function getTestLiveUrl() {
    if (converter && converter.liveCache && converter.liveCache.size > 0) {
        // Pega a primeira live do cache
        const firstLive = converter.liveCache.values().next().value;
        if (firstLive && firstLive.youtubeUrl) {
            console.log(`?? Usando live monitorada para teste: ${firstLive.youtubeUrl}`);
            return firstLive.youtubeUrl;
        }
    }
    // Fallback: live da Record News
    console.log('?? Nenhuma live monitorada, usando URL padr?o');
    return 'https://www.youtube.com/watch?v=rdHcRsSCBiU';
}

// Testar cookie atual
app.post('/api/cookie/test', async (req, res) => {
    const mainPath = path.join(cookiesDir, 'main.txt');
    
    if (!fs.existsSync(mainPath)) {
        return res.json({ valid: false, error: 'Nenhum cookie configurado' });
    }
    
    const testLiveUrl = getTestLiveUrl();
    console.log('?? Validando cookie em 3 n?veis...');
    
    try {
        const result = await validateCookie(mainPath, testLiveUrl);
        console.log('? Cookie 100% v?lido!');
        res.json({ 
            valid: true, 
            message: 'Cookie v?lido - pronto para uso',
            hlsExtracted: result.hlsUrl ? 'Sim' : 'N?o'
        });
    } catch (error) {
        console.log('? Cookie inv?lido:', error.message);
        res.json({ 
            valid: false, 
            error: error.message
        });
    }
});

// Upload com valida??o em 3 n?veis
app.post('/api/cookie/upload', upload.single('cookie'), async (req, res) => {
    const tempPath = path.join(cookiesDir, 'temp.txt');
    const mainPath = path.join(cookiesDir, 'main.txt');
    const backupPath = path.join(cookiesDir, 'backup.txt');
    
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'Nenhum arquivo enviado' });
        }
        
        const testLiveUrl = getTestLiveUrl();
        console.log('?? Validando novo cookie em 3 n?veis...');
        
        // Validar o cookie tempor?rio
        const result = await validateCookie(tempPath, testLiveUrl);
        
        console.log('? Cookie validado com sucesso!');
        
        let backupCreated = false;
        
        // Criar backup do cookie atual
        if (fs.existsSync(mainPath)) {
            fs.copyFileSync(mainPath, backupPath);
            backupCreated = true;
            console.log('?? Backup criado: backup.txt');
        }
        
        // Substituir cookie principal
        fs.copyFileSync(tempPath, mainPath);
        console.log('? Cookie principal atualizado');
        
        // Limpar tempor?rio
        if (fs.existsSync(tempPath)) {
            fs.unlinkSync(tempPath);
        }
        
        res.json({ 
            success: true, 
            message: 'Cookie atualizado com sucesso',
            activeCookie: 'main.txt',
            backupCreated: backupCreated,
            validation: '3 n?veis - OK'
        });
        
    } catch (error) {
        console.log('? Cookie rejeitado:', error.message);
        
        // Limpar tempor?rio
        if (fs.existsSync(tempPath)) {
            fs.unlinkSync(tempPath);
        }
        
        res.status(400).json({ 
            success: false, 
            message: 'Cookie inv?lido',
            error: error.message
        });
    }
});

// Status do cookie (melhorado)
app.get('/api/cookie/status', (req, res) => {
    const mainPath = path.join(cookiesDir, 'main.txt');
    const backupPath = path.join(cookiesDir, 'backup.txt');
    let mainSize = 0;
    
    if (fs.existsSync(mainPath)) {
        const stats = fs.statSync(mainPath);
        mainSize = stats.size;
    }
    
    res.json({
        healthy: fs.existsSync(mainPath) && mainSize > 5000,
        hasBackup: fs.existsSync(backupPath),
        activeCookie: fs.existsSync(mainPath) ? 'main.txt' : (fs.existsSync(backupPath) ? 'backup.txt (fallback)' : 'nenhum'),
        cookieSize: mainSize,
        lastCheck: new Date().toISOString()
    });
});
