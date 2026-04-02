import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "node:http";
import { createLogger } from "./observability.js";

const PROJECT_SLUG = process.env.PROJECT_SLUG || "unknown/project";
const ROUTER_URL = process.env.ROUTER_URL || "http://127.0.0.1:9000";

const log = createLogger(`channel:${PROJECT_SLUG}`, true); // stderr for MCP

// --- MCP Server setup ---
const mcp = new Server(
  { name: "webhook-channel", version: "0.2.0" },
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
      body: JSON.stringify({ project_slug: PROJECT_SLUG, port: assignedPort }),
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

// Bind to port 0 for auto-assignment
httpServer.listen(0, "127.0.0.1", async () => {
  const addr = httpServer.address();
  assignedPort = typeof addr === "object" && addr ? addr.port : 0;
  log.info("HTTP server listening", { host: "127.0.0.1", port: assignedPort });

  await register();
  startHeartbeat();
});

// Graceful shutdown: unregister from router
async function shutdown() {
  log.info("shutting down");
  if (heartbeatTimer) clearInterval(heartbeatTimer);
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
await mcp.connect(transport);
log.info("MCP server connected via stdio");
