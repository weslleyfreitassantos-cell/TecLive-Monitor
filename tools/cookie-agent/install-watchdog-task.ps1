[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$TaskName = 'TecLive Cookie Sync Watchdog',
    [string]$AgentTaskName = 'TecLive Cookie Sync Agent',
    [string]$ConfigPath,
    [switch]$Force,
    [switch]$RunAsAdmin,
    [switch]$WakeToRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module ScheduledTasks -ErrorAction Stop
. (Join-Path $PSScriptRoot 'cookie-agent-common.ps1')

if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
    $ConfigPath = Join-Path $PSScriptRoot 'cookie-agent.config.json'
}
if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
    throw "Config ausente: $ConfigPath"
}

function Get-ScheduledTaskRunLevel {
    param([bool]$Elevated)
    $validNames = [System.Enum]::GetNames([Microsoft.PowerShell.Cmdletization.GeneratedTypes.ScheduledTask.RunLevelEnum])
    $desired = if ($Elevated) { 'Highest' } else { 'Limited' }
    if ($validNames -notcontains $desired) {
        throw "RunLevel '$desired' nao e suportado neste ambiente. Valores aceitos: $($validNames -join ', ')"
    }
    return $desired
}

$projectRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$watchdogLauncher = Join-Path $PSScriptRoot 'run-cookie-watchdog-hidden.vbs'
$wscript = Join-Path $env:WINDIR 'System32\wscript.exe'
if (-not (Test-Path -LiteralPath $wscript -PathType Leaf)) {
    $wscriptCommand = Get-Command wscript.exe -ErrorAction SilentlyContinue
    if ($wscriptCommand) { $wscript = $wscriptCommand.Source }
}
if (-not (Test-Path -LiteralPath $wscript -PathType Leaf)) {
    throw 'wscript.exe nao encontrado. O launcher sem console exige Windows Script Host.'
}
if (-not (Test-Path -LiteralPath $watchdogLauncher -PathType Leaf)) {
    throw "Launcher VBS ausente: $watchdogLauncher"
}
$hiddenLauncher = if ($WhatIfPreference) {
    Get-CookieAgentHiddenLauncherPath
} else {
    Install-CookieAgentHiddenLauncher -ScriptRoot $PSScriptRoot
}

if ((Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) -and -not $Force) {
    throw "Tarefa ja existe. Use -Force para substituir: $TaskName"
}
if ($Force -and $PSCmdlet.ShouldProcess($TaskName, 'remover tarefa watchdog existente')) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
}

function Join-TaskActionArguments {
    param([string[]]$Arguments)
    return (@($Arguments | ForEach-Object {
        $value = [string]$_
        if ($value -notmatch '[\s"]') {
            $value
        } else {
            '"' + ($value -replace '"', '\"') + '"'
        }
    }) -join ' ')
}

$arguments = Join-TaskActionArguments @('//B', '//NoLogo', $watchdogLauncher, $hiddenLauncher, $AgentTaskName, $ConfigPath, $projectRoot)

$action = New-ScheduledTaskAction -Execute $wscript -Argument $arguments -WorkingDirectory $projectRoot
$triggerLogon = New-ScheduledTaskTrigger -AtLogOn
$triggerRepeat = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1)) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet `
    -MultipleInstances IgnoreNew `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 2) `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -Hidden `
    -WakeToRun:$WakeToRun.IsPresent
$runLevel = Get-ScheduledTaskRunLevel -Elevated:$RunAsAdmin.IsPresent
$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel $runLevel

if ($PSCmdlet.ShouldProcess($TaskName, "criar tarefa watchdog com RunLevel $runLevel")) {
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($triggerLogon, $triggerRepeat) -Settings $settings -Principal $principal | Out-Null
    Write-Host "Tarefa criada: $TaskName"
} else {
    Write-Host "Tarefa validada: $TaskName"
}

Write-Host "Execute: $wscript"
Write-Host "Launcher: $(Split-Path $watchdogLauncher -Leaf)"
Write-Host "HiddenProcessLauncher: $(Split-Path $hiddenLauncher -Leaf)"
Write-Host "RunLevel: $runLevel"
Write-Host "MultipleInstances: $($settings.MultipleInstances)"
Write-Host "RestartCount: $($settings.RestartCount)"
Write-Host "RestartInterval: $($settings.RestartInterval)"
Write-Host "ExecutionTimeLimit: $($settings.ExecutionTimeLimit)"
Write-Host "StartWhenAvailable: $($settings.StartWhenAvailable)"
Write-Host "Hidden: $($settings.Hidden)"
Write-Host "WakeToRun: $($settings.WakeToRun)"
Write-Host 'O watchdog executa uma checagem por disparo e termina.'
