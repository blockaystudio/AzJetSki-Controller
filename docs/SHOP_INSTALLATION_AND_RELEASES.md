# Shop installation, updates and rollback

OwnerTracker is a single-shop Windows server/POS with browser clients. A hosted review site is separate from the shop computer and does not install printer drivers, charge the Dejavoo terminal, place dealer orders, or replace real-device acceptance.

## Build a local release

Use the repository's required Node **22.16+ within 22.x**. From `Windows-Server`, run:

```sh
node scripts/package-release.mjs /absolute/path/outside-the-checkout/OwnerTracker-release
node scripts/package-release.mjs --verify /absolute/path/outside-the-checkout/OwnerTracker-release
```

The output is an extracted release folder containing code, web assets, launcher, documentation, and `.env.example`, plus `RELEASE-MANIFEST.json` with version/runtime requirements and every file's SHA-256 hash. It excludes real `.env` settings, databases, customer uploads, backups, runtime executables, Git metadata and dependency folders. Hashes detect tampering/corruption relative to the supplied manifest; they are not a digital publisher signature. Obtain the release and updater from your trusted repository/source.

The `Verify Windows install and rollback` GitHub workflow packages a release, checks installation and code rollback on a Windows runner, and provides an `OwnerTracker-shop-release` artifact. Review the run result before using its artifact. The real shop PC, user permissions, antivirus, hardware and production dataset still require acceptance testing.

## First Windows installation

1. Install Windows x64 Node 22.x, version 22.16 or newer.
2. Extract the release to a local staging folder **outside** the installation target, such as `C:\OwnerTracker-Releases\version`.
3. In PowerShell, inspect the release without changing files:

```powershell
& 'C:\OwnerTracker-Releases\version\windows\INSTALL_OR_UPDATE.ps1' `
  -ReleaseDir 'C:\OwnerTracker-Releases\version' -TargetDir 'C:\OwnerTracker' -DryRun
```

4. With no OwnerTracker server or desktop receiver running, explicitly install:

```powershell
& 'C:\OwnerTracker-Releases\version\windows\INSTALL_OR_UPDATE.ps1' `
  -ReleaseDir 'C:\OwnerTracker-Releases\version' -TargetDir 'C:\OwnerTracker' -ConfirmStopped
```

5. Run `C:\OwnerTracker\windows\SETUP_FIRST.cmd` **once for a new installation** and protect the generated password/configuration. Then launch `OwnerTrackerDesktop.exe` and open the configured local address, normally `http://127.0.0.1:8787`.

If Windows execution policy blocks the script, follow your shop administrator's approved script policy. Do not download and execute an unsigned script through a one-line remote command. This updater does not change machine-wide execution policy or request administrator access automatically.

## Upgrade an existing shop

- Make a verified full database/photo backup and retain the private `.env` separately. Restore-test a copied shop dataset before the first real upgrade.
- Stop the server **and** desktop receiver. Verify Task Manager if necessary. The updater checks target-associated processes, the launcher lock and common SQLite sidecars; explicit `-ConfirmStopped` also asserts that manually launched relative-path processes/custom database connections are closed. The updater never kills processes or deletes database sidecars.
- Run `-DryRun`, then the explicit installation command above with `-ConfirmStopped`.
- The updater verifies the entire incoming inventory/hash manifest before changing code, stages the release, and retains the complete previous managed code under `C:\OwnerTracker.code-backup-UUID`. It replaces managed code roots while leaving `.env`, `data`, `uploads`, `backups`, `runtime` and unlisted root paths untouched. Caught installation failures roll the managed code back.
- An interrupted power loss or forced process termination can leave an incomplete code swap or update lock. Keep the retained baseline/staging folders, stop all application processes, and recover with administrator assistance. Do not delete an active update lock or run competing updaters.
- Start the new version and verify sign-in, customers, vehicles, approvals, work orders, photos, balances, receipts and desktop receiver status before resuming shop operations.

## Roll back code

Use the updater from a verified release, with the retained baseline as source:

```powershell
& 'C:\OwnerTracker-Releases\version\windows\INSTALL_OR_UPDATE.ps1' `
  -Rollback 'C:\OwnerTracker.code-backup-UUID' -TargetDir 'C:\OwnerTracker' -DryRun

& 'C:\OwnerTracker-Releases\version\windows\INSTALL_OR_UPDATE.ps1' `
  -Rollback 'C:\OwnerTracker.code-backup-UUID' -TargetDir 'C:\OwnerTracker' -ConfirmStopped
```

Rollback restores the exact retained code and keeps the code being replaced in another baseline. **Code rollback does not roll back the database or reverse migrations.** Confirm schema compatibility and restore a separately verified full backup only when required, with the server and receiver stopped. Do not mix an old database with a newer photo set.

## Native iPhone builds

`.github/workflows/ios.yml` generates the Xcode project with XcodeGen and compiles both `OwnerTrackerOwner` and `OwnerTrackerTech` for an **unsigned iOS simulator**. Artifacts are development simulator applications, not installable signed iPhone/App Store releases. A successful workflow checks compilation only.

Actual iPhone distribution requires the shop's Apple developer team/signing configuration, chosen bundle identifiers, device/TestFlight provisioning and on-device camera, photo upload, connectivity, privacy and permission testing. Neither Apple publishing nor signing is performed by this workflow. The owner/technician browser clients remain available for shop review and device testing.
