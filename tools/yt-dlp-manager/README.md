# Gerenciador seguro do yt-dlp no Windows

## Checar versao

```powershell
.\tools\yt-dlp-manager\check-ytdlp-update.ps1
```

O script nao altera nada. Ele consulta a ultima versao no repositorio oficial do `yt-dlp`.

## Simular atualizacao

```powershell
.\tools\yt-dlp-manager\update-ytdlp-safe.ps1 -DryRun
```

## Atualizar manualmente

```powershell
.\tools\yt-dlp-manager\update-ytdlp-safe.ps1 -ConfirmUpdate
```

O script recusa executar se houver processo `yt-dlp` ativo, salvo com `-Force`. Depois da atualizacao, ele testa `yt-dlp --version` e roda o Cookie Sync em `-DryRun` apenas para `cookie1`.

Nenhum upload e feito por este gerenciador.
