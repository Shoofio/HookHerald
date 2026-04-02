import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "node:http";
import { createLogger } from "./observability.js";

const PROJECT_SLUG = process.env.PROJECT_SLUG || "unknown/project";
const ROUTER_URL = process.env.ROUTER_URL || "http://127.0.0.1:9000";

const log = createLogger(`channel:${PROJECT_SLUG}`, true); // stderr for MCP

// --- MCP Server setup ---
const mcp = new Server(
  { name: "webhook-channel", version: "0.1.0" },
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
  const status = payload.pipeline_status || "unknown";
  const slug = payload.project_slug || "unknown";
  const mrIid = payload.mr_iid || "none";
  const branch = payload.branch || "unknown";
  const commitSha = (payload.commit_sha || "unknown").slice(0, 8);
  const commitTitle = payload.commit_title || "";
  const pipelineUrl = payload.pipeline_url || "";

  const statusUpper = status.toUpperCase();
  let msg = `CI pipeline ${statusUpper} for ${slug}`;
  if (mrIid !== "none") msg += ` MR !${mrIid}`;
  msg += ` on branch ${branch}`;
  msg += ` (commit ${commitSha}`;
  if (commitTitle) msg += `: "${commitTitle}"`;
  msg += `)`;
  if (pipelineUrl) msg += `\nPipeline: ${pipelineUrl}`;
  return msg;
}

let assignedPort: number;

const httpServer = createServer(async (req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405).end("Method not allowed");
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
    status: String(payload.pipeline_status || ""),
    mr_iid: String(payload.mr_iid || "none"),
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

// Bind to port 0 for auto-assignment
httpServer.listen(0, "127.0.0.1", async () => {
  const addr = httpServer.address();
  assignedPort = typeof addr === "object" && addr ? addr.port : 0;
  log.info("HTTP server listening", { host: "127.0.0.1", port: assignedPort });

  // Self-register with the router
  try {
    const resp = await fetch(`${ROUTER_URL}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_slug: PROJECT_SLUG, port: assignedPort }),
    });
    if (resp.ok) {
      log.info("registered with router", { router: ROUTER_URL });
    } else {
      log.warn("registration failed", { status: resp.status });
    }
  } catch (err: any) {
    log.warn("could not reach router", { router: ROUTER_URL, error: err.message });
    log.info("running standalone", { port: assignedPort });
  }
});

// Graceful shutdown: unregister from router
async function shutdown() {
  log.info("shutting down");
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
