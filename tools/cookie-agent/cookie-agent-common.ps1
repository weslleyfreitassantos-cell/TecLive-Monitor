Set-StrictMode -Version Latest

function Redact-CookieAgentText {
    param([AllowNull()][string]$Text)
    $safe = [string]$Text
    $safe = $safe -replace '(Authorization:\s*Bearer\s+)[^\s]+', '$1[redacted]'
    $safe = $safe -replace '(Bearer\s+)[A-Za-z0-9+/_=.-]{12,}', '$1[redacted]'
    $safe = $safe -replace '(token["'':=\s]+)[^"'',\s]+', '$1[redacted]'
    $safe = $safe -replace '# Netscape HTTP Cookie File[\s\S]*', '[cookie content redacted]'
    $safe = $safe -replace '[A-Za-z]:\\[^\s"'']+', '[path]'
    $safe = $safe -replace '/(?:var|home|root|etc|opt)/[^\s"'']+', '[path]'
    return ($safe -replace '\s+', ' ').Trim()
}

function ConvertTo-CookieAgentHashtable {
    param([AllowNull()][object]$Value)
    if ($null -eq $Value) { return @{} }
    if ($Value -is [hashtable]) { return $Value }
    $table = @{}
    foreach ($property in $Value.PSObject.Properties) {
        $table[$property.Name] = $property.Value
    }
    return $table
}

function Read-CookieAgentJsonFile {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return @{}
    }
    try {
        return ConvertTo-CookieAgentHashtable (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json)
    } catch {
        return @{
            invalidJson = $true
            path = Redact-CookieAgentText $Path
            error = Redact-CookieAgentText $_.Exception.Message
        }
    }
}

function Save-CookieAgentJsonAtomic {
    param([string]$Path, [hashtable]$Data)
    $dir = Split-Path $Path -Parent
    if (-not (Test-Path -LiteralPath $dir)) {
        [void](New-Item -ItemType Directory -Path $dir -Force)
    }
    $tmp = Join-Path $dir ('.{0}.{1}.{2}.tmp' -f (Split-Path $Path -Leaf), $PID, [guid]::NewGuid().ToString('N'))
    $Data | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $tmp -Encoding UTF8
    Move-Item -LiteralPath $tmp -Destination $Path -Force
}

function Write-CookieAgentLog {
    param(
        [string]$Path,
        [string]$Message,
        [switch]$VerboseOutput
    )
    $dir = Split-Path $Path -Parent
    if (-not (Test-Path -LiteralPath $dir)) {
        [void](New-Item -ItemType Directory -Path $dir -Force)
    }
    $line = '{0} {1}' -f (Get-Date -Format o), (Redact-CookieAgentText $Message)
    Add-Content -LiteralPath $Path -Value $line -Encoding UTF8
    if ($VerboseOutput) { Write-Host $line }
}

