[CmdletBinding(DefaultParameterSetName='Install')]
param(
  [Parameter(Mandatory=$true,ParameterSetName='Install')][string]$ReleaseDir,
  [Parameter(Mandatory=$true,ParameterSetName='Rollback')][string]$Rollback,
  [string]$TargetDir='C:\OwnerTracker',
  [switch]$ConfirmStopped,
  [switch]$DryRun
)

# Local, explicitly invoked updater. It does not download or execute remote code,
# stop processes, overwrite credentials, restore databases, or change customer data.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$managedRoots=@('src','public','scripts','windows','ios','deploy','docs','package.json','OwnerTrackerDesktop.exe','.env.example','README.md','START_HERE_V11.md','IMPLEMENTATION_PLAN_V11.md','QA_AND_ACCEPTANCE_V11.md','RELEASE_NOTES_V11.md')
$protectedSegments=@('.git','.codex','.agents','node_modules','data','uploads','backups','runtime','.openai')

function Assert-LocalPath([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value) -or $Value.StartsWith('\\')) { throw 'Use an explicit local disk path, not a network share.' }
  $full=[System.IO.Path]::GetFullPath($Value).TrimEnd([char[]]'\/')
  if ($full -eq [System.IO.Path]::GetPathRoot($full).TrimEnd([char[]]'\/')) { throw 'A drive root cannot be an application/release directory.' }
  $current=$full
  while ($current) {
    if (Test-Path -LiteralPath $current) {
      $item=Get-Item -LiteralPath $current -Force
      if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Linked directories are not supported: $current" }
    }
    $parent=Split-Path -Parent $current
    if ($parent -eq $current) { break }
    $current=$parent
  }
  return $full
}

function Test-AllowedRelative([string]$Relative) {
  if (!$Relative -or $Relative -match '[\\:\x00-\x1f]') { return $false }
  $segments=$Relative.Split('/')
  if ($managedRoots -notcontains $segments[0]) { return $false }
  foreach ($part in $segments) {
    if (!$part -or $part -eq '.' -or $part -eq '..' -or $protectedSegments -contains $part) { return $false }
    if (($part -eq '.env' -or $part.StartsWith('.env.')) -and $part -ne '.env.example') { return $false }
  }
  if ($Relative -match '\.(sqlite(?:-[a-z]+)?|db|log|pem|key)$') { return $false }
  return $true
}

