const express = require('express');
const cors = require('cors');

const liveRoute = require('./routes/live');
const monitorRoute = require('./routes/monitor');
const autoRoute = require('./routes/auto');
const neonewsRoute = require('./routes/neonews');

const app = express();

app.use(cors());
app.use(express.json());

app.use('/live', liveRoute);
app.use('/monitor', monitorRoute);
app.use('/auto', autoRoute);
app.use('/neonews', neonewsRoute);

app.listen(3001, () => {
    console.log('API ONLINE NA PORTA 3001');
    console.log('📡 Sistema de monitoramento de lives ativo');
    console.log('🚀 Modo automático: http://localhost:3001/auto/start?url=...');
    console.log('📺 Endpoint NEOnews: http://localhost:3001/neonews/play?url=...');
});