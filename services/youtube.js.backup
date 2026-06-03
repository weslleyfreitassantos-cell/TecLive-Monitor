const { exec } = require('child_process');

function getM3U8(url) {
    return new Promise((resolve, reject) => {
        // --- ALTERADO PARA USAR FIREFOX ---
        const command = `yt-dlp.exe --cookies-from-browser firefox -g "${url}"`;
        
        console.log('🔑 Usando cookies do Firefox...');
        
        exec(command, (error, stdout, stderr) => {
            if (error) {
                console.error('❌ Erro:', stderr);
                reject(error);
                return;
            }
            console.log('✅ M3U8 obtido!');
            resolve(stdout.trim());
        });
    });
}

module.exports = { getM3U8 };