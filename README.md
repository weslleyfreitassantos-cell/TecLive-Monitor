
Estrutura do Projeto

youtube-live-monitor-v2/
├── public/                 # Dashboards (HTML/CSS/JS)
├── routes/                 # API endpoints
├── services/               # Lógica de negócio
├── database/               # SQLite schema
├── cookies/                # Cookie técnico
├── logs/                   # Logs do sistema
├── backups/                # Backups do banco
├── .env                    # Configurações
├── ecosystem.config.js     # PM2 config
└── app.js                  # Servidor principal

🔒 Segurança
Cookie técnico único (não por cliente)

Senha admin configurável via .env

Rate limiting para endpoints públicos

Validação de cookie no upload (teste real com yt-dlp)

📈 Performance
Métrica	Valor
Requisições ao YouTube	1 por live
Memória RAM	~50-100 MB
Escala	Ilimitada

📊 Monitoramento
Status	Cor	Significado	Ação
HEALTHY	🟢	Cookie funcionando	Nada
WARNING	🟡	1-2 falhas	Monitorar
CRITICAL	🔴	3+ falhas	Trocar cookie

**Para o Cliente:**
- Adicione qualquer live do YouTube com apenas a URL
- Receba um link permanente para usar no NEOnews
- Copie o link em um clique
- Visualize thumbnails e títulos das lives

**Para o Administrador:**
- Monitoramento automático do cookie técnico (testes a cada 30min)
- Dashboard admin com status do sistema, CPU, RAM e lives ativas
- Renovação de cookie por upload (sem reiniciar a API)
- Alertas por Email, Discord e Telegram
- Estatísticas de clientes por live

**Tecnicamente:**
- Arquitetura compartilhada (1 monitor por live, não por cliente)
- SQLite para persistência e histórico de eventos
- Rate limiting para proteção contra abusos
- PM2 Ready para produção
