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

Para instalar, iniciar e validar:

```powershell
.\tools\cookie-agent\install-agent-task.ps1 -Force -StartAfterInstall -ValidateAfterStart
```

A validacao exige tarefa `Running`, processo `cookie-sync-agent.ps1` e heartbeat recente no arquivo local `tools/cookie-agent/agent-runtime-state.json`.

## 6.1. Health check local

```powershell
.\tools\cookie-agent\get-agent-health.ps1 -Human
.\tools\cookie-agent\get-agent-health.ps1 -Json
```

Campos principais:

- `taskState`: `Running`, `Ready`, `Queued`, `Disabled` ou `Missing`.
- `lastTaskResult`: decimal e hexadecimal.
- `processFound`: confirma processo real do agente pelo `CommandLine`.
- `heartbeatAgeSeconds`: idade do ultimo heartbeat local.
- `queueCheckAgeSeconds`: idade da ultima consulta de fila.
- `recommendedAction`: `none`, `start-task`, `stop-start`, `recreate-task`, `observe` ou `cleanup-state`.

Interpretação comum:

- `267009 / 0x41301`: tarefa em execucao.
- `3221225786 / 0xC000013A`: processo interrompido, frequentemente por encerramento de sessao/console.
- `Ready`: tarefa pronta, mas nao necessariamente com agente rodando.
- `Queued`: tarefa enfileirada; se ficar assim sem processo/heartbeat, o watchdog deve recuperar.
- `Running`: saudavel apenas quando ha processo e heartbeat recente.

## 6.2. Watchdog

O agente consulta a fila e executa Cookie Sync. O watchdog nao roda em loop; ele executa uma checagem, tenta no maximo uma recuperacao e termina.

DryRun:

```powershell
.\tools\cookie-agent\cookie-agent-watchdog.ps1 -DryRun -VerboseOutput
```

Instalar:

```powershell
.\tools\cookie-agent\install-watchdog-task.ps1 -Force
```

Remover:

```powershell
.\tools\cookie-agent\uninstall-watchdog-task.ps1
```

A tarefa `TecLive Cookie Sync Watchdog` roda no logon e a cada 5 minutos. Ela usa `RunLevel Limited` por padrao; `Highest` so com `-RunAsAdmin`. A recuperacao tenta Stop/Start antes de recriar a tarefa principal. A recriacao usa `install-agent-task.ps1`, preserva `RunAsAdmin`, `WakeToRun`, `TaskName` e `ConfigPath` quando possivel, e aplica cooldown para evitar loops.

Logs:

```powershell
Get-Content .\logs\cookie-agent\watchdog.log -Tail 100
```

Codigos de saida do watchdog:

- `0`: saudavel ou inconsistencia sem necessidade segura de acao.
- `10`: recuperacao realizada com sucesso.
- `20`: recuperacao seria necessaria, mas `-DryRun`/`-WhatIf` impediu alteracao.
- `30`: recuperacao falhou ou cooldown bloqueou nova tentativa.
- `40`: config/tarefa invalida ou erro inesperado do watchdog.

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
- se o health local indica processo e heartbeat recentes;
- se o watchdog log registrou recuperacao ou cooldown;
- se `agent.log` mostra erro de rede, token ou Firefox aberto;
- se `server.baseUrl` usa HTTPS;
- se o token local bate com o token do servidor.

Recuperacao manual segura:

```powershell
.\tools\cookie-agent\get-agent-health.ps1 -Human
.\tools\cookie-agent\cookie-agent-watchdog.ps1 -DryRun -VerboseOutput
Stop-ScheduledTask -TaskName "TecLive Cookie Sync Agent"
Start-ScheduledTask -TaskName "TecLive Cookie Sync Agent"
.\tools\cookie-agent\install-agent-task.ps1 -Force -StartAfterInstall -ValidateAfterStart
```

Nao use `taskkill` ou `Stop-Process powershell` generico. O health valida o `CommandLine` para diferenciar o agente de outros processos PowerShell.

## 12. Se o Google pedir login

A automacao nao resolve login Google, CAPTCHA ou 2FA. Abra o perfil Firefox do cookie afetado, autentique manualmente, feche o Firefox e teste:

```powershell
.\tools\cookie-sync\export-and-upload.ps1 -Cookie cookie2 -DryRun
```

## 13. Manter o PC ligado

Configure energia para impedir suspensao/hibernacao. A tela pode desligar, mas o Windows precisa continuar acordado para o agente rodar.

Tela bloqueada funciona. Logoff encerra a sessao interativa. Suspensao/hibernacao interrompe o agente ate o Windows acordar.

O watchdog nao resolve:

- PC desligado;
- logoff sem sessao interativa;
- perfil Firefox deslogado;
- CAPTCHA ou 2FA;
- bloqueios do Google que exigem acao manual.

## 14. Cancelar tarefas no dashboard

No card `AUTOMACAO DE COOKIES`, use `Cancelar tarefa pendente`. Tarefas `running` nao sao canceladas pelo dashboard para evitar interromper uma promocao em andamento.

## 15. Fallback manual

O upload manual antigo permanece funcionando e deve ser mantido como fallback operacional.
