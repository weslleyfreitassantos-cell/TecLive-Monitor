using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Management.Automation;
using System.Management.Automation.Host;
using System.Management.Automation.Runspaces;

internal static class HiddenProcessLauncher
{
    private static int Main(string[] args)
    {
        string scriptPath;
        Dictionary<string, string> parameters;
        if (!TryParseExpectedArguments(args, out scriptPath, out parameters))
        {
            return 64;
        }

        var host = new HiddenPowerShellHost();

        try
        {
            using (var runspace = RunspaceFactory.CreateRunspace(host))
            {
                runspace.Open();
                using (var powerShell = PowerShell.Create())
                {
                    powerShell.Runspace = runspace;
                    powerShell.AddCommand(scriptPath);
                    foreach (var parameter in parameters)
                    {
                        powerShell.AddParameter(parameter.Key, parameter.Value);
                    }
                    powerShell.Invoke();

                    if (host.ExitCode.HasValue)
                    {
                        return host.ExitCode.Value;
                    }
                    var lastExitCode = GetLastExitCode(runspace);
                    if (lastExitCode.HasValue)
                    {
                        return lastExitCode.Value;
                    }
                    return powerShell.HadErrors ? 1 : 0;
                }
            }
        }
        catch
        {
            return host.ExitCode.HasValue ? host.ExitCode.Value : 1;
        }
    }

    private static int? GetLastExitCode(Runspace runspace)
    {
        try
        {
            var value = runspace.SessionStateProxy.GetVariable("LASTEXITCODE");
            if (value == null)
            {
                return null;
            }
            return Convert.ToInt32(value, CultureInfo.InvariantCulture);
        }
        catch
        {
            return null;
        }
    }

