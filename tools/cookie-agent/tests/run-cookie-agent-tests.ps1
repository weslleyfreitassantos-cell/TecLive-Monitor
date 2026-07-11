[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Split-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) -Parent
$agent = Join-Path $root 'tools\cookie-agent\cookie-sync-agent.ps1'
$install = Join-Path $root 'tools\cookie-agent\install-agent-task.ps1'
$uninstall = Join-Path $root 'tools\cookie-agent\uninstall-agent-task.ps1'

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

function Invoke-Agent {
    param([string[]]$Arguments)
    $psExe = (Get-Process -Id $PID).Path
    $oldPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $psExe -NoProfile -ExecutionPolicy Bypass -File $agent @Arguments *> $null
        return $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $oldPreference
    }
}

foreach ($file in @($agent, $install, $uninstall)) {
    $tokens = $null
    $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$errors) > $null
    Assert-True ($errors.Count -eq 0) "Parser falhou em $file"
}

$content = Get-Content -LiteralPath $agent -Raw
$installContent = Get-Content -LiteralPath $install -Raw
Assert-True ($content -notmatch 'Invoke-Expression') 'Invoke-Expression nao deve ser usado'
Assert-True ($content -match 'Mutex') 'Mutex/lock local ausente'
Assert-True ($content -match 'Authorization = "Bearer') 'Bearer token header ausente'
Assert-True ($content -match 'Redact-SensitiveText') 'Redacao de dados sensiveis ausente'
Assert-True ($content -match 'HTTP e permitido apenas para localhost') 'Validacao HTTPS ausente'
Assert-True ($content -match 'Assert-AgentApiSuccess') 'Validacao de resposta da API ausente'
Assert-True ($content -match 'pendingReport') 'Retry/idempotencia de complete/fail ausente'
Assert-True ($content -match "marcar running") 'Falha ao marcar running deve ser tratada antes do Cookie Sync'
Assert-True ($content -notmatch "-All") 'Agente nao deve executar -All'
Assert-True ($installContent -match 'RunAsAdmin') 'Parametro RunAsAdmin ausente no instalador'
Assert-True ($installContent -match "'Highest'") 'RunAsAdmin deve usar Highest'
Assert-True ($installContent -match "'Limited'") 'Padrao deve usar Limited'
Assert-True ($installContent -notmatch '-RunLevel\s+LeastPrivilege') 'Instalador nao deve usar LeastPrivilege'
Assert-True ($installContent -match 'RunLevelEnum') 'Deteccao defensiva do enum RunLevelEnum ausente'

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("cookie-agent-test-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
    $installConfig = Join-Path $tmp 'install-config.json'
    '{}' | Set-Content -LiteralPath $installConfig -Encoding UTF8
    $defaultTaskName = "Cookie Agent Test Default $([guid]::NewGuid().ToString('N'))"
    $adminTaskName = "Cookie Agent Test Admin $([guid]::NewGuid().ToString('N'))"
    $defaultInstall = (& $install -TaskName $defaultTaskName -ConfigPath $installConfig -WhatIf *>&1) -join "`n"
    $adminInstall = (& $install -TaskName $adminTaskName -ConfigPath $installConfig -RunAsAdmin -WhatIf *>&1) -join "`n"
    Assert-True ($defaultInstall -match 'RunLevel:\s+Limited') 'Padrao do instalador deve usar Limited'
    Assert-True ($adminInstall -match 'RunLevel:\s+Highest') 'RunAsAdmin deve usar Highest'
    Assert-True (($defaultInstall + $adminInstall) -notmatch 'RunLevel:\s+LeastPrivilege') 'Instalador nunca deve usar LeastPrivilege'
    $createdInstallTasks = Get-ScheduledTask -TaskName $defaultTaskName, $adminTaskName -ErrorAction SilentlyContinue
    Assert-True (-not $createdInstallTasks) 'Teste do instalador nao deve criar tarefa real'

    $missing = Join-Path $tmp 'missing.json'
    $missingExit = Invoke-Agent -Arguments @('-Once', '-DryRun', '-ConfigPath', $missing)
    Assert-True ($missingExit -ne 0) 'Config ausente deveria falhar'

    $invalid = Join-Path $tmp 'invalid.json'
    Set-Content -LiteralPath $invalid -Value '{ invalid json' -Encoding UTF8
    $invalidExit = Invoke-Agent -Arguments @('-Once', '-DryRun', '-ConfigPath', $invalid)
    Assert-True ($invalidExit -ne 0) 'JSON invalido deveria falhar'

    $badUrl = Join-Path $tmp 'bad-url.json'
    @{
        server = @{ baseUrl = 'http://example.com'; token = 'secret-token'; pollSeconds = 1; timeoutSeconds = 5 }
        agent = @{ id = 'agent-test'; version = '1.0.0' }
        paths = @{ projectPath = $root; cookieSyncScript = 'tools\cookie-sync\export-and-upload.ps1'; logPath = "$tmp\agent.log"; statePath = "$tmp\state.json" }
    } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $badUrl -Encoding UTF8
    $badUrlExit = Invoke-Agent -Arguments @('-Once', '-DryRun', '-ConfigPath', $badUrl)
    Assert-True ($badUrlExit -ne 0) 'HTTP nao-localhost deveria falhar'

    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Parse('127.0.0.1'), 0)
    $listener.Start()
    $port = $listener.LocalEndpoint.Port
    $listener.Stop()

    $mock = Join-Path $tmp 'mock-api.js'
    @'
const http = require('http');
const port = Number(process.argv[2]);
const calls = [];
const server = http.createServer((req, res) => {
  calls.push({ method: req.method, url: req.url, auth: req.headers.authorization || '' });
  if (req.url === '/api/cookie-agent/heartbeat') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
    return;
  }
  if (req.url === '/api/cookie-agent/jobs/next') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ success: true, job: { id: 'job-1', cookie: 'cookie2', status: 'pending' } }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ success: false }));
});
server.listen(port, '127.0.0.1');
'@ | Set-Content -LiteralPath $mock -Encoding UTF8

    $node = (Get-Command node -ErrorAction Stop).Source
    $server = Start-Process -FilePath $node -ArgumentList @($mock, [string]$port) -PassThru -WindowStyle Hidden
    Start-Sleep -Seconds 1
    try {
        $config = Join-Path $tmp 'config.json'
        @{
            server = @{ baseUrl = "http://localhost:$port"; token = 'secret-token-for-tests'; pollSeconds = 1; timeoutSeconds = 5 }
            agent = @{ id = 'agent-test'; version = '1.0.0-test' }
            paths = @{ projectPath = $root; cookieSyncScript = 'tools\cookie-sync\export-and-upload.ps1'; logPath = "$tmp\agent.log"; statePath = "$tmp\state.json" }
        } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $config -Encoding UTF8

        $dryRunExit = Invoke-Agent -Arguments @('-Once', '-DryRun', '-ConfigPath', $config, '-VerboseOutput')
        Assert-True ($dryRunExit -eq 0) 'DryRun com API mock deveria passar'
        $log = Get-Content -LiteralPath "$tmp\agent.log" -Raw
        Assert-True ($log -match 'DryRun') 'DryRun deveria ser registrado'
        Assert-True ($log -notmatch 'secret-token-for-tests') 'Token nao deve aparecer no log'
    } finally {
        Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
    }
} finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host 'Cookie Agent PowerShell tests OK'
