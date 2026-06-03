const express = require('express');
const router = express.Router();
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const oauth = require('../services/oauth');

// Configurar multer para upload de arquivos (em memória)
const storage = multer.memoryStorage();
const upload = multer({ storage: storage, limits: { fileSize: 1024 * 1024 } }); // Max 1MB

// Criar pastas se não existirem
const userCookieDir = path.join(__dirname, '..', 'user-cookies');
if (!fs.existsSync(userCookieDir)) {
    fs.mkdirSync(userCookieDir, { recursive: true });
}

// Função auxiliar para pegar email do usuário atual
async function getCurrentUserEmail(req) {
    try {
        // Opção 1: Do header (passado pelo frontend)
        const headerEmail = req.headers['x-user-email'];
        if (headerEmail) return headerEmail;
        
        // Opção 2: Do corpo da requisição
        if (req.body && req.body.user) return req.body.user;
        
        // Opção 3: Do query string
        if (req.query && req.query.user) return req.query.user;
        
        // Opção 4: Buscar o primeiro usuário do banco (fallback)
        const users = await oauth.getAllUsers();
        if (users && users.length > 0) {
            return users[0].email;
        }
        
        return null;
    } catch (error) {
        console.error('Erro ao obter email do usuário:', error);
        return null;
    }
}

// ========================================
// ROTAS DE COOKIE
// ========================================

// Rota para upload de cookies (COM LOGS)
router.post('/upload-cookies', upload.single('cookies'), async (req, res) => {
    try {
        console.log('🔍 Upload de cookies iniciado');
        console.log('📋 Headers:', req.headers);
        console.log('📋 Body:', req.body);
        console.log('📋 File:', req.file ? 'Arquivo recebido' : 'Nenhum arquivo');
        
        const userEmail = await getCurrentUserEmail(req);
        console.log(`👤 Email do usuário: ${userEmail}`);
        
        if (!userEmail) {
            console.log('❌ Erro: Usuário não autenticado');
            return res.status(401).json({ error: 'Usuário não autenticado' });
        }
        
        if (!req.file) {
            console.log('❌ Erro: Nenhum arquivo enviado');
            return res.status(400).json({ error: 'Nenhum arquivo enviado' });
        }
        
        const cookieContent = req.file.buffer.toString('utf-8');
        console.log(`📄 Tamanho do cookie: ${cookieContent.length} bytes`);
        console.log(`📄 Primeiros 100 caracteres: ${cookieContent.substring(0, 100)}`);
        
        // Validar formato do cookie
        if (!cookieContent.includes('# Netscape HTTP Cookie File') && 
            !cookieContent.includes('# HTTP Cookie File')) {
            console.log('❌ Erro: Formato de cookie inválido');
            return res.status(400).json({ error: 'Arquivo de cookie inválido. Use a extensão "Get cookies.txt LOCALLY".' });
        }
        
        // Validar se tem cookies do YouTube
        if (!cookieContent.includes('.youtube.com')) {
            console.log('❌ Erro: Nenhum cookie do YouTube encontrado');
            return res.status(400).json({ error: 'Arquivo não contém cookies do YouTube. Faça login no YouTube antes de exportar.' });
        }
        
        const safeEmail = userEmail.replace(/[^a-z0-9]/gi, '_');
        const cookiePath = path.join(userCookieDir, `${safeEmail}.txt`);
        fs.writeFileSync(cookiePath, cookieContent);
        
        console.log(`🍪 Cookies salvos para: ${userEmail} em ${cookiePath}`);
        res.json({ success: true, message: 'Cookies salvos com sucesso' });
        
    } catch (error) {
        console.error('❌ Erro no upload:', error);
        res.status(500).json({ error: error.message });
    }
});

// Rota para verificar status dos cookies
router.get('/cookie-status', async (req, res) => {
    try {
        const userEmail = await getCurrentUserEmail(req);
        if (!userEmail) {
            return res.json({ hasCookie: false });
        }
        
        const safeEmail = userEmail.replace(/[^a-z0-9]/gi, '_');
        const cookiePath = path.join(userCookieDir, `${safeEmail}.txt`);
        const hasCookie = fs.existsSync(cookiePath);
        
        let isValid = hasCookie;
        if (hasCookie) {
            const stats = fs.statSync(cookiePath);
            const daysOld = (Date.now() - stats.mtime) / (1000 * 60 * 60 * 24);
            if (daysOld > 30) {
                console.log(`⚠️ Cookie de ${userEmail} tem ${Math.floor(daysOld)} dias - pode estar expirado`);
            }
        }
        
        res.json({ hasCookie: isValid });
    } catch (error) {
        console.error('Erro ao verificar cookies:', error);
        res.json({ hasCookie: false });
    }
});