function Get-Inventory([string]$Directory) {
  $result=@()
  foreach ($entry in (Get-ChildItem -LiteralPath $Directory -Force -Recurse)) {
    if (($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Release/code links are not allowed: $($entry.FullName)" }
    if ($entry.PSIsContainer) { continue }
    $relative=$entry.FullName.Substring($Directory.Length).TrimStart([char[]]'\/').Replace('\','/')
    if ($relative -eq 'RELEASE-MANIFEST.json') { continue }
    if (!(Test-AllowedRelative $relative)) { throw "Unexpected or private file in managed code: $relative" }
    $result+=@{path=$relative;size=[long]$entry.Length;sha256=(Get-FileHash -LiteralPath $entry.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
  }
  return $result
}

function Assert-Release([string]$Directory) {
  if (!(Test-Path -LiteralPath $Directory -PathType Container)) { throw 'Extract the release to a local folder first.' }
  $manifestPath=Join-Path $Directory 'RELEASE-MANIFEST.json'
  if (!(Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'Release manifest is missing.' }
  if ((Get-Item -LiteralPath $manifestPath).Length -gt 16777216) { throw 'Release manifest is too large.' }
  $manifest=Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  if ($manifest.schemaVersion -ne 1 -or $manifest.product -ne 'OwnerTracker' -or $manifest.nodeEngine -ne '>=22.16.0 <23') { throw 'Unsupported release manifest/runtime contract.' }
  if ($manifest.version -notmatch '^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$' -or @($manifest.files).Count -eq 0) { throw 'Invalid release version or file list.' }
  $expected=@{}
  foreach ($file in $manifest.files) {
    if (!(Test-AllowedRelative ([string]$file.path)) -or $file.sha256 -notmatch '^[a-f0-9]{64}$' -or [long]$file.size -lt 0) { throw 'Invalid release file metadata.' }
    $key=([string]$file.path).ToLowerInvariant()
    if ($expected.ContainsKey($key)) { throw "Duplicate/case-colliding manifest entry: $key" }
    $expected[$key]=$file
  }
  $actual=@(Get-Inventory $Directory)
  if ($actual.Count -ne $expected.Count) { throw 'Release contains missing or unexpected files.' }
  foreach ($file in $actual) {
    $key=$file.path.ToLowerInvariant()
    if (!$expected.ContainsKey($key) -or $expected[$key].sha256 -ne $file.sha256 -or [long]$expected[$key].size -ne $file.size) { throw "Release checksum/inventory mismatch: $($file.path)" }
  }
  if (!$expected.ContainsKey('src/server.mjs') -or !$expected.ContainsKey('package.json')) { throw 'Release server/package files are missing.' }
  return $manifest
}

function Assert-Stopped([string]$Target) {
  if (!$ConfirmStopped) { throw 'Stop the POS server and desktop agent first, then invoke with -ConfirmStopped. This updater never kills processes.' }
  $processes=Get-CimInstance Win32_Process
  foreach ($process in $processes) {
    if ($process.Name -in @('node.exe','OwnerTrackerDesktop.exe')) {
      $candidate=([string]$process.ExecutablePath)+' '+([string]$process.CommandLine)
      if ($candidate.IndexOf($Target,[System.StringComparison]::OrdinalIgnoreCase) -ge 0) { throw 'A process using this application directory is still running. Close it before updating.' }
    }
  }
  if (Test-Path -LiteralPath (Join-Path $Target 'data\desktop-launcher.lock')) { throw 'The desktop launcher lock exists. Verify both children are stopped and follow the documented stale-lock recovery procedure.' }
  if (Test-Path -LiteralPath (Join-Path $Target 'data')) {
    $sidecars=@(Get-ChildItem -LiteralPath (Join-Path $Target 'data') -File -Force | Where-Object { $_.Name -match '\.(sqlite|db)-(wal|shm|journal)$' })
    if ($sidecars.Count) { throw 'SQLite sidecars exist; stop all app processes and confirm the database is safely closed. Do not delete live sidecars.' }
  }
}

function Write-BaselineManifest([string]$Directory) {
  $version='previous-code'
  $package=Join-Path $Directory 'package.json'
  if (Test-Path -LiteralPath $package) {
    $metadata=Get-Content -LiteralPath $package -Raw | ConvertFrom-Json
    if ($metadata.version -match '^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$') { $version=[string]$metadata.version }
  }
  $manifest=@{schemaVersion=1;product='OwnerTracker';version=$version;nodeEngine='>=22.16.0 <23';target='windows-x64';createdAt=[DateTime]::UtcNow.ToString('o');commit='retained-local-code';files=@(Get-Inventory $Directory)}
  $manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $Directory 'RELEASE-MANIFEST.json') -Encoding UTF8
}

$source=Assert-LocalPath $(if ($PSCmdlet.ParameterSetName -eq 'Rollback') { $Rollback } else { $ReleaseDir })
$target=Assert-LocalPath $TargetDir
if ($source.Equals($target,[System.StringComparison]::OrdinalIgnoreCase) -or $source.StartsWith($target+'\',[System.StringComparison]::OrdinalIgnoreCase) -or $target.StartsWith($source+'\',[System.StringComparison]::OrdinalIgnoreCase)) { throw 'Release and target paths must not overlap.' }
$manifest=Assert-Release $source
$incomingRoots=@($manifest.files | ForEach-Object { $_.path.Split('/')[0] } | Sort-Object -Unique)
if ($DryRun) {
  Write-Output "Verified OwnerTracker $($manifest.version), $(@($manifest.files).Count) files. No files changed."
  Write-Output "Target: $target. Managed code roots: $($incomingRoots -join ', ')."
  Write-Output 'Preserved: .env, customer data/uploads, backups, bundled runtime, and all unlisted root paths.'
  return
}
Assert-Stopped $target
New-Item -ItemType Directory -Path $target -Force | Out-Null
$lockPath=Join-Path $target '.ownertracker-update.lock'
$lock=$null
$id=[Guid]::NewGuid().ToString()
$stage=$target+'.stage-'+$id
$baseline=$target+'.code-backup-'+$id
$moved=@()
$installed=@()
$complete=$false
try {
  $lock=[System.IO.File]::Open($lockPath,[System.IO.FileMode]::CreateNew,[System.IO.FileAccess]::Write,[System.IO.FileShare]::None)
  New-Item -ItemType Directory -Path $stage | Out-Null
  foreach ($entry in (Get-ChildItem -LiteralPath $source -Force)) { Copy-Item -LiteralPath $entry.FullName -Destination $stage -Recurse -Force }
  Assert-Release $stage | Out-Null
  # Inspect all managed existing roots before changing any of them. Unexpected
  # private files inside code must be moved to standard private storage first.
  foreach ($root in $managedRoots) {
    $existing=Join-Path $target $root
    if (Test-Path -LiteralPath $existing) {
      $item=Get-Item -LiteralPath $existing -Force
      if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Linked managed code is not supported: $root" }
      if ($item.PSIsContainer) {
        foreach ($child in (Get-ChildItem -LiteralPath $existing -Recurse -Force)) {
          if (($child.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Linked managed code is not supported.' }
          $relative=$child.FullName.Substring($target.Length).TrimStart([char[]]'\/').Replace('\','/')
          if (!(Test-AllowedRelative $relative)) { throw "Private/unexpected content inside managed code: $relative" }
        }
      }
    }
  }
  New-Item -ItemType Directory -Path $baseline | Out-Null
  Assert-Stopped $target
  foreach ($root in $managedRoots) {
    $existing=Join-Path $target $root
    if (Test-Path -LiteralPath $existing) { Move-Item -LiteralPath $existing -Destination (Join-Path $baseline $root);$moved+=$root }
  }
  if ($moved.Count) { Write-BaselineManifest $baseline }
  foreach ($root in $incomingRoots) {
    Move-Item -LiteralPath (Join-Path $stage $root) -Destination (Join-Path $target $root)
    $installed+=$root
  }
  $complete=$true
  Write-Output "Installed OwnerTracker $($manifest.version). Credentials and customer data were preserved."
  if ($moved.Count) { Write-Output "Previous complete code baseline: $baseline. Use -Rollback with that path to restore code; database restoration is separate." }
  Write-Output 'For a new installation, run windows\SETUP_FIRST.cmd. For an upgrade, keep the existing .env. Test the POS and photos before resuming shop work.'
} catch {
  $failure=$_.Exception.Message
  $rollbackErrors=@()
  foreach ($root in $installed) { try { Remove-Item -LiteralPath (Join-Path $target $root) -Recurse -Force } catch { $rollbackErrors+=$_.Exception.Message } }
  foreach ($root in $moved) { try { Move-Item -LiteralPath (Join-Path $baseline $root) -Destination (Join-Path $target $root) } catch { $rollbackErrors+=$_.Exception.Message } }
  if ($rollbackErrors.Count) { throw "Update failed: $failure. Code rollback incomplete; preserve $baseline and $stage. $($rollbackErrors -join '; ')" }
  throw "Update failed; previous code was restored and customer data was not touched: $failure"
} finally {
  if ($lock) { $lock.Dispose(); Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue }
  if ($complete -and (Test-Path -LiteralPath $stage)) { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
}
