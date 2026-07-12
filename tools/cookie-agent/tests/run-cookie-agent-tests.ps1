[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Split-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) -Parent
$agent = Join-Path $root 'tools\cookie-agent\cookie-sync-agent.ps1'
$common = Join-Path $root 'tools\cookie-agent\cookie-agent-common.ps1'
$watchdog = Join-Path $root 'tools\cookie-agent\cookie-agent-watchdog.ps1'
$healthScript = Join-Path $root 'tools\cookie-agent\get-agent-health.ps1'
$install = Join-Path $root 'tools\cookie-agent\install-agent-task.ps1'
$uninstall = Join-Path $root 'tools\cookie-agent\uninstall-agent-task.ps1'
$installWatchdog = Join-Path $root 'tools\cookie-agent\install-watchdog-task.ps1'
$uninstallWatchdog = Join-Path $root 'tools\cookie-agent\uninstall-watchdog-task.ps1'
$agentLauncher = Join-Path $root 'tools\cookie-agent\run-cookie-agent-hidden.vbs'
$watchdogLauncher = Join-Path $root 'tools\cookie-agent\run-cookie-watchdog-hidden.vbs'
$hiddenLauncherSource = Join-Path $root 'tools\cookie-agent\hidden-process-launcher.cs'

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

function Assert-OutputMatch {
    param([string]$Output, [string]$Pattern, [string]$Message)
    Assert-True ($Output -match $Pattern) $Message
}

foreach ($file in @($common, $agent, $watchdog, $healthScript, $install, $uninstall, $installWatchdog, $uninstallWatchdog)) {
    $tokens = $null
    $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$errors) > $null
    Assert-True ($errors.Count -eq 0) "Parser falhou em $file"
}

. $common

