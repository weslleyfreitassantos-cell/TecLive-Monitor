Option Explicit

Dim shell, fso, scriptDir, launcherPath, agentTaskName, configPath, projectRoot, watchdogScript, command, exitCode

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

If WScript.Arguments.Count < 4 Then
    WScript.Quit 64
End If

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
launcherPath = WScript.Arguments(0)
agentTaskName = WScript.Arguments(1)
configPath = WScript.Arguments(2)
projectRoot = WScript.Arguments(3)
watchdogScript = fso.BuildPath(scriptDir, "cookie-agent-watchdog.ps1")

If Not fso.FileExists(launcherPath) Then
    WScript.Quit 66
End If
If Not fso.FileExists(watchdogScript) Then
    WScript.Quit 66
End If
If Not fso.FileExists(configPath) Then
    WScript.Quit 66
End If
If fso.FolderExists(projectRoot) Then
    shell.CurrentDirectory = projectRoot
End If

command = QuoteArg(launcherPath) & " " & QuoteArg(watchdogScript) & " -TaskName " & QuoteArg(agentTaskName) & " -ConfigPath " & QuoteArg(configPath)

exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode

Function QuoteArg(value)
    QuoteArg = Chr(34) & Replace(CStr(value), Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function
