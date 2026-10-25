param(
    [string]$JavaHome = $env:JAVA_HOME,
    [string]$AndroidSdk = $(if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { $env:ANDROID_SDK_ROOT }),
    [string]$BuildTools = '',
    [string]$AndroidJar = '',
    [string]$SigningKey = '',
    [string]$OutputApk = '',
    [string]$ProjectRoot = $PSScriptRoot,
    [string[]]$AdditionalSources = @()
)
$ErrorActionPreference = 'Stop'
if (!$JavaHome) {
    $compiler = Get-Command javac.exe -ErrorAction SilentlyContinue
    if ($compiler) { $JavaHome = Split-Path (Split-Path $compiler.Source -Parent) -Parent }
}
if (!$JavaHome) { throw 'JDK not found. Set JAVA_HOME or pass -JavaHome.' }
if (!$AndroidSdk) { $AndroidSdk = Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
if (!$BuildTools) {
    $installed = Get-ChildItem -LiteralPath (Join-Path $AndroidSdk 'build-tools') -Directory |
        Where-Object { $_.Name -match '^\d+\.\d+\.\d+$' } |
        Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
    if (!$installed) { throw 'No Android build-tools found. Set -BuildTools explicitly.' }
    $BuildTools = $installed.FullName
}
if (!$AndroidJar) { $AndroidJar = Join-Path $AndroidSdk 'platforms\android-35\android.jar' }
foreach ($required in @(
    (Join-Path $JavaHome 'bin\javac.exe'),
    $AndroidJar,
    (Join-Path $BuildTools 'aapt2.exe'),
    (Join-Path $BuildTools 'd8.bat'),
    (Join-Path $BuildTools 'zipalign.exe'),
    (Join-Path $BuildTools 'apksigner.bat')
)) {
    if (!(Test-Path -LiteralPath $required)) { throw "Missing build dependency: $required" }
}
$env:JAVA_HOME = $JavaHome
$env:PATH = (Join-Path $JavaHome 'bin') + ';' + $env:PATH
$buildRoot = Join-Path $ProjectRoot 'build'
$build = Join-Path $buildRoot ([guid]::NewGuid().ToString('N'))
$classes = Join-Path $build 'classes'
$dex = Join-Path $build 'dex'
[void][IO.Directory]::CreateDirectory($classes)
[void][IO.Directory]::CreateDirectory($dex)
if (!$OutputApk) { $OutputApk = Join-Path $buildRoot 'MihayouMotionController.apk' }
if (!$SigningKey) { $SigningKey = Join-Path $buildRoot 'development.jks' }
function Check-Step { if ($LASTEXITCODE -ne 0) { throw "Android build failed: $LASTEXITCODE" } }
$sources = @(Get-ChildItem -LiteralPath (Join-Path $ProjectRoot 'src') -Filter '*.java' -Recurse |
    ForEach-Object FullName) + $AdditionalSources
& (Join-Path $JavaHome 'bin\javac.exe') --release 8 -encoding UTF-8 -classpath $AndroidJar -d $classes @sources
Check-Step
$classFiles = @(Get-ChildItem -LiteralPath $classes -Filter '*.class' -Recurse | ForEach-Object FullName)
& (Join-Path $BuildTools 'd8.bat') --lib $AndroidJar --min-api 26 --output $dex @classFiles
Check-Step
$unsigned = Join-Path $build 'unsigned.apk'
& (Join-Path $BuildTools 'aapt2.exe') link -o $unsigned --manifest (Join-Path $ProjectRoot 'AndroidManifest.xml') -I $AndroidJar
Check-Step
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::Open($unsigned, [IO.Compression.ZipArchiveMode]::Update)
try {
    [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, (Join-Path $dex 'classes.dex'), 'classes.dex')
} finally { $archive.Dispose() }
$aligned = Join-Path $build 'aligned.apk'
& (Join-Path $BuildTools 'zipalign.exe') -f 4 $unsigned $aligned
Check-Step
if (!(Test-Path -LiteralPath $SigningKey)) {
    & (Join-Path $JavaHome 'bin\keytool.exe') -genkeypair -keystore $SigningKey -storepass android -keypass android -alias debug -keyalg RSA -keysize 2048 -validity 3650 -dname 'CN=Mihayou Development'
    Check-Step
}
& (Join-Path $BuildTools 'apksigner.bat') sign --ks $SigningKey --ks-key-alias debug --ks-pass pass:android --key-pass pass:android --out $OutputApk $aligned
Check-Step
& (Join-Path $BuildTools 'apksigner.bat') verify --verbose $OutputApk
Check-Step
Write-Host "APK ready: $OutputApk"
