# Agente Windows de Cookie Sync

O agente consulta a API do servidor por HTTPS, reivindica uma tarefa de cookie e executa o `tools/cookie-sync/export-and-upload.ps1` existente. O Windows nao expõe porta; ele apenas faz conexoes de saida.

## Configurar

Copie:

```powershell
Copy-Item .\tools\cookie-agent\cookie-agent.config.example.json .\tools\cookie-agent\cookie-agent.config.json
```

Edite `cookie-agent.config.json` com:

- `server.baseUrl`: URL HTTPS do servidor.
- `server.token`: mesmo valor de `COOKIE_AGENT_TOKEN` no `.env` do servidor.
- `agent.id`: identificador unico do computador.
- `paths.projectPath`: caminho local do projeto.

HTTP e aceito apenas para `localhost` em testes.

## Testar sem upload

```powershell
.\tools\cookie-agent\cookie-sync-agent.ps1 -Once -DryRun -VerboseOutput
```

Em `-DryRun`, o agente envia heartbeat, consulta no maximo uma tarefa e mostra o que faria. Ele nao faz claim, nao executa upload e nao conclui tarefa real.

## Executar uma vez

```powershell
.\tools\cookie-agent\cookie-sync-agent.ps1 -Once
```

Sem `-DryRun`, se houver tarefa, o agente executa o Cookie Sync correspondente, por exemplo `-Cookie cookie2`.

## Instalar no Agendador de Tarefas

```powershell
.\tools\cookie-agent\install-agent-task.ps1 -Force
```

A tarefa criada chama `TecLive Cookie Sync Agent`, inicia no logon do usuario atual, roda oculta e reinicia em falha. O instalador nao inicia a tarefa automaticamente.

Para iniciar e validar depois da instalacao:

```powershell
.\tools\cookie-agent\install-agent-task.ps1 -Force -StartAfterInstall -ValidateAfterStart
```

Essa validacao exige tarefa `Running`, processo real `cookie-sync-agent.ps1` e heartbeat recente no `agent-runtime-state.json`.

Para remover:

```powershell
.\tools\cookie-agent\uninstall-agent-task.ps1
```

## Diagnosticar saude

```powershell
.\tools\cookie-agent\get-agent-health.ps1 -Human
.\tools\cookie-agent\get-agent-health.ps1 -Json
```

Saida humana esperada quando tudo esta bem:

```text
Task: Running
Process: OK pid=1234
Heartbeat: 28s
Queue check: 12s
Last result: 267009 (0x00041301)
Health: OK
```

`267009 / 0x41301` significa tarefa em execucao no Task Scheduler. `3221225786 / 0xC000013A` normalmente indica encerramento/interrupcao da sessao ou do processo PowerShell.

## Watchdog

O agente faz o trabalho continuo. O watchdog apenas executa uma checagem curta, tenta no maximo uma recuperacao segura e termina.

Teste sem alterar nada:

```powershell
.\tools\cookie-agent\cookie-agent-watchdog.ps1 -DryRun -VerboseOutput
```

Instalar a tarefa do watchdog:

```powershell
.\tools\cookie-agent\install-watchdog-task.ps1 -Force
```

Remover:

```powershell
.\tools\cookie-agent\uninstall-watchdog-task.ps1
```

O watchdog roda no logon e a cada 5 minutos. Ele usa `RunLevel Limited` por padrao, nao armazena senha, nao mata `powershell.exe` genericamente e nao recria a tarefa quando existe processo real saudavel. As recuperacoes tem cooldown para evitar loop de recriacao.

## Logs

```powershell
Get-Content .\logs\cookie-agent\agent.log -Tail 100
Get-Content .\logs\cookie-agent\watchdog.log -Tail 100
```

Os logs sao rotativos, com ate 5 arquivos de 5 MB. Token e conteudo de cookies sao redigidos.

## Rotacionar token

1. Gere um token forte manualmente.
2. Atualize `COOKIE_AGENT_TOKEN` no `.env` do servidor.
3. Recarregue o PM2.
4. Atualize `tools/cookie-agent/cookie-agent.config.json`.
5. Reinicie a tarefa do Windows.

## Limites

A automacao nao resolve login Google, CAPTCHA ou 2FA. Se o Google pedir login, abra o perfil Firefox correspondente, autentique manualmente e rode um teste com `-Once -DryRun`.

Suspensao ou hibernacao impedem o agente. Configure energia para manter o PC ligado sem manter a tela ligada quando a automacao for necessaria.

Tela bloqueada nao impede a tarefa interativa. Logoff encerra a sessao interativa e pode interromper o agente. O watchdog nao resolve PC desligado, logoff, suspensao, perfil Firefox deslogado, CAPTCHA ou 2FA.

O upload manual antigo permanece como fallback no dashboard.
