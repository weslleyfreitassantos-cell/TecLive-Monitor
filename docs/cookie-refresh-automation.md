# Automacao segura de atualizacao de cookies

Esta automacao cria uma fila no servidor quando `cookie1`, `cookie2` ou `cookie3` fica realmente `invalid`. Um agente PowerShell no Windows consulta a fila por HTTPS, executa o Cookie Sync existente e informa o resultado.

O agente Windows nao expõe porta. Ele apenas inicia conexoes de saida para o servidor.

## 1. Gerar token

Gere um token forte manualmente em uma maquina confiavel:

```powershell
[Convert]::ToBase64String((1..48 | ForEach-Object { Get-Random -Maximum 256 }))
```

Nao versionar esse valor.

## 2. Configurar `.env` do servidor

No Ubuntu, adicione:

```bash
COOKIE_AGENT_TOKEN=COLOQUE_O_TOKEN_AQUI
COOKIE_REFRESH_LEASE_MS=600000
COOKIE_REFRESH_MAX_ATTEMPTS=3
COOKIE_REFRESH_COOLDOWN_MS=600000
COOKIE_AGENT_OFFLINE_MS=90000
```

Depois recarregue o processo:

```bash
pm2 reload youtube-monitor-v3 --update-env
```

Se `COOKIE_AGENT_TOKEN` nao estiver configurado, a API do agente retorna indisponivel e o dashboard mostra automacao desativada. O monitor continua funcionando.

## 3. Configurar `cookie-agent.config.json`

No Windows:

```powershell
Copy-Item .\tools\cookie-agent\cookie-agent.config.example.json .\tools\cookie-agent\cookie-agent.config.json
```

Edite:

- `server.baseUrl`: URL HTTPS do servidor.
- `server.token`: mesmo token do `.env`.
- `agent.id`: nome unico do computador.
- `paths.projectPath`: caminho local do projeto.

## 4. Testar com `-Once`

```powershell
.\tools\cookie-agent\cookie-sync-agent.ps1 -Once -VerboseOutput
```

O agente faz heartbeat, consulta uma tarefa, executa no maximo uma tarefa e sai.

## 5. Testar com `-DryRun`

```powershell
.\tools\cookie-agent\cookie-sync-agent.ps1 -Once -DryRun -VerboseOutput
```

Em `-DryRun`, o agente nao faz claim, nao executa upload e nao conclui tarefa real.

## 6. Instalar no Agendador de Tarefas

```powershell
.\tools\cookie-agent\install-agent-task.ps1 -Force
```

A tarefa se chama `TecLive Cookie Sync Agent`, inicia no logon do usuario atual e reinicia em caso de falha. O instalador nao inicia automaticamente em testes.

## 7. Iniciar, parar e reiniciar

```powershell
Start-ScheduledTask -TaskName "TecLive Cookie Sync Agent"
Stop-ScheduledTask -TaskName "TecLive Cookie Sync Agent"
Restart-ScheduledTask -TaskName "TecLive Cookie Sync Agent"
```

## 8. Consultar logs

```powershell
Get-Content .\logs\cookie-agent\agent.log -Tail 100
```

Os logs nao incluem token nem conteudo dos cookies.

## 9. Remover

```powershell
.\tools\cookie-agent\uninstall-agent-task.ps1
```

Config e logs nao sao apagados.

## 10. Rotacionar token

1. Gere novo token.
2. Atualize `COOKIE_AGENT_TOKEN` no `.env` do servidor.
3. Rode `pm2 reload youtube-monitor-v3 --update-env`.
4. Atualize `tools/cookie-agent/cookie-agent.config.json`.
5. Reinicie a tarefa do Windows.

## 11. Diagnosticar agente offline

Verifique:

- se o PC esta ligado;
- se nao entrou em suspensao ou hibernacao;
- se a tarefa existe no Agendador;
- se `agent.log` mostra erro de rede, token ou Firefox aberto;
- se `server.baseUrl` usa HTTPS;
- se o token local bate com o token do servidor.

## 12. Se o Google pedir login

A automacao nao resolve login Google, CAPTCHA ou 2FA. Abra o perfil Firefox do cookie afetado, autentique manualmente, feche o Firefox e teste:

```powershell
.\tools\cookie-sync\export-and-upload.ps1 -Cookie cookie2 -DryRun
```

## 13. Manter o PC ligado

Configure energia para impedir suspensao/hibernacao. A tela pode desligar, mas o Windows precisa continuar acordado para o agente rodar.

## 14. Cancelar tarefas no dashboard

No card `AUTOMACAO DE COOKIES`, use `Cancelar tarefa pendente`. Tarefas `running` nao sao canceladas pelo dashboard para evitar interromper uma promocao em andamento.

## 15. Fallback manual

O upload manual antigo permanece funcionando e deve ser mantido como fallback operacional.