function Resolve-CookieAgentPath {
    param([string]$ProjectPath, [string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) { return $Value }
    if ([System.IO.Path]::IsPathRooted($Value)) {
        $resolved = Resolve-Path -LiteralPath $Value -ErrorAction SilentlyContinue
        if ($resolved) { return $resolved.Path }
        return $Value
    }
    return (Join-Path $ProjectPath $Value)
}

function Get-CookieAgentRuntimeStatePath {
    param([string]$ScriptRoot)
    if (-not [string]::IsNullOrWhiteSpace($env:COOKIE_AGENT_RUNTIME_STATE_PATH)) {
        return $env:COOKIE_AGENT_RUNTIME_STATE_PATH
    }
    return (Join-Path $ScriptRoot 'agent-runtime-state.json')
}

function Get-CookieAgentHiddenLauncherPath {
    $base = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'TecLive\CookieAgent'
    return (Join-Path $base 'hidden-process-launcher.exe')
}

function Get-CookieAgentHiddenLauncherMetadataPath {
    param([string]$LauncherPath)
    $launcherPath = if ([string]::IsNullOrWhiteSpace($LauncherPath)) { Get-CookieAgentHiddenLauncherPath } else { $LauncherPath }
    return "$launcherPath.meta.json"
}

function Get-CookieAgentFileHash {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

function Get-CookieAgentSid {
    param([System.Security.Principal.WellKnownSidType]$Type)
    return [System.Security.Principal.SecurityIdentifier]::new($Type, $null)
}

function Set-CookieAgentSecureAcl {
    param(
        [string]$Path,
        [switch]$Directory
    )
    $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $system = Get-CookieAgentSid ([System.Security.Principal.WellKnownSidType]::LocalSystemSid)
    $admins = Get-CookieAgentSid ([System.Security.Principal.WellKnownSidType]::BuiltinAdministratorsSid)

    if ($Directory) {
        $acl = [System.Security.AccessControl.DirectorySecurity]::new()
        $inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
    } else {
        $acl = [System.Security.AccessControl.FileSecurity]::new()
        $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
    }
    $propagation = [System.Security.AccessControl.PropagationFlags]::None
    $rights = [System.Security.AccessControl.FileSystemRights]::FullControl
    $type = [System.Security.AccessControl.AccessControlType]::Allow

    foreach ($sid in @($currentUser, $system, $admins)) {
        $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, $rights, $inheritance, $propagation, $type)
        $acl.AddAccessRule($rule)
    }
    $acl.SetAccessRuleProtection($true, $false)
    Set-Acl -LiteralPath $Path -AclObject $acl
}

function Protect-CookieAgentHiddenLauncherPath {
    param([string]$LauncherPath)
    $launcherPath = if ([string]::IsNullOrWhiteSpace($LauncherPath)) { Get-CookieAgentHiddenLauncherPath } else { $LauncherPath }
    $dir = Split-Path $launcherPath -Parent
    if (Test-Path -LiteralPath $dir -PathType Container) {
        Set-CookieAgentSecureAcl -Path $dir -Directory
    }
    foreach ($path in @($launcherPath, (Get-CookieAgentHiddenLauncherMetadataPath -LauncherPath $launcherPath))) {
        if (Test-Path -LiteralPath $path -PathType Leaf) {
            Set-CookieAgentSecureAcl -Path $path
        }
    }
}

function Test-CookieAgentHiddenLauncherCurrent {
    param([string]$Source, [string]$LauncherPath)
    $target = if ([string]::IsNullOrWhiteSpace($LauncherPath)) { Get-CookieAgentHiddenLauncherPath } else { $LauncherPath }
    $metadataPath = Get-CookieAgentHiddenLauncherMetadataPath -LauncherPath $target
    if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { return $false }
    if (-not (Test-Path -LiteralPath $metadataPath -PathType Leaf)) { return $false }
    $metadata = Read-CookieAgentJsonFile -Path $metadataPath
    if ($metadata.ContainsKey('invalidJson') -and $metadata.invalidJson) { return $false }

    $sourceHash = Get-CookieAgentFileHash -Path $Source
    $binaryHash = Get-CookieAgentFileHash -Path $target
    if ([string]::IsNullOrWhiteSpace($sourceHash) -or [string]::IsNullOrWhiteSpace($binaryHash)) { return $false }
    if ([string]$metadata.sourceHash -ne $sourceHash) { return $false }
    if ([string]$metadata.binaryHash -ne $binaryHash) { return $false }
    return $true
}

function Get-CookieAgentCSharpCompilerPath {
    $candidates = @(
        (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
        (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    $command = Get-Command csc.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    return $null
}

function Get-CookieAgentPowerShellAutomationPath {
    try {
        $assemblyPath = ([System.Management.Automation.PSObject].Assembly.Location)
        if (Test-Path -LiteralPath $assemblyPath -PathType Leaf) { return $assemblyPath }
    } catch {}
    $candidates = @(
        (Join-Path $env:WINDIR 'Microsoft.NET\assembly\GAC_MSIL\System.Management.Automation\v4.0_3.0.0.0__31bf3856ad364e35\System.Management.Automation.dll'),
        (Join-Path $env:WINDIR 'assembly\GAC_MSIL\System.Management.Automation\1.0.0.0__31bf3856ad364e35\System.Management.Automation.dll')
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    return $null
}

function Install-CookieAgentHiddenLauncher {
    param([string]$ScriptRoot, [string]$OutputPath)

    $source = Join-Path $ScriptRoot 'hidden-process-launcher.cs'
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "Codigo-fonte do launcher sem console ausente: $source"
    }

    $target = if ([string]::IsNullOrWhiteSpace($OutputPath)) { Get-CookieAgentHiddenLauncherPath } else { $OutputPath }
    $targetDir = Split-Path $target -Parent
    if (-not (Test-Path -LiteralPath $targetDir)) {
        [void](New-Item -ItemType Directory -Path $targetDir -Force)
    }
    Protect-CookieAgentHiddenLauncherPath -LauncherPath $target

    if (Test-CookieAgentHiddenLauncherCurrent -Source $source -LauncherPath $target) {
        Protect-CookieAgentHiddenLauncherPath -LauncherPath $target
        return $target
    }

    $compiler = Get-CookieAgentCSharpCompilerPath
    if ([string]::IsNullOrWhiteSpace($compiler)) {
        throw 'Compilador C# nao encontrado. O launcher sem console exige .NET Framework csc.exe.'
    }
    $automation = Get-CookieAgentPowerShellAutomationPath
    if ([string]::IsNullOrWhiteSpace($automation)) {
        throw 'System.Management.Automation.dll nao encontrado. O launcher sem console exige Windows PowerShell 5.1.'
    }

    $tmp = Join-Path $targetDir ('.hidden-process-launcher.{0}.{1}.tmp.exe' -f $PID, [guid]::NewGuid().ToString('N'))
    try {
        $output = & $compiler @('/nologo', '/target:winexe', '/optimize+', "/reference:$automation", "/out:$tmp", $source) 2>&1
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $tmp -PathType Leaf)) {
            throw "Falha ao compilar launcher sem console: $($output -join ' ')"
        }
        Move-Item -LiteralPath $tmp -Destination $target -Force
    } catch {
        Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
        Protect-CookieAgentHiddenLauncherPath -LauncherPath $target
        throw
    }
    $metadata = @{
        sourceHash = Get-CookieAgentFileHash -Path $source
        binaryHash = Get-CookieAgentFileHash -Path $target
        builtAt = (Get-Date).ToString('o')
        sourceName = (Split-Path $source -Leaf)
    }
    Save-CookieAgentJsonAtomic -Path (Get-CookieAgentHiddenLauncherMetadataPath -LauncherPath $target) -Data $metadata
    Protect-CookieAgentHiddenLauncherPath -LauncherPath $target
    return $target
}

function Update-CookieAgentRuntimeState {
    param([string]$Path, [hashtable]$Patch)
    $state = Read-CookieAgentJsonFile -Path $Path
    if ($state.ContainsKey('invalidJson') -and $state.invalidJson) { $state = @{} }
    foreach ($key in $Patch.Keys) {
        $state[$key] = $Patch[$key]
    }
    Save-CookieAgentJsonAtomic -Path $Path -Data $state
    return $state
}

function Get-CookieAgentAgeSeconds {
    param([AllowNull()][object]$Value, [datetime]$Now = (Get-Date))
    if (-not $Value) { return $null }
    try {
        $date = [datetime]$Value
        if ($date.Year -lt 1971) { return $null }
        return [math]::Max(0, [int]($Now - $date).TotalSeconds)
    } catch {
        return $null
    }
}

function ConvertTo-CookieAgentTaskResultHex {
    param([AllowNull()][object]$Value)
    if ($null -eq $Value) { return $null }
    try {
        $number = [uint32]([int64]$Value -band 0xffffffff)
        return ('0x{0:X8}' -f $number)
    } catch {
        return $null
    }
}

function Test-CookieAgentProcessMatches {
    param(
        [AllowNull()][object]$Process,
        [string]$ConfigPath,
        [string]$AgentScriptName = 'cookie-sync-agent.ps1'
    )
    if (-not $Process) { return $false }
    $cmd = [string]$Process.CommandLine
    if ([string]::IsNullOrWhiteSpace($cmd)) { return $false }
    $processName = if ($Process.PSObject.Properties['Name']) { [string]$Process.Name } else { '' }
    if ($processName -eq 'hidden-process-launcher.exe') {
        $launcherPath = Get-CookieAgentHiddenLauncherPath
        $resolvedLauncher = Resolve-Path -LiteralPath $launcherPath -ErrorAction SilentlyContinue
        $launcherCandidates = @($launcherPath)
        if ($resolvedLauncher) { $launcherCandidates += $resolvedLauncher.Path }
        $launcherMatched = $false
        foreach ($candidate in $launcherCandidates) {
            if (-not [string]::IsNullOrWhiteSpace($candidate) -and $cmd -match [regex]::Escape($candidate)) {
                $launcherMatched = $true
                break
            }
        }
        if (-not $launcherMatched) { return $false }
    }
    if ($cmd -notmatch [regex]::Escape($AgentScriptName)) { return $false }
    if (-not [string]::IsNullOrWhiteSpace($ConfigPath) -and $cmd -match '(?i)-ConfigPath') {
        $resolved = Resolve-Path -LiteralPath $ConfigPath -ErrorAction SilentlyContinue
        $candidates = @($ConfigPath, (Split-Path $ConfigPath -Leaf))
        if ($resolved) { $candidates += $resolved.Path }
        $matched = $false
        foreach ($candidate in $candidates) {
            if (-not [string]::IsNullOrWhiteSpace($candidate) -and $cmd -match [regex]::Escape($candidate)) {
                $matched = $true
                break
            }
        }
        if (-not $matched) { return $false }
    }
    return $true
}

function Get-CookieAgentProcessList {
    param(
        [string]$ConfigPath,
        [string]$AgentScriptName = 'cookie-sync-agent.ps1'
    )
    $items = @()
    try {
        $items = Get-CimInstance Win32_Process -ErrorAction Stop |
            Where-Object { $_.Name -in @('powershell.exe', 'pwsh.exe', 'hidden-process-launcher.exe') }
    } catch {
        try {
            $items = Get-WmiObject Win32_Process -ErrorAction Stop |
                Where-Object { $_.Name -in @('powershell.exe', 'pwsh.exe', 'hidden-process-launcher.exe') }
        } catch {
            return @()
        }
    }
    return @($items | Where-Object {
        Test-CookieAgentProcessMatches -Process $_ -ConfigPath $ConfigPath -AgentScriptName $AgentScriptName
    } | ForEach-Object {
        [pscustomobject]@{
            ProcessId = [int]$_.ProcessId
            Name = [string]$_.Name
            CommandLine = [string]$_.CommandLine
            CreationDate = $_.CreationDate
        }
    })
}

function Test-CookieAgentPidActive {
    param(
        [Alias('Pid')]
        [AllowNull()][object]$ProcessId,
        [string]$ConfigPath,
        [AllowNull()][object[]]$ProcessList = $null
    )
    if (-not $ProcessId) { return $false }
    $pidNumber = 0
    if (-not [int]::TryParse([string]$ProcessId, [ref]$pidNumber)) { return $false }
    if ($PSBoundParameters.ContainsKey('ProcessList')) {
        $matches = @($ProcessList | Where-Object {
            $_ -and $_.PSObject.Properties['ProcessId'] -and [int]$_.ProcessId -eq $pidNumber
        })
        $process = if ($matches.Count -gt 0) { $matches[0] } else { $null }
        return (Test-CookieAgentProcessMatches -Process $process -ConfigPath $ConfigPath)
    }
    $processes = Get-CookieAgentProcessList -ConfigPath $ConfigPath
    return [bool](@($processes | Where-Object { [int]$_.ProcessId -eq $pidNumber }).Count -gt 0)
}

function Get-CookieAgentTaskHealth {
    param(
        [string]$TaskName = 'TecLive Cookie Sync Agent',
        [string]$ConfigPath,
        [string]$RuntimeStatePath,
        [string]$LogPath,
        [int]$StaleMinutes = 5,
        [int]$QueuedMinutes = 2,
        [datetime]$Now = (Get-Date),
        [AllowNull()][object]$MockTask = $null,
        [AllowNull()][object]$MockTaskInfo = $null,
        [AllowNull()][object[]]$MockProcesses = $null,
        [AllowNull()][hashtable]$MockRuntimeState = $null
    )

    $task = $MockTask
    $taskInfo = $MockTaskInfo
    if (-not $PSBoundParameters.ContainsKey('MockTask')) {
        try { $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } catch { $task = $null }
    }
    if ($task -and -not $PSBoundParameters.ContainsKey('MockTaskInfo')) {
        try { $taskInfo = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue } catch { $taskInfo = $null }
    }

    $processes = if ($PSBoundParameters.ContainsKey('MockProcesses')) {
        @($MockProcesses | Where-Object { Test-CookieAgentProcessMatches -Process $_ -ConfigPath $ConfigPath })
    } else {
        @(Get-CookieAgentProcessList -ConfigPath $ConfigPath)
    }

    $runtime = if ($PSBoundParameters.ContainsKey('MockRuntimeState')) {
        $MockRuntimeState
    } elseif ($RuntimeStatePath) {
        Read-CookieAgentJsonFile -Path $RuntimeStatePath
    } else {
        @{}
    }

    $taskState = if ($task) { [string]$task.State } else { 'Missing' }
    $lastRunTime = if ($taskInfo) { $taskInfo.LastRunTime } else { $null }
    $lastTaskResult = if ($taskInfo) { $taskInfo.LastTaskResult } else { $null }
    $lastTaskResultHex = ConvertTo-CookieAgentTaskResultHex -Value $lastTaskResult
    $processArray = @($processes)
    $process = if ($processArray.Count -gt 0) { $processArray[0] } else { $null }
    $processFound = [bool]$process
    $processName = if ($process -and $process.PSObject.Properties['Name']) { [string]$process.Name } elseif ($process -and $process.PSObject.Properties['processName']) { [string]$process.processName } else { '' }
    $processIsDetachedLauncher = ($processName -eq 'hidden-process-launcher.exe')
    $runtimeHeartbeatAt = if ($runtime.ContainsKey('lastHeartbeatAt')) { $runtime.lastHeartbeatAt } else { $null }
    $runtimeQueueCheckAt = if ($runtime.ContainsKey('lastQueueCheckAt')) { $runtime.lastQueueCheckAt } else { $null }
    $runtimePid = if ($runtime.ContainsKey('pid')) { $runtime.pid } else { $null }
    $heartbeatAge = Get-CookieAgentAgeSeconds -Value $runtimeHeartbeatAt -Now $Now
    $queueAge = Get-CookieAgentAgeSeconds -Value $runtimeQueueCheckAt -Now $Now
    $logAge = $null
    if ($LogPath -and (Test-Path -LiteralPath $LogPath -PathType Leaf)) {
        $logAge = [int]($Now - (Get-Item -LiteralPath $LogPath).LastWriteTime).TotalSeconds
    }
    $statePidDead = $false
    if ($runtimePid) {
        $statePidDead = -not (Test-CookieAgentPidActive -Pid $runtimePid -ConfigPath $ConfigPath -ProcessList $processes)
    }
    $heartbeatRecent = ($null -ne $heartbeatAge -and $heartbeatAge -le ($StaleMinutes * 60))
    $queueRecent = ($null -ne $queueAge -and $queueAge -le ($QueuedMinutes * 60))
    $activityAgeCandidates = @()
    if ($null -ne $heartbeatAge) { $activityAgeCandidates += [int]$heartbeatAge }
    if ($null -ne $queueAge) { $activityAgeCandidates += [int]$queueAge }
    $activityAge = if ($activityAgeCandidates.Count -gt 0) { [int](($activityAgeCandidates | Measure-Object -Minimum).Minimum) } else { $null }
    $activityRecent = ($heartbeatRecent -or $queueRecent)
    $taskEffectivelyRunning = ($taskState -eq 'Running' -or ($taskState -eq 'Ready' -and $processIsDetachedLauncher))
    $healthy = ($taskEffectivelyRunning -and $processFound -and $activityRecent -and -not $statePidDead)
    $degraded = $false
    $reason = 'ok'
    $recommended = 'none'

    if (-not $task) {
        if ($activityRecent) {
            $reason = 'task-missing-recent-activity'; $recommended = 'observe'; $degraded = $true
        } else {
            $reason = 'task-missing'; $recommended = 'recreate-task'
        }
    } elseif ($taskState -eq 'Disabled') {
        if ($activityRecent) {
            $reason = 'task-disabled-recent-activity'; $recommended = 'observe'; $degraded = $true
        } else {
            $reason = 'task-disabled'; $recommended = 'recreate-task'
        }
    } elseif ($healthy) {
        $reason = 'ok'; $recommended = 'none'
    } elseif ($lastTaskResultHex -eq '0xC000013A' -and $activityRecent) {
        $reason = 'interrupted-recent-activity'; $recommended = 'observe'; $degraded = $true
    } elseif ($lastTaskResultHex -eq '0xC000013A' -and -not $processFound) {
        $reason = 'interrupted-0xC000013A'; $recommended = 'recreate-task'
    } elseif (-not $processFound -and $activityRecent) {
        $reason = 'recent-activity-without-process'; $recommended = 'observe'; $degraded = $true
    } elseif ($taskState -eq 'Running' -and -not $processFound) {
        $reason = 'running-without-process'; $recommended = 'stop-start'
    } elseif ($taskState -eq 'Queued' -and -not $processFound) {
        $reason = 'queued-without-process'; $recommended = 'stop-start'
    } elseif ($taskState -eq 'Ready' -and -not $processFound -and -not $activityRecent) {
        $reason = 'ready-stale'; $recommended = 'start-task'
    } elseif ($statePidDead) {
        $reason = 'state-pid-dead'; $recommended = 'cleanup-state'
    } elseif ($processFound -and $taskState -ne 'Running') {
        $reason = 'process-task-not-running'; $recommended = 'observe'; $degraded = $true
    } elseif (-not $activityRecent) {
        $reason = 'stale-heartbeat'; $recommended = 'stop-start'
    }
    if ($healthy) { $reason = 'ok'; $recommended = 'none'; $degraded = $false }
    $classification = if ($healthy) { 'ok' } elseif ($degraded) { 'degraded' } else { 'fail' }

    return [pscustomobject]@{
        taskName = $TaskName
        taskState = $taskState
        lastRunTime = $lastRunTime
        lastTaskResult = $lastTaskResult
        lastTaskResultHex = $lastTaskResultHex
        processFound = $processFound
        processId = if ($process) { [int]$process.ProcessId } else { $null }
        processName = $processName
        processStartTime = if ($process) { $process.CreationDate } else { $null }
        runtimeState = $runtime
        runtimeStateInvalid = [bool]($runtime.ContainsKey('invalidJson') -and $runtime.invalidJson)
        statePidDead = $statePidDead
        heartbeatAgeSeconds = $heartbeatAge
        queueCheckAgeSeconds = $queueAge
        activityAgeSeconds = $activityAge
        activityRecent = $activityRecent
        logAgeSeconds = $logAge
        healthy = $healthy
        degraded = $degraded
        classification = $classification
        reason = $reason
        recommendedAction = $recommended
        observedAt = $Now.ToString('o')
    }
}
