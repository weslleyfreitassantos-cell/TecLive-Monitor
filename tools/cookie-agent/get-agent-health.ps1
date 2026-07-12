[CmdletBinding()]
param(
    [switch]$Human,
    [switch]$Json,
    [string]$TaskName = 'TecLive Cookie Sync Agent',
    [string]$ConfigPath,
    [int]$StaleMinutes = 5,
    [int]$QueuedMinutes = 2
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'cookie-agent-common.ps1')

if (-not $Human -and -not $Json) {
    $Human = $true
}
if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
    $ConfigPath = Join-Path $PSScriptRoot 'cookie-agent.config.json'
}

$projectRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$logPath = Join-Path $projectRoot 'logs\cookie-agent\agent.log'
if (Test-Path -LiteralPath $ConfigPath -PathType Leaf) {
    try {
        $config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
        if ($config.paths -and $config.paths.logPath) {
            $configuredProject = Resolve-CookieAgentPath -ProjectPath $projectRoot -Value ([string]$config.paths.projectPath)
            $logPath = Resolve-CookieAgentPath -ProjectPath $configuredProject -Value ([string]$config.paths.logPath)
        }
    } catch {}
}

$health = Get-CookieAgentTaskHealth `
    -TaskName $TaskName `
    -ConfigPath $ConfigPath `
    -RuntimeStatePath (Get-CookieAgentRuntimeStatePath -ScriptRoot $PSScriptRoot) `
    -LogPath $logPath `
    -StaleMinutes $StaleMinutes `
    -QueuedMinutes $QueuedMinutes

function Format-AgentAge {
    param([AllowNull()][object]$Seconds)
    if ($null -eq $Seconds) { return '—' }
    if ($Seconds -lt 60) { return "${Seconds}s" }
    if ($Seconds -lt 3600) { return ('{0}m' -f [math]::Floor($Seconds / 60)) }
    return ('{0}h' -f [math]::Floor($Seconds / 3600))
}

if ($Json) {
    $health | ConvertTo-Json -Depth 8
}

if ($Human) {
    $result = if ($null -ne $health.lastTaskResult) { "$($health.lastTaskResult) ($($health.lastTaskResultHex))" } else { '—' }
    Write-Host "Task: $($health.taskState)"
    if ($health.processFound) {
        Write-Host "Process: OK pid=$($health.processId)"
    } else {
        Write-Host 'Process: ausente'
    }
    Write-Host "Heartbeat: $(Format-AgentAge $health.heartbeatAgeSeconds)"
    Write-Host "Queue check: $(Format-AgentAge $health.queueCheckAgeSeconds)"
    Write-Host "Last result: $result"
    $healthLabel = if ($health.healthy) {
        'OK'
    } elseif ($health.classification -eq 'degraded') {
        'DEGRADED'
    } else {
        'FAIL'
    }
    Write-Host "Health: $healthLabel"
    if (-not $health.healthy) {
        Write-Host "Reason: $($health.reason)"
        Write-Host "Recommended action: $($health.recommendedAction)"
    }
}
