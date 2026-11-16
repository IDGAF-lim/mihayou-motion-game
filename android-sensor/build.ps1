param(
    [string]$JavaHome = $env:JAVA_HOME,
    [string]$AndroidSdk = $env:ANDROID_HOME,
    [string]$BuildTools = '',
    [string]$AndroidJar = '',
    [string]$SigningKey = '',
    [string]$OutputApk = ''
)
if (!$OutputApk) { $OutputApk = Join-Path $PSScriptRoot '..\apps\MihaSensor-integrated.apk' }
& (Join-Path $PSScriptRoot '..\android\build.ps1') -JavaHome $JavaHome -AndroidSdk $AndroidSdk `
    -BuildTools $BuildTools -AndroidJar $AndroidJar -SigningKey $SigningKey -OutputApk $OutputApk `
    -ProjectRoot $PSScriptRoot
if ($LASTEXITCODE -ne 0) { throw 'Sensor integration build failed.' }