$content = Get-Content -LiteralPath $agent -Raw
$installContent = Get-Content -LiteralPath $install -Raw
$uninstallContent = Get-Content -LiteralPath $uninstall -Raw
$commonContent = Get-Content -LiteralPath $common -Raw
$watchdogContent = Get-Content -LiteralPath $watchdog -Raw
$healthContent = Get-Content -LiteralPath $healthScript -Raw
$installWatchdogContent = Get-Content -LiteralPath $installWatchdog -Raw
$agentLauncherContent = Get-Content -LiteralPath $agentLauncher -Raw
$watchdogLauncherContent = Get-Content -LiteralPath $watchdogLauncher -Raw
$hiddenLauncherSourceContent = Get-Content -LiteralPath $hiddenLauncherSource -Raw
Assert-True ($content -notmatch 'Invoke-Expression') 'Invoke-Expression nao deve ser usado'
Assert-True ($content -match 'Mutex') 'Mutex/lock local ausente'
Assert-True ($content -match 'Authorization = "Bearer') 'Bearer token header ausente'
Assert-True ($content -match 'Redact-SensitiveText') 'Redacao de dados sensiveis ausente'
Assert-True ($content -match 'HTTP e permitido apenas para localhost') 'Validacao HTTPS ausente'
Assert-True ($content -match 'Assert-AgentApiSuccess') 'Validacao de resposta da API ausente'
Assert-True ($content -match 'pendingReport') 'Retry/idempotencia de complete/fail ausente'
Assert-True ($content -match "marcar running") 'Falha ao marcar running deve ser tratada antes do Cookie Sync'
Assert-True ($content -notmatch "-All") 'Agente nao deve executar -All'
Assert-True ($content -match 'RuntimeStatePath' -and $commonContent -match 'agent-runtime-state\.json') 'Runtime state do agente ausente'
Assert-True ($content -match 'Inicializacao do agente') 'Log de inicializacao ausente'
Assert-True ($content -match 'Encerramento do agente') 'Log de encerramento ausente'
Assert-True ($content -match 'Console\.CancelKeyPress') 'Tratamento de Ctrl+C ausente'
Assert-True ($content -match 'PowerShell\.Exiting') 'Tratamento de PowerShell.Exiting ausente'
Assert-True ($content -match 'WaitOne\(\$TimeoutMilliseconds\)') 'Mutex deve usar timeout curto'
Assert-True ($content -match 'instancia ja em execucao') 'Segunda instancia deve sair com log claro'
Assert-True ($content -notmatch '&\s+icacls') 'Polling/startup do agente nao deve iniciar icacls.exe'
Assert-True ($content -match 'Set-Acl') 'Protecao de ACL deve ser feita in-process'
Assert-True ($content -match 'WellKnownSidType') 'Protecao de ACL deve usar SIDs, nao nomes localizados'
Assert-True ($content -match 'LocalSystemSid' -and $content -match 'BuiltinAdministratorsSid') 'Protecao de ACL deve preservar SYSTEM e Administrators'
Assert-True ($content -match 'SetAccessRuleProtection\(\$true, \$false\)') 'Protecao de ACL deve remover heranca generica'
Assert-True ($content -match 'Assert-CookieSyncToolsAvailable') 'Checagem de yt-dlp/ssh/scp deve ficar no caminho de job'
Assert-True ($content -match 'Get-WindowsPowerShellPath') 'Agente deve resolver powershell.exe real para executar Cookie Sync'
Assert-True ($content -notmatch 'Get-Process -Id \$PID\)\.Path') 'Agente nao deve usar o proprio host como powershell.exe do Cookie Sync'
Assert-True ($installContent -match 'RunAsAdmin') 'Parametro RunAsAdmin ausente no instalador'
Assert-True ($installContent -match "'Highest'") 'RunAsAdmin deve usar Highest'
Assert-True ($installContent -match "'Limited'") 'Padrao deve usar Limited'
Assert-True ($installContent -notmatch '-RunLevel\s+LeastPrivilege') 'Instalador nao deve usar LeastPrivilege'
Assert-True ($installContent -match 'RunLevelEnum') 'Deteccao defensiva do enum RunLevelEnum ausente'
Assert-True ($installContent -match 'WakeToRun') 'Parametro WakeToRun ausente no instalador'
Assert-True ($installContent -match 'StartAfterInstall') 'StartAfterInstall ausente'
Assert-True ($installContent -match 'ValidateAfterStart') 'ValidateAfterStart ausente'
Assert-True ($installContent -match 'Get-CookieAgentTaskHealth') 'Validacao pos-start deve usar health real'
Assert-True ($installContent -match 'SupportsShouldProcess') 'Instalador deve suportar WhatIf'
Assert-True ($installContent -match 'New-ScheduledTaskTrigger\s+-AtLogOn') 'Trigger no logon deve ser mantido'
Assert-True ($installContent -match '-Hidden') 'Tarefa do agente deve ser criada oculta'
Assert-True ($installContent -match 'wscript\.exe') 'Instalador do agente deve usar wscript.exe'
Assert-True ($installContent -match 'run-cookie-agent-hidden\.vbs') 'Instalador do agente deve usar launcher VBS'
Assert-True ($installContent -match 'Install-CookieAgentHiddenLauncher') 'Instalador do agente deve preparar launcher sem console'
Assert-True ($installContent -match 'WhatIfPreference') 'WhatIf do agente nao deve compilar launcher real'
Assert-True ($installContent -match 'New-ScheduledTaskAction\s+-Execute\s+\$wscript') 'Acao do agente deve executar wscript.exe'
Assert-True ($installContent -notmatch 'New-ScheduledTaskAction\s+-Execute\s+\$ps') 'Acao do agente nao deve executar powershell.exe diretamente'
Assert-True ($installContent -match 'wscript\.exe nao encontrado') 'Instalador deve falhar claramente sem wscript.exe'
Assert-True ($installContent -notmatch '-Password|LogonType\s+Password') 'Instalador nao deve armazenar senha'
Assert-True ($uninstallContent -match 'SupportsShouldProcess' -and $uninstallContent -match 'ShouldProcess') 'Uninstall do agente deve suportar WhatIf'
Assert-True ($commonContent -match 'Win32_Process') 'Health deve verificar processo via Win32_Process'
Assert-True ($commonContent -match 'CommandLine') 'Health deve validar CommandLine do processo'
Assert-True ($commonContent -match 'activityRecent') 'Health deve considerar heartbeat ou fila recentes como atividade'
Assert-True ($commonContent -match 'Install-CookieAgentHiddenLauncher') 'Common deve compilar o launcher sem console'
Assert-True ($commonContent -match '/target:winexe') 'Launcher nativo deve ser compilado como Windows application'
Assert-True ($commonContent -match 'Set-CookieAgentSecureAcl') 'Diretorio do helper deve receber ACL segura'
Assert-True ($commonContent -match 'SetAccessRuleProtection\(\$true, \$false\)') 'ACL do helper deve bloquear heranca'
Assert-True ($commonContent -match 'sourceHash' -and $commonContent -match 'binaryHash') 'Helper deve validar hash de source e binario'
Assert-True ($commonContent -match 'tmp\.exe') 'Compilacao do helper deve usar executavel temporario'
Assert-True ($commonContent -match 'Move-Item .* -Destination \$target -Force') 'Compilacao do helper deve substituir binario so apos sucesso'
Assert-True ($watchdogContent -match 'Stop-ScheduledTask') 'Watchdog deve tentar Stop-ScheduledTask'
Assert-True ($watchdogContent -match 'Start-ScheduledTask') 'Watchdog deve tentar Start-ScheduledTask'
Assert-True ($watchdogContent -match 'install-agent-task\.ps1') 'Watchdog deve recriar via instalador existente'
Assert-True ($watchdogContent -match 'Cooldown') 'Watchdog deve ter cooldown'
Assert-True ($watchdogContent -match 'ProcessStartInfo') 'Watchdog deve iniciar recriacao sem janela visivel'
Assert-True ($watchdogContent -match 'CreateNoWindow\s*=\s*\$true') 'Watchdog deve usar CreateNoWindow'
Assert-True ($watchdogContent -match 'UseShellExecute\s*=\s*\$false') 'Watchdog deve desabilitar ShellExecute'
Assert-True ($watchdogContent -match 'WindowStyle\s*=\s*\[System\.Diagnostics\.ProcessWindowStyle\]::Hidden') 'Watchdog deve usar WindowStyle Hidden'
Assert-True ($watchdogContent -match 'ReadToEndAsync') 'Watchdog deve ler stdout/stderr sem deadlock'
Assert-True ($watchdogContent -match 'WaitForExit\(\$timeoutMs\)') 'Watchdog deve impor timeout no processo filho'
Assert-True ($watchdogContent -match 'Assert-HiddenPowerShellResult') 'Watchdog deve validar exit code do processo filho'
Assert-True ($watchdogContent -notmatch '&\s+\$psExe\s+@installArgs') 'Watchdog nao deve usar chamada PowerShell visivel na recriacao'
Assert-True ($watchdogContent -match 'Recriacao bloqueada porque existe processo real ou atividade recente') 'Watchdog deve bloquear recriacao com processo ou atividade recente'
Assert-True ($watchdogContent -match 'Recuperacao por \$action concluida com sucesso') 'Watchdog deve reportar recuperacao bem-sucedida'
Assert-True ($watchdogContent -match 'Recuperacao falhou') 'Watchdog deve reportar recuperacao falha'
Assert-True ($watchdogContent -notmatch 'Stop-Process|taskkill|Restart-Service') 'Watchdog nao deve matar processos genericos nem reiniciar servicos'
Assert-True ($watchdogContent -match '\$Process\.Kill\(\)') 'Timeout deve encerrar somente o processo filho controlado'
Assert-True ($watchdogContent -match 'Stop/Start nao recuperou; health=\$\(\$afterStart\.reason\)\.' -and $watchdogContent -match 'return 30') 'Stop/start nao deve escalar para recreate-task na mesma execucao'
Assert-True ($healthContent -match 'ConvertTo-Json') 'Health JSON ausente'
Assert-True ($healthContent -match 'DEGRADED') 'Health Human deve expor estado DEGRADED'
Assert-True ($installWatchdogContent -match 'TecLive Cookie Sync Watchdog') 'Instalador do watchdog ausente'
Assert-True ($installWatchdogContent -match 'RepetitionInterval') 'Watchdog deve rodar periodicamente'
Assert-True ($installWatchdogContent -match 'Get-Date\)\.AddMinutes\(1\)') 'Trigger repetitivo deve iniciar a partir de agora'
Assert-True ($installWatchdogContent -match 'New-ScheduledTaskTrigger\s+-AtLogOn') 'Watchdog deve iniciar no logon'
Assert-True ($installWatchdogContent -match "'Limited'") 'Watchdog deve usar Limited por padrao'
Assert-True ($installWatchdogContent -match '-Hidden') 'Tarefa do watchdog deve ser criada oculta'
Assert-True ($installWatchdogContent -match 'wscript\.exe') 'Instalador do watchdog deve usar wscript.exe'
Assert-True ($installWatchdogContent -match 'run-cookie-watchdog-hidden\.vbs') 'Instalador do watchdog deve usar launcher VBS'
Assert-True ($installWatchdogContent -match 'Install-CookieAgentHiddenLauncher') 'Instalador do watchdog deve preparar launcher sem console'
Assert-True ($installWatchdogContent -match 'WhatIfPreference') 'WhatIf do watchdog nao deve compilar launcher real'
Assert-True ($installWatchdogContent -match 'New-ScheduledTaskAction\s+-Execute\s+\$wscript') 'Acao do watchdog deve executar wscript.exe'
Assert-True ($installWatchdogContent -notmatch 'New-ScheduledTaskAction\s+-Execute\s+\$ps') 'Acao do watchdog nao deve executar powershell.exe diretamente'
Assert-True ($installWatchdogContent -notmatch '-RunLevel\s+LeastPrivilege|-Password|LogonType\s+Password') 'Watchdog nao deve usar LeastPrivilege nem senha'

