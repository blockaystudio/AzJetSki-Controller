package main

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// The test executable can stand in for node.exe without installing another runtime.
func TestMain(m *testing.M) {
	if len(os.Args) == 2 && os.Args[1] == "--version" && os.Getenv("OWNERTRACKER_TEST_NODE_VERSION") != "" {
		fmt.Println(os.Getenv("OWNERTRACKER_TEST_NODE_VERSION"))
		os.Exit(0)
	}
	if len(os.Args) == 2 && os.Args[1] == "--ownertracker-child" {
		time.Sleep(time.Hour)
		os.Exit(0)
	}
	if len(os.Args) == 2 && (os.Args[1] == filepath.Join("src", "server.mjs") || os.Args[1] == filepath.Join("scripts", "desktop-agent.mjs")) && os.Getenv("OWNERTRACKER_TEST_NODE_VERSION") != "" {
		// A Node startup failure must never reach browser/receiver launch.
		if os.Args[1] == filepath.Join("scripts", "desktop-agent.mjs") {
			_ = os.WriteFile(os.Getenv("OWNERTRACKER_TEST_AGENT_MARKER"), []byte("unexpected receiver start"), 0600)
		}
		os.Exit(17)
	}
	os.Exit(m.Run())
}

const testConfig = "HOST=127.0.0.1\nPORT=8787\nOWNERTRACKER_SESSION_SECRET=private-test-session\nQBPOS_BRIDGE_TOKEN=private-test-bridge\nDESKTOP_AGENT_TOKEN=private-test-agent\n"

func writeConfig(t *testing.T, dir, text string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, ".env"), []byte(text), 0600); err != nil {
		t.Fatal(err)
	}
}
func noEnv(string) (string, bool) { return "", false }

func TestConfigPrecedenceAndLocalEndpoint(t *testing.T) {
	dir := t.TempDir()
	writeConfig(t, dir, testConfig+"PORT=9999\n")
	config, err := readDesktopConfig(dir, noEnv)
	if err != nil || config.baseURL != "http://127.0.0.1:8787" {
		t.Fatalf("first .env value should win: %+v %v", config, err)
	}
	lookup := func(key string) (string, bool) {
		values := map[string]string{"HOST": "localhost", "PORT": "9123"}
		value, ok := values[key]
		return value, ok
	}
	config, err = readDesktopConfig(dir, lookup)
	if err != nil || config.baseURL != "http://localhost:9123" {
		t.Fatalf("inherited environment should override .env: %+v %v", config, err)
	}
	writeConfig(t, dir, strings.ReplaceAll(testConfig, "127.0.0.1", "\"localhost\""))
	config, err = readDesktopConfig(dir, noEnv)
	if err != nil || config.host != "localhost" {
		t.Fatalf("quoted .env host: %+v %v", config, err)
	}
}

func TestConfigRejectsRemoteBindingInvalidPortAndMissingSecrets(t *testing.T) {
	for _, host := range []string{"0.0.0.0", "192.168.1.5", "example.com", "127.0.0.1.example.com", "::", "::1", "http://localhost"} {
		t.Run("host_"+host, func(t *testing.T) {
			dir := t.TempDir()
			writeConfig(t, dir, strings.ReplaceAll(testConfig, "127.0.0.1", host))
			if _, err := readDesktopConfig(dir, noEnv); err == nil {
				t.Fatalf("accepted unsupported desktop host %q", host)
			}
		})
	}
	for _, port := range []string{"0", "65536", "-1", "8787/health", "1e3", "0x222f", "08787"} {
		t.Run("port_"+port, func(t *testing.T) {
			dir := t.TempDir()
			writeConfig(t, dir, strings.ReplaceAll(testConfig, "8787", port))
			if _, err := readDesktopConfig(dir, noEnv); err == nil {
				t.Fatalf("accepted invalid port %q", port)
			}
		})
	}
	dir := t.TempDir()
	writeConfig(t, dir, testConfig)
	lookup := func(key string) (string, bool) {
		if key == "DESKTOP_AGENT_TOKEN" {
			return "", true
		}
		return "", false
	}
	if _, err := readDesktopConfig(dir, lookup); err == nil || !strings.Contains(err.Error(), "DESKTOP_AGENT_TOKEN") || strings.Contains(err.Error(), "private-test") {
		t.Fatalf("missing secret must fail without exposing values: %v", err)
	}
}

