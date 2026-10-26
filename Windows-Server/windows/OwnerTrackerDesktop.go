package main

// Owner Tracker starts the local POS server and desktop manifest receiver.
// Requires Node.js >=22.16.0 and <23, installed or at runtime/node.exe.
import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type desktopConfig struct{ host, port, baseURL string }

// Match loadEnv's simple KEY=value and matching-quote rules. Values are never logged.
func readDesktopConfig(dir string, lookup func(string) (string, bool)) (desktopConfig, error) {
	data, err := os.ReadFile(filepath.Join(dir, ".env"))
	if err != nil {
		return desktopConfig{}, errors.New("private .env configuration is missing or unreadable; for a NEW installation run windows\\SETUP_FIRST.cmd first; preserve existing credentials and data on upgrades")
	}
	values := map[string]string{}
	for _, raw := range strings.Split(string(data), "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key, value = strings.TrimSpace(key), strings.TrimSpace(value)
		if len(value) >= 2 && ((value[0] == '"' && value[len(value)-1] == '"') || (value[0] == '\'' && value[len(value)-1] == '\'')) {
			value = value[1 : len(value)-1]
		}
		// loadEnv keeps the first assignment, unless the inherited environment supplies it.
		if _, exists := values[key]; !exists {
			values[key] = value
		}
	}
	get := func(key string) string {
		if value, ok := lookup(key); ok {
			return value
		}
		return values[key]
	}
	for _, key := range []string{"OWNERTRACKER_SESSION_SECRET", "QBPOS_BRIDGE_TOKEN", "DESKTOP_AGENT_TOKEN"} {
		value := get(key)
		if value == "" || strings.HasPrefix(value, "CHANGE_ME") {
			return desktopConfig{}, fmt.Errorf("configure %s privately before launching (the value has not been printed)", key)
		}
	}
	host := strings.TrimSpace(get("HOST"))
	if host == "" {
		host = "127.0.0.1"
	}
	// The existing desktop receiver supports these two local HTTP addresses.
	if host != "127.0.0.1" && host != "localhost" {
		return desktopConfig{}, errors.New("the desktop launcher requires HOST=127.0.0.1 or HOST=localhost; use a separately secured server deployment for other bind addresses")
	}
	port := strings.TrimSpace(get("PORT"))
	if port == "" {
		port = "8787"
	}
	number, err := strconv.Atoi(port)
	if err != nil || number < 1 || number > 65535 || strconv.Itoa(number) != port {
		return desktopConfig{}, errors.New("PORT must be a decimal integer from 1 to 65535")
	}
	return desktopConfig{host, port, "http://" + net.JoinHostPort(host, port)}, nil
}

var nodeVersionPattern = regexp.MustCompile(`^v?(\d+)\.(\d+)\.(\d+)$`)

func checkNodeVersion(output string) error {
	parts := nodeVersionPattern.FindStringSubmatch(strings.TrimSpace(output))
	if len(parts) != 4 {
		return errors.New("could not verify the Node.js version; install Node.js 22.x, version 22.16.0 or newer")
	}
	major, majorErr := strconv.Atoi(parts[1])
	minor, minorErr := strconv.Atoi(parts[2])
	if majorErr != nil || minorErr != nil || major != 22 || minor < 16 {
		return errors.New("Node.js >=22.16.0 and <23 is required; install a current Node.js 22.x Windows x64 runtime")
	}
	return nil
}

func resolveNode(ctx context.Context, dir string) (string, error) {
	node := filepath.Join(dir, "runtime", "node.exe")
	if info, err := os.Stat(node); err != nil || info.IsDir() {
		var err error
		node, err = exec.LookPath("node.exe")
		if err != nil {
			return "", errors.New("Node.js 22.x is missing; install Windows x64 Node.js >=22.16.0 and <23, or place its executable at runtime\\node.exe")
		}
	}
	probe, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	output, err := exec.CommandContext(probe, node, "--version").Output()
	if err != nil {
		return "", errors.New("Node.js could not report its version; repair the installed or bundled runtime")
	}
	if err := checkNodeVersion(string(output)); err != nil {
		return "", err
	}
	return node, nil
}