    private static bool TryParseExpectedArguments(string[] args, out string scriptPath, out Dictionary<string, string> parameters)
    {
        scriptPath = null;
        parameters = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (args.Length < 1)
        {
            return false;
        }

        string fullPath;
        try
        {
            fullPath = Path.GetFullPath(args[0]);
        }
        catch
        {
            return false;
        }

        if (!File.Exists(fullPath) || !string.Equals(Path.GetExtension(fullPath), ".ps1", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        var scriptName = Path.GetFileName(fullPath);
        if (!IsExpectedScriptPath(fullPath))
        {
            return false;
        }

        if (string.Equals(scriptName, "cookie-sync-agent.ps1", StringComparison.OrdinalIgnoreCase))
        {
            if (args.Length != 3 || !IsParameter(args[1], "ConfigPath") || !IsExistingJsonFile(args[2]))
            {
                return false;
            }
            scriptPath = fullPath;
            parameters["ConfigPath"] = Path.GetFullPath(args[2]);
            return true;
        }

        if (string.Equals(scriptName, "cookie-agent-watchdog.ps1", StringComparison.OrdinalIgnoreCase))
        {
            if (args.Length != 5 || !IsParameter(args[1], "TaskName") || string.IsNullOrWhiteSpace(args[2]) || !IsParameter(args[3], "ConfigPath") || !IsExistingJsonFile(args[4]))
            {
                return false;
            }
            scriptPath = fullPath;
            parameters["TaskName"] = args[2];
            parameters["ConfigPath"] = Path.GetFullPath(args[4]);
            return true;
        }

        return false;
    }

    private static bool IsParameter(string value, string expected)
    {
        return string.Equals(value, "-" + expected, StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsExpectedScriptPath(string fullPath)
    {
        try
        {
            var expectedDirectory = Path.GetFullPath(Path.Combine(Environment.CurrentDirectory, "tools", "cookie-agent"));
            var actualDirectory = Path.GetDirectoryName(fullPath);
            return string.Equals(actualDirectory, expectedDirectory, StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return false;
        }
    }

    private static bool IsExistingJsonFile(string value)
    {
        try
        {
            var fullPath = Path.GetFullPath(value);
            return File.Exists(fullPath) && string.Equals(Path.GetExtension(fullPath), ".json", StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return false;
        }
    }
}

internal sealed class HiddenPowerShellHost : PSHost
{
    private readonly Guid instanceId = Guid.NewGuid();
    private readonly HiddenPowerShellUi ui = new HiddenPowerShellUi();

    public int? ExitCode { get; private set; }
    public override Guid InstanceId { get { return instanceId; } }
    public override string Name { get { return "TecLiveHiddenPowerShellHost"; } }
    public override Version Version { get { return new Version(1, 0, 0, 0); } }
    public override PSHostUserInterface UI { get { return ui; } }
    public override CultureInfo CurrentCulture { get { return CultureInfo.CurrentCulture; } }
    public override CultureInfo CurrentUICulture { get { return CultureInfo.CurrentUICulture; } }

    public override void SetShouldExit(int exitCode)
    {
        ExitCode = exitCode;
    }

    public override void EnterNestedPrompt() { }
    public override void ExitNestedPrompt() { }
    public override void NotifyBeginApplication() { }
    public override void NotifyEndApplication() { }
}

internal sealed class HiddenPowerShellUi : PSHostUserInterface
{
    private readonly HiddenPowerShellRawUi rawUi = new HiddenPowerShellRawUi();
    public override PSHostRawUserInterface RawUI { get { return rawUi; } }

    public override string ReadLine() { return string.Empty; }
    public override System.Security.SecureString ReadLineAsSecureString() { return new System.Security.SecureString(); }
    public override void Write(string value) { }
    public override void Write(ConsoleColor foregroundColor, ConsoleColor backgroundColor, string value) { }
    public override void WriteLine(string value) { }
    public override void WriteErrorLine(string value) { }
    public override void WriteDebugLine(string message) { }
    public override void WriteProgress(long sourceId, ProgressRecord record) { }
    public override void WriteVerboseLine(string message) { }
    public override void WriteWarningLine(string message) { }
    public override Dictionary<string, PSObject> Prompt(string caption, string message, System.Collections.ObjectModel.Collection<FieldDescription> descriptions)
    {
        return new Dictionary<string, PSObject>();
    }
    public override int PromptForChoice(string caption, string message, System.Collections.ObjectModel.Collection<ChoiceDescription> choices, int defaultChoice)
    {
        return defaultChoice;
    }
    public override PSCredential PromptForCredential(string caption, string message, string userName, string targetName)
    {
        return null;
    }
    public override PSCredential PromptForCredential(string caption, string message, string userName, string targetName, PSCredentialTypes allowedCredentialTypes, PSCredentialUIOptions options)
    {
        return null;
    }
}

internal sealed class HiddenPowerShellRawUi : PSHostRawUserInterface
{
    private Size bufferSize = new Size(120, 3000);
    private Coordinates cursorPosition = new Coordinates(0, 0);
    private Size windowSize = new Size(120, 40);

    public override ConsoleColor BackgroundColor { get; set; }
    public override Size BufferSize { get { return bufferSize; } set { bufferSize = value; } }
    public override Coordinates CursorPosition { get { return cursorPosition; } set { cursorPosition = value; } }
    public override int CursorSize { get; set; }
    public override ConsoleColor ForegroundColor { get; set; }
    public override bool KeyAvailable { get { return false; } }
    public override Size MaxPhysicalWindowSize { get { return windowSize; } }
    public override Size MaxWindowSize { get { return windowSize; } }
    public override Coordinates WindowPosition { get; set; }
    public override Size WindowSize { get { return windowSize; } set { windowSize = value; } }
    public override string WindowTitle { get; set; }

    public override void FlushInputBuffer() { }
    public override BufferCell[,] GetBufferContents(Rectangle rectangle) { return new BufferCell[0, 0]; }
    public override KeyInfo ReadKey(ReadKeyOptions options) { return new KeyInfo(); }
    public override void ScrollBufferContents(Rectangle source, Coordinates destination, Rectangle clip, BufferCell fill) { }
    public override void SetBufferContents(Coordinates origin, BufferCell[,] contents) { }
    public override void SetBufferContents(Rectangle rectangle, BufferCell fill) { }
}
