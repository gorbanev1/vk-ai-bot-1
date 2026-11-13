$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$entry = Join-Path $project 'src\index.js'
$node = (Get-Command node.exe -ErrorAction Stop).Source
$existing = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
    $command = [string]$_.CommandLine
    $command.Replace('/', '\').Contains($entry) -or $command -match '(^|\s|\x22)src[/\\]index\.js(\s|$|\x22)'
}
if ($existing) {
    Write-Output ('BOT_ALREADY_RUNNING=' + (($existing | Select-Object -ExpandProperty ProcessId) -join ','))
    exit 0
}
# The short launcher has no console; its child also uses windowsHide and file handles.
$info = New-Object System.Diagnostics.ProcessStartInfo
$info.FileName = $node
$info.Arguments = '"' + (Join-Path $PSScriptRoot 'start-bot-hidden.mjs') + '"'
$info.WorkingDirectory = $project
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$info.RedirectStandardOutput = $true
$info.RedirectStandardError = $true
$launcher = New-Object System.Diagnostics.Process
$launcher.StartInfo = $info
[void]$launcher.Start()
$output = $launcher.StandardOutput.ReadToEnd()
$errorOutput = $launcher.StandardError.ReadToEnd()
$launcher.WaitForExit()
Write-Output $output.Trim()
if ($launcher.ExitCode -ne 0) { throw $errorOutput }
