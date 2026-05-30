# YouTube Live Monitor API

API para monitorar e extrair links M3U8 de lives do YouTube em tempo real. Ideal para integração com NEOnews Player e outros sistemas de Digital Signage.

 Funcionalidades

-  **Extrai link M3U8** de qualquer live do YouTube
-  **Monitora mudanças** em tempo real (links expiram a cada 5-10 segundos)
-  **Endpoint fixo** para NEOnews (nunca precisa reconfigurar)
-  **Cache inteligente** de 30 minutos
-  **Múltiplas lives** simultâneas
-  **Rate limiting** e validação de URL
-  **Logs estruturados** com Winston
-  **Autenticação OAuth2** (não precisa de cookies manuais)

##  Pré-requisitos

- Node.js 18+ (https://nodejs.org)
- npm ou yarn
- Conta Google (para autenticação)

## 📦 Instalação

```bash
git clone https://github.com/weslleyfreitassantos-cell/youtube-live-monitor.git
cd youtube-live-monitor
npm install