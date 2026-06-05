const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

// Caminho para cookies dos usuários
const userCookieDir = path.join(__dirname, '..', 'user-cookies');

async function getM3U8(url, userEmail = null) {
    return new Promise(async (resolve, reject) => {
        let command;
        let cookiePath = null;
        
        console.log(`?? getM3U8 chamado com userEmail: ${userEmail || 'null'}`);
        
        // PRIORIDADE 1: Cookie específico do cliente (pelo email)
        if (userEmail) {
            const safeEmail = userEmail.replace(/[^a-z0-9]/gi, '_');
            const userCookiePath = path.join(userCookieDir, `${safeEmail}.txt`);
            console.log(`?? Procurando cookie em: ${userCookiePath}`);
            
            if (fs.existsSync(userCookiePath)) {
                cookiePath = userCookiePath;
                console.log(`? Usando cookie do cliente: ${userEmail}`);
            } else {
                console.log(`?? Cookie não encontrado para: ${userEmail} em ${userCookiePath}`);
            }
        }
        
        // PRIORIDADE 2: Fallback para cookie técnico usando cookie-manager
        if (!cookiePath) {
            try {
                const cookieManager = require('../cookie-manager');
                const activeCookiePath = cookieManager.getActiveCookiePath();
                if (activeCookiePath && fs.existsSync(activeCookiePath)) {
                    cookiePath = activeCookiePath;
                    console.log(`?? Usando cookie ativo via cookie-manager: ${path.basename(activeCookiePath)}`);
                } else {
                    console.log(`?? Nenhum cookie ativo encontrado pelo cookie-manager`);
                }
            } catch (err) {
                console.log(`?? Erro ao acessar cookie-manager: ${err.message}`);
                // Fallback antigo (caso o cookie-manager falhe)
                const fallbackDir = path.join(__dirname, '..', 'cookies');
                if (fs.existsSync(fallbackDir)) {
                    const fallbackFiles = fs.readdirSync(fallbackDir).filter(f => f.endsWith('.txt'));
                    if (fallbackFiles.length > 0) {
                        cookiePath = path.join(fallbackDir, fallbackFiles[0]);
                        console.log(`?? Fallback: usando ${fallbackFiles[0]}`);
                    }
                }
            }
        }
        
        // PRIORIDADE 3: Último recurso - Firefox local
        if (cookiePath) {
            command = `yt-dlp --cookies "${cookiePath}" -g "${url}"`;
            console.log(`?? Comando com cookie: ${command.substring(0, 100)}...`);
        } else {
            command = `yt-dlp --cookies-from-browser firefox -g "${url}"`;
            console.log(`?? Usando Firefox local (fallback final)`);
        }
        
        exec(command, { windowsHide: true }, (error, stdout, stderr) => {
            if (error) {
                console.error('? Erro:', stderr);
                reject(error);
                return;
            }
            const m3u8Url = stdout.trim();
            console.log(`? M3U8 obtido com sucesso!`);
            resolve(m3u8Url);
        });
    });
}

module.exports = { getM3U8 };