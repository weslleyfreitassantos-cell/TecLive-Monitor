# Cookie Sync seguro

Este fluxo exporta cookies de perfis Firefox no Windows, valida localmente com `yt-dlp`, envia por SCP para o Ubuntu e promove no servidor somente depois de nova validacao.

Nada aqui automatiza login Google, CAPTCHA ou 2FA. Nunca coloque senha, cookie ou chave SSH no Git.

## Preparacao dos perfis Firefox

Use tres perfis separados:

- `cookie1`: perfil Firefox dedicado ao `cookie1.txt`
- `cookie2`: perfil Firefox dedicado ao `cookie2.txt`
- `cookie3`: perfil Firefox dedicado ao `cookie3.txt`

Faça login manualmente no YouTube em cada perfil. Depois feche todas as janelas do Firefox antes de exportar. O script interrompe se detectar `firefox.exe` aberto e nao encerra processos automaticamente.

## Configuracao local

Copie:

```powershell
Copy-Item .\tools\cookie-sync\cookie-sync.config.example.json .\tools\cookie-sync\cookie-sync.config.json
```

Edite `cookie-sync.config.json` com os caminhos dos perfis Firefox. Esse arquivo esta no `.gitignore` e nao deve ser versionado.

Em `validation.testUrls`, mantenha uma lista ordenada de URLs publicas estaveis. O script testa uma por vez ate obter sucesso. `validation.testUrl` ainda e aceito para configuracoes antigas, mas a forma recomendada e:

```json
"validation": {
  "testUrls": [
    "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com/watch?v=M7lc1UVf-VE"
  ]
}
```

URLs encerradas, privadas, removidas ou indisponiveis sao tratadas como inadequadas para validacao e nao como falha de cookie. Erros de rede e timeout tambem nao indicam cookie invalido.

## SSH com chave

Configure chave SSH no Windows e teste manualmente antes de usar o envio real:

```powershell
ssh -p 22 root@177.153.62.32
```

Nao coloque senha no script. Use chave SSH protegida.

## Teste local sem upload

Cookie 1:

```powershell
.\tools\cookie-sync\export-and-upload.ps1 -Cookie cookie1 -DryRun
```

Todos:

```powershell
.\tools\cookie-sync\export-and-upload.ps1 -All -DryRun
```

`-DryRun` e `-SkipUpload` exportam, validam e limpam temporarios sem SCP/SSH.

## Enviar cookies

Depois de instalar os scripts no Ubuntu e revisar o DryRun:

```powershell
.\tools\cookie-sync\export-and-upload.ps1 -Cookie cookie1
.\tools\cookie-sync\export-and-upload.ps1 -All
```

O upload vai para `/var/www/livemonitor/cookies/incoming/` com nome aleatorio e timestamp. O servidor valida e promove.

## Instalar scripts no Ubuntu

No servidor:

```bash
cd /var/www/livemonitor
chmod +x scripts/cookie-sync/install-server.sh
./scripts/cookie-sync/install-server.sh
```

O instalador nao altera firewall, SSH, Nginx, cron, systemd ou PM2 atual.

## Logs

Servidor:

```bash
tail -n 100 /var/www/livemonitor/logs/cookie-sync/cookie-sync.log
```

Os logs nao exibem conteudo dos cookies.

## Rollback manual de cookie

Os backups ficam em:

```bash
/var/www/livemonitor/cookies/archive/
```

Para restaurar manualmente:

```bash
cp -p /var/www/livemonitor/cookies/archive/cookie1.txt.TIMESTAMP.bak /var/www/livemonitor/cookies/cookie1.txt
chmod 600 /var/www/livemonitor/cookies/cookie1.txt
pm2 reload youtube-monitor-v3 --update-env
```

## yt-dlp

Checar versao no Windows:

```powershell
.\tools\yt-dlp-manager\check-ytdlp-update.ps1
```

Simular atualizacao no Windows:

```powershell
.\tools\yt-dlp-manager\update-ytdlp-safe.ps1 -DryRun
```

Checar no Ubuntu:

```bash
./scripts/yt-dlp-manager/check-ytdlp-update.sh
```

Simular no Ubuntu:

```bash
./scripts/yt-dlp-manager/update-ytdlp-safe.sh --dry-run
```

Atualizacao automatica deve ser checagem por padrao. Recomenda-se checagem diaria de versao e atualizacao manual ou semanal controlada. Nunca atualize no meio de uma captura critica.

## Remover a solucao

Remova estes diretorios depois de parar qualquer uso:

```bash
rm -rf scripts/cookie-sync scripts/yt-dlp-manager scripts/health/check-environment.sh logs/cookie-sync logs/yt-dlp-manager
```

No Windows, remova `tools/cookie-sync` e `tools/yt-dlp-manager`.

## Agendamentos futuros

Esta entrega nao configura Task Scheduler, cron ou systemd. Futuramente, agende apenas checagens por padrao:

- Task Scheduler no Windows para `check-ytdlp-update.ps1`
- cron/systemd timer no Ubuntu para `check-ytdlp-update.sh`

Sincronizacao e atualizacao real devem continuar exigindo revisao manual.