foreach ($launcherContent in @($agentLauncherContent, $watchdogLauncherContent)) {
    Assert-True ($launcherContent -match 'Option Explicit') 'Launcher VBS deve usar Option Explicit'
    Assert-True ($launcherContent -match 'WScript\.Shell') 'Launcher VBS deve usar WScript.Shell'
    Assert-True ($launcherContent -match '\.Run\(command,\s*0,\s*(True|False)\)') 'Launcher VBS deve executar com janela oculta'
    Assert-True ($launcherContent -match 'QuoteArg') 'Launcher VBS deve escapar argumentos'
    Assert-True ($launcherContent -match 'launcherPath') 'Launcher VBS deve chamar helper sem console'
    Assert-True ($launcherContent -notmatch 'cmd\.exe|/c|Authorization|Bearer|token') 'Launcher VBS nao deve usar cmd nem conter token'
}
Assert-True ($agentLauncherContent -match '\.Run\(command,\s*0,\s*False\)' -and $agentLauncherContent -match 'WScript\.Quit 0') 'Launcher do agente nao deve aguardar retorno'
Assert-True ($watchdogLauncherContent -match '\.Run\(command,\s*0,\s*True\)' -and $watchdogLauncherContent -match 'WScript\.Quit exitCode') 'Launcher do watchdog deve propagar exit code'
Assert-True ($agentLauncherContent -match 'cookie-sync-agent\.ps1') 'Launcher do agente deve chamar cookie-sync-agent.ps1'
Assert-True ($watchdogLauncherContent -match 'cookie-agent-watchdog\.ps1') 'Launcher do watchdog deve chamar cookie-agent-watchdog.ps1'
Assert-True ($hiddenLauncherSourceContent -match 'System\.Management\.Automation') 'Launcher nativo deve hospedar Windows PowerShell em processo'
Assert-True ($hiddenLauncherSourceContent -match 'RunspaceFactory\.CreateRunspace') 'Launcher nativo deve criar runspace sem powershell.exe filho'
Assert-True ($hiddenLauncherSourceContent -match 'PSHost') 'Launcher nativo deve fornecer host PowerShell'
Assert-True ($hiddenLauncherSourceContent -match 'SetShouldExit') 'Launcher nativo deve capturar exit code do watchdog'
Assert-True ($hiddenLauncherSourceContent -match 'LASTEXITCODE') 'Launcher nativo deve capturar exit code de scripts PowerShell'
Assert-True ($hiddenLauncherSourceContent -match 'cookie-sync-agent\.ps1' -and $hiddenLauncherSourceContent -match 'cookie-agent-watchdog\.ps1') 'Launcher nativo deve permitir apenas scripts esperados'
Assert-True ($hiddenLauncherSourceContent -match 'Path\.GetExtension\(fullPath\)' -and $hiddenLauncherSourceContent -match '"\.ps1"') 'Launcher nativo deve exigir extensao ps1'
Assert-True ($hiddenLauncherSourceContent -match 'IsExpectedScriptPath' -and $hiddenLauncherSourceContent -match 'tools", "cookie-agent') 'Launcher nativo deve restringir diretorio do script'
Assert-True ($hiddenLauncherSourceContent -match 'IsExistingJsonFile') 'Launcher nativo deve validar ConfigPath JSON existente'
Assert-True ($hiddenLauncherSourceContent -notmatch 'ProcessStartInfo|Process\.Start') 'Launcher nativo nao deve iniciar powershell.exe filho'
Assert-True ($hiddenLauncherSourceContent -notmatch 'Authorization|Bearer|token|cmd\.exe') 'Launcher nativo nao deve conter token nem cmd'

