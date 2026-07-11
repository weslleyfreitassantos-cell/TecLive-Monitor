[CmdletBinding()]
param(
    [string]$TaskName = 'TecLive Cookie Sync Agent'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) {
    Write-Host "Tarefa nao encontrada: $TaskName"
    exit 0
}

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Host "Tarefa removida: $TaskName"
Write-Host "Config, state e logs nao foram apagados."
