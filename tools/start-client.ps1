[CmdletBinding()]
param([string]$LoaderPath, [switch]$NoLaunch)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$build = Join-Path $root 'build'
$local = Join-Path $root '.local-client'
New-Item -ItemType Directory -Path $local -Force | Out-Null
$clientExe = Join-Path $build 'DImensionagent.exe'
$backend = Join-Path $build 'DImensionagent-native.exe'
foreach ($file in @($clientExe,$backend)) {
    if (!(Test-Path -LiteralPath $file -PathType Leaf)) { throw "Build the desktop and backend targets first. Missing: $file" }
}
$node = (Get-Command node.exe -CommandType Application -ErrorAction Stop).Source
if (!(Test-Path (Join-Path $root 'runtime/node_modules/@modelcontextprotocol/sdk/package.json'))) {
    throw 'Install runtime dependencies first: npm ci --prefix runtime --ignore-scripts'
}
$loader = Join-Path $local 'WebView2Loader.dll'
$expected = 'D3FCE90BDEECB08596E377DEA6A316354DD8949E32FF09B89D51BE00C14E21B6'
if ($LoaderPath) {
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $LoaderPath).Hash -ne $expected) {throw 'WebView2 x64 loader hash mismatch'}
    Copy-Item -LiteralPath $LoaderPath -Destination $loader -Force
} elseif (!(Test-Path $loader) -or (Get-FileHash $loader).Hash -ne $expected) {
    $pkg = Join-Path $local 'webview2-sdk.nupkg'
    Invoke-WebRequest -UseBasicParsing -Uri 'https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/1.0.4314.35/microsoft.web.webview2.1.0.4314.35.nupkg' -OutFile $pkg
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($pkg)
    try {
        $entry = $archive.GetEntry('build/native/x64/WebView2Loader.dll')
        if (!$entry) {throw 'WebView2 package does not contain x64 loader'}
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry,$loader,$true)
    } finally { $archive.Dispose() }
}
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $loader).Hash -ne $expected) {throw 'WebView2 loader verification failed'}
$config = [ordered]@{
    backend=$backend; ui=(Join-Path $root 'ui'); data='data'; loader=$loader
    node=$node; pluginHost=(Join-Path $root 'runtime/plugin-host.mjs')
    icon=(Join-Path $root 'ui/DimensionAgent.ico'); splash=(Join-Path $root 'ui/splash.png')
}
$helper=Join-Path $build 'linux/dimension-desktop-helper'
if(Test-Path $helper){ $config.desktopHelper=$helper; $config.sandboxDistribution='dimension-sandbox'; $config.desktopHomeRoot='/home/dimension' }
$pointer=Join-Path $local 'native-client.json'
[IO.File]::WriteAllText($pointer,($config | ConvertTo-Json))
if (!$NoLaunch) { & $clientExe --config $pointer }
