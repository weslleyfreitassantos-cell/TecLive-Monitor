Option Explicit

Dim shell, fso, scriptDir, launcherPath, configPath, projectRoot, agentScript, command

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

If WScript.Arguments.Count < 3 Then
    WScript.Quit 64
End If

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
launcherPath = WScript.Arguments(0)
configPath = WScript.Arguments(1)
projectRoot = WScript.Arguments(2)
agentScript = fso.BuildPath(scriptDir, "cookie-sync-agent.ps1")

If Not fso.FileExists(launcherPath) Then
    WScript.Quit 66
End If
If Not fso.FileExists(agentScript) Then
    WScript.Quit 66
End If
If Not fso.FileExists(configPath) Then
    WScript.Quit 66
End If
If fso.FolderExists(projectRoot) Then
    shell.CurrentDirectory = projectRoot
End If

command = QuoteArg(launcherPath) & " " & QuoteArg(agentScript) & " -ConfigPath " & QuoteArg(configPath)

' Let the continuous agent live independently of the Task Scheduler wrapper.
Call shell.Run(command, 0, False)
WScript.Quit 0

Function QuoteArg(value)
    QuoteArg = Chr(34) & Replace(CStr(value), Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function
