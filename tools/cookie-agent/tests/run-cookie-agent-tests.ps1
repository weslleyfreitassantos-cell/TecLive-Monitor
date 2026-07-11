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
Assert-True ($installContent -notmatch '-Password|LogonType\s+Password') 'Instalador nao deve armazenar senha'
Assert-True ($uninstallContent -match 'SupportsShouldProcess' -and $uninstallContent -match 'ShouldProcess') 'Uninstall do agente deve suportar WhatIf'
Assert-True ($commonContent -match 'Win32_Process') 'Health deve verificar processo via Win32_Process'
Assert-True ($commonContent -match 'CommandLine') 'Health deve validar CommandLine do processo'
Assert-True ($watchdogContent -match 'Stop-ScheduledTask') 'Watchdog deve tentar Stop-ScheduledTask'
Assert-True ($watchdogContent -match 'Start-ScheduledTask') 'Watchdog deve tentar Start-ScheduledTask'
Assert-True ($watchdogContent -match 'install-agent-task\.ps1') 'Watchdog deve recriar via instalador existente'
Assert-True ($watchdogContent -match 'Cooldown') 'Watchdog deve ter cooldown'
Assert-True ($watchdogContent -match 'Recriacao bloqueada porque existe processo real saudavel') 'Watchdog deve bloquear recriacao com processo saudavel'
Assert-True ($watchdogContent -match 'Recuperacao por \$action concluida com sucesso') 'Watchdog deve reportar recuperacao bem-sucedida'
Assert-True ($watchdogContent -match 'Recuperacao falhou') 'Watchdog deve reportar recuperacao falha'
Assert-True ($watchdogContent -notmatch 'Kill\(|Stop-Process|taskkill|Restart-Service') 'Watchdog nao deve matar processos nem reiniciar servicos'
Assert-True ($healthContent -match 'ConvertTo-Json') 'Health JSON ausente'
Assert-True ($installWatchdogContent -match 'TecLive Cookie Sync Watchdog') 'Instalador do watchdog ausente'
Assert-True ($installWatchdogContent -match 'RepetitionInterval') 'Watchdog deve rodar periodicamente'
Assert-True ($installWatchdogContent -match 'Get-Date\)\.AddMinutes\(1\)') 'Trigger repetitivo deve iniciar a partir de agora'
Assert-True ($installWatchdogContent -match 'New-ScheduledTaskTrigger\s+-AtLogOn') 'Watchdog deve iniciar no logon'
Assert-True ($installWatchdogContent -match "'Limited'") 'Watchdog deve usar Limited por padrao'
Assert-True ($installWatchdogContent -notmatch '-RunLevel\s+LeastPrivilege|-Password|LogonType\s+Password') 'Watchdog nao deve usar LeastPrivilege nem senha'

$now = Get-Date
$mockConfigPath = 'C:\Agent\cookie-agent.config.json'
$agentProcess = [pscustomobject]@{ ProcessId = 1234; CommandLine = "powershell -File C:\Agent\cookie-sync-agent.ps1 -ConfigPath $mockConfigPath"; CreationDate = $now.AddMinutes(-2) }
$otherProcess = [pscustomobject]@{ ProcessId = 9999; CommandLine = 'powershell -NoProfile'; CreationDate = $now }
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

$runningNoProcess = Get-CookieAgentTaskHealth -TaskName 'mock' -ConfigPath $mockConfigPath -MockTask $runningTask -MockTaskInfo $okInfo -MockProcesses @() -MockRuntimeState $freshState -Now $now
Assert-True ($runningNoProcess.reason -eq 'running-without-process') 'Running sem processo nao detectado'

$queuedNoProcess = Get-CookieAgentTaskHealth -TaskName 'mock' -ConfigPath $mockConfigPath -MockTask $queuedTask -MockTaskInfo $okInfo -MockProcesses @() -MockRuntimeState $staleState -Now $now
Assert-True ($queuedNoProcess.reason -eq 'queued-without-process') 'Queued sem processo nao detectado'

$readyStale = Get-CookieAgentTaskHealth -TaskName 'mock' -ConfigPath $mockConfigPath -MockTask $readyTask -MockTaskInfo $okInfo -MockProcesses @() -MockRuntimeState $staleState -Now $now
Assert-True ($readyStale.reason -eq 'ready-stale') 'Ready stale nao detectado'

$processHealthyTaskInconsistent = Get-CookieAgentTaskHealth -TaskName 'mock' -ConfigPath $mockConfigPath -MockTask $readyTask -MockTaskInfo $okInfo -MockProcesses @($agentProcess) -MockRuntimeState $freshState -Now $now
Assert-True ($processHealthyTaskInconsistent.reason -eq 'process-task-not-running') 'Processo saudavel com task inconsistente nao detectado'
Assert-True ($processHealthyTaskInconsistent.recommendedAction -eq 'observe') 'Processo saudavel nao deve disparar recriacao'

$ctrlC = Get-CookieAgentTaskHealth -TaskName 'mock' -ConfigPath $mockConfigPath -MockTask $readyTask -MockTaskInfo $ctrlCInfo -MockProcesses @() -MockRuntimeState $staleState -Now $now
Assert-True ($ctrlC.reason -eq 'interrupted-0xC000013A') '0xC000013A nao detectado'
Assert-True ($ctrlC.lastTaskResultHex -eq '0xC000013A') 'Hex de LastTaskResult incorreto'

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

$invalidStatePath = Join-Path ([System.IO.Path]::GetTempPath()) ("cookie-agent-invalid-state-" + [guid]::NewGuid().ToString('N') + '.json')
try {
    '{ invalid json' | Set-Content -LiteralPath $invalidStatePath -Encoding UTF8
    $invalidState = Read-CookieAgentJsonFile -Path $invalidStatePath
    Assert-True ($invalidState.invalidJson -eq $true) 'State JSON invalido deve ser identificado'
    Assert-True (-not [string]::IsNullOrWhiteSpace([string]$invalidState.error)) 'State JSON invalido deve incluir diagnostico'
} finally {
    Remove-Item -LiteralPath $invalidStatePath -Force -ErrorAction SilentlyContinue
}

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("cookie-agent-test-" + [guid]::NewGuid().ToString('N'))
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
    Assert-OutputMatch $defaultInstall 'WakeToRun:\s+False' 'WakeToRun padrao deve ser False'
    Assert-OutputMatch $wakeInstall 'WakeToRun:\s+True' 'WakeToRun explicito deve ser True'
    Assert-OutputMatch $watchdogInstall 'RunLevel:\s+Limited' 'Watchdog deve usar Limited por padrao'
    Assert-OutputMatch $watchdogInstall 'ExecutionTimeLimit:\s+PT2M' 'Watchdog deve limitar execucao a 2 minutos'
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
