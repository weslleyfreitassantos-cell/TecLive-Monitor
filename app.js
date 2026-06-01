const express = require('express');
const cors = require('cors');
const path = require('path'); // ADICIONADO

const liveRoute = require('./routes/live');
const monitorRoute = require('./routes/monitor');
const autoRoute = require('./routes/auto');
const neonewsRoute = require('./routes/neonews');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname)); // ADICIONADO - serve arquivos estáticos (HTML, CSS, etc.)

app.use('/live', liveRoute);
app.use('/monitor', monitorRoute);
app.use('/auto', autoRoute);
app.use('/neonews', neonewsRoute);

// Iniciar monitoramento automático
try {
    require('./auto-start');
} catch (error) {
    console.error('Erro ao iniciar auto-start:', error.message);
}

app.listen(3001, () => {
    console.log('API ONLINE NA PORTA 3001');
    console.log('📡 Sistema de monitoramento de lives ativo');
    console.log('🚀 Modo automático: http://localhost:3001/auto/start?url=...');
    console.log('📺 Endpoint NEOnews: http://localhost:3001/neonews/play?url=...');
    console.log('🌐 Player HTML: http://localhost:3001/player.html?live=ID_DA_LIVE'); // ADICIONADO
});