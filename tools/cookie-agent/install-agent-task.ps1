[CmdletBinding()]
param(
    [string]$TaskName = 'TecLive Cookie Sync Agent',
    [string]$ConfigPath,
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
    $ConfigPath = Join-Path $PSScriptRoot 'cookie-agent.config.json'
}
if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
    throw "Config ausente: $ConfigPath"
}

$projectRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$agentScript = Join-Path $PSScriptRoot 'cookie-sync-agent.ps1'
$pwsh = Get-Command pwsh -ErrorAction SilentlyContinue
if ($pwsh) {
    $ps = $pwsh.Source
} else {
    $ps = (Get-Command powershell -ErrorAction Stop).Source
}

if ((Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) -and -not $Force) {
    throw "Tarefa ja existe. Use -Force para substituir: $TaskName"
}
if ($Force) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
}

$arguments = @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-WindowStyle', 'Hidden',
    '-File', "`"$agentScript`"",
    '-ConfigPath', "`"$ConfigPath`""
) -join ' '

$action = New-ScheduledTaskAction -Execute $ps -Argument $arguments -WorkingDirectory $projectRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel LeastPrivilege
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal | Out-Null

Write-Host "Tarefa criada: $TaskName"
Write-Host "Comando: $ps $arguments"
Write-Host "A tarefa nao foi iniciada automaticamente por este instalador."
