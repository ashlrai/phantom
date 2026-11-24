# install.ps1 - per-user Phantom install for Windows.
#
#   irm https://raw.githubusercontent.com/ashlrai/phantom/master/scripts/install.ps1 | iex
#
# Installs the complete npm package by default. PHANTOM_PREFER_NATIVE=1 opts
# into a matching CLI-only native asset when published (otherwise uses npm). The npm tarball is
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
$Verifier = $env:PHANTOM_VERIFY_RELEASE
$PreferNative = $env:PHANTOM_PREFER_NATIVE
$PathMode = if ($env:PHANTOM_PATH_MODE) { $env:PHANTOM_PATH_MODE } else { 'user' }

$RegistryPackage = '@ashlr/phantom'
$RegistryHost = 'https://registry.npmjs.org'
$GitHubRepo = 'ashlrai/phantom'
$IntegrityPattern = '^sha512-[A-Za-z0-9+/]{86}==$'

function Fail([string]$Message) {
  throw $Message
}

if ($PreferNative -and $PreferNative -notin @('0', '1')) { Fail 'PHANTOM_PREFER_NATIVE must be 0 or 1' }
if ($PathMode -notin @('user', 'session')) { Fail 'PHANTOM_PATH_MODE must be user or session' }
if ($Version -and $Version -notmatch '^\d+\.\d+\.\d+$') {
  Fail 'PHANTOM_VERSION must be a stable version (x.y.z).'
}
# Optional signer-owner adapter: an executable path, never evaluated as code.
function Test-Release([string]$Artifact, [string]$Kind, [string]$ArtifactVersion) {
  if ($Verifier) {
    # IsPathRooted also accepts C:relative and \relative; require a full drive
    # or UNC path. This works on Windows PowerShell 5.1 as well as PowerShell 7.
    if ($Verifier -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+\\)' -or -not (Test-Path -LiteralPath $Verifier -PathType Leaf)) {
      Fail 'Release verifier must be an absolute executable path'
    }
    $global:LASTEXITCODE = 0
    & $Verifier $Artifact $Kind $ArtifactVersion
    if (-not $? -or $LASTEXITCODE -ne 0) { Fail 'Release verifier refused the artifact' }
  }
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
  if ($got -cne $Expected) { Fail 'Release integrity verification failed' }
}

function Test-Sha256File([string]$Path, [string]$ExpectedHex) {
  $got = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
  if ($got -ne $ExpectedHex.ToLowerInvariant()) { Fail 'Release asset checksum verification failed' }
}

try {
  if ($Tarball) {
    if (-not $Integrity) { Fail 'A local tarball requires PHANTOM_INTEGRITY (sha512-...).' }
    if (-not (Test-Path -LiteralPath $Tarball)) { Fail "Tarball not found: $Tarball" }
    Copy-Item -LiteralPath $Tarball -Destination $downloaded
    Test-Sha512 $downloaded $Integrity
    Test-Release $downloaded npm $Version
    Write-Host 'Verified local tarball sha512'
  } else {
    $headers = @{ 'User-Agent' = 'phantom-install'; 'Accept' = 'application/vnd.github+json' }
    $assetName = "ashlr-windows-$archName.exe"
    $asset = $null
    $release = $null
    if ($PreferNative -eq '1') {
      try {
        $releasePath = if ($Version) { "tags/v$Version" } else { 'latest' }
        $release = Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/repos/$GitHubRepo/releases/$releasePath"
        $asset = @($release.assets) | Where-Object { $_.name -eq $assetName } | Select-Object -First 1
      } catch {
        $asset = $null
      }
    }
    $validRelease = $release -and $release.tag_name -match '^v\d+\.\d+\.\d+$' -and -not $release.draft -and -not $release.prerelease
    if ($Version -and $release.tag_name -ne "v$Version") { $validRelease = $false }
    $expectedAssetUrl = "https://github.com/$GitHubRepo/releases/download/$($release.tag_name)/$assetName"
    if ($validRelease -and $asset -and $asset.browser_download_url -ceq $expectedAssetUrl -and $asset.digest -match '^sha256:([a-fA-F0-9]{64})$') {
      $assetDigest = $Matches[1]
      $exe = Join-Path $work $assetName
      Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $exe -UseBasicParsing
      Test-Sha256File $exe $assetDigest
      $assetVersion = ([string]$release.tag_name).Substring(1)
      Test-Release $exe native $assetVersion
      $installedExe = $true
      Copy-Item -LiteralPath $exe -Destination (Join-Path $Prefix 'ashlr.exe')
      Set-Content -LiteralPath (Join-Path $Prefix 'phm.cmd') -Encoding ascii -Value "@echo off`r`n`"%~dp0ashlr.exe`" %*`r`n"
      Write-Host "Installed CLI-only $assetName (console assets require the npm package)"
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
      if ($Version -and $packageVersion -ne $Version) { Fail 'Registry version mismatch' }
      $integrity = [string]$meta.dist.integrity
      $url = [string]$meta.dist.tarball
      if ($integrity -notmatch $IntegrityPattern) { Fail 'Release integrity metadata unavailable' }
      if ($url -cne "$RegistryHost/@ashlr/phantom/-/phantom-$packageVersion.tgz") {
        Fail 'Release integrity metadata unavailable'
      }
      Invoke-WebRequest -Uri $url -OutFile $downloaded -UseBasicParsing
      Test-Sha512 $downloaded $integrity
      $gh = Get-Command gh -ErrorAction SilentlyContinue
      if ($gh) {
        & gh attestation verify $downloaded --repo ashlrai/phantom --hostname github.com
        if ($LASTEXITCODE -ne 0) { Fail 'GitHub attestation verification failed' }
        Write-Host 'GitHub attestation verified'
      } else {
        Write-Host 'sha512 verified; GitHub CLI not installed, attestation left unknown'
      }
      Test-Release $downloaded npm $packageVersion
      Write-Host "Verified npm package $packageVersion"
    }
  }

  if (-not $installedExe) {
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npm) { Fail 'npm is required to install the package.' }
    & $npm.Source install --global --prefix $Prefix --no-audit --no-fund $downloaded
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

if ($PathMode -eq 'user') {
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $parts = @()
  if ($userPath) { $parts = $userPath.Split(';') | Where-Object { $_ -and ($_ -ne $binDir) } }
  [Environment]::SetEnvironmentVariable('Path', ((@($binDir) + $parts) -join ';'), 'User')
}
$env:Path = "$binDir;$env:Path"
if ($PathMode -eq 'user' -and $env:GITHUB_PATH) { Add-Content -LiteralPath $env:GITHUB_PATH -Value $binDir }
Write-Host "PATH updated ($PathMode): $binDir"

& $phm --version
if ($LASTEXITCODE -ne 0) { Fail 'Installed phm did not start' }
& $phm doctor
if ($LASTEXITCODE -ne 0) { Write-Host 'Installed; doctor found setup items. Review them with phm doctor.' }
& $phm daemon install
if ($LASTEXITCODE -ne 0) { Fail "phm daemon install failed ($LASTEXITCODE)" }
Write-Host 'Installed. Per-user logon task: AshlrDaemon (limited, interactive).'
