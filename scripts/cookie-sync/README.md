# Cookie Sync no Ubuntu

Scripts usados pelo envio seguro a partir do Windows.

## Instalar

```bash
cd /var/www/livemonitor
chmod +x scripts/cookie-sync/install-server.sh
./scripts/cookie-sync/install-server.sh
```

O instalador apenas verifica dependencias, cria diretorios e ajusta permissoes. Ele nao instala pacotes, nao altera firewall, SSH, Nginx, PM2, cron ou systemd.

## Promocao

O script abaixo e chamado via SSH pelo Windows depois do SCP:

```bash
scripts/cookie-sync/validate-and-promote-cookie.sh cookie1.txt /var/www/livemonitor/cookies/incoming/arquivo.txt
```

Ele valida o arquivo recebido, cria backup do cookie atual, promove atomicamente, testa novamente e atualiza o `cookieStatus.json` para `valid` com `failCount=0`. Por padrao ele nao recarrega PM2; o app le o arquivo do cookie nas proximas extracoes e evita reinicios em lote.

Se for realmente necessario recarregar o processo apos cada cookie, habilite explicitamente:

```bash
COOKIE_SYNC_RELOAD_PM2=1
```

## URLs de teste

Configure `COOKIE_SYNC_TEST_URLS` em `scripts/cookie-sync/cookie-sync.env` com uma lista separada por virgula. O legado `COOKIE_SYNC_TEST_URL` ainda funciona, mas a lista permite fallback quando uma URL publica fica encerrada, privada, removida ou indisponivel.

```bash
COOKIE_SYNC_TEST_URLS=https://www.youtube.com/watch?v=jNQXAC9IVRw,https://www.youtube.com/watch?v=dQw4w9WgXcQ,https://www.youtube.com/watch?v=M7lc1UVf-VE
```

O validador tenta uma URL por vez. URL inadequada, erro de rede ou timeout nao sao tratados como falha de cookie.

## Rollback

Rollback automatico ocorre se o teste final ou `cookieStatus.json` falharem. Se `COOKIE_SYNC_RELOAD_PM2=1`, falha de PM2 tambem dispara rollback. Backups ficam em:

```bash
/var/www/livemonitor/cookies/archive/
```

Logs:

```bash
/var/www/livemonitor/logs/cookie-sync/cookie-sync.log
```

O conteudo dos cookies nunca deve aparecer nos logs.
