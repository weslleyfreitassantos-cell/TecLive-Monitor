const express = require('express');
const router = express.Router();
const db = require('../database/schema');
const liveMonitor = require('../services/liveMonitor');
const liveRegistry = require('../services/liveRegistry');
const { getCookieStatus } = require('../services/cookieMonitor');
const os = require('os');
const crypto = require('crypto');
const multer = require('multer');
const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');

const upload = multer({ storage: multer.memoryStorage() });

// Middleware de autenticação
async function adminAuth(req, res, next) {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Não autorizado' });
    
    db.get('SELECT * FROM admin_sessions WHERE token = ? AND expires_at > ?', 
        [token, new Date().toISOString()], 
        (err, row) => {
            if (err || !row) return res.status(401).json({ error: 'Não autorizado' });
            next();
        }
    );
}

// Login
router.post('/login', (req, res) => {
    const { password } = req.body;
    if (password !== process.env.ADMIN_PASSWORD) {
        return res.status(401).json({ success: false });
    }
    
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 3600000);
    
    db.run('INSERT INTO admin_sessions (token, expires_at) VALUES (?, ?)',
        [token, expiresAt.toISOString()],
        (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, token });
        }
    );
});

// Status do sistema
router.get('/system-status', adminAuth, (req, res) => {
    const memUsage = process.memoryUsage();
    res.json({
        memory: {
            rss: Math.round(memUsage.rss / 1024 / 1024),
            heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024)
        },
        cpu: { loadAvg1: os.loadavg()[0] },
        uptime: process.uptime()
    });
});

// Status do cookie (MODIFICADO: usando cookie-manager)
router.get('/cookie-status', adminAuth, (req, res) => {
    try {
        const cookieManager = require('../cookie-manager');
        const status = cookieManager.getStatus();
        
        // Formata para o dashboard
        let dashboardStatus = 'unknown';
        let consecutiveFailures = 0;
        let lastSuccess = null;
        
        if (status.active === 'main') {
            dashboardStatus = status.main.valid ? 'healthy' : 'critical';
            consecutiveFailures = status.main.failCount;
            lastSuccess = status.main.lastTest;
        } else {
            dashboardStatus = status.backup.valid ? 'healthy' : 'critical';
            consecutiveFailures = status.backup.failCount;
            lastSuccess = status.backup.lastTest;
        }
        
        res.json({
            status: dashboardStatus,
            consecutiveFailures: consecutiveFailures,
            lastSuccess: lastSuccess,
            active: status.active,
            main: status.main,
            backup: status.backup
        });
    } catch (error) {
        console.error('Erro ao obter status do cookie:', error);
        res.json({
            status: 'unknown',
            consecutiveFailures: 0,
            lastSuccess: null,
            error: error.message
        });
    }
});

// Saúde das lives
router.get('/lives-health', adminAuth, (req, res) => {
    const health = liveMonitor.getAllLivesHealth?.() || [];
    res.json({ total: health.length, lives: health });
});

// Upload de cookie
router.post('/upload-cookie', adminAuth, upload.single('cookie'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo' });
        
        const content = req.file.buffer.toString('utf-8');
        if (!content.includes('.youtube.com')) {
            return res.status(400).json({ error: 'Cookies do YouTube não encontrados' });
        }
        
        const tempPath = path.join(__dirname, '..', 'cookies', '_temp.txt');
        const finalPath = path.join(__dirname, '..', 'cookies', 'tecnico.txt');
        
        await fs.writeFile(tempPath, content);
        
        // Testar o cookie (MODIFICADO: adicionado windowsHide: true)
        const isValid = await new Promise((resolve) => {
            exec(`yt-dlp --cookies "${tempPath}" -g "https://www.youtube.com/watch?v=dGiMBVU3j8s" --simulate`, 
                { timeout: 15000, windowsHide: true }, (error) => resolve(!error));
        });
        
        if (!isValid) {
            await fs.unlink(tempPath);
            return res.status(400).json({ error: 'Cookie inválido' });
        }
        
        await fs.rename(tempPath, finalPath);
        
        // Após upload, atualiza o cookie-manager com o novo cookie
        try {
            const cookieManager = require('../cookie-manager');
            const newCookieContent = await fs.readFile(finalPath, 'utf-8');
            await cookieManager.updateMainCookie(newCookieContent, req.headers['x-admin-name'] || 'Admin');
        } catch (cmError) {
            console.error('Erro ao atualizar cookie-manager:', cmError);
        }
        
        res.json({ success: true, message: 'Cookie atualizado' });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Estatísticas de clientes por live
router.get('/live-stats', adminAuth, (req, res) => {
    db.all(`
        SELECT ls.id, ls.title, ls.youtube_id, COUNT(uls.user_id) as client_count
        FROM live_sources ls
        LEFT JOIN user_live_subscriptions uls ON uls.live_source_id = ls.id
        GROUP BY ls.id
        ORDER BY client_count DESC
    `, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ lives: rows || [] });
    });
});

module.exports = router;