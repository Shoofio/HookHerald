import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "node:http";
import { readFileSync, watch as fsWatch, type FSWatcher } from "node:fs";
import { execFile } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger, type WatcherConfig } from "./observability.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, "..", "package.json"), "utf-8"));
const VERSION = pkg.version;

const PROJECT_SLUG = process.env.PROJECT_SLUG || "unknown/project";
const ROUTER_URL = process.env.ROUTER_URL || "http://127.0.0.1:9000";
const CONFIG_PATH = process.env.HH_CONFIG_PATH || "";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";

const log = createLogger(`channel:${PROJECT_SLUG}`, true); // stderr for MCP

// --- MCP Server setup ---
const mcp = new Server(
  { name: "webhook-channel", version: VERSION },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
    },
    instructions:
      'CI pipeline events arrive as <channel source="webhook-channel" ...>. ' +
      "They are one-way notifications. Read them and act on the CI results — " +
      "check logs, inspect code, fix issues, etc.",
  }
);

// --- HTTP Server to receive forwarded webhooks ---
function formatMessage(payload: any): string {
  return JSON.stringify(payload, null, 2);
}

let assignedPort: number;

const httpServer = createServer(async (req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405).end("Method not allowed");
    return;
  }

  // Remote shutdown endpoint
  if (req.url === "/shutdown") {
    log.info("received remote shutdown signal");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    shutdown();
    return;
  }

  const traceId = req.headers["x-trace-id"] as string | undefined;

  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const rawBody = Buffer.concat(chunks).toString();

  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    res.writeHead(400).end("Invalid JSON");
    return;
  }

  const content = formatMessage(payload);
  const meta: Record<string, string> = {
    project: String(payload.project_slug || ""),
    traceId: traceId || "",
  };

  log.info("received event", {
    status: payload.pipeline_status,
    slug: payload.project_slug,
    traceId,
  });

  try {
    await mcp.notification({
      method: "notifications/claude/channel",
      params: { content, meta },
    });
    log.info("emitted channel notification", { traceId });
  } catch (err: any) {
    log.error("failed to emit notification", { error: err.message, traceId });
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
});

// --- Registration with heartbeat ---

const HEARTBEAT_INTERVAL = parseInt(process.env.HH_HEARTBEAT_MS || "30000", 10);
let registered = false;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

async function register(): Promise<boolean> {
  try {
    const resp = await fetch(`${ROUTER_URL}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_slug: PROJECT_SLUG,
        port: assignedPort,
        watchers: currentWatcherConfigs,
      }),
    });
    if (resp.ok) {
      if (!registered) log.info("registered with router", { router: ROUTER_URL });
      registered = true;
      return true;
    }
    log.warn("registration failed", { status: resp.status });
    registered = false;
    return false;
  } catch {
    if (registered) log.warn("lost connection to router", { router: ROUTER_URL });
    registered = false;
    return false;
  }
}

function startHeartbeat() {
  heartbeatTimer = setInterval(register, HEARTBEAT_INTERVAL);
  heartbeatTimer.unref();
}

// --- Watcher system ---

let currentWatcherConfigs: WatcherConfig[] = [];
const watcherIntervals: Map<string, ReturnType<typeof setInterval>> = new Map();
let configWatcher: FSWatcher | null = null;

function readConfig(): { slug: string; router_url: string; watchers: WatcherConfig[] } | null {
  if (!CONFIG_PATH) return null;
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return null;
  }
}

function executeCommand(cmd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile("sh", ["-c", cmd], { encoding: "utf-8", timeout: 60000 }, (err, stdout) => {
      resolve((stdout || "").trim());
    });
  });
}

async function runWatcher(watcher: WatcherConfig) {
  const output = await executeCommand(watcher.command);
  if (!output) return;

  let parsed: any;
  try {
    parsed = JSON.parse(output);
  } catch {
    parsed = output;
  }

  const envelope = {
    project_slug: PROJECT_SLUG,
    source: watcher.command,
    output: parsed,
  };

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (WEBHOOK_SECRET) headers["X-Webhook-Token"] = WEBHOOK_SECRET;

  try {
    await fetch(`${ROUTER_URL}/`, {
      method: "POST",
      headers,
      body: JSON.stringify(envelope),
    });
    log.debug("watcher sent", { command: watcher.command });
  } catch (err: any) {
    log.warn("watcher POST failed", { command: watcher.command, error: err.message });
  }
}

function watcherKey(w: WatcherConfig): string {
  return `${w.command}::${w.interval}`;
}

function startWatchers(watchers: WatcherConfig[]) {
  // Stop removed/changed watchers
  const newKeys = new Set(watchers.map(watcherKey));
  for (const [key, timer] of watcherIntervals) {
    if (!newKeys.has(key)) {
      clearInterval(timer);
      watcherIntervals.delete(key);
      log.info("watcher stopped", { key });
    }
  }

  // Start new watchers
  for (const w of watchers) {
    const key = watcherKey(w);
    if (watcherIntervals.has(key)) continue;

    // Run immediately (if registered), then on interval
    if (registered) runWatcher(w);
    const timer = setInterval(() => runWatcher(w), w.interval * 1000);
    timer.unref();
    watcherIntervals.set(key, timer);
    log.info("watcher started", { command: w.command, interval: w.interval });
  }

  currentWatcherConfigs = watchers;
}

async function loadAndStartWatchers() {
  const config = readConfig();
  const watchers = config?.watchers || [];
  startWatchers(watchers);
  // Re-register so the router sees the updated watcher list
  if (registered) await register();
}

function startConfigWatcher() {
  if (!CONFIG_PATH) return;

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  function watch() {
    if (configWatcher) { try { configWatcher.close(); } catch {} }
    try {
      configWatcher = fsWatch(CONFIG_PATH, () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          log.info("config changed, reloading watchers");
          loadAndStartWatchers();
          // Re-establish watcher (inode may have changed)
          watch();
        }, 200);
      });
      configWatcher.unref();
    } catch {
      log.debug("could not watch config file, retrying in 5s", { path: CONFIG_PATH });
      setTimeout(watch, 5000);
    }
  }

  watch();
}

// Bind to port 0 for auto-assignment
httpServer.listen(0, "127.0.0.1", async () => {
  const addr = httpServer.address();
  assignedPort = typeof addr === "object" && addr ? addr.port : 0;
  log.info("HTTP server listening", { host: "127.0.0.1", port: assignedPort });

  loadAndStartWatchers();
  startConfigWatcher();
  await register();
  // Run watchers that were deferred during startup (before registration)
  for (const w of currentWatcherConfigs) runWatcher(w);
  startHeartbeat();
});

// Graceful shutdown: unregister from router
let shutdownInProgress = false;

async function shutdown() {
  if (shutdownInProgress) return;
  shutdownInProgress = true;
  log.info("shutting down");
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  for (const timer of watcherIntervals.values()) clearInterval(timer);
  watcherIntervals.clear();
  if (configWatcher) { configWatcher.close(); configWatcher = null; }
  try {
    await fetch(`${ROUTER_URL}/unregister`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_slug: PROJECT_SLUG }),
    });
    log.info("unregistered from router");
  } catch {
    // Router may already be down
  }
  httpServer.close();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// --- Connect MCP over stdio ---
const transport = new StdioServerTransport();
transport.onclose = () => {
  log.info("MCP transport closed, shutting down");
  shutdown();
};
await mcp.connect(transport);
log.info("MCP server connected via stdio");

// Fallback: if stdin closes (parent died), shut down even if transport doesn't notice
process.stdin.on("end", () => {
  log.info("stdin closed, shutting down");
  shutdown();
});