$now = Get-Date
$mockConfigPath = 'C:\Agent\cookie-agent.config.json'
$agentProcess = [pscustomobject]@{ ProcessId = 1234; CommandLine = "powershell -File C:\Agent\cookie-sync-agent.ps1 -ConfigPath $mockConfigPath"; CreationDate = $now.AddMinutes(-2) }
$otherProcess = [pscustomobject]@{ ProcessId = 9999; CommandLine = 'powershell -NoProfile'; CreationDate = $now }
$hiddenLauncherMockPath = Get-CookieAgentHiddenLauncherPath
$hiddenAgentProcess = [pscustomobject]@{ ProcessId = 2222; Name = 'hidden-process-launcher.exe'; CommandLine = "`"$hiddenLauncherMockPath`" `"C:\Agent\cookie-sync-agent.ps1`" -ConfigPath `"$mockConfigPath`""; CreationDate = $now.AddMinutes(-2) }
$fakeHiddenAgentProcess = [pscustomobject]@{ ProcessId = 3333; Name = 'hidden-process-launcher.exe'; CommandLine = '"C:\Temp\hidden-process-launcher.exe" "C:\Agent\cookie-sync-agent.ps1" -ConfigPath "C:\Agent\cookie-agent.config.json"'; CreationDate = $now.AddMinutes(-2) }
$runningTask = [pscustomobject]@{ State = 'Running'; Principal = [pscustomobject]@{ RunLevel = 'Limited' }; Settings = [pscustomobject]@{ WakeToRun = $false } }
$readyTask = [pscustomobject]@{ State = 'Ready'; Principal = [pscustomobject]@{ RunLevel = 'Limited' }; Settings = [pscustomobject]@{ WakeToRun = $false } }
$queuedTask = [pscustomobject]@{ State = 'Queued'; Principal = [pscustomobject]@{ RunLevel = 'Limited' }; Settings = [pscustomobject]@{ WakeToRun = $false } }
$disabledTask = [pscustomobject]@{ State = 'Disabled'; Principal = [pscustomobject]@{ RunLevel = 'Limited' }; Settings = [pscustomobject]@{ WakeToRun = $false } }
$okInfo = [pscustomobject]@{ LastRunTime = $now.AddMinutes(-1); LastTaskResult = 267009 }
$ctrlCInfo = [pscustomobject]@{ LastRunTime = $now.AddMinutes(-30); LastTaskResult = 3221225786 }
$freshState = @{ pid = 1234; lastHeartbeatAt = $now.AddSeconds(-20).ToString('o'); lastQueueCheckAt = $now.AddSeconds(-10).ToString('o') }
$staleState = @{ pid = 1234; lastHeartbeatAt = $now.AddMinutes(-30).ToString('o'); lastQueueCheckAt = $now.AddMinutes(-30).ToString('o') }

$healthy = Get-CookieAgentTaskHealth -TaskName 'mock' -ConfigPath $mockConfigPath -MockTask $runningTask -MockTaskInfo $okInfo -MockProcesses @($agentProcess) -MockRuntimeState $freshState -Now $now
Assert-True ($healthy.healthy -eq $true) 'Watchdog saudavel deveria ser healthy'
Assert-True ($healthy.lastTaskResult -eq 267009) 'LastTaskResult 267009 deve ser preservado'
Assert-True ($healthy.lastTaskResultHex -eq '0x00041301') '267009 deve virar 0x00041301'
Assert-True ($healthy.reason -eq 'ok') '267009/0x41301 nao deve ser tratado como erro'
Assert-True ($healthy.classification -eq 'ok') 'Health saudavel deve ter classificacao ok'

$runningNoProcess = Get-CookieAgentTaskHealth -TaskName 'mock' -ConfigPath $mockConfigPath -MockTask $runningTask -MockTaskInfo $okInfo -MockProcesses @() -MockRuntimeState $freshState -Now $now
Assert-True ($runningNoProcess.reason -eq 'recent-activity-without-process') 'Running sem processo com atividade recente deve degradar sem recuperar'
Assert-True ($runningNoProcess.recommendedAction -eq 'observe') 'Atividade recente sem processo nao deve disparar recuperacao'
Assert-True ($runningNoProcess.classification -eq 'degraded') 'Atividade recente sem processo deve ser degradada'

$limitState = @{ pid = 1234; lastHeartbeatAt = $now.AddMinutes(-5).ToString('o'); lastQueueCheckAt = $now.AddMinutes(-20).ToString('o') }
$limitHealth = Get-CookieAgentTaskHealth -TaskName 'mock' -ConfigPath $mockConfigPath -MockTask $runningTask -MockTaskInfo $okInfo -MockProcesses @($agentProcess) -MockRuntimeState $limitState -Now $now -StaleMinutes 5 -QueuedMinutes 2
Assert-True ($limitHealth.activityRecent -eq $true) 'Atividade exatamente no limite deve ser recente'
Assert-True ($limitHealth.healthy -eq $true) 'Heartbeat exatamente no limite deve manter health OK'

$invalidTimestamp = Get-CookieAgentTaskHealth -TaskName 'mock' -ConfigPath $mockConfigPath -MockTask $runningTask -MockTaskInfo $okInfo -MockProcesses @($agentProcess) -MockRuntimeState @{ pid = 1234; lastHeartbeatAt = 'not-a-date'; lastQueueCheckAt = 'also-not-a-date' } -Now $now
Assert-True ($null -eq $invalidTimestamp.activityAgeSeconds) 'Timestamp invalido nao deve gerar activityAgeSeconds'
Assert-True ($invalidTimestamp.activityRecent -eq $false) 'Timestamp invalido nao deve ser atividade recente'
Assert-True ($invalidTimestamp.classification -eq 'fail') 'Timestamp invalido deve falhar de forma controlada'

$queuedNoProcess = Get-CookieAgentTaskHealth -TaskName 'mock' -ConfigPath $mockConfigPath -MockTask $queuedTask -MockTaskInfo $okInfo -MockProcesses @() -MockRuntimeState $staleState -Now $now
Assert-True ($queuedNoProcess.reason -eq 'queued-without-process') 'Queued sem processo nao detectado'

$readyStale = Get-CookieAgentTaskHealth -TaskName 'mock' -ConfigPath $mockConfigPath -MockTask $readyTask -MockTaskInfo $okInfo -MockProcesses @() -MockRuntimeState $staleState -Now $now
Assert-True ($readyStale.reason -eq 'ready-stale') 'Ready stale nao detectado'
Assert-True ($readyStale.classification -eq 'fail') 'Ready stale sem processo deve falhar'
Assert-True ($readyStale.recommendedAction -eq 'start-task') 'Ready stale sem processo deve recomendar start-task'

