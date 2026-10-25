param([switch]$Game)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$nodePath = Join-Path $root 'runtime\node.exe'
[void][IO.Directory]::CreateDirectory((Join-Path $root 'runtime'))
if (!(Test-Path -LiteralPath $nodePath)) {
    $installedNode = Get-Command node.exe -ErrorAction SilentlyContinue
    if (!$installedNode) { throw 'Node.js not found. Install Node.js or use the complete Windows package.' }
    $nodePath = $installedNode.Source
}
$browserRoute = if ($Game) { '/game/' } else { '' }
$infoPath = Join-Path $root 'runtime\server-info.json'
$serverPath = Join-Path $root 'server.js'
if (Test-Path -LiteralPath $infoPath) {
    try {
        $info = Get-Content -LiteralPath $infoPath -Raw | ConvertFrom-Json
        $running = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $info.pid) -ErrorAction Stop
        if ($running.CommandLine -like ('*' + $serverPath + '*')) {
            $health = Invoke-RestMethod -Uri ($info.url + '/api/config') -TimeoutSec 2
            if ($health.version -eq '1.0.0') {
                Start-Process ($info.url + $browserRoute)
                Write-Host ('Already running: ' + $info.url)
                exit 0
            }
        }
    } catch {}
}
$startTime = Get-Date
$process = Start-Process -FilePath $nodePath -ArgumentList @('"' + $serverPath + '"') -WorkingDirectory $root -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $root 'runtime\server.log') -RedirectStandardError (Join-Path $root 'runtime\server-error.log')
for ($attempt = 0; $attempt -lt 50; $attempt++) {
    Start-Sleep -Milliseconds 200
    if ($process.HasExited) { throw 'Server failed. Check runtime\server-error.log.' }
    if ((Test-Path -LiteralPath $infoPath) -and (Get-Item -LiteralPath $infoPath).LastWriteTime -ge $startTime) {
        $info = Get-Content -LiteralPath $infoPath -Raw | ConvertFrom-Json
        try {
            [void](Invoke-RestMethod -Uri ($info.url + '/api/config') -TimeoutSec 2)
            Start-Process ($info.url + $browserRoute)
            Write-Host ('Ready: ' + $info.url)
            exit 0
        } catch {}
    }
}
throw 'Server did not become ready. Check runtime\server-error.log.'
