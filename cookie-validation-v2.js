// ========== VALIDACAO DE COOKIE OTIMIZADA ==========
const TEST_LIVE_URL = 'https://www.youtube.com/watch?v=8Ic1bW0IK1k';

async function validateCookieComplete(cookiePath) {
    // N?vel 1: Verificar estrutura b?sica
    const content = fs.readFileSync(cookiePath, 'utf8');
    if (content.length < 5000) {
        throw new Error(`Cookie muito pequeno (${content.length} bytes)`);
    }
    if (!content.includes('.youtube.com') && !content.includes('youtube.com')) {
        throw new Error('Cookie nao contem dominios do YouTube');
    }
    console.log('? Nivel 1: Estrutura OK');
    
    const ytCmd = process.platform === 'win32' ? '.\\yt-dlp.exe' : 'yt-dlp';
    
    // N?vel 2: Simulate com live p?blica
    try {
        await execPromise(`${ytCmd} --cookies "${cookiePath}" --simulate "${TEST_LIVE_URL}"`, { timeout: 20000 });
        console.log('? Nivel 2: Simulate OK');
    } catch (error) {
        throw new Error(`Falha na simulacao: ${error.message}`);
    }
    
    // N?vel 3: Extrair URL HLS
    try {
        const { stdout } = await execPromise(`${ytCmd} --cookies "${cookiePath}" -g --format best "${TEST_LIVE_URL}"`, { timeout: 30000 });
        const hlsUrl = stdout.trim();
        if (!hlsUrl.includes('.m3u8') && !hlsUrl.includes('manifest')) {
            throw new Error('Nao retornou URL HLS');
        }
        console.log('? Nivel 3: Extracao HLS OK');
        return { valid: true, hlsUrl: hlsUrl };
    } catch (error) {
        throw new Error(`Falha na extracao HLS: ${error.message}`);
    }
}
