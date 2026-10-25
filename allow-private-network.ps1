$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $PSCommandPath + '"'))
    exit 0
}
$nodePath = Join-Path $PSScriptRoot 'runtime\node.exe'
$ruleName = 'MihayouLink-Private'
if (!(Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -Name $ruleName -DisplayName 'Mihayou Link - private LAN' -Direction Inbound -Program $nodePath -Protocol TCP -LocalPort 8765-8785 -RemoteAddress LocalSubnet -Action Allow -Profile Private
}
