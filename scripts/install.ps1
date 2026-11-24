# install.ps1 - per-user Phantom install for Windows.
#
#   irm https://raw.githubusercontent.com/ashlrai/phantom/master/scripts/install.ps1 | iex
#
# Detects the CPU architecture, downloads a matching GitHub release asset when
# one is published, and otherwise installs the npm package. The npm tarball is
# checked the same way the POSIX release installer does: registry sha512
# integrity, then `gh attestation verify` when the GitHub CLI is installed.
# No Administrator prompt and no SYSTEM service. phm and ashlr are added to
# the user PATH, then `phm doctor` and `phm daemon install` run.

# No param() block: `irm ... | iex` runs the body in the current scope.
$ErrorActionPreference = 'Stop'
$Tarball = $env:PHANTOM_TARBALL
$Integrity = $env:PHANTOM_INTEGRITY
$Version = $env:PHANTOM_VERSION
$Prefix = $env:PHANTOM_PREFIX

$RegistryPackage = '@ashlr/phantom'
$RegistryHost = 'https://registry.npmjs.org'
$GitHubRepo = 'ashlrai/phantom'
$IntegrityPattern = '^sha512-[A-Za-z0-9+/]{86}==$'

function Fail([string]$Message) {
  throw $Message
}

if ($env:USERNAME -eq 'SYSTEM' -or ($env:USERPROFILE -match '\\system32\\config\\systemprofile$')) {
  Fail 'Refusing to install as SYSTEM. Run this as the user who will use phm.'
}

$archName = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
if ($archName -notin @('x64', 'arm64')) {
  Fail "Unsupported architecture: $archName. Phantom supports x64 and arm64."
}
Write-Host "Phantom installer (windows-$archName)"

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Fail 'Node.js 22.15 or newer is required.' }
$nodeVersion = (& node -p 'process.versions.node').Trim()
$nodeParts = $nodeVersion.Split('.')
$nodeMajor = [int]$nodeParts[0]
$nodeMinor = [int]$nodeParts[1]
if ($nodeMajor -lt 22 -or ($nodeMajor -eq 22 -and $nodeMinor -lt 15)) {
  Fail "Node.js 22.15 or newer is required; found $nodeVersion."
}
Write-Host "Node $nodeVersion"

if (-not $Prefix) {
  $local = $env:LOCALAPPDATA
  if (-not $local) { $local = Join-Path $env:USERPROFILE 'AppData\Local' }
  $Prefix = Join-Path $local 'phantom'
}
New-Item -ItemType Directory -Force -Path $Prefix | Out-Null

$work = Join-Path ([System.IO.Path]::GetTempPath()) ("phantom-install-" + [guid]::NewGuid().ToString('n'))
New-Item -ItemType Directory -Force -Path $work | Out-Null
$downloaded = Join-Path $work 'package.tgz'
$installedExe = $false

function Test-Sha512([string]$Path, [string]$Expected) {
  if ($Expected -notmatch $IntegrityPattern) { Fail 'Release integrity metadata unavailable' }
  $sha = [System.Security.Cryptography.SHA512]::Create()
  try {
    $hash = $sha.ComputeHash([System.IO.File]::ReadAllBytes($Path))
  } finally {
    $sha.Dispose()
  }
  $got = 'sha512-' + [Convert]::ToBase64String($hash)
  if ($got -ne $Expected) { Fail 'Release integrity verification failed' }
}

function Test-Sha256File([string]$Path, [string]$ExpectedHex) {
  $got = (Get-FileHash -Algorithm SHA256 -Path $Path).Hash.ToLowerInvariant()
  if ($got -ne $ExpectedHex.ToLowerInvariant()) { Fail 'Release asset checksum verification failed' }
}

