# Windows desktop launcher

`OwnerTrackerDesktop.go` starts the shared POS server and desktop manifest receiver. Keep the compiled `OwnerTrackerDesktop.exe` in the parent `Windows-Server` folder beside `src`, `scripts`, `public`, and the private `.env` file.

Before starting either child process, the launcher:

- Requires an existing readable `.env`; it never runs setup or overwrites shop credentials/data. On a new installation, run `SETUP_FIRST.cmd` first.
- Executes `node.exe --version` and requires **Node >=22.16.0 and <23**. It prefers `runtime/node.exe`, then searches `PATH`.
- Reads `HOST` and `PORT` using inherited environment values before `.env` values. Desktop mode accepts `HOST=127.0.0.1` or `HOST=localhost`; absent values default to `127.0.0.1:8787`. Other deployment addresses require a separately configured secure server, rather than this local desktop launcher.
- Validates the required session/bridge/desktop secrets without printing their values, acquires a single-launch lock, and rejects an occupied local port.
- Waits up to 20 seconds for the local `/health` endpoint to identify itself as Owner Tracker V11. It opens the browser only after server readiness and never follows health-check redirects.

The desktop receiver always targets the local server and configured port, even if a different `DESKTOP_SERVER_URL` was supplied. Output goes to private `data/desktop.log`. If either child exits, the launcher stops and reaps the other. **Press Ctrl+C in the launcher console to stop both processes.** Operating-system termination, power loss, and forcible process kills can bypass normal cleanup; Windows console-close behavior still requires testing on the shop PC.

`data/desktop-launcher.lock` prevents concurrent launcher instances. Normal shutdown removes it. After an interrupted shutdown, verify in Task Manager that no Owner Tracker server or desktop receiver Node processes are still running, then remove that lock folder before retrying. Do not remove an active launcher's lock or start multiple servers against the shop database.

## Build and verify

Using the real Go toolchain (Go 1.24.x or newer), from `Windows-Server`:

```sh
# Linux/macOS shell. No Go module or external dependencies are needed.
GO111MODULE=off go test -race ./windows
GOOS=windows GOARCH=amd64 go build -trimpath -ldflags='-s -w' -o OwnerTrackerDesktop.exe windows/OwnerTrackerDesktop.go
```

The tests run on the build host and cover runtime/configuration preflight, secret-safe errors, duplicate startup and port collision, readiness/redirect behavior, cancellation, child cleanup, and the local receiver target. Cross-compilation verifies a Windows x64 binary can be built. These checks do not establish real Windows execution, browser launch, console events, printer operation, or shop-device acceptance.
