# Gerenciador seguro do yt-dlp no Ubuntu

Estes scripts verificam e atualizam o `yt-dlp` sem substituir cegamente o executavel atual.

## Checar versao

```bash
./scripts/yt-dlp-manager/check-ytdlp-update.sh
```

Saidas:

- `0`: versao instalada igual a versao mais recente detectada.
- `10`: existe atualizacao disponivel.
- outro codigo: erro de ambiente ou rede.

## Simular atualizacao

```bash
./scripts/yt-dlp-manager/update-ytdlp-safe.sh --dry-run
```

## Atualizar com controle manual

Execute somente depois de revisar logs, processos ativos e janela operacional:

```bash
./scripts/yt-dlp-manager/update-ytdlp-safe.sh
```

O script usa `flock`, cria backup para binario standalone, testa `--version`, testa uma lista ordenada de URLs publicas e recarrega o PM2 somente apos sucesso.

Configure a lista em `scripts/yt-dlp-manager/yt-dlp-manager.env`:

```bash
YTDLP_TEST_URLS=https://www.youtube.com/watch?v=jNQXAC9IVRw,https://www.youtube.com/watch?v=dQw4w9WgXcQ,https://www.youtube.com/watch?v=M7lc1UVf-VE
```

`YTDLP_TEST_URL` segue aceito para compatibilidade, mas `YTDLP_TEST_URLS` e a opcao recomendada. URL encerrada, privada, removida ou indisponivel e rejeitada como URL inadequada, nao como falha de cookie.

Nao ha cron ou systemd nesta etapa.
