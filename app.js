require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');

// Rotas
const liveRoute = require('./routes/live');
const monitorRoute = require('./routes/monitor');
const autoRoute = require('./routes/auto');
const neonewsRoute = require('./routes/neonews');
const authRoute = require('./routes/auth');
const adminRoute = require('./routes/admin');  // NOVA ROTA ADMIN

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));
app.use(express.static('public'));

// Rotas
app.use('/auth', authRoute);
app.use('/live', liveRoute);
app.use('/monitor', monitorRoute);
app.use('/auto', autoRoute);
app.use('/neonews', neonewsRoute);
app.use('/admin', adminRoute);  // NOVA ROTA ADMIN

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date(),
        uptime: process.uptime(),
        version: '2.0.0'
    });
});

// Dashboard do cliente
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

// Página inicial
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>YouTube Live Monitor V2</title>
            <style>
                body { font-family: Arial; text-align: center; padding: 50px; }
                .menu { display: flex; justify-content: center; gap: 20px; margin-top: 30px; }
                .btn { padding: 10px 20px; background: #007bff; color: white; text-decoration: none; border-radius: 5px; }
                .btn:hover { background: #0056b3; }
            </style>
        </head>
        <body>
            <h1>🎥 YouTube Live Monitor V2</h1>
            <p>Monitoramento de lives com autenticação OAuth2</p>
            <div class="menu">
                <a href="/dashboard" class="btn">📊 Dashboard Cliente</a>
                <a href="/admin-login.html" class="btn">🔐 Admin</a>
                <a href="/health" class="btn">📊 Health Check</a>
                <a href="/monitor/lives" class="btn">📡 Lives Ativas</a>
            </div>
        </body>
        </html>
    `);
});

// Rota para obter dados do usuário logado
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

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
    console.log(`🚀 API V2 ONLINE NA PORTA ${PORT}`);
    console.log(`🔐 Auth: http://localhost:${PORT}/auth/login`);
    console.log(`📊 Dashboard: http://localhost:${PORT}/dashboard`);
    console.log(`🔐 Admin: http://localhost:${PORT}/admin-login.html`);
    console.log(`📺 NEOnews: http://localhost:${PORT}/neonews/neonews.m3u8?user=email&url=URL`);
    console.log(`🎬 Live Limpa: http://localhost:${PORT}/live/1.m3u8`);
});

module.exports = app;