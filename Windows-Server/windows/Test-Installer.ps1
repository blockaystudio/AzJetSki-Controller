[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$ReleaseDir)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$release=(Resolve-Path -LiteralPath $ReleaseDir).ProviderPath
$updater=Join-Path $release 'windows\INSTALL_OR_UPDATE.ps1'
$root=Join-Path ([System.IO.Path]::GetTempPath()) ('OwnerTracker-install-test-'+[Guid]::NewGuid().ToString())
$target=Join-Path $root 'shop'
function Assert-True([bool]$Condition,[string]$Message) { if (!$Condition) { throw $Message } }
try {
  New-Item -ItemType Directory -Path (Join-Path $target 'src'),(Join-Path $target 'public'),(Join-Path $target 'data\uploads'),(Join-Path $target 'backups'),(Join-Path $target 'runtime') -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $target 'src\server.mjs') -Value '// retained previous code' -Encoding UTF8
  Set-Content -LiteralPath (Join-Path $target 'public\index.html') -Value '<h1>Previous</h1>' -Encoding UTF8
  Set-Content -LiteralPath (Join-Path $target 'package.json') -Value '{"name":"ownertracker","version":"11.0.0-previous","engines":{"node":">=22.16.0 <23"}}' -Encoding UTF8
  Set-Content -LiteralPath (Join-Path $target '.env') -Value 'PRIVATE_TEST_MARKER=do-not-overwrite' -Encoding UTF8
  Set-Content -LiteralPath (Join-Path $target 'data\shop.sqlite') -Value 'private database fixture' -Encoding UTF8
  Set-Content -LiteralPath (Join-Path $target 'data\uploads\photo.jpg') -Value 'private photo fixture' -Encoding UTF8
  Set-Content -LiteralPath (Join-Path $target 'backups\old.backup') -Value 'private backup fixture' -Encoding UTF8
  Set-Content -LiteralPath (Join-Path $target 'runtime\node.exe') -Value 'private runtime fixture' -Encoding UTF8
  $privateFiles=@('.env','data\shop.sqlite','data\uploads\photo.jpg','backups\old.backup','runtime\node.exe')
  $before=@{}
  foreach ($file in $privateFiles) { $before[$file]=(Get-FileHash -LiteralPath (Join-Path $target $file) -Algorithm SHA256).Hash }
  $oldServer=(Get-FileHash -LiteralPath (Join-Path $target 'src\server.mjs') -Algorithm SHA256).Hash
  & $updater -ReleaseDir $release -TargetDir $target -DryRun
  Assert-True ((Get-FileHash -LiteralPath (Join-Path $target 'src\server.mjs') -Algorithm SHA256).Hash -eq $oldServer) 'Dry run changed the server.'
  & $updater -ReleaseDir $release -TargetDir $target -ConfirmStopped
  Assert-True ((Get-FileHash -LiteralPath (Join-Path $target 'src\server.mjs') -Algorithm SHA256).Hash -eq (Get-FileHash -LiteralPath (Join-Path $release 'src\server.mjs') -Algorithm SHA256).Hash) 'Installation did not install verified source.'
  foreach ($file in $privateFiles) { Assert-True ((Get-FileHash -LiteralPath (Join-Path $target $file) -Algorithm SHA256).Hash -eq $before[$file]) "Private file changed: $file" }
  $baseline=@(Get-ChildItem -LiteralPath $root -Directory | Where-Object { $_.Name -like 'shop.code-backup-*' })
  Assert-True ($baseline.Count -eq 1) 'Expected one retained complete code baseline.'
  & $updater -Rollback $baseline[0].FullName -TargetDir $target -ConfirmStopped
  Assert-True ((Get-FileHash -LiteralPath (Join-Path $target 'src\server.mjs') -Algorithm SHA256).Hash -eq $oldServer) 'Rollback did not restore exact previous code.'
  foreach ($file in $privateFiles) { Assert-True ((Get-FileHash -LiteralPath (Join-Path $target $file) -Algorithm SHA256).Hash -eq $before[$file]) "Rollback changed private file: $file" }
  $tampered=Join-Path $root 'tampered-release'
  New-Item -ItemType Directory -Path $tampered | Out-Null
  foreach ($entry in (Get-ChildItem -LiteralPath $release -Force)) { Copy-Item -LiteralPath $entry.FullName -Destination $tampered -Recurse -Force }
  Add-Content -LiteralPath (Join-Path $tampered 'src\server.mjs') -Value '// tampered'
  $failed=$false
  try { & $updater -ReleaseDir $tampered -TargetDir $target -ConfirmStopped } catch { $failed=$true }
  Assert-True $failed 'Tampered release was accepted.'
  Assert-True ((Get-FileHash -LiteralPath (Join-Path $target 'src\server.mjs') -Algorithm SHA256).Hash -eq $oldServer) 'Tamper rejection changed installed code.'
  Write-Output 'PASS: Windows installer dry run, hash validation, code installation/rollback, and private data preservation.'
} finally {
  if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
}
