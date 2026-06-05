require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');

// Rotas
const liveRoute = require('./routes/live');
const liveSecureRoute = require('./routes/liveSecure');
const monitorRoute = require('./routes/monitor');
const autoRoute = require('./routes/auto');
const neonewsRoute = require('./routes/neonews');
const authRoute = require('./routes/auth');
const adminRoute = require('./routes/admin');
const clientAuthRoute = require('./routes/clientAuth');
const adminClientsRoute = require('./routes/adminClients');
const clientLivesRoute = require('./routes/clientLives');

// Gerenciador de cookie reserva
const cookieManager = require('./cookie-manager');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));
app.use(express.static('public'));

// Rotas
app.use('/auth', authRoute);
app.use('/live', liveRoute);
app.use('/secure/live', liveSecureRoute);
app.use('/monitor', monitorRoute);
app.use('/auto', autoRoute);
app.use('/neonews', neonewsRoute);
app.use('/admin', adminRoute);
app.use('/client', clientAuthRoute);
app.use('/admin', adminClientsRoute);
app.use('/client', clientLivesRoute);

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date(),
        uptime: process.uptime(),
        version: '2.0.0'
    });
});

// Status dos cookies (principal e reserva)
app.get('/api/cookie/status', (req, res) => {
    const status = cookieManager.getStatus();
    res.json(status);
});

// Forçar verificação de cookies
app.post('/api/cookie/check', async (req, res) => {
    const result = await cookieManager.checkAndFallback();
    res.json(result);
});

// Dashboard do cliente (antigo - público)
app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Admin login page
app.get('/admin-login.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin-login.html'));
});

// Admin dashboard page
app.get('/admin-dashboard.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin-dashboard.html'));
});

// Client login page
app.get('/client-login.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'client-login.html'));
});

// Client dashboard page
app.get('/client-dashboard.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'client-dashboard.html'));
});

// Página de status dos cookies
app.get('/cookie-status', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'cookie-status.html'));
});

// Página inicial
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>YouTube Live Monitor</title>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
                body { font-family: Arial, sans-serif; text-align: center; padding: 50px; margin: 0; }
                .menu { display: flex; justify-content: center; flex-wrap: wrap; gap: 15px; margin-top: 30px; }
                .btn { padding: 12px 24px; background: #007bff; color: white; text-decoration: none; border-radius: 8px; display: inline-block; }
                .btn:hover { background: #0056b3; }
                .btn-outline { background: #6c757d; }
                .btn-outline:hover { background: #5a6268; }
                @media (max-width: 600px) {
                    body { padding: 20px; }
                    .btn { padding: 10px 20px; font-size: 14px; }
                }
            </style>
        </head>
        <body>
            <h1>🎥 YouTube Live Monitor</h1>
            <p>Sistema profissional de monitoramento de lives</p>
            <div class="menu">
                <a href="/client-login.html" class="btn">👤 Área do Cliente</a>
                <a href="/admin-login.html" class="btn">🔐 Admin</a>
                <a href="/cookie-status" class="btn btn-outline">🍪 Status dos Cookies</a>
                <a href="/health" class="btn btn-outline">📊 Health Check</a>
            </div>
        </body>
        </html>
    `);
});

// Rota para obter dados do usuário logado (antigo OAuth2)
app.get('/auth/me', async (req, res) => {
    res.json({ 
        email: 'usuario@exemplo.com', 
        name: 'Usuário Demo',
        picture: null
    });
});

// Rota de logout
app.get('/auth/logout', (req, res) => {
    res.redirect('/auth/login');
});

// Monitor de cookie técnico
const { startCookieMonitoring } = require('./services/cookieMonitor');
startCookieMonitoring();

// Verificação periódica do cookie reserva (a cada 5 minutos)
setInterval(async () => {
    console.log('🔄 Verificando saúde dos cookies...');
    const result = await cookieManager.checkAndFallback();
    
    if (result.fallbackActivated) {
        console.log('⚠️⚠️⚠️ Cookie reserva foi ativado! ⚠️⚠️⚠️');
    }
    
    if (result.critical) {
        console.error('🔴🔴🔴 AMBOS OS COOKIES FALHARAM! 🔴🔴🔴');
    }
}, 5 * 60 * 1000); // 5 minutos

// Verificação inicial ao iniciar
(async () => {
    console.log('🔄 Verificando cookies na inicialização...');
    await cookieManager.checkAndFallback();
    console.log('✅ Sistema de cookies inicializado');
})();

// Iniciar backup automático em produção
if (process.env.NODE_ENV === 'production') {
    try {
        require('./scripts/backup');
        console.log('📀 Sistema de backup ativado');
    } catch (error) {
        console.error('⚠️ Erro ao iniciar backup:', error.message);
    }
}

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
    console.log(`🚀 API V2 ONLINE NA PORTA ${PORT}`);
    console.log(`👤 Cliente: http://localhost:${PORT}/client-login.html`);
    console.log(`🔐 Admin: http://localhost:${PORT}/admin-login.html`);
    console.log(`🍪 Status Cookies: http://localhost:${PORT}/cookie-status`);
    console.log(`🔒 Link Protegido: http://localhost:${PORT}/secure/live/{id}.m3u8`);
    console.log(`📺 NEOnews: http://localhost:${PORT}/neonews/neonews.m3u8?url=...`);
});

module.exports = app;