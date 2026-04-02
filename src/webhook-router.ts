import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createLogger,
  EventStore,
  MetricsCollector,
  createTrace,
  truncatePayload,
  newEventId,
  type RouteInfo,
  type RouterEvent,
} from "./observability.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.ROUTER_PORT || "9000", 10);
const SECRET = process.env.WEBHOOK_SECRET || "dev-secret";

const log = createLogger("router");
const events = new EventStore();
const metrics = new MetricsCollector();

// Routing table: project_slug → RouteInfo
const routes = new Map<string, RouteInfo>();

// Dashboard HTML — cached at startup
let dashboardHtml = "";
try {
  dashboardHtml = readFileSync(resolve(__dirname, "dashboard.html"), "utf-8");
} catch {
  log.warn("dashboard.html not found — dashboard will be unavailable");
}

// --- Request body helper ---

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString();
}

// --- Route helpers ---

function getRoutesSnapshot() {
  return Object.fromEntries([...routes.entries()].map(([slug, info]) => [slug, info]));
}

// --- Handlers ---

async function handleRegister(req: IncomingMessage, res: ServerResponse) {
  const body = JSON.parse(await readBody(req));
  const { project_slug, port } = body;
  if (!project_slug || !port) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "missing project_slug or port" }));
    return;
  }

  // Heartbeat: if same slug already registered, treat as keepalive
  const existing = routes.get(project_slug);
  if (existing) {
    if (existing.port !== port) {
      existing.port = port;
      log.info("route updated", { slug: project_slug, port });
      broadcast("session", { sessions: getSessionsData() });
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, heartbeat: true }));
    return;
  }

  const info: RouteInfo = {
    port,
    registeredAt: new Date().toISOString(),
    lastEventAt: null,
    eventCount: 0,
    errorCount: 0,
    status: "unknown",
  };
  routes.set(project_slug, info);
  metrics.registrations++;
  log.info("registered", { slug: project_slug, port });

  const event: RouterEvent = {
    id: newEventId(),
    timestamp: new Date().toISOString(),
    type: "register",
    slug: project_slug,
    routingDecision: null,
    downstreamPort: port,
    durationMs: 0,
    responseStatus: 200,
  };
  events.push(event);
  broadcast("session", { sessions: getSessionsData() });
  broadcast("webhook", event);

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

async function handleUnregister(req: IncomingMessage, res: ServerResponse) {
  const body = JSON.parse(await readBody(req));
  const { project_slug } = body;
  if (!project_slug) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "missing project_slug" }));
    return;
  }

  routes.delete(project_slug);
  metrics.unregistrations++;
  log.info("unregistered", { slug: project_slug });

  const event: RouterEvent = {
    id: newEventId(),
    timestamp: new Date().toISOString(),
    type: "unregister",
    slug: project_slug,
    routingDecision: null,
    durationMs: 0,
    responseStatus: 200,
  };
  events.push(event);
  broadcast("session", { sessions: getSessionsData() });
  broadcast("webhook", event);

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

function handleRoutes(_req: IncomingMessage, res: ServerResponse) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(getRoutesSnapshot(), null, 2));
}

