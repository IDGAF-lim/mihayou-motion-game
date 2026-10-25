$ErrorActionPreference = 'Stop'
$infoPath = Join-Path $PSScriptRoot 'runtime\server-info.json'
if (!(Test-Path -LiteralPath $infoPath)) { Write-Host 'No running server recorded.'; exit 0 }
$info = Get-Content -LiteralPath $infoPath -Raw | ConvertFrom-Json
$serverPath = Join-Path $PSScriptRoot 'server.js'
$process = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $info.pid) -ErrorAction SilentlyContinue
if ($process -and $process.CommandLine -like ('*' + $serverPath + '*')) {
    Stop-Process -Id $info.pid
    Write-Host 'Mihayou server stopped.'
} else { Write-Host 'Recorded process is not this server; no action taken.' }