$readyRecent = Get-CookieAgentTaskHealth -TaskName 'mock' -ConfigPath $mockConfigPath -MockTask $readyTask -MockTaskInfo $okInfo -MockProcesses @() -MockRuntimeState $freshState -Now $now
Assert-True ($readyRecent.reason -eq 'recent-activity-without-process') 'Ready com atividade recente deve degradar sem recuperar'
Assert-True ($readyRecent.recommendedAction -eq 'observe') 'Ready recente nao deve recomendar recuperacao destrutiva'
Assert-True ($readyRecent.classification -eq 'degraded') 'Ready recente deve ser DEGRADED'

$processHealthyTaskInconsistent = Get-CookieAgentTaskHealth -TaskName 'mock' -ConfigPath $mockConfigPath -MockTask $readyTask -MockTaskInfo $okInfo -MockProcesses @($agentProcess) -MockRuntimeState $freshState -Now $now
Assert-True ($processHealthyTaskInconsistent.reason -eq 'process-task-not-running') 'Processo saudavel com task inconsistente nao detectado'
Assert-True ($processHealthyTaskInconsistent.recommendedAction -eq 'observe') 'Processo saudavel nao deve disparar recriacao'
Assert-True ($processHealthyTaskInconsistent.classification -eq 'degraded') 'Processo saudavel com task inconsistente deve ser degradado'

$ctrlCRecent = Get-CookieAgentTaskHealth -TaskName 'mock' -ConfigPath $mockConfigPath -MockTask $readyTask -MockTaskInfo $ctrlCInfo -MockProcesses @() -MockRuntimeState $freshState -Now $now
Assert-True ($ctrlCRecent.reason -eq 'interrupted-recent-activity') '0xC000013A com atividade recente deve ser observado'
Assert-True ($ctrlCRecent.recommendedAction -eq 'observe') '0xC000013A recente nao deve recriar tarefa'
Assert-True ($ctrlCRecent.classification -eq 'degraded') '0xC000013A recente deve ser degradado'

$ctrlC = Get-CookieAgentTaskHealth -TaskName 'mock' -ConfigPath $mockConfigPath -MockTask $readyTask -MockTaskInfo $ctrlCInfo -MockProcesses @() -MockRuntimeState $staleState -Now $now
Assert-True ($ctrlC.reason -eq 'interrupted-0xC000013A') '0xC000013A nao detectado'
Assert-True ($ctrlC.lastTaskResultHex -eq '0xC000013A') 'Hex de LastTaskResult incorreto'
Assert-True ($ctrlC.recommendedAction -eq 'recreate-task') '0xC000013A stale sem processo deve recriar'
Assert-True ($ctrlC.classification -eq 'fail') '0xC000013A stale deve falhar'

$missingTask = Get-CookieAgentTaskHealth -TaskName 'mock' -ConfigPath $mockConfigPath -MockTask $null -MockTaskInfo $null -MockProcesses @() -MockRuntimeState $staleState -Now $now
Assert-True ($missingTask.reason -eq 'task-missing') 'Tarefa ausente nao detectada'

$disabled = Get-CookieAgentTaskHealth -TaskName 'mock' -ConfigPath $mockConfigPath -MockTask $disabledTask -MockTaskInfo $okInfo -MockProcesses @() -MockRuntimeState $staleState -Now $now
Assert-True ($disabled.reason -eq 'task-disabled') 'Tarefa disabled nao detectada'

$pidDead = Get-CookieAgentTaskHealth -TaskName 'mock' -ConfigPath $mockConfigPath -MockTask $runningTask -MockTaskInfo $okInfo -MockProcesses @($agentProcess) -MockRuntimeState @{ pid = 5555; lastHeartbeatAt = $now.AddSeconds(-20).ToString('o') } -Now $now
Assert-True ($pidDead.reason -eq 'state-pid-dead') 'PID morto no state nao detectado'

$missingLog = Get-CookieAgentTaskHealth -TaskName 'mock' -ConfigPath $mockConfigPath -RuntimeStatePath '' -LogPath (Join-Path ([System.IO.Path]::GetTempPath()) ('missing-log-' + [guid]::NewGuid().ToString('N') + '.log')) -MockTask $runningTask -MockTaskInfo $okInfo -MockProcesses @($agentProcess) -MockRuntimeState $freshState -Now $now
Assert-True ($null -eq $missingLog.logAgeSeconds) 'Log ausente deve ser tolerado'

$notAgent = Test-CookieAgentPidActive -Pid 9999 -ConfigPath $mockConfigPath -ProcessList @($otherProcess)
Assert-True ($notAgent -eq $false) 'PID vivo que nao e agente nao deve ser aceito'
$emptyProcessList = Test-CookieAgentPidActive -Pid 1234 -ConfigPath $mockConfigPath -ProcessList @()
Assert-True ($emptyProcessList -eq $false) 'Lista mock vazia nao deve consultar processos reais'

$redacted = Redact-CookieAgentText 'Authorization: Bearer secret-token token:abc C:\Users\Weslley\secret.txt /var/www/livemonitor/app.js # Netscape HTTP Cookie File content'
Assert-True ($redacted -notmatch 'secret-token|abc|Netscape|C:\\Users|/var/www') 'Redacao de dados sensiveis falhou'

$hiddenFreshState = @{ pid = 2222; lastHeartbeatAt = $now.AddSeconds(-20).ToString('o'); lastQueueCheckAt = $now.AddSeconds(-10).ToString('o') }
$hiddenReady = Get-CookieAgentTaskHealth -TaskName 'mock' -ConfigPath $mockConfigPath -MockTask $readyTask -MockTaskInfo $okInfo -MockProcesses @($hiddenAgentProcess) -MockRuntimeState $hiddenFreshState -Now $now
Assert-True ($hiddenReady.healthy -eq $true) 'Hidden launcher validado deve ser OK mesmo com task Ready'
Assert-True ($hiddenReady.processName -eq 'hidden-process-launcher.exe') 'Health deve reportar o processo launcher'
$fakeHiddenAccepted = Test-CookieAgentProcessMatches -Process $fakeHiddenAgentProcess -ConfigPath $mockConfigPath
Assert-True ($fakeHiddenAccepted -eq $false) 'Launcher com mesmo nome em caminho nao esperado nao deve ser aceito'

$hiddenTestRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("cookie-hidden-launcher-test-" + [guid]::NewGuid().ToString('N'))
try {
    New-Item -ItemType Directory -Path $hiddenTestRoot | Out-Null
    $testHiddenLauncherPath = Join-Path $hiddenTestRoot 'hidden-process-launcher.exe'

    $missingSourceMessage = $null
    try {
        Install-CookieAgentHiddenLauncher -ScriptRoot (Join-Path $hiddenTestRoot 'missing-source') -OutputPath $testHiddenLauncherPath
    } catch {
        $missingSourceMessage = $_.Exception.Message
    }
    Assert-True ($missingSourceMessage -match 'Codigo-fonte do launcher sem console ausente') 'Source C# ausente deve falhar claramente'

    $sourceRoot = Join-Path $hiddenTestRoot 'source'
    New-Item -ItemType Directory -Path $sourceRoot | Out-Null
    'this is not valid csharp' | Set-Content -LiteralPath (Join-Path $sourceRoot 'hidden-process-launcher.cs') -Encoding ASCII
    'previous binary' | Set-Content -LiteralPath $testHiddenLauncherPath -Encoding ASCII
    $previousHash = Get-CookieAgentFileHash -Path $testHiddenLauncherPath
    $compileFailMessage = $null
    try {
        Install-CookieAgentHiddenLauncher -ScriptRoot $sourceRoot -OutputPath $testHiddenLauncherPath
    } catch {
        $compileFailMessage = $_.Exception.Message
    }
    Assert-True (-not [string]::IsNullOrWhiteSpace($compileFailMessage)) 'Falha de compilacao deve ser reportada'
    Assert-True ((Get-CookieAgentFileHash -Path $testHiddenLauncherPath) -eq $previousHash) 'Falha de compilacao deve preservar binario anterior'
    Assert-True ((Test-CookieAgentHiddenLauncherCurrent -Source (Join-Path $sourceRoot 'hidden-process-launcher.cs') -LauncherPath $testHiddenLauncherPath) -eq $false) 'Helper corrompido ou sem metadata nao deve ser considerado atual'

    Protect-CookieAgentHiddenLauncherPath -LauncherPath $testHiddenLauncherPath
    $acl = Get-Acl -LiteralPath $hiddenTestRoot
    Assert-True ($acl.AreAccessRulesProtected -eq $true) 'Diretorio do helper deve bloquear heranca'
    $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
    Assert-True (@($rules | Where-Object { $_.IdentityReference.Value -eq 'S-1-1-0' }).Count -eq 0) 'Diretorio do helper nao deve permitir Everyone'
} finally {
    Remove-Item -LiteralPath $hiddenTestRoot -Recurse -Force -ErrorAction SilentlyContinue
}

function Import-AgentFunctionDefinitions {
    param([string]$Path)
    $tokens = $null
    $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors)
    Assert-True ($errors.Count -eq 0) "Parser falhou em $Path"
    $functions = $ast.FindAll({
        param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst]
    }, $true)
    foreach ($function in $functions) {
        Invoke-Expression ("function script:$($function.Name) $($function.Body.Extent.Text)")
    }
}

Import-AgentFunctionDefinitions -Path $watchdog
$spaceArgs = @('-File', 'C:\Program Files\TecLive Agent\install-agent-task.ps1', '-ConfigPath', 'C:\Users\Weslley\TecLive Config\cookie-agent.config.json')
$joinedSpaceArgs = Join-WatchdogProcessArguments -Arguments $spaceArgs
Assert-True ($joinedSpaceArgs -match '"C:\\Program Files\\TecLive Agent\\install-agent-task\.ps1"') 'Argumentos com espacos devem ser preservados entre aspas'
Assert-True ($joinedSpaceArgs -match '"C:\\Users\\Weslley\\TecLive Config\\cookie-agent\.config\.json"') 'ConfigPath com espacos deve ser preservado entre aspas'
$hiddenStartInfo = New-HiddenPowerShellStartInfo -PowerShellPath 'C:\Program Files\PowerShell\7\pwsh.exe' -Arguments $spaceArgs
Assert-True ($hiddenStartInfo.FileName -eq 'C:\Program Files\PowerShell\7\pwsh.exe') 'ProcessStartInfo deve aceitar caminho do PowerShell com espacos'
Assert-True ($hiddenStartInfo.UseShellExecute -eq $false) 'ProcessStartInfo deve usar UseShellExecute=false'
Assert-True ($hiddenStartInfo.CreateNoWindow -eq $true) 'ProcessStartInfo deve usar CreateNoWindow=true'
Assert-True ($hiddenStartInfo.WindowStyle -eq [System.Diagnostics.ProcessWindowStyle]::Hidden) 'ProcessStartInfo deve usar WindowStyle Hidden'
Assert-True ($hiddenStartInfo.RedirectStandardOutput -and $hiddenStartInfo.RedirectStandardError) 'ProcessStartInfo deve redirecionar stdout/stderr'

$nonZeroMessage = $null
try {
    Assert-HiddenPowerShellResult -Result ([pscustomobject]@{
        ExitCode = 7
        StdOut = 'token:abc C:\Users\Weslley\secret.json'
        StdErr = 'Authorization: Bearer secret-token'
        TimedOut = $false
    })
} catch {
    $nonZeroMessage = $_.Exception.Message
}
Assert-True ($nonZeroMessage -match 'retornou 7') 'Exit code diferente de zero deve falhar'
Assert-True ($nonZeroMessage -notmatch 'secret-token|token:abc|C:\\Users\\Weslley') 'Erro do processo filho deve ser redigido'

