# 🎥 TecLive-Monitor

Sistema de monitoramento, proxy e distribuição de transmissões ao vivo do YouTube, desenvolvido para ambientes corporativos e displays digitais. Ideal para **totens, TV boxes, painéis de sinalização** e qualquer dispositivo que precise exibir lives com alta estabilidade e qualidade adaptativa.

---

## ✨ Funcionalidades

- 📡 **Monitoramento contínuo** de lives com verificação a cada **8–13 segundos**
- 🔄 **Renovação automática** da URL HLS antes da expiração (preventiva) e em caso de falhas
- 🚫 **Proxy transparente** sem redirect – compatível com ExoPlayer/Android e qualquer player HLS
- 🗂️ **Cache de playlists m3u8** com TTL configurável (padrão: 5s) e suporte a conteúdo stale
- 💾 **Persistência em disco** dos monitores ativos (recuperação pós-restart)
- 🍪 **Rotação automática** de cookies (3 arquivos) para evitar bloqueios do YouTube
- 📊 **Dashboard administrativo** com gestão de lives, upload de cookies e visão geral
- 👥 **Contagem de espectadores ativos por live** (baseada em IP único, janela de 30s)
- 📧 **Alertas por e-mail** para falhas críticas (cookie inválido, live encerrada, etc.)
- ⚡ **GlobalScheduler** com pool de workers (6 padrão) para alto desempenho
- 🎯 **Adaptive Bitrate (ABR)** – geração dinâmica de manifesto master com múltiplas qualidades
- 🔢 **Controle de qualidade via URL** (`?max=480`) – ideal para dispositivos com pouca memória ou redes limitadas
- 🌐 **Otimizações de rede**: IPv4 forçado, `maxSockets=50`, keepAlive, timeouts de 30s
- 🧠 **Resiliência**: timeout de renovação de 10s e stale content de até 60s
- 🖥️ **Interface NOC** com filtros, busca, saúde do sistema, linha do tempo e métricas

---

## 🧰 Tecnologias

- **Node.js** (v18+)
- **Express** – servidor web e rotas
- **yt-dlp** – extração e parse de streams do YouTube
- **PM2** – gerenciamento de processos (produção)
- **Multer** – upload de arquivos de cookies
- **Express-session** – autenticação administrativa
- **Tippy.js** – tooltips no dashboard

---

## 📦 Pré-requisitos

