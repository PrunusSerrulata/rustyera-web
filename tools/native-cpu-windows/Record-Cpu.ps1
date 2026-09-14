param(
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [ValidateRange(1, 900)][int]$DurationSeconds = 300
)
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'Native CPU ETW recording is Windows-only.'
}
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'WPR CPU recording requires an elevated Windows administrator token.'
}
if ($OutputDirectory -notmatch '^[A-Za-z]:[\\/]') { throw 'Local absolute output directory required.' }
$output = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $output) { throw 'Output directory must be new.' }
$null = New-Item -ItemType Directory -Path $output
$wpr = Join-Path ([Environment]::GetFolderPath('Windows')) 'System32/wpr.exe'
$instance = 'RustyEraCpu-' + [Guid]::NewGuid().ToString('N')
$active = $false
$result = [ordered]@{
    schemaVersion = 1; platform = 'windows'; profiler = 'WPR CPU'; instance = $instance
    recorderPid = $PID; startedUtc = [DateTime]::UtcNow.ToString('o')
    wpr = $wpr; wprSha256 = (Get-FileHash -LiteralPath $wpr -Algorithm SHA256).Hash
    durationSeconds = $DurationSeconds; status = 'failed'; commands = @()
}
function Invoke-Recorder([string]$name, [string[]]$arguments, [int]$timeoutMs) {
    # Process.Start retains the native handle even when WPR exits before the first poll.
    # Windows PowerShell Start-Process -PassThru can otherwise expose a null ExitCode.
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $wpr
    $info.Arguments = $arguments -join ' '
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $process = [Diagnostics.Process]::Start($info)
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    $completed = $process.WaitForExit($timeoutMs)
    if (-not $completed) { $process.Kill(); $process.WaitForExit(); }
    $process.Refresh()
    $code = $process.ExitCode
    $stdout.GetAwaiter().GetResult() | Set-Content -LiteralPath (Join-Path $output "$name.stdout.log")
    $stderr.GetAwaiter().GetResult() | Set-Content -LiteralPath (Join-Path $output "$name.stderr.log")
    $process.Dispose()
    $result.commands += @{ name = $name; arguments = $arguments; exitCode = $code; timedOut = -not $completed }
    if (-not $completed -or $code -ne 0) { throw "WPR $name failed; see recorder logs." }
}
try {
    $temp = Join-Path $output 'temporary'
    $null = New-Item -ItemType Directory -Path $temp
    # WPR arguments are fixed except for a quoted local output path and our unique instance.
    if ($output.Contains('"')) { throw 'Quote in output path.' }
    $result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $output 'session.json')
    # Even a failed/timed-out start may have created the uniquely named ETW session.
    $active = $true
    Invoke-Recorder 'start' @('-start', 'CPU', '-filemode', '-recordtempto', "`"$temp`"", '-instancename', $instance) 30000
    $result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $output 'ready.json')
    $deadline = [DateTime]::UtcNow.AddSeconds($DurationSeconds)
    while (-not (Test-Path -LiteralPath (Join-Path $output 'stop.request'))) {
        if ([DateTime]::UtcNow -ge $deadline) { throw 'Recorder deadline reached without stop request.' }
        $bytes = (Get-ChildItem -LiteralPath $temp -File | Measure-Object Length -Sum).Sum
        if ($bytes -gt 1GB) { throw 'ETW temporary output exceeded 1 GiB.' }
        Start-Sleep -Milliseconds 250
    }
    $etl = Join-Path $output 'cpu.etl'
    Invoke-Recorder 'stop' @('-stop', "`"$etl`"", '-skipPdbGen', '-compress', '-instancename', $instance) 120000
    $active = $false
    if ((Get-Item -LiteralPath $etl).Length -le 0) { throw 'Empty ETL.' }
    $result.etlSha256 = (Get-FileHash -LiteralPath $etl -Algorithm SHA256).Hash
    $result.status = 'recorded'
} catch {
    $result.error = $_.Exception.Message
} finally {
    if ($active) {
        try { Invoke-Recorder 'cancel' @('-cancel', '-instancename', $instance) 30000 }
        catch { $result.cleanupError = $_.Exception.Message }
    }
    $result.finishedUtc = [DateTime]::UtcNow.ToString('o')
    $result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $output 'result.json')
}
if ($result.status -ne 'recorded') { exit 1 }
