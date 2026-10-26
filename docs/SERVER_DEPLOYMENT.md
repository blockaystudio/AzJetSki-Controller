# Permanent shop server

The server package is ready for a Linux host running Docker Engine and Docker Compose 2.24.4 or newer (also required by the disposable verification script). It has not provisioned a hosting account, purchased a server, configured DNS, or verified a public certificate. The owner must select a hosting account and a domain they control before those steps can be completed.

Start with one Linux virtual machine with 2 vCPUs, 4 GB RAM, and persistent SSD storage. Allow at least 40 GB initially and monitor photo/backup growth. This is a starting recommendation, not a measured capacity guarantee. Run one application container with its local SQLite volume. Do not run replicas against the same database or move SQLite onto a shared network filesystem.

## DNS and host preparation

1. Create the Linux server in the selected hosting account. Keep its disk persistent across reboots. Use SSH keys and permit SSH only from the administrator's address where practical.
2. Install Docker Engine and the Compose v2 plugin following [Docker's Linux installation instructions](https://docs.docker.com/engine/install/). Enable Docker at boot: `sudo systemctl enable --now docker`. The commands below assume the administrator can run Docker.
3. Point the chosen domain's DNS `A` record at the server's public IPv4 address. Add an `AAAA` record only if IPv6 reaches this same server. Remove stale records pointing elsewhere.
4. Allow inbound TCP ports 80 and 443 in the hosting firewall and host firewall. Port 80 provides the HTTPS redirect and certificate validation. The application port, 8787, is internal to Docker and is not published. No database port is published.
5. Clone the authoritative source and check out the reviewed release/commit:

```sh
git clone https://github.com/blockaystudio/AzJetSki-Controller.git
cd AzJetSki-Controller
```

The server's Docker storage must be on persistent disk. Provider snapshots are additional recovery copies; they do not replace the application's validated encrypted backups.

## Create private configuration and start

Replace `shop.yourdomain.com` with the actual DNS name. This command uses Node 22 in a temporary container; a host Node installation is unnecessary. It creates `Windows-Server/.server/` with mode 0700 and `.env` and `owner-login.txt` with mode 0600. It refuses an existing directory and never prints generated credentials.

```sh
docker run --rm --user "$(id -u):$(id -g)" \
  --mount "type=bind,src=$PWD/Windows-Server,dst=/app" \
  --workdir /app node:22-bookworm-slim \
  node scripts/setup-server.mjs --domain shop.yourdomain.com

ot() {
  docker compose --env-file Windows-Server/.server/.env \
    -f Windows-Server/deploy/compose.server.yml "$@"
}

ot config --quiet
ot up --build -d --wait --wait-timeout 180
ot ps
curl --fail --show-error https://shop.yourdomain.com/health
```

Recreate the `ot` shell function when opening a new SSH session, from the repository root. `ot config --quiet` validates configuration without displaying secrets. Avoid publishing the output of unredacted `ot config` or container environment inspection.

Open `Windows-Server/.server/owner-login.txt` privately and store the initial login in the shop password manager. Save a separate offline copy of `.env`, especially `OWNERTRACKER_BACKUP_KEY`, before loading shop data. The backup key is necessary to decrypt backups; losing it makes those archives unusable. Keep it separate from the backup storage. The `.server` directory is excluded from Git and the image build; never upload it to Drive or include it in support screenshots.

The generated password initializes a new database only. Editing it in `.env` does not reset an existing owner. Change the password through the application and update the password manager. For a lost owner login, follow the existing `recover-owner.mjs` recovery procedure while the app is stopped.

The application runs as the image's `node` user (UID 1000), with a read-only root filesystem, a temporary `/tmp`, dropped Linux capabilities, and no new privileges. Newly created named data and backup volumes inherit the required ownership from the image. Caddy waits for the application's health check, serves HTTPS on 443, and stores certificates in persistent volumes. The Compose project name is fixed as `ownertracker-shop`; retain that name on later runs so the same volumes are reused.

Caddy starts obtaining a publicly trusted certificate after DNS and network access are correct. A successful Compose startup alone does not prove public HTTPS works: check the actual HTTPS URL from another network. Caddy's certificate storage must remain writable and persistent. See [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https) and [Compose health-dependent startup](https://docs.docker.com/compose/how-tos/startup-order/).

## Launch checks and daily operation

The database starts without demo customers or transactions. Review mode, automatic customer sending, live dealer ordering, historical QBPOS import, and DocuSign sending are disabled. Merchant credentials are absent. Live providers, shop hardware, imports, and actual customer delivery require their own setup and acceptance before use.

Sign in as the owner and verify the shop name, tax settings, staff access, and permissions. Confirm repair intake and counter sale workflows using fictional records before importing reviewed shop data. Check Maintenance for a successful encrypted backup and rehearse restoration on a disposable copy. Confirm the public customer links use the intended HTTPS domain.

```sh
ot logs --tail 100 ownertracker https
ot restart
ot ps
curl --fail --show-error https://shop.yourdomain.com/health
```

Both containers restart after a host reboot when Docker is enabled. A failed process restarts automatically; an unhealthy but still running process needs investigation, since Docker's restart policy does not restart a container merely for an unhealthy check. Monitor external HTTPS health, maintenance failures, host disk usage, and backup destination availability. Log files rotate automatically. `ot stop` deliberately stops the services; `ot up -d --wait` starts them again.

Data, photos, encrypted backups, and TLS certificates live in named volumes. Ordinary restarts and `ot down` retain them. **Do not run `ot down --volumes`, remove the named volumes, or prune volumes on the shop server.**

For a reviewed update, first produce and export an encrypted backup, then select the reviewed source commit and rebuild:

```sh
ot exec -T ownertracker node scripts/encrypted-backup.mjs
ot cp ownertracker:/app/backups Windows-Server/.server/backup-export
# Copy the encrypted archives to separate private storage before updating.
git fetch origin
git checkout REVIEWED_COMMIT
ot up --build -d --wait --wait-timeout 180
```

Replace `REVIEWED_COMMIT` with the accepted commit. Review migrations before rolling back application code; restoring an earlier database is a separate operation that can discard later transactions.

## Encrypted backups and recovery

Automatic encrypted backups run on first startup and every 24 hours, retaining 30 successful scheduled backups by default. Manual CLI backups are additional archives and are not part of that automatic retention count. The local backup volume shares the server's failure domain. Before real shop use, arrange encrypted copies on separate storage and verify recovery with the separately held key.

The application can upload each scheduled archive to an authorized HTTPS endpoint supporting `PUT`. Configure `BACKUP_OFFSITE_URL` and, if needed, `BACKUP_OFFSITE_TOKEN` privately in `.server/.env`, then recreate the app with `ot up -d --force-recreate --wait ownertracker`. Use `{filename}` in the URL or a directory endpoint; the application otherwise appends the archive filename. Verify Maintenance reports `offsite_confirmed`. An unconfigured destination leaves backups local; an accepted HTTP upload is not proof of successful recovery.

To export local encrypted archives, use `ot cp ownertracker:/app/backups Windows-Server/.server/backup-export` and transfer the exported `.otb` files through the chosen private storage workflow. Keep plaintext recovery folders and `.env` out of shared exports. Check free disk space and retained archive counts regularly.

The following restore procedure changes the active database and photos. Rehearse it with a disposable server before use. Choose the correct archive and recovery key, stop staff activity and any desktop agents, and preserve a current encrypted backup first. Run from the repository root with the `ot` function above. Replace `ownertracker-CHOSEN.otb` with the selected archive name.

```sh
ot exec -T ownertracker node scripts/encrypted-backup.mjs
ot stop https ownertracker

# Close/checkpoint any SQLite sidecars left by process termination.
# This runs after all application writers have stopped.
ot run --rm --no-deps ownertracker node -e \
  "const fs=require('node:fs');const p=process.env.OWNERTRACKER_DB;if(fs.existsSync(p)){const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(p);db.exec('PRAGMA wal_checkpoint(TRUNCATE)');db.close()}"

# The recovery directory must be a new path. Choose another name on later rehearsals.
ot run --rm --no-deps ownertracker node scripts/encrypted-backup.mjs \
  decrypt /app/backups/ownertracker-CHOSEN.otb /app/backups/restore-reviewed
ot run --rm --no-deps ownertracker node scripts/restore-all.mjs \
  /app/backups/restore-reviewed
ot up -d --wait --wait-timeout 180
curl --fail --show-error https://shop.yourdomain.com/health
```

Restore validates archive authentication, checksums, database integrity, and upload paths before replacing data. It retains a pre-restore database/photo copy in the data volume. Sign in and verify customer counts, repair records, inventory, invoices, payments, retained approvals, and photos before reopening the shop. Keep the original archive and the pre-restore copy until recovery is accepted. The decrypted recovery folder is plaintext; remove it after accepted recovery using the precise reviewed directory, retaining the encrypted original.

On a replacement server, recover the original private `.env` and key into the new `.server` directory with the same permissions before starting the application. Point DNS to the replacement only after checking the restoration. To import an archive from private host storage into the new backup volume without displaying contents:

```sh
ot run --rm -T --no-deps ownertracker node --input-type=module -e \
  "import fs from 'node:fs';import {pipeline} from 'node:stream/promises';await pipeline(process.stdin,fs.createWriteStream('/app/backups/recovery-import.otb',{flags:'wx',mode:0o600}))" \
  < /private/path/ownertracker-CHOSEN.otb
```

Then use `/app/backups/recovery-import.otb` in the decrypt step above. Import refuses to overwrite an existing archive. New named volumes receive node ownership when the first container is created. Retaining the original session/calendar keys also preserves access to data encrypted or signed with those keys.