try {
  if ($Tarball) {
    if (-not $Integrity) { Fail 'A local tarball requires PHANTOM_INTEGRITY (sha512-...).' }
    if (-not (Test-Path -LiteralPath $Tarball)) { Fail "Tarball not found: $Tarball" }
    Test-Sha512 $Tarball $Integrity
    Copy-Item -LiteralPath $Tarball -Destination $downloaded
    Write-Host 'Verified local tarball sha512'
  } else {
    $headers = @{ 'User-Agent' = 'phantom-install'; 'Accept' = 'application/vnd.github+json' }
    $assetName = "ashlr-windows-$archName.exe"
    $asset = $null
    try {
      $release = Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/repos/$GitHubRepo/releases/latest"
      $asset = @($release.assets) | Where-Object { $_.name -eq $assetName } | Select-Object -First 1
    } catch {
      $asset = $null
    }
    if ($asset -and $asset.digest -match '^sha256:([a-fA-F0-9]{64})$') {
      $exe = Join-Path $work $assetName
      Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $exe -UseBasicParsing
      Test-Sha256File $exe $Matches[1]
      $installedExe = $true
      Copy-Item -LiteralPath $exe -Destination (Join-Path $Prefix 'ashlr.exe')
      Set-Content -Path (Join-Path $Prefix 'phm.cmd') -Encoding ascii -Value "@echo off`r`n`"%~dp0ashlr.exe`" %*`r`n"
      Write-Host "Installed $assetName"
    } else {
      $metaUrl = if ($Version) {
        "$RegistryHost/$RegistryPackage/$Version"
      } else {
        "$RegistryHost/$RegistryPackage/latest"
      }
      $meta = Invoke-RestMethod -Headers @{ 'User-Agent' = 'phantom-install' } -Uri $metaUrl
      if ($meta.name -ne $RegistryPackage) { Fail 'Registry metadata unavailable' }
      if ($meta.version -notmatch '^\d+\.\d+\.\d+$') { Fail 'Registry metadata unavailable' }
      $packageVersion = $meta.version
      $integrity = [string]$meta.dist.integrity
      $url = [string]$meta.dist.tarball
      if ($integrity -notmatch $IntegrityPattern) { Fail 'Release integrity metadata unavailable' }
      if ($url -ne "$RegistryHost/@ashlr/phantom/-/phantom-$packageVersion.tgz") {
        Fail 'Release integrity metadata unavailable'
      }
      Invoke-WebRequest -Uri $url -OutFile $downloaded -UseBasicParsing
      Test-Sha512 $downloaded $integrity
      $gh = Get-Command gh -ErrorAction SilentlyContinue
      if ($gh) {
        & gh attestation verify $downloaded --repo ashlr/phantom --hostname github.com
        if ($LASTEXITCODE -ne 0) { Fail 'GitHub attestation verification failed' }
        Write-Host 'GitHub attestation verified'
      } else {
        Write-Host 'sha512 verified; GitHub CLI not installed, attestation left unknown'
      }
      Write-Host "Verified npm package $packageVersion"
    }
  }

  if (-not $installedExe) {
    $npm = Get-Command npm -ErrorAction SilentlyContinue
    if (-not $npm) { Fail 'npm is required to install the package.' }
    & npm install --global --prefix $Prefix --no-audit --no-fund $downloaded
    if ($LASTEXITCODE -ne 0) { Fail 'npm install failed' }
  }
} finally {
  if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force }
}

$binDir = $Prefix
foreach ($name in @('phm.cmd', 'phm.exe')) {
  if (Test-Path -LiteralPath (Join-Path $Prefix $name)) { $binDir = $Prefix; break }
  if (Test-Path -LiteralPath (Join-Path $Prefix "bin\$name")) { $binDir = Join-Path $Prefix 'bin'; break }
}
$phm = Join-Path $binDir 'phm.cmd'
if (-not (Test-Path -LiteralPath $phm)) { $phm = Join-Path $binDir 'phm.exe' }
if (-not (Test-Path -LiteralPath $phm)) { Fail 'phm was not installed' }

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$parts = @()
if ($userPath) { $parts = $userPath.Split(';') | Where-Object { $_ -and ($_ -ne $binDir) } }
[Environment]::SetEnvironmentVariable('Path', ((@($binDir) + $parts) -join ';'), 'User')
$env:Path = "$binDir;$env:Path"
if ($env:GITHUB_PATH) { Add-Content -Path $env:GITHUB_PATH -Value $binDir }
Write-Host "PATH updated for the current user: $binDir"

& $phm doctor
if ($LASTEXITCODE -ne 0) { Fail "phm doctor failed ($LASTEXITCODE)" }
& $phm daemon install
if ($LASTEXITCODE -ne 0) { Fail "phm daemon install failed ($LASTEXITCODE)" }
Write-Host 'Installed. Per-user logon task: AshlrDaemon (limited, interactive).'
