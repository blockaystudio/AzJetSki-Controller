# Permanent-server preparation

Completed 2026-10-26 in `/workspace/ownertracker`; no cloud host provisioned.

## Files and behavior

- New `Windows-Server/deploy/compose.server.yml`, `Dockerfile.server`, and Dockerfile-specific `.dockerignore` preserve existing deployments. Node 22 runs as UID 1000 with read-only root, writable named data/backups volumes, temporary `/tmp`, dropped capabilities, no new privileges, health checks, and restart-on-exit. Port 8787 stays internal. Caddy exposes 80/443 with persistent TLS storage and waits for healthy app startup.
- New `Windows-Server/scripts/setup-server.mjs --domain DOMAIN` creates only a new private `.server` directory, `.env`, and owner login. It validates DNS-name syntax, generates independent cryptographic credentials, prints no secret, rejects existing setup and symlink ancestors. Backup schedule is enabled; review/demo loading, merchant/dealer credentials, imports, and automatic notifications are absent or disabled. Root `.gitignore` narrowly ignores `/Windows-Server/.server/`.
- Source/package read permissions are normalized in the server image because this checkout and portable releases contain private 0600/0700 modes. Caddy preserves inherited proxy exclusions and adds its private `ownertracker` upstream.
- `docs/SERVER_DEPLOYMENT.md` supplies provider/domain prerequisites, Linux/DNS/firewall setup, exact startup/update/restart/backup/restore commands, offline key handling, and the distinction between healthy-container detection and process-exit restart. `deploy/README.md` makes the guide discoverable in standalone releases.
- New `test/server-deployment-smoke.py` is a repeatable Linux test requiring Node 22, Python 3, local Docker socket, Compose >=2.24.4. It builds a temporary image, uses unique temporary Compose resources and loopback port, and cleans up. Root owns CI integration and the suite list.

## Verification

- Three focused setup-server tests passed under Node 22. Root reports full suite passed including those tests.
- Disposable full Compose run passed: healthy startup, UID 1000, read-only source/root, node-owned persistent volumes, capability/restart settings, no published application port, Caddy reverse proxy, empty initial customer table, database/upload persistence after restart, automatic encrypted startup backup, explicit encrypted backup/decryption/restoration, retained pre-restore copy, and healthy restored server.
- Evidence: `docs/evidence/server-container-smoke-2026-10-26.txt`.
- `git diff --check`, setup script syntax, and Python compilation passed.
- Read-only peer review found no blocker in bootstrap/Compose/image and called out the offline-key, WAL-checkpoint, and health-versus-restart documentation requirements; all are documented.

## Remaining launch dependencies

Hosting account and owned domain are still required. Current environment status has no configured cloud identity or credentials. No paid host, public DNS, ACME certificate, actual host reboot, offsite retention service, or real-data recovery has been verified. Encrypted backups remain local until a private offsite destination is configured. All test records were fictional; review runtime and real provider data were untouched.