- Node.js 18+ instalado
- yt-dlp instalado no sistema:
  ```bash
  # Ubuntu/Debian
  sudo apt install yt-dlp

  # macOS
  brew install yt-dlp

PM2 (opcional, mas recomendado para produção)

⚙️ Instalação e Configuração
1. Clone o repositório
bash
git clone https://github.com/weslleyfreitassantos-cell/TecLive-Monitor.git
cd TecLive-Monitor
2. Instale as dependências
bash
npm install
3. Configure as variáveis de ambiente
Crie um arquivo .env na raiz do projeto com o seguinte conteúdo (ajuste conforme sua necessidade):

env
PORT=3002
BIND_HOST=127.0.0.1
TRUST_PROXY=false
BASE_URL=https://seu-dominio.com   # ou http://localhost:3002

EMAIL_USER=seu-email@gmail.com
EMAIL_PASS=senha-de-app
ADMIN_EMAIL=seu-email@gmail.com

ADMIN_PASSWORD=sua-senha-admin
SESSION_SECRET=um-segredo-grande-e-aleatorio

# ==========================================
# CONFIGURAÇÕES DE QUALIDADE (ABR)
# ==========================================
# Desativa o ABR automático (usamos master artificial)
ADAPTIVE_QUALITY=false

# Qualidade máxima padrão (para quem não usar ?max=)
VIDEO_MAX_HEIGHT=720

# ==========================================
# TIMEOUTS E CACHE
# ==========================================
STALE_MAX_AGE_MS=60000
M3U8_CACHE_TTL=5000

Em produção atrás de Nginx, mantenha o Node escutando apenas em `127.0.0.1:3002`.
Depois de confirmar que a porta 3002 não está exposta diretamente, configure `TRUST_PROXY=loopback`
ou um número/lista restrita de proxies confiáveis. Não use `TRUST_PROXY=true`.

4. Inicie o servidor
Modo desenvolvimento:

bash
node app.js
Modo produção (com PM2):

bash
pm2 start app.js --name youtube-monitor-v3
pm2 save
pm2 startup
🚀 Como usar
1. Converter uma live do YouTube
Acesse http://localhost:3002/converter.html (ou seu domínio), cole a URL do YouTube e clique em "Converter". O sistema gerará um link único como:

text
https://seu-dominio.com/neonews/VIDEO_ID.m3u8
2. Controle de qualidade (ABR + parâmetro ?max)
Sem parâmetro: o servidor gera um manifesto master com todas as qualidades até o valor definido em VIDEO_MAX_HEIGHT (padrão: 720p). O player (ExoPlayer) escolhe a melhor qualidade com base na largura de banda disponível.

Com ?max=XXX: você força o limite máximo de qualidade para aquele dispositivo. Valores válidos: 144, 240, 360, 480, 720, 1080.

url
# Para dispositivos modernos (ABR total)
https://seu-dominio.com/neonews/VIDEO_ID.m3u8

# Para dispositivos antigos ou com pouca memória
https://seu-dominio.com/neonews/VIDEO_ID.m3u8?max=480

# Para testes ou redes muito limitadas
https://seu-dominio.com/neonews/VIDEO_ID.m3u8?max=360
3. Dashboard administrativo
Acesse http://localhost:3002/dashboard (ou seu domínio) e faça login com a senha definida em ADMIN_PASSWORD. No dashboard você pode:

Visualizar todas as lives em execução

Ver o status de saúde de cada monitor

Ver a contagem de espectadores ativos por live

Filtrar e buscar lives

Substituir cookies (caso expirem)

Acompanhar logs e métricas

🧪 Testes e verificação
Teste local
bash
curl -I http://localhost:3002/neonews/VIDEO_ID.m3u8?max=480
Deverá retornar 200 OK e o cabeçalho X-Master: true (se for um master artificial).

Ver logs do servidor
bash
pm2 logs youtube-monitor-v3
# ou, se rodando diretamente
node app.js
🔧 Estrutura de diretórios
text
TecLive-Monitor/
├── app.js                 # Servidor principal (Express + rotas)
├── api/
│   └── convert.js         # Lógica de conversão e monitoramento
├── monitor/
│   └── liveMonitor.js     # Classe LiveMonitor (ciclo de verificação, ABR, etc.)
├── public/
│   ├── dashboard.html     # Interface NOC
│   ├── converter.html     # Página de conversão
│   └── admin-login.html   # Login administrativo
├── alerts/
│   └── emailAlerts.js     # Envio de e-mails de alerta
├── cookies/               # Arquivos de cookie (não versionados)
│   ├── cookie1.txt
│   ├── cookie2.txt
│   └── cookie3.txt
├── .env                   # Configurações sensíveis
├── package.json
└── README.md
🔒 Segurança e recomendações
Nunca versionar os arquivos da pasta cookies/ (já incluídos no .gitignore).

Utilize senhas fortes no .env.

Em produção, use HTTPS (recomendo um proxy reverso com Nginx + Let's Encrypt).

Mantenha o yt-dlp atualizado regularmente.

📌 Problemas comuns e soluções
Problema	Solução
"Invalid URL" ou 500 no m3u8	Certifique-se de que o cookie está válido. Substitua via dashboard.
Player não inicia ou fica em buffering	Verifique se o link está acessível. Teste com curl ou navegador.
Dispositivo antigo com lag	Use ?max=480 ou ?max=360 para limitar a qualidade.
Não consigo acessar o dashboard	Verifique se a sessão está ativa. Use admin-logout e tente novamente.
Servidor não reinicia	Verifique se a porta 3002 está livre. Use pm2 logs para erros.



  

  # Windows (via chocolatey ou manual)
  choco install yt-dlp

## Cookie Sync e URLs de teste

O fluxo seguro de exportacao de cookies fica em `tools/cookie-sync` no Windows e `scripts/cookie-sync` no Ubuntu. A validacao usa `testUrls`, uma lista ordenada de URLs publicas, e ainda aceita `testUrl` legado para compatibilidade.

Antes de fixar uma URL nos exemplos, valide com:

```bash
yt-dlp --simulate --dump-json --flat-playlist --playlist-end 1 URL
```

O validador tenta as URLs em ordem. URL encerrada, privada, removida ou indisponivel e considerada inadequada para validacao; rede e timeout tambem nao invalidam cookies.

## Automacao sob demanda de cookies

A fila segura de atualizacao sob demanda e o agente Windows estao documentados em:

```text
docs/cookie-refresh-automation.md
```

Essa automacao e opcional. Sem `COOKIE_AGENT_TOKEN`, o monitor continua funcionando e o dashboard mostra a automacao como desativada.