async function handleWebhook(req: IncomingMessage, res: ServerResponse) {
  const trace = createTrace();
  const traceId = newEventId();

  // Auth
  const authSpan = trace.span("auth_validate");
  const token = req.headers["x-gitlab-token"];
  if (token !== SECRET) {
    trace.end(authSpan);
    log.warn("rejected: invalid token", { traceId });
    metrics.recordRequest(401);
    metrics.recordWebhook("unauthorized");

    const ev: RouterEvent = {
      id: traceId,
      timestamp: new Date().toISOString(),
      type: "webhook",
      slug: "unknown",
      routingDecision: "unauthorized",
      durationMs: trace.elapsed(),
      responseStatus: 401,
      traceSpans: trace.spans,
      error: "invalid token",
    };
    events.push(ev);
    broadcast("webhook", ev);

    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }
  trace.end(authSpan);

  // Parse
  const parseSpan = trace.span("parse_payload");
  const rawBody = await readBody(req);
  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    trace.end(parseSpan);
    metrics.recordRequest(400);
    metrics.recordWebhook("invalid");

    const ev: RouterEvent = {
      id: traceId,
      timestamp: new Date().toISOString(),
      type: "webhook",
      slug: "unknown",
      routingDecision: "invalid",
      durationMs: trace.elapsed(),
      responseStatus: 400,
      traceSpans: trace.spans,
      error: "invalid JSON",
    };
    events.push(ev);
    broadcast("webhook", ev);

    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid JSON" }));
    return;
  }
  trace.end(parseSpan);

  const slug = payload.project_slug;
  if (!slug) {
    metrics.recordRequest(400);
    metrics.recordWebhook("invalid");

    const ev: RouterEvent = {
      id: traceId,
      timestamp: new Date().toISOString(),
      type: "webhook",
      slug: "unknown",
      routingDecision: "invalid",
      payload: truncatePayload(payload),
      durationMs: trace.elapsed(),
      responseStatus: 400,
      traceSpans: trace.spans,
      error: "missing project_slug",
    };
    events.push(ev);
    broadcast("webhook", ev);

    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "missing project_slug in payload" }));
    return;
  }

  // Route lookup
  const routeSpan = trace.span("route_lookup");
  const routeInfo = routes.get(slug);
  trace.end(routeSpan);

  if (!routeInfo) {
    const durationMs = trace.elapsed();
    log.warn("no route", { slug, traceId });
    metrics.recordRequest(404);
    metrics.recordWebhook("no_route", slug, durationMs);

    const ev: RouterEvent = {
      id: traceId,
      timestamp: new Date().toISOString(),
      type: "webhook",
      slug,
      routingDecision: "no_route",
      payload: truncatePayload(payload),
      durationMs,
      responseStatus: 404,
      traceSpans: trace.spans,
    };
    events.push(ev);
    broadcast("webhook", ev);

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `no route for ${slug}` }));
    return;
  }

  // Forward
  const fwdSpan = trace.span("forward_downstream");
  log.info("routing", { slug, port: routeInfo.port, traceId });
  try {
    const resp = await fetch(`http://127.0.0.1:${routeInfo.port}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Trace-Id": traceId,
      },
      body: rawBody,
    });
    trace.end(fwdSpan);
    const durationMs = trace.elapsed();

    routeInfo.lastEventAt = new Date().toISOString();
    routeInfo.eventCount++;
    routeInfo.status = "up";
    metrics.recordRequest(200);
    metrics.recordWebhook("forwarded", slug, durationMs);
    log.info("forwarded", { slug, port: routeInfo.port, status: resp.status, durationMs, traceId });

    const ev: RouterEvent = {
      id: traceId,
      timestamp: new Date().toISOString(),
      type: "webhook",
      slug,
      routingDecision: "forwarded",
      downstreamPort: routeInfo.port,
      downstreamStatus: resp.status,
      payload: truncatePayload(payload),
      durationMs,
      forwardDurationMs: fwdSpan.durationMs,
      responseStatus: 200,
      traceSpans: trace.spans,
    };
    events.push(ev);
    broadcast("webhook", ev);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, forwarded_to: routeInfo.port }));
  } catch (err: any) {
    trace.end(fwdSpan);
    const durationMs = trace.elapsed();

    routeInfo.errorCount++;
    routeInfo.status = "down";
    metrics.recordRequest(502);
    metrics.recordWebhook("downstream_error", slug, durationMs);
    log.error("forward failed", { slug, port: routeInfo.port, error: err.message, traceId });

    const ev: RouterEvent = {
      id: traceId,
      timestamp: new Date().toISOString(),
      type: "webhook",
      slug,
      routingDecision: "forwarded",
      downstreamPort: routeInfo.port,
      payload: truncatePayload(payload),
      durationMs,
      forwardDurationMs: fwdSpan.durationMs,
      responseStatus: 502,
      traceSpans: trace.spans,
      error: err.message,
    };
    events.push(ev);
    broadcast("webhook", ev);

    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "downstream unreachable" }));
  }
}

// --- API handlers ---

function handleApiEvents(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);
  const limit = parseInt(url.searchParams.get("limit") || "50", 10);
  const offset = parseInt(url.searchParams.get("offset") || "0", 10);
  const slug = url.searchParams.get("slug");

  const result = slug ? events.getBySlug(slug, limit) : events.getRecent(limit, offset);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(result));
}

function handleApiStats(_req: IncomingMessage, res: ServerResponse) {
  const stats = {
    ...metrics.getStats(),
    routesActive: routes.size,
    routes: getRoutesSnapshot(),
    totalEvents: events.count,
  };
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(stats));
}

function handleMetrics(_req: IncomingMessage, res: ServerResponse) {
  const text = metrics.formatPrometheus({ routesActive: routes.size });
  res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
  res.end(text);
}

// --- SSE ---

const sseClients = new Set<ServerResponse>();

function broadcast(eventType: string, data: any) {
  const msg = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(msg);
    } catch {
      sseClients.delete(client);
    }
  }
}

function handleApiStream(req: IncomingMessage, res: ServerResponse) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const initData = {
    sessions: getSessionsData(),
    stats: metrics.getStats(),
    recentEvents: events.getRecent(50),
  };
  res.write(`event: init\ndata: ${JSON.stringify(initData)}\n\n`);

  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
}

// Periodic stats broadcast
const statsInterval = setInterval(() => {
  if (sseClients.size > 0) {
    broadcast("stats", metrics.getStats());
  }
}, 5000);
statsInterval.unref();

function handleApiHealth(_req: IncomingMessage, res: ServerResponse) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    status: "ok",
    version: "0.2.0",
    uptimeSeconds: Math.floor((Date.now() - metrics.startTime) / 1000),
    routesActive: routes.size,
  }));
}

async function handleApiKill(req: IncomingMessage, res: ServerResponse) {
  const body = JSON.parse(await readBody(req));
  const { project_slug } = body;
  if (!project_slug) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "missing project_slug" }));
    return;
  }

  const routeInfo = routes.get(project_slug);
  if (!routeInfo) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `no route for ${project_slug}` }));
    return;
  }

  const result = { ok: true, slug: project_slug, port: routeInfo.port, eventCount: routeInfo.eventCount };

  // Signal the channel to shut down
  try {
    await fetch(`http://127.0.0.1:${routeInfo.port}/shutdown`, { method: "POST" });
    log.info("sent shutdown to channel", { slug: project_slug, port: routeInfo.port });
  } catch {
    log.warn("could not reach channel for shutdown", { slug: project_slug, port: routeInfo.port });
  }

  routes.delete(project_slug);
  log.info("killed", { slug: project_slug, port: routeInfo.port });

  events.push({
    id: newEventId(),
    timestamp: new Date().toISOString(),
    type: "unregister",
    slug: project_slug,
    routingDecision: null,
    durationMs: 0,
    responseStatus: 200,
  });
  broadcast("session", { sessions: getSessionsData() });

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(result));
}

