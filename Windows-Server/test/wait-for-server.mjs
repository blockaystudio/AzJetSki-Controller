// Wait for the disposable HTTP server, without assuming a startup duration.
import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const [pidArgument, healthUrl, logPath, timeoutArgument = '15000'] = process.argv.slice(2);
const pid = Number(pidArgument);
const timeoutMs = Number(timeoutArgument);

function assertRunning() {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code === 'ESRCH') throw new Error(`Server process ${pid} exited before becoming ready`);
    throw error;
  }
}

try {
  if (!Number.isInteger(pid) || pid <= 0 || !healthUrl || !logPath ||
      !Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60000) {
    throw new Error('Usage: node test/wait-for-server.mjs PID HEALTH_URL SERVER_LOG [TIMEOUT_MS: 1-60000]');
  }
  const deadline = performance.now() + timeoutMs;
  let ready = false;
  let lastFailure = 'No health response';
  let lastHealthResponse = '';
  while (performance.now() < deadline) {
    assertRunning();
    try {
      const remaining = Math.max(1, Math.ceil(deadline - performance.now()));
      const response = await fetch(healthUrl, {
        signal: AbortSignal.timeout(Math.min(500, remaining)),
        redirect: 'error',
      });
      const health = await response.json();
      if (response.status === 200 && health.ok === true && health.name === 'Owner Tracker V11') {
        assertRunning();
        ready = true;
        break;
      }
      lastHealthResponse = `HTTP ${response.status}; expected the OwnerTracker healthy response`;
      lastFailure = lastHealthResponse;
    } catch (error) {
      lastFailure = error.cause?.code || error.message;
    }
    assertRunning();
    const remaining = deadline - performance.now();
    if (remaining > 0) await delay(Math.min(100, remaining));
  }
  if (!ready) {
    const detail = lastHealthResponse && lastHealthResponse !== lastFailure ? `; last response: ${lastHealthResponse}` : '';
    throw new Error(`Server ${pid} was not ready at ${healthUrl} within ${timeoutMs}ms: ${lastFailure}${detail}`);
  }
  console.log(`PASS: disposable server ready at ${healthUrl}`);
} catch (error) {
  console.error(error.message);
  if (logPath) {
    try {
      console.error(`Server log (${logPath}):\n${fs.readFileSync(logPath, 'utf8').slice(-8000).trim() || '(empty)'}`);
    } catch (logError) {
      console.error(`Server log unavailable: ${logError.message}`);
    }
  }
  process.exitCode = 1;
}
