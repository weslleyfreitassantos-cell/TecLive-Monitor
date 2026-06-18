// ========== ROTAS DE COOKIE (FLUXO SEGURO) ==========

// Testar cookie atual
app.post('/api/cookie/test', async (req, res) => {
    const mainPath = path.join(cookiesDir, 'main.txt');
    
    if (!fs.existsSync(mainPath)) {
        return res.json({ 
            valid: false, 
            error: 'Nenhum cookie configurado' 
        });
    }
    
    const testUrl = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
    const ytCmd = process.platform === 'win32' ? '.\\yt-dlp.exe' : 'yt-dlp';
    
    try {
        await execPromise(`${ytCmd} --cookies "${mainPath}" --dry-run "${testUrl}"`, { timeout: 15000 });
        res.json({ valid: true, message: 'Cookie v?lido' });
    } catch (error) {
        let errorMsg = error.message;
        if (errorMsg.includes('Sign in') || errorMsg.includes('bot')) {
            errorMsg = 'Sign in to confirm you\\'re not a bot';
        }
        res.json({ valid: false, error: errorMsg });
    }
});

// Upload com valida??o segura (NUNCA sobrescreve antes de testar)
app.post('/api/cookie/upload', upload.single('cookie'), async (req, res) => {
    const tempPath = path.join(cookiesDir, 'temp.txt');
    const mainPath = path.join(cookiesDir, 'main.txt');
    const backupPath = path.join(cookiesDir, 'backup.txt');
    
    try {
        if (!req.file) {
            return res.status(400).json({ 
                success: false, 
                message: 'Nenhum arquivo enviado' 
            });
        }
        
        console.log('?? Testando cookie enviado...');
        
        const testUrl = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
        const ytCmd = process.platform === 'win32' ? '.\\yt-dlp.exe' : 'yt-dlp';
        
        try {
            // Testar o cookie tempor?rio
            await execPromise(`${ytCmd} --cookies "${tempPath}" --dry-run "${testUrl}"`, { timeout: 15000 });
            console.log('? Cookie v?lido!');
            
            let backupCreated = false;
            
            // Criar backup do cookie atual (se existir)
            if (fs.existsSync(mainPath)) {
                fs.copyFileSync(mainPath, backupPath);
                backupCreated = true;
                console.log('?? Backup criado: backup.txt');
            }
            
            // Substituir cookie principal
            fs.copyFileSync(tempPath, mainPath);
            console.log('? Cookie principal atualizado');
            
            // Limpar arquivo tempor?rio
            if (fs.existsSync(tempPath)) {
                fs.unlinkSync(tempPath);
            }
            
            res.json({ 
                success: true, 
                message: 'Cookie atualizado com sucesso',
                activeCookie: 'main.txt',
                backupCreated: backupCreated
            });
            
        } catch (error) {
            console.log('? Cookie inv?lido:', error.message);
            
            // Extrair mensagem de erro amig?vel
            let errorMsg = 'Cookie inv?lido';
            if (error.message.includes('Sign in') || error.message.includes('bot')) {
                errorMsg = 'Sign in to confirm you\\'re not a bot';
            } else if (error.message.includes('unable to download')) {
                errorMsg = 'N?o foi poss?vel validar o cookie';
            }
            
            // Limpar arquivo tempor?rio
            if (fs.existsSync(tempPath)) {
                fs.unlinkSync(tempPath);
            }
            
            res.status(400).json({ 
                success: false, 
                message: 'Cookie inv?lido',
                error: errorMsg
            });
        }
        
    } catch (error) {
        console.error('Erro no upload:', error);
        
        // Limpar arquivo tempor?rio em caso de erro
        if (fs.existsSync(tempPath)) {
            fs.unlinkSync(tempPath);
        }
        
        res.status(500).json({ 
            success: false, 
            message: 'Erro interno ao processar arquivo',
            error: error.message
        });
    }
});

// Status do cookie
app.get('/api/cookie/status', (req, res) => {
    const mainPath = path.join(cookiesDir, 'main.txt');
    const backupPath = path.join(cookiesDir, 'backup.txt');
    const mainExists = fs.existsSync(mainPath);
    const backupExists = fs.existsSync(backupPath);
    
    // Tentar ler ?ltimo erro do sistema (simplificado)
    const hasBackup = backupExists;
    
    res.json({
        healthy: mainExists,
        hasBackup: hasBackup,
        activeCookie: mainExists ? 'main.txt' : (backupExists ? 'backup.txt (fallback)' : 'nenhum'),
        lastCheck: new Date().toISOString()
    });
});