function getSessionsData() {
  return [...routes.entries()].map(([slug, info]) => {
    const rm = metrics.perRoute.get(slug);
    return {
      slug,
      port: info.port,
      status: info.status,
      registeredAt: info.registeredAt,
      lastEventAt: info.lastEventAt,
      eventCount: info.eventCount,
      errorCount: info.errorCount,
      avgLatencyMs: rm?.avgLatencyMs ?? 0,
      successCount: rm?.success ?? 0,
      failedCount: rm?.failed ?? 0,
    };
  });
}

function handleApiSessions(_req: IncomingMessage, res: ServerResponse) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(getSessionsData()));
}

function handleApiEventById(id: string, res: ServerResponse) {
  const event = events.getById(id);
  if (!event) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "event not found" }));
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(event));
}

// --- Server ---

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);
  const method = req.method?.toUpperCase();

  try {
    // POST routes
    if (method === "POST") {
      if (url.pathname === "/register") return await handleRegister(req, res);
      if (url.pathname === "/unregister") return await handleUnregister(req, res);
      if (url.pathname === "/api/kill") return await handleApiKill(req, res);
      if (url.pathname === "/") return await handleWebhook(req, res);
    }

    // GET routes
    if (method === "GET") {
      if (url.pathname === "/" || url.pathname === "/dashboard") {
        if (dashboardHtml) {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(dashboardHtml);
        } else {
          res.writeHead(503, { "Content-Type": "text/plain" });
          res.end("Dashboard not available");
        }
        return;
      }
      if (url.pathname === "/routes") return handleRoutes(req, res);
      if (url.pathname === "/metrics") return handleMetrics(req, res);
      if (url.pathname === "/api/health") return handleApiHealth(req, res);
      if (url.pathname === "/api/sessions") return handleApiSessions(req, res);
      if (url.pathname === "/api/events") return handleApiEvents(req, res);
      if (url.pathname === "/api/stats") return handleApiStats(req, res);
      if (url.pathname === "/api/stream") return handleApiStream(req, res);
      // /api/events/:id
      const evMatch = url.pathname.match(/^\/api\/events\/(.+)$/);
      if (evMatch) return handleApiEventById(evMatch[1], res);
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  } catch (err: any) {
    log.error("unhandled error", { error: err.message, path: url.pathname });
    metrics.recordRequest(500);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "internal error" }));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : PORT;
  log.info("listening", { host: "127.0.0.1", port: actualPort });
  log.info("secret", { preview: SECRET.slice(0, 4) + "..." });
  // Machine-readable line for process spawners to discover the port
  process.stderr.write(`HOOKHERALD_PORT=${actualPort}\n`);
});
