# Linux server deployment

Use `compose.server.yml` and `Dockerfile.server` for a new permanent Linux host.
The complete setup, DNS, private key, backup, restart, and restore procedure is in
[SERVER_DEPLOYMENT.md](https://github.com/blockaystudio/AzJetSki-Controller/blob/main/docs/SERVER_DEPLOYMENT.md).
In a source checkout, it is also at `../../docs/SERVER_DEPLOYMENT.md`.

The guide assumes a repository checkout whose application is under `Windows-Server/`.
For a standalone release, run from the release root and omit `Windows-Server/` from
the guide's paths. Bootstrap uses `node scripts/setup-server.mjs --domain YOUR_DOMAIN`;
Compose uses `docker compose --env-file .server/.env -f deploy/compose.server.yml`.
Docker Engine, Compose v2, a persistent Linux host, and an owned domain are required.

The bootstrap creates new private `.server/.env` and `.server/owner-login.txt` files
and refuses to overwrite existing configuration. Keep a separate offline recovery
copy of `.env`, particularly the backup key. Do not put `.server`, customer data,
or backup exports in source control or shared documents.

The application starts without demo data. Live providers and automatic customer
notifications remain disabled. Encrypted backups start enabled but remain local
until a separate destination is configured. Public HTTPS requires working DNS
and inbound TCP 80/443; local container tests do not verify a public certificate.

For repeatable disposable local verification in a source checkout, use Node 22,
Python 3, Docker Engine, and Compose 2.24.4 or newer:

```sh
python3 Windows-Server/test/server-deployment-smoke.py
```

The check builds a temporary image, creates uniquely named containers/volumes,
uses only a random loopback HTTP port, and removes its test resources afterward.
It verifies startup, private app networking, non-root/read-only operation, Caddy,
restart persistence, and encrypted backup/restore with fictional records. It
requires the local Unix Docker socket and does not provision a cloud server.