$timeoutMessage = $null
try {
    Assert-HiddenPowerShellResult -Result ([pscustomobject]@{
        ExitCode = $null
        StdOut = ''
        StdErr = ''
        TimedOut = $true
    })
} catch {
    $timeoutMessage = $_.Exception.Message
}
Assert-True ($timeoutMessage -match 'timeout') 'Timeout do processo filho deve falhar claramente'

Import-AgentFunctionDefinitions -Path $agent
$script:DryRun = $false
$script:VerboseOutput = $false
$script:AllowedCookies = @('cookie1', 'cookie2', 'cookie3')
$script:HeartbeatFailureActive = $false
$script:heartbeatCalls = 0
$script:queueCalls = 0
$script:cookieSyncCalls = 0
$script:toolChecks = 0
function Write-AgentLog { param([string]$Path, [string]$Message) }
function Update-RuntimeState { param([hashtable]$Patch) }
function Send-PendingReport { param([pscustomobject]$Config, [string]$StatePath, [string]$LogPath) return $true }
function Assert-CookieSyncToolsAvailable { $script:toolChecks += 1; throw 'tool check should not run during empty polling' }
function Invoke-CookieSync {
    $script:cookieSyncCalls += 1
    throw 'Cookie Sync should not run during empty polling'
}
function Invoke-AgentApi {
    param(
        [pscustomobject]$Config,
        [string]$Method,
        [string]$Path,
        [object]$Body = $null
    )
    if ($Method -eq 'POST' -and $Path -eq '/api/cookie-agent/heartbeat') {
        $script:heartbeatCalls += 1
        return [pscustomobject]@{ StatusCode = 200; Data = [pscustomobject]@{ success = $true } }
    }
    if ($Method -eq 'GET' -and $Path -eq '/api/cookie-agent/jobs/next') {
        $script:queueCalls += 1
        return [pscustomobject]@{ StatusCode = 204; Data = $null }
    }
    throw "Chamada inesperada no polling vazio: $Method $Path"
}
$mockAgentConfig = [pscustomobject]@{
    server = [pscustomobject]@{ timeoutSeconds = 900 }
    agent = [pscustomobject]@{ id = 'mock-agent'; version = 'test' }
}
foreach ($i in 1..3) {
    $emptyCycleOk = Invoke-OneCycle -Config $mockAgentConfig -ProjectPath $root -CookieSyncScript $agent -LogPath 'mock.log' -StatePath 'mock-state.json' -RuntimeStatePath 'mock-runtime.json'
    Assert-True ($emptyCycleOk -eq $true) "Polling vazio ciclo $i deveria retornar sucesso"
}
Assert-True ($script:heartbeatCalls -eq 3) 'Polling vazio deve manter heartbeat'
Assert-True ($script:queueCalls -eq 3) 'Polling vazio deve consultar fila'
Assert-True ($script:cookieSyncCalls -eq 0) 'Polling vazio nao deve executar Cookie Sync/processo filho'
Assert-True ($script:toolChecks -eq 0) 'Polling vazio nao deve checar yt-dlp/ssh/scp'

