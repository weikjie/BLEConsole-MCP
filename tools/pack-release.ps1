# Assembles the release bundle: BLEConsole.exe + the MCP server + the docs.
# Output lands in dist\BLEConsole-MCP-v<version>\ — zip that folder and attach it to the release.
#
#   pwsh tools\pack-release.ps1                 # build, then stage
#   pwsh tools\pack-release.ps1 -SkipBuild      # stage whatever is already in bin\Release
#   pwsh tools\pack-release.ps1 -Version 1.1.0

param(
  [string]$Version = '1.0.0',
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$name = "BLEConsole-MCP-v$Version"
$stage = Join-Path $root "dist\$name"
$exe = Join-Path $root 'BLEConsole\bin\Release\BLEConsole.exe'
$cfg = "$exe.config"

if (-not $SkipBuild) {
  $buildArgs = @((Join-Path $root 'BLEConsole\BLEConsole.csproj'), '/p:Configuration=Release', '/p:Platform=AnyCPU', '/v:minimal')
  msbuild @buildArgs
  if ($LASTEXITCODE -ne 0) {
    # MSB3644: no .NET Framework 4.8 targeting pack on this machine. Compiling against the runtime
    # assemblies of the installed framework produces the same binary and is how this release is built.
    $fw = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
    if (-not (Test-Path $fw)) { $fw = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319' }
    Write-Host "`nmsbuild failed - retrying with /p:FrameworkPathOverride=$fw"
    msbuild @buildArgs "/p:FrameworkPathOverride=$fw"
    if ($LASTEXITCODE -ne 0) { throw "msbuild failed with exit code $LASTEXITCODE" }
  }
}

if (-not (Test-Path $exe)) {
  throw "BLEConsole.exe not found at $exe — build it first: msbuild BLEConsole\BLEConsole.csproj /p:Configuration=Release /p:Platform=AnyCPU"
}

Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force (Join-Path $stage 'mcp-server') | Out-Null

# The executable sits next to mcp-server\ on purpose: server.mjs resolves it against its own
# location, so this layout needs no BLE_CONSOLE_PATH.
Copy-Item $exe, $cfg $stage
Copy-Item (Join-Path $root 'mcp-server\*.mjs'), (Join-Path $root 'mcp-server\package.json') (Join-Path $stage 'mcp-server')
Copy-Item (Join-Path $root 'README.md'), (Join-Path $root 'README.zh-CN.md'), (Join-Path $root 'README-BLEConsole.md'), (Join-Path $root 'LICENSE') $stage

Get-ChildItem $stage -Recurse -File | ForEach-Object { $_.FullName.Replace("$stage\", '  ') }
Write-Host "`nStaged: $stage"
Write-Host "Next  : Compress-Archive -Path '$stage' -DestinationPath '$name-win-x64.zip'"
