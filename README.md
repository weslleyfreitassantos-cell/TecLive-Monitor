# YouTube Live Monitor API

API para extrair e monitorar links M3U8 de lives do YouTube em tempo real.

## Requisitos

- Node.js 18+
- Firefox (para autenticação)

## Instalação

git clone https://github.com/weslleyfreitassantos-cell/youtube-live-monitor.git
cd youtube-live-monitor
npm install

## Como usar

node app.js

## Endpoints

- GET /live?url=... - Extrai link M3U8
- POST /monitor/start - Inicia monitoramento
- GET /neonews/play?url=... - Link para NEOnews
- GET /health - Status da API