$invalidStatePath = Join-Path ([System.IO.Path]::GetTempPath()) ("cookie-agent-invalid-state-" + [guid]::NewGuid().ToString('N') + '.json')
try {
    '{ invalid json' | Set-Content -LiteralPath $invalidStatePath -Encoding UTF8
    $invalidState = Read-CookieAgentJsonFile -Path $invalidStatePath
    Assert-True ($invalidState.invalidJson -eq $true) 'State JSON invalido deve ser identificado'
    Assert-True (-not [string]::IsNullOrWhiteSpace([string]$invalidState.error)) 'State JSON invalido deve incluir diagnostico'
} finally {
    Remove-Item -LiteralPath $invalidStatePath -Force -ErrorAction SilentlyContinue
}

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("cookie agent test " + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
$oldRuntimeStatePath = $env:COOKIE_AGENT_RUNTIME_STATE_PATH
$oldWatchdogStatePath = $env:COOKIE_AGENT_WATCHDOG_STATE_PATH
$oldWatchdogLogPath = $env:COOKIE_AGENT_WATCHDOG_LOG_PATH
try {
    $env:COOKIE_AGENT_RUNTIME_STATE_PATH = Join-Path $tmp 'agent-runtime-state.json'
    $env:COOKIE_AGENT_WATCHDOG_STATE_PATH = Join-Path $tmp 'watchdog-state.json'
    $env:COOKIE_AGENT_WATCHDOG_LOG_PATH = Join-Path $tmp 'watchdog.log'

    $installConfig = Join-Path $tmp 'install-config.json'
    '{}' | Set-Content -LiteralPath $installConfig -Encoding UTF8
    $defaultTaskName = "Cookie Agent Test Default $([guid]::NewGuid().ToString('N'))"
    $adminTaskName = "Cookie Agent Test Admin $([guid]::NewGuid().ToString('N'))"
    $wakeTaskName = "Cookie Agent Test Wake $([guid]::NewGuid().ToString('N'))"
    $watchdogTaskName = "Cookie Agent Watchdog Test $([guid]::NewGuid().ToString('N'))"
    $defaultInstall = (& $install -TaskName $defaultTaskName -ConfigPath $installConfig -WhatIf *>&1) -join "`n"
    $adminInstall = (& $install -TaskName $adminTaskName -ConfigPath $installConfig -RunAsAdmin -WhatIf *>&1) -join "`n"
    $wakeInstall = (& $install -TaskName $wakeTaskName -ConfigPath $installConfig -WakeToRun -WhatIf *>&1) -join "`n"
    $watchdogInstall = (& $installWatchdog -TaskName $watchdogTaskName -ConfigPath $installConfig -WhatIf *>&1) -join "`n"
    $watchdogUninstall = (& $uninstallWatchdog -TaskName $watchdogTaskName -WhatIf *>&1) -join "`n"
    Assert-OutputMatch $defaultInstall 'RunLevel:\s+Limited' 'Padrao do instalador deve usar Limited'
    Assert-OutputMatch $defaultInstall 'Execute:\s+.*wscript\.exe' 'Acao do agente deve usar wscript.exe'
    Assert-OutputMatch $defaultInstall 'Launcher:\s+run-cookie-agent-hidden\.vbs' 'Instalador do agente deve reportar launcher VBS'
    Assert-OutputMatch $defaultInstall 'HiddenProcessLauncher:\s+hidden-process-launcher\.exe' 'Instalador do agente deve reportar helper sem console'
    Assert-True ($defaultInstall -notmatch 'Execute:\s+.*powershell\.exe') 'Acao do agente nao deve executar powershell.exe diretamente'
    Assert-OutputMatch $adminInstall 'RunLevel:\s+Highest' 'RunAsAdmin deve usar Highest'
    Assert-True (($defaultInstall + $adminInstall + $wakeInstall) -notmatch 'RunLevel:\s+LeastPrivilege') 'Instalador nunca deve usar LeastPrivilege'
    Assert-OutputMatch $defaultInstall 'MultipleInstances:\s+IgnoreNew' 'MultipleInstances deve ser IgnoreNew'
    Assert-OutputMatch $defaultInstall 'RestartCount:\s+3' 'RestartCount deve ser 3'
    Assert-OutputMatch $defaultInstall 'RestartInterval:\s+PT1M' 'RestartInterval deve ser 1 minuto'
    Assert-OutputMatch $defaultInstall 'ExecutionTimeLimit:\s+PT0S' 'ExecutionTimeLimit deve ser ilimitado'
    Assert-OutputMatch $defaultInstall 'AllowDemandStart:\s+True' 'AllowDemandStart deve ser True'
    Assert-OutputMatch $defaultInstall 'DisallowStartIfOnBatteries:\s+False' 'DisallowStartIfOnBatteries deve ser False'
    Assert-OutputMatch $defaultInstall 'StopIfGoingOnBatteries:\s+False' 'StopIfGoingOnBatteries deve ser False'
    Assert-OutputMatch $defaultInstall 'StartWhenAvailable:\s+True' 'StartWhenAvailable deve ser True'
    Assert-OutputMatch $defaultInstall 'RunOnlyIfNetworkAvailable:\s+False' 'RunOnlyIfNetworkAvailable deve ser False'
    Assert-OutputMatch $defaultInstall 'Hidden:\s+True' 'Tarefa do agente deve ser Hidden=True'
    Assert-OutputMatch $defaultInstall 'WakeToRun:\s+False' 'WakeToRun padrao deve ser False'
    Assert-OutputMatch $wakeInstall 'WakeToRun:\s+True' 'WakeToRun explicito deve ser True'
    Assert-OutputMatch $watchdogInstall 'RunLevel:\s+Limited' 'Watchdog deve usar Limited por padrao'
    Assert-OutputMatch $watchdogInstall 'Execute:\s+.*wscript\.exe' 'Acao do watchdog deve usar wscript.exe'
    Assert-OutputMatch $watchdogInstall 'Launcher:\s+run-cookie-watchdog-hidden\.vbs' 'Instalador do watchdog deve reportar launcher VBS'
    Assert-OutputMatch $watchdogInstall 'HiddenProcessLauncher:\s+hidden-process-launcher\.exe' 'Instalador do watchdog deve reportar helper sem console'
    Assert-True ($watchdogInstall -notmatch 'Execute:\s+.*powershell\.exe') 'Acao do watchdog nao deve executar powershell.exe diretamente'
    Assert-OutputMatch $watchdogInstall 'ExecutionTimeLimit:\s+PT2M' 'Watchdog deve limitar execucao a 2 minutos'
    Assert-OutputMatch $watchdogInstall 'Hidden:\s+True' 'Tarefa do watchdog deve ser Hidden=True'
    Assert-OutputMatch $watchdogInstall 'WakeToRun:\s+False' 'Watchdog WakeToRun padrao deve ser False'
    Assert-True ($watchdogUninstall -match 'Tarefa nao encontrada|What if|validada') 'Uninstall watchdog deve ser seguro em WhatIf'
    $createdInstallTasks = Get-ScheduledTask -TaskName $defaultTaskName, $adminTaskName, $wakeTaskName, $watchdogTaskName -ErrorAction SilentlyContinue
    Assert-True (-not $createdInstallTasks) 'Teste do instalador nao deve criar tarefa real'

    $healthHuman = (& $healthScript -TaskName "Missing Agent Test $([guid]::NewGuid().ToString('N'))" -ConfigPath $installConfig -Human *>&1) -join "`n"
    Assert-OutputMatch $healthHuman 'Health:\s+FAIL' 'get-agent-health Human deveria reportar FAIL para tarefa ausente'
    $healthJsonRaw = (& $healthScript -TaskName "Missing Agent Test $([guid]::NewGuid().ToString('N'))" -ConfigPath $installConfig -Json *>&1) -join "`n"
    $healthJson = $healthJsonRaw | ConvertFrom-Json
    Assert-True ($healthJson.reason -eq 'task-missing') 'get-agent-health Json deveria reportar task-missing'

    Assert-True ($watchdogContent -match 'exit 0') 'Watchdog deve expor codigo 0'
    Assert-True ($watchdogContent -match 'return 10') 'Watchdog deve expor codigo 10'
    Assert-True ($watchdogContent -match 'return 20') 'Watchdog deve expor codigo 20'
    Assert-True ($watchdogContent -match 'return 30') 'Watchdog deve expor codigo 30'
    Assert-True ($watchdogContent -match 'exit 40') 'Watchdog deve expor codigo 40'
    Assert-True ($watchdogContent -match 'DryRun/WhatIf') 'Watchdog deve respeitar DryRun/WhatIf'
    Assert-True ($content -match 'DryRun: executaria tarefa') 'Agente deve logar DryRun sem executar Cookie Sync'
} finally {
    $env:COOKIE_AGENT_RUNTIME_STATE_PATH = $oldRuntimeStatePath
    $env:COOKIE_AGENT_WATCHDOG_STATE_PATH = $oldWatchdogStatePath
    $env:COOKIE_AGENT_WATCHDOG_LOG_PATH = $oldWatchdogLogPath
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host 'Cookie Agent PowerShell tests OK'