func acquireLauncherLock(dir string) (func(), error) {
	lock := filepath.Join(dir, "data", "desktop-launcher.lock")
	if err := os.MkdirAll(filepath.Dir(lock), 0700); err != nil {
		return nil, errors.New("cannot create the private application data directory")
	}
	if err := os.Mkdir(lock, 0700); err != nil {
		return nil, errors.New("another desktop launcher may be running. Close it first. After a crash/restart, verify no Owner Tracker Node processes are running, then remove data\\desktop-launcher.lock and retry")
	}
	release := func() { os.Remove(filepath.Join(lock, "pid")); os.Remove(lock) }
	if err := os.WriteFile(filepath.Join(lock, "pid"), []byte(strconv.Itoa(os.Getpid())+"\n"), 0600); err != nil {
		release()
		return nil, errors.New("cannot write the launcher lock")
	}
	return release, nil
}

func checkPortAvailable(config desktopConfig) error {
	listener, err := net.Listen("tcp", net.JoinHostPort(config.host, config.port))
	if err != nil {
		return fmt.Errorf("local port %s is already in use or unavailable; close the existing Owner Tracker server or choose a different PORT", config.port)
	}
	return listener.Close()
}

type childProcess struct {
	command *exec.Cmd
	done    chan struct{}
	err     error
}

func startChild(command string, args []string, dir string, env []string, output io.Writer) (*childProcess, error) {
	cmd := exec.Command(command, args...)
	cmd.Dir = dir
	cmd.Env = env
	cmd.Stdout = output
	cmd.Stderr = output
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	child := &childProcess{command: cmd, done: make(chan struct{})}
	go func() { child.err = cmd.Wait(); close(child.done) }()
	return child, nil
}
func (child *childProcess) stop() {
	if child == nil {
		return
	}
	select {
	case <-child.done:
		return
	default:
	}
	_ = child.command.Process.Kill()
	// Reap the process before releasing the single-launch lock or closing its log.
	<-child.done
}

func waitForReady(ctx context.Context, baseURL string, stopped <-chan struct{}, timeout time.Duration) error {
	client := &http.Client{
		Timeout:       400 * time.Millisecond,
		Transport:     &http.Transport{Proxy: nil},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	defer client.CloseIdleConnections()
	deadline, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-deadline.Done():
			return deadline.Err()
		case <-stopped:
			return errors.New("POS server exited during startup; review data\\desktop.log")
		default:
		}
		req, err := http.NewRequestWithContext(deadline, http.MethodGet, baseURL+"/health", nil)
		if err != nil {
			return err
		}
		response, err := client.Do(req)
		healthy := false
		if err == nil {
			var health struct {
				OK   bool   `json:"ok"`
				Name string `json:"name"`
			}
			err = json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&health)
			response.Body.Close()
			healthy = response.StatusCode == http.StatusOK && err == nil && health.OK && health.Name == "Owner Tracker V11"
		}
		if healthy {
			select {
			case <-stopped:
				return errors.New("POS server exited during startup; review data\\desktop.log")
			default:
				return nil
			}
		}
		select {
		case <-deadline.Done():
			return fmt.Errorf("POS did not become ready: %w; review data\\desktop.log", deadline.Err())
		case <-stopped:
			return errors.New("POS server exited during startup; review data\\desktop.log")
		case <-ticker.C:
		}
	}
}

func childEnvironment(config desktopConfig) []string {
	env := []string{}
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		if strings.EqualFold(key, "HOST") || strings.EqualFold(key, "PORT") || strings.EqualFold(key, "DESKTOP_SERVER_URL") {
			continue
		}
		env = append(env, entry)
	}
	// Keep the desktop receiver on the server just started, even with custom PORT.
	return append(env, "HOST="+config.host, "PORT="+config.port, "DESKTOP_SERVER_URL="+config.baseURL)
}

