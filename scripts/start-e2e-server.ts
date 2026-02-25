/**
 * @fileoverview Starts the Next.js dev server on the first available port (3000, 3001, …),
 * then runs Playwright E2E tests with that base URL. Used so E2E work even when 3000 is in use.
 * Ensures the dev server is killed when tests finish or the process exits (e.g. Ctrl+C).
 * @module scripts/start-e2e-server
 */

import { execSync, spawn } from "child_process";
import net from "net";
import os from "os";

const PORT_MIN = 3000;
const PORT_MAX = 3010;
const SHUTDOWN_WAIT_MS = 3000;

/** @returns the first port in [PORT_MIN, PORT_MAX] that is not in use. */
function findFreePort(): Promise<number> {
  function tryPort(port: number): Promise<number> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      const onError = () => {
        socket.destroy();
        resolve(port);
      };
      socket.setTimeout(200);
      socket.once("error", onError);
      socket.once("timeout", onError);
      socket.connect(port, "127.0.0.1", () => {
        socket.destroy();
        if (port < PORT_MAX) tryPort(port + 1).then(resolve);
        else resolve(-1);
      });
    });
  }
  return tryPort(PORT_MIN);
}

/** Wait until url returns a 2xx or 3xx (or timeout). */
async function waitForReady(url: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { method: "HEAD" });
      if (res.ok || res.status >= 300) return true;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/**
 * Kill the dev server process (and on Windows, its whole tree). No-op if pid is undefined.
 * @param dev - ChildProcess from spawn
 */
function killDevServer(dev: ReturnType<typeof spawn>): void {
  if (!dev.pid) return;
  try {
    if (os.platform() === "win32") {
      execSync(`taskkill /pid ${dev.pid} /T /F`, { stdio: "ignore" });
    } else {
      dev.kill("SIGTERM");
    }
  } catch {
    try {
      dev.kill("SIGKILL");
    } catch {
      // ignore
    }
  }
}

/**
 * Wait for the child process to exit, then force-kill if it still runs after timeout.
 * @param dev - ChildProcess from spawn
 * @param timeoutMs - Max ms to wait before SIGKILL (non-Windows)
 */
function waitForExit(dev: ReturnType<typeof spawn>, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (!dev.pid) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    dev.once("exit", done);
    const timer = setTimeout(() => {
      dev.removeListener("exit", done);
      try {
        dev.kill("SIGKILL");
      } catch {
        // ignore
      }
      resolve();
    }, timeoutMs);
  });
}

async function main(): Promise<number> {
  const port = await findFreePort();
  if (port < 0) {
    console.error("No free port found between %d and %d", PORT_MIN, PORT_MAX);
    return 1;
  }

  const baseURL = `http://localhost:${port}`;
  console.log("Starting dev server on %s (port %d)", baseURL, port);

  const bun = process.execPath;
  const dev = spawn(bun, ["run", "dev", "--", "-p", String(port)], {
    env: { ...process.env, PORT: String(port), E2E_TEST: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });

  const cleanup = () => {
    killDevServer(dev);
  };

  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });

  try {
    const timeoutMs = 120_000;
    const ready = await waitForReady(baseURL, timeoutMs);
    if (!ready) {
      cleanup();
      await waitForExit(dev, 2000);
      console.error("Dev server did not become ready within %ds", timeoutMs / 1000);
      return 1;
    }

    const playwright = spawn(bun, ["x", "playwright", "test", ...process.argv.slice(2)], {
      env: { ...process.env, PLAYWRIGHT_BASE_URL: baseURL },
      stdio: "inherit",
      shell: false,
    });

    const code = await new Promise<number>((resolve) => {
      playwright.on("close", (c) => resolve(c ?? 0));
    });

    cleanup();
    await waitForExit(dev, SHUTDOWN_WAIT_MS);
    return code;
  } finally {
    cleanup();
  }
}

main().then((code) => process.exit(code));
