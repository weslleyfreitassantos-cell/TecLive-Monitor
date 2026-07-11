[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$TaskName = 'TecLive Cookie Sync Watchdog'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module ScheduledTasks -ErrorAction Stop

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) {
    Write-Host "Tarefa nao encontrada: $TaskName"
    exit 0
}

if ($PSCmdlet.ShouldProcess($TaskName, 'remover tarefa watchdog')) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Tarefa removida: $TaskName"
} else {
    Write-Host "Tarefa validada para remocao: $TaskName"
}
Write-Host 'Config, state e logs nao foram apagados.'