func runDesktop(ctx context.Context, dir string) error {
	for _, file := range []string{filepath.Join("src", "server.mjs"), filepath.Join("scripts", "desktop-agent.mjs")} {
		if info, err := os.Stat(filepath.Join(dir, file)); err != nil || info.IsDir() {
			return errors.New("keep OwnerTrackerDesktop.exe inside the complete Windows-Server folder beside src, scripts and public")
		}
	}
	config, err := readDesktopConfig(dir, os.LookupEnv)
	if err != nil {
		return err
	}
	node, err := resolveNode(ctx, dir)
	if err != nil {
		return err
	}
	release, err := acquireLauncherLock(dir)
	if err != nil {
		return err
	}
	defer release()
	if err := checkPortAvailable(config); err != nil {
		return err
	}
	logPath := filepath.Join(dir, "data", "desktop.log")
	log, err := os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0600)
	if err != nil {
		return errors.New("cannot open data\\desktop.log")
	}
	defer log.Close()
	env := childEnvironment(config)
	server, err := startChild(node, []string{filepath.Join("src", "server.mjs")}, dir, env, log)
	if err != nil {
		return errors.New("failed to start the POS server; check the Node.js installation")
	}
	defer server.stop()
	fmt.Println("Starting Owner Tracker; waiting for the local server...")
	if err := waitForReady(ctx, config.baseURL, server.done, 20*time.Second); err != nil {
		return err
	}
	agent, err := startChild(node, []string{filepath.Join("scripts", "desktop-agent.mjs")}, dir, env, log)
	if err != nil {
		return errors.New("failed to start the desktop receiver; the POS server will stop")
	}
	defer agent.stop()
	select {
	case <-ctx.Done():
		return nil
	case <-agent.done:
		return errors.New("desktop receiver exited; review data\\desktop.log")
	case <-server.done:
		return errors.New("POS server exited; review data\\desktop.log")
	default:
	}
	fmt.Println("Owner Tracker V11 desktop / POS is ready")
	fmt.Println("Shop desktop:", config.baseURL+"/desktop.html")
	fmt.Println("Sales / POS:", config.baseURL+"/shop-ops.html?tab=retail")
	fmt.Println("Calendar:", config.baseURL+"/shop-ops.html?tab=schedule")
	fmt.Println("Shop operations:", config.baseURL+"/shop-ops.html")
	fmt.Println("Owner / technician:", config.baseURL+"/owner.html", config.baseURL+"/tech.html")
	fmt.Println("Payments:", config.baseURL+"/billing.html")
	fmt.Println("Leave this console open. Press Ctrl+C here to stop the server and desktop receiver.")
	browser := exec.Command("rundll32.exe", "url.dll,FileProtocolHandler", config.baseURL+"/desktop.html")
	if err := browser.Start(); err != nil {
		fmt.Println("Open the POS URL above in your browser.")
	} else {
		go func() { _ = browser.Wait() }()
	}
	select {
	case <-ctx.Done():
		return nil
	case <-server.done:
		return errors.New("POS server stopped; review data\\desktop.log")
	case <-agent.done:
		return errors.New("desktop receiver stopped; review data\\desktop.log")
	}
}

func main() {
	if runtime.GOOS != "windows" {
		fmt.Println("This desktop launcher is for Windows 10/11 x64.")
		return
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	own, err := os.Executable()
	if err == nil {
		err = runDesktop(ctx, filepath.Dir(own))
	}
	if err != nil && ctx.Err() == nil {
		fmt.Println("ERROR:", err)
		fmt.Println("Press Enter to exit.")
		entered := make(chan struct{})
		go func() { _, _ = fmt.Scanln(); close(entered) }()
		select {
		case <-entered:
		case <-ctx.Done():
		}
		os.Exit(1)
	}
}
