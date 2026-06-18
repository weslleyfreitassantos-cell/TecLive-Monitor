// Rotas de gerenciamento de cookie
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

const cookiesDir = path.join(__dirname, 'cookies');
const mainCookiePath = path.join(cookiesDir, 'main.txt');
const backupCookiePath = path.join(cookiesDir, 'backup.txt');
const tempCookiePath = path.join(cookiesDir, 'temp.txt');

// Garantir que pasta cookies existe
if (!fs.existsSync(cookiesDir)) {
    fs.mkdirSync(cookiesDir, { recursive: true });
}

// Configura??o do multer para upload
const storage = multer.diskStorage({
    destination: cookiesDir,
    filename: (req, file, cb) => {
        cb(null, 'temp.txt');
    }
});
const upload = multer({ storage: storage });

// Status do cookie
app.get('/api/cookie/status', (req, res) => {
    const stats = cookieManager ? cookieManager.getStats() : {
        healthy: fs.existsSync(mainCookiePath),
        lastTest: new Date().toISOString(),
        failCount: 0,
        activeCookie: fs.existsSync(mainCookiePath) ? 'main.txt' : 'nenhum',
        lastError: null
    };
    res.json(stats);
});

// Upload e valida??o de cookie
app.post('/api/cookie/upload', upload.single('cookie'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'Nenhum arquivo enviado' });
        }

        // Testar se o cookie ? v?lido com yt-dlp
        const testUrl = 'https://www.youtube.com/watch?v=jNQXAC9IVRw'; // Video de teste
        const ytCmd = process.platform === 'win32' ? '.\\yt-dlp.exe' : 'yt-dlp';
        
        console.log('?? Testando cookie enviado...');
        
        try {
            await execPromise(`${ytCmd} --cookies "${tempCookiePath}" --dry-run "${testUrl}"`, { timeout: 15000 });
            console.log('? Cookie v?lido!');
            
            // Backup do cookie atual
            if (fs.existsSync(mainCookiePath)) {
                fs.copyFileSync(mainCookiePath, backupCookiePath);
                console.log('?? Backup criado: backup.txt');
            }
            
            // Substituir cookie principal
            fs.copyFileSync(tempCookiePath, mainCookiePath);
            console.log('? Cookie principal substitu?do');
            
            // Limpar arquivo tempor?rio
            fs.unlinkSync(tempCookiePath);
            
            res.json({ success: true, message: 'Cookie atualizado com sucesso' });
            
        } catch (error) {
            console.log('? Cookie inv?lido:', error.message);
            fs.unlinkSync(tempCookiePath);
            res.status(400).json({ success: false, error: 'Cookie inv?lido. O YouTube recusou a autentica??o.' });
        }
        
    } catch (error) {
        console.error('Erro no upload:', error);
        res.status(500).json({ success: false, error: 'Erro interno ao processar arquivo' });
    }
});