func TestMissingConfigDoesNotInitializeData(t *testing.T) {
	dir := t.TempDir()
	if _, err := readDesktopConfig(dir, noEnv); err == nil || !strings.Contains(err.Error(), "SETUP_FIRST.cmd") {
		t.Fatalf("missing configuration should give setup instruction: %v", err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 0 {
		t.Fatalf("configuration check modified installation: %v %v", entries, err)
	}
}

func TestSupportedNodeVersions(t *testing.T) {
	for _, version := range []string{"v22.16.0\r\n", "v22.23.4", "22.99.1"} {
		if err := checkNodeVersion(version); err != nil {
			t.Errorf("rejected supported version %q: %v", version, err)
		}
	}
	for _, version := range []string{"v22.5.0", "v22.15.9", "v20.19.0", "v23.0.0", "v24.1.0", "v22.16.0-rc.1", "node v22.16.0", "v22.16", "garbage"} {
		if err := checkNodeVersion(version); err == nil {
			t.Errorf("accepted unsupported version %q", version)
		}
	}
}

func installFakeNode(t *testing.T, dir string) {
	t.Helper()
	source, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "runtime"), 0700); err != nil {
		t.Fatal(err)
	}
	input, err := os.Open(source)
	if err != nil {
		t.Fatal(err)
	}
	defer input.Close()
	output, err := os.OpenFile(filepath.Join(dir, "runtime", "node.exe"), os.O_CREATE|os.O_WRONLY, 0700)
	if err != nil {
		t.Fatal(err)
	}
	_, copyErr := io.Copy(output, input)
	closeErr := output.Close()
	if copyErr != nil || closeErr != nil {
		t.Fatalf("copy test runtime: %v %v", copyErr, closeErr)
	}
}

func TestRuntimePreflightRefusesOldNodeWithoutStartingApplication(t *testing.T) {
	dir := t.TempDir()
	writeConfig(t, dir, testConfig)
	installFakeNode(t, dir)
	for _, file := range []string{filepath.Join("src", "server.mjs"), filepath.Join("scripts", "desktop-agent.mjs")} {
		if err := os.MkdirAll(filepath.Dir(filepath.Join(dir, file)), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, file), nil, 0600); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("OWNERTRACKER_TEST_NODE_VERSION", "v22.5.0")
	err := runDesktop(context.Background(), dir)
	if err == nil || !strings.Contains(err.Error(), ">=22.16.0") {
		t.Fatalf("old Node runtime was not refused: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "data")); !os.IsNotExist(err) {
		t.Fatalf("old Node preflight should not create data or launch children: %v", err)
	}
}

func TestServerStartupFailureCleansUpAndNeverStartsReceiver(t *testing.T) {
	dir := t.TempDir()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := fmt.Sprint(listener.Addr().(*net.TCPAddr).Port)
	listener.Close()
	writeConfig(t, dir, strings.ReplaceAll(testConfig, "8787", port))
	installFakeNode(t, dir)
	for _, file := range []string{filepath.Join("src", "server.mjs"), filepath.Join("scripts", "desktop-agent.mjs")} {
		if err := os.MkdirAll(filepath.Dir(filepath.Join(dir, file)), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, file), nil, 0600); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("OWNERTRACKER_TEST_NODE_VERSION", "v22.23.4")
	t.Setenv("OWNERTRACKER_TEST_AGENT_MARKER", filepath.Join(dir, "receiver-started"))
	t.Setenv("HOST", "127.0.0.1")
	t.Setenv("PORT", port)
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	err = runDesktop(ctx, dir)
	if err == nil || !strings.Contains(err.Error(), "exited during startup") {
		t.Fatalf("server startup failure was not reported: %v", err)
	}
	for _, file := range []string{filepath.Join("data", "desktop-launcher.lock"), "receiver-started"} {
		if _, err := os.Stat(filepath.Join(dir, file)); !os.IsNotExist(err) {
			t.Fatalf("startup failure left %s: %v", file, err)
		}
	}
}

func TestLauncherLockRequiresExplicitRecoveryAfterCrash(t *testing.T) {
	dir := t.TempDir()
	release, err := acquireLauncherLock(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := acquireLauncherLock(dir); err == nil {
		t.Fatal("second launcher acquired the lock")
	}
	release()
	release, err = acquireLauncherLock(dir)
	if err != nil {
		t.Fatalf("normal shutdown failed to release lock: %v", err)
	}
	release()
	if err := os.Mkdir(filepath.Join(dir, "data", "desktop-launcher.lock"), 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := acquireLauncherLock(dir); err == nil || !strings.Contains(err.Error(), "verify no Owner Tracker Node processes") {
		t.Fatalf("stale lock should require verified recovery: %v", err)
	}
}

func TestOccupiedPortIsRejected(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	config := desktopConfig{host: "127.0.0.1", port: fmt.Sprint(listener.Addr().(*net.TCPAddr).Port)}
	if err := checkPortAvailable(config); err == nil {
		listener.Close()
		t.Fatal("accepted an occupied port")
	}
	listener.Close()
	if err := checkPortAvailable(config); err != nil {
		t.Fatalf("released port should be available: %v", err)
	}
}

func TestReadinessWaitsForIdentifiedHealthyServer(t *testing.T) {
	var ready atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/health" {
			t.Errorf("unexpected readiness path %q", r.URL.Path)
		}
		if ready.Load() {
			fmt.Fprint(w, `{"ok":true,"name":"Owner Tracker V11"}`)
		} else {
			w.WriteHeader(503)
		}
	}))
	defer server.Close()
	done := make(chan struct{})
	result := make(chan error, 1)
	go func() { result <- waitForReady(context.Background(), server.URL, done, 2*time.Second) }()
	select {
	case err := <-result:
		t.Fatalf("returned before ready: %v", err)
	case <-time.After(150 * time.Millisecond):
	}
	ready.Store(true)
	if err := <-result; err != nil {
		t.Fatalf("healthy server never became ready: %v", err)
	}
}

