// ========== ROTAS DE COOKIE CORRIGIDAS ==========

// URL de teste - uma live p?blica confi?vel (Record News)
const TEST_LIVE_URL = 'https://www.youtube.com/watch?v=rdHcRsSCBiU';

// Testar cookie atual com uma live real
app.post('/api/cookie/test', async (req, res) => {
    const mainPath = path.join(cookiesDir, 'main.txt');
    
    if (!fs.existsSync(mainPath)) {
        return res.json({ valid: false, error: 'Nenhum cookie configurado' });
    }
    
    const ytCmd = process.platform === 'win32' ? '.\\yt-dlp.exe' : 'yt-dlp';
    
    // Usar --simulate (ou -s) para testar sem baixar
    const command = `${ytCmd} --cookies "${mainPath}" --simulate "${TEST_LIVE_URL}"`;
    
    console.log('?? Testando cookie com comando:', command);
    
    try {
        await execPromise(command, { timeout: 30000 });
        console.log('? Cookie v?lido!');
        res.json({ valid: true, message: 'Cookie v?lido - YouTube aceitou a autentica??o' });
    } catch (error) {
        console.log('? Cookie inv?lido:', error.message);
        
        let errorMsg = 'Cookie inv?lido';
        if (error.message.includes('Sign in') || error.message.includes('bot') || error.message.includes('login')) {
            errorMsg = 'Sign in to confirm you are not a bot';
        } else if (error.message.includes('HTTP Error 403')) {
            errorMsg = 'Acesso negado - cookie expirado ou inv?lido';
        } else if (error.message.includes('unable to download')) {
            errorMsg = 'N?o foi poss?vel acessar o YouTube';
        }
        
        res.json({ 
            valid: false, 
            error: errorMsg,
            details: error.message.substring(0, 200)
        });
    }
});

// Upload com valida??o usando --simulate
app.post('/api/cookie/upload', upload.single('cookie'), async (req, res) => {
    const tempPath = path.join(cookiesDir, 'temp.txt');
    const mainPath = path.join(cookiesDir, 'main.txt');
    const backupPath = path.join(cookiesDir, 'backup.txt');
    
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'Nenhum arquivo enviado' });
        }
        
        console.log('?? Testando cookie enviado...');
        
        const ytCmd = process.platform === 'win32' ? '.\\yt-dlp.exe' : 'yt-dlp';
        const command = `${ytCmd} --cookies "${tempPath}" --simulate "${TEST_LIVE_URL}"`;
        
        try {
            await execPromise(command, { timeout: 30000 });
            console.log('? Cookie v?lido!');
            
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
                backupCreated: backupCreated
            });
            
        } catch (error) {
            console.log('? Cookie inv?lido:', error.message);
            
            let errorMsg = 'Cookie inv?lido';
            if (error.message.includes('Sign in') || error.message.includes('bot')) {
                errorMsg = 'Sign in to confirm you are not a bot';
            } else if (error.message.includes('HTTP Error 403')) {
                errorMsg = 'Acesso negado - cookie expirado';
            }
            
            // Limpar tempor?rio
            if (fs.existsSync(tempPath)) {
                fs.unlinkSync(tempPath);
            }
            
            res.status(400).json({ 
                success: false, 
                message: 'Cookie inv?lido',
                error: errorMsg,
                details: error.message.substring(0, 200)
            });
        }
        
    } catch (error) {
        if (fs.existsSync(tempPath)) {
            fs.unlinkSync(tempPath);
        }
        res.status(500).json({ success: false, message: 'Erro interno' });
    }
});
