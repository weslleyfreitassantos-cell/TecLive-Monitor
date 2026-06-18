# start-scheduler.ps1
param([int]$MaxConcurrent = 10)
$env:MAX_CONCURRENT_LIVES = $MaxConcurrent
Write-Host "Iniciando servidor com maxConcurrent = $MaxConcurrent" -ForegroundColor Cyan
node app.js
