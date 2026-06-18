# 🎥 TecLive-Monitor

Sistema de monitoramento, proxy e distribuição de transmissões ao vivo do YouTube, desenvolvido para ambientes corporativos e displays digitais.

---

## ✨ Funcionalidades

- 📡 **Monitoramento contínuo** de lives com verificação a cada **8 segundos**
- 🔄 **Renovação automática** da URL HLS antes da expiração (preventiva)
- 🚫 **Proxy transparente** sem redirect – compatível com Android/ExoPlayer
- 🗂️ **Cache de playlists m3u8** com TTL de 4 segundos
- 💾 **Persistência em disco** dos monitores ativos (recuperação pós-restart)
- 🍪 **Rotação automática** de cookies para evitar bloqueios
- 📊 **Dashboard administrativo** para gestão de lives e cookies
- 👥 **Contagem de espectadores ativos** por live (IP-based)
- 📧 **Alertas por e-mail** para falhas críticas
- ⚡ **GlobalScheduler** com pool de workers para alto desempenho

---

## 🧰 Tecnologias

- **Node.js** (v18+)
- **Express** – servidor web
- **yt-dlp** – extração de streams do YouTube
- **PM2** – gerenciamento de processos
- **Multer** – upload de cookies
- **Express-session** – autenticação administrativa

---

## 📦 Pré-requisitos

- Node.js 18+ instalado
- yt-dlp instalado no sistema (`apt install yt-dlp` ou `brew install yt-dlp`)
- PM2 (opcional, mas recomendado para produção)

---

## ⚙️ Instalação e Configuração

### 1. Clone o repositório

```bash
git clone https://github.com/weslleyfreitassantos-cell/TecLive-Monitor.git
cd TecLive-Monitor