func TestReadinessRejectsWrongServiceAndRedirects(t *testing.T) {
	for _, body := range []string{`{"ok":true,"name":"Another app"}`, `{"ok":false,"name":"Owner Tracker V11"}`, `not json`} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, body) }))
		if err := waitForReady(context.Background(), server.URL, make(chan struct{}), 120*time.Millisecond); err == nil {
			t.Errorf("accepted invalid health response %q", body)
		}
		server.Close()
	}
	var redirected atomic.Bool
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		redirected.Store(true)
		fmt.Fprint(w, `{"ok":true,"name":"Owner Tracker V11"}`)
	}))
	defer target.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, http.StatusFound) }))
	defer server.Close()
	if err := waitForReady(context.Background(), server.URL, make(chan struct{}), 120*time.Millisecond); err == nil {
		t.Fatal("accepted redirected readiness response")
	}
	if redirected.Load() {
		t.Fatal("readiness followed a redirect away from local endpoint")
	}
}

func TestReadinessStopsForStartupFailureOrCancellation(t *testing.T) {
	stopped := make(chan struct{})
	close(stopped)
	if err := waitForReady(context.Background(), "http://127.0.0.1:1", stopped, time.Second); err == nil || !strings.Contains(err.Error(), "exited during startup") {
		t.Fatalf("startup failure was not reported: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := waitForReady(ctx, "http://127.0.0.1:1", make(chan struct{}), time.Second); err == nil {
		t.Fatal("readiness ignored cancellation")
	}
}

func TestStoppedChildrenAreReaped(t *testing.T) {
	child, err := startChild(os.Args[0], []string{"--ownertracker-child"}, t.TempDir(), os.Environ(), io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	child.stop()
	select {
	case <-child.done:
	case <-time.After(time.Second):
		t.Fatal("child did not stop")
	}
	if child.command.ProcessState == nil {
		t.Fatal("child was not reaped")
	}
	child.stop() // Cleanup remains safe when a process has already exited.
}

func TestDesktopReceiverUsesSameLocalPort(t *testing.T) {
	t.Setenv("DESKTOP_SERVER_URL", "https://remote.example.invalid")
	config := desktopConfig{host: "localhost", port: "9123", baseURL: "http://localhost:9123"}
	env := childEnvironment(config)
	count := 0
	for _, entry := range env {
		if strings.HasPrefix(entry, "DESKTOP_SERVER_URL=") {
			count++
			if entry != "DESKTOP_SERVER_URL=http://localhost:9123" {
				t.Fatalf("receiver retained remote target %q", entry)
			}
		}
	}
	if count != 1 {
		t.Fatalf("expected one receiver URL override, got %d", count)
	}
}