// Rota para deletar cookies
router.delete('/delete-cookies', async (req, res) => {
    try {
        const userEmail = await getCurrentUserEmail(req);
        if (!userEmail) {
            return res.status(401).json({ error: 'Usuário não autenticado' });
        }
        
        const safeEmail = userEmail.replace(/[^a-z0-9]/gi, '_');
        const cookiePath = path.join(userCookieDir, `${safeEmail}.txt`);
        
        if (fs.existsSync(cookiePath)) {
            fs.unlinkSync(cookiePath);
            console.log(`🍪 Cookies removidos para: ${userEmail}`);
        }
        
        res.json({ success: true, message: 'Cookies removidos' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ========================================
// ROTAS DE AUTENTICAÇÃO
// ========================================

// Página de login
router.get('/login', (req, res) => {
    const authUrl = oauth.getAuthUrl();
    res.send(`
        <!DOCTYPE html>
        <html lang="pt-BR">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Login - YouTube Live Monitor</title>
            <style>
                * { margin: 0; padding: 0; box-sizing: border-box; }
                body {
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    min-height: 100vh;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    padding: 20px;
                }
                .login-card {
                    background: white;
                    border-radius: 28px;
                    padding: 40px 32px;
                    max-width: 450px;
                    width: 100%;
                    text-align: center;
                    box-shadow: 0 25px 50px -12px rgba(0,0,0,0.25);
                }
                .logo h1 { font-size: 28px; color: #333; margin-bottom: 10px; }
                .subtitle { color: #666; margin-bottom: 30px; }
                .btn-google {
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    gap: 12px;
                    background: #fff;
                    border: 1px solid #e0e0e0;
                    color: #333;
                    padding: 14px 28px;
                    border-radius: 50px;
                    font-size: 16px;
                    font-weight: 500;
                    text-decoration: none;
                    width: 100%;
                }
                .btn-google:hover {
                    background: #f8f9fa;
                    transform: translateY(-2px);
                    box-shadow: 0 5px 15px rgba(0,0,0,0.1);
                }
                .footer { margin-top: 24px; font-size: 12px; color: #aaa; }
            </style>
        </head>
        <body>
            <div class="login-card">
                <div class="logo">
                    <h1>🎥 YouTube Live Monitor</h1>
                </div>
                <div class="subtitle">Conecte sua conta Google para começar</div>
                <a href="${authUrl}" class="btn-google">🔑 Conectar com Google</a>
                <div class="footer">Versão 2.0 - Copa 2026</div>
            </div>
        </body>
        </html>
    `);
});

// Callback após autorização OAuth2
router.get('/callback', async (req, res) => {
    const { code } = req.query;
    
    try {
        const tokens = await oauth.getTokens(code);
        const refreshToken = tokens.refresh_token;
        
        const oauth2Client = oauth.oauth2Client;
        oauth2Client.setCredentials(tokens);
        
        const { google } = require('googleapis');
        const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
        const userInfo = await oauth2.userinfo.get();
        
        await oauth.saveUserTokens(userInfo.data.email, refreshToken);
        
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <meta http-equiv="refresh" content="3;url=/dashboard">
                <title>Sucesso - YouTube Live Monitor</title>
                <style>
                    body {
                        font-family: Arial, sans-serif;
                        text-align: center;
                        padding: 50px;
                        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                        min-height: 100vh;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                    }
                    .container {
                        background: white;
                        padding: 40px;
                        border-radius: 20px;
                        max-width: 500px;
                    }
                    h1 { color: #28a745; }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>✅ Conta conectada com sucesso!</h1>
                    <p><strong>Email:</strong> ${userInfo.data.email}</p>
                    <p>Redirecionando para o dashboard...</p>
                </div>
            </body>
            </html>
        `);
        
    } catch (error) {
        console.error('Erro no callback:', error);
        res.status(500).send(`
            <html>
            <body style="font-family: Arial; text-align: center; padding: 50px;">
                <h1>❌ Erro na autenticação</h1>
                <p>${error.message}</p>
                <a href="/auth/login">Tentar novamente</a>
            </body>
            </html>
        `);
    }
});

// Rota para obter dados do usuário atual
router.get('/me', async (req, res) => {
    try {
        const userEmail = await getCurrentUserEmail(req);
        
        if (userEmail) {
            return res.json({ 
                email: userEmail, 
                name: userEmail.split('@')[0],
                picture: null,
                authenticated: true
            });
        }
        
        const users = await oauth.getAllUsers();
        if (users && users.length > 0) {
            return res.json({ 
                email: users[0].email, 
                name: users[0].email.split('@')[0],
                picture: null,
                authenticated: true
            });
        }
        
        res.json({ email: null, authenticated: false });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Listar usuários conectados
router.get('/users', async (req, res) => {
    try {
        const users = await oauth.getAllUsers();
        res.json({ total: users.length, users });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;