import { randomUUID } from "node:crypto";

// --- Types ---

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const CURRENT_LEVEL = LOG_LEVELS[(process.env.LOG_LEVEL as LogLevel) || "info"] ?? 1;

export interface TraceSpan {
  name: string;
  startMs: number;
  endMs: number;
  durationMs: number;
}

export interface RouterEvent {
  id: string;
  timestamp: string;
  type: "webhook" | "register" | "unregister" | "error";
  slug: string;
  routingDecision: "forwarded" | "no_route" | "unauthorized" | "invalid" | null;
  downstreamPort?: number;
  downstreamStatus?: number;
  payload?: any;
  durationMs: number;
  forwardDurationMs?: number;
  responseStatus: number;
  traceSpans?: TraceSpan[];
  error?: string;
}

export interface WatcherConfig {
  command: string;
  interval: number;
}

export interface RouteInfo {
  port: number;
  registeredAt: string;
  lastHeartbeatAt: number;
  lastEventAt: string | null;
  eventCount: number;
  errorCount: number;
  status: "up" | "down" | "unknown";
  watchers: WatcherConfig[];
}

interface RouteMetrics {
  total: number;
  success: number;
  failed: number;
  lastEventAt: string | null;
  latencySum: number;
  avgLatencyMs: number;
}

// --- Structured Logger ---

export function createLogger(component: string, toStderr = false) {
  const write = toStderr
    ? (line: string) => process.stderr.write(line + "\n")
    : (line: string) => console.log(line);

  function emit(level: LogLevel, msg: string, fields?: Record<string, any>) {
    if (LOG_LEVELS[level] < CURRENT_LEVEL) return;
    const entry = { ts: new Date().toISOString(), level, component, msg, ...fields };
    write(JSON.stringify(entry));
  }

  return {
    debug: (msg: string, fields?: Record<string, any>) => emit("debug", msg, fields),
    info: (msg: string, fields?: Record<string, any>) => emit("info", msg, fields),
    warn: (msg: string, fields?: Record<string, any>) => emit("warn", msg, fields),
    error: (msg: string, fields?: Record<string, any>) => emit("error", msg, fields),
  };
}

// --- Event Store (ring buffer) ---

export class EventStore {
  private events: RouterEvent[] = [];
  private readonly maxSize: number;

  constructor(maxSize = 1000) {
    this.maxSize = maxSize;
  }

  push(event: RouterEvent) {
    if (this.events.length >= this.maxSize) {
      this.events.shift();
    }
    this.events.push(event);
  }

  getRecent(limit = 50, offset = 0): RouterEvent[] {
    const reversed = [...this.events].reverse();
    return reversed.slice(offset, offset + limit);
  }

  getById(id: string): RouterEvent | undefined {
    return this.events.find((e) => e.id === id);
  }

  getBySlug(slug: string, limit = 50): RouterEvent[] {
    return [...this.events]
      .reverse()
      .filter((e) => e.slug === slug)
      .slice(0, limit);
  }

  get count(): number {
    return this.events.length;
  }
}

// --- Metrics Collector ---

export class MetricsCollector {
  startTime = Date.now();
  requests = { total: 0, byStatus: new Map<number, number>() };
  webhooks = {
    total: 0,
    forwarded: 0,
    noRoute: 0,
    unauthorized: 0,
    invalidPayload: 0,
    downstreamErrors: 0,
  };
  perRoute = new Map<string, RouteMetrics>();
  registrations = 0;
  unregistrations = 0;

  recordRequest(status: number) {
    this.requests.total++;
    this.requests.byStatus.set(status, (this.requests.byStatus.get(status) || 0) + 1);
  }

  recordWebhook(
    outcome: "forwarded" | "no_route" | "unauthorized" | "invalid" | "downstream_error",
    slug?: string,
    durationMs?: number,
  ) {
    this.webhooks.total++;
    switch (outcome) {
      case "forwarded":
        this.webhooks.forwarded++;
        break;
      case "no_route":
        this.webhooks.noRoute++;
        break;
      case "unauthorized":
        this.webhooks.unauthorized++;
        break;
      case "invalid":
        this.webhooks.invalidPayload++;
        break;
      case "downstream_error":
        this.webhooks.downstreamErrors++;
        break;
    }

    if (slug && durationMs !== undefined) {
      const rm = this.perRoute.get(slug) || {
        total: 0,
        success: 0,
        failed: 0,
        lastEventAt: null,
        latencySum: 0,
        avgLatencyMs: 0,
      };
      rm.total++;
      if (outcome === "forwarded") rm.success++;
      else rm.failed++;
      rm.lastEventAt = new Date().toISOString();
      rm.latencySum += durationMs;
      rm.avgLatencyMs = Math.round(rm.latencySum / rm.total);
      this.perRoute.set(slug, rm);
    }
  }

  formatPrometheus(extra?: { routesActive?: number }): string {
    const uptime = Math.floor((Date.now() - this.startTime) / 1000);
    const lines: string[] = [];

    lines.push("# HELP hookherald_uptime_seconds Seconds since router started");
    lines.push("# TYPE hookherald_uptime_seconds gauge");
    lines.push(`hookherald_uptime_seconds ${uptime}`);
    lines.push("");

    lines.push("# HELP hookherald_requests_total Total HTTP requests");
    lines.push("# TYPE hookherald_requests_total counter");
    for (const [status, count] of this.requests.byStatus) {
      lines.push(`hookherald_requests_total{status="${status}"} ${count}`);
    }
    lines.push("");

    lines.push("# HELP hookherald_webhooks_total Webhook events by outcome");
    lines.push("# TYPE hookherald_webhooks_total counter");
    lines.push(`hookherald_webhooks_total{outcome="forwarded"} ${this.webhooks.forwarded}`);
    lines.push(`hookherald_webhooks_total{outcome="no_route"} ${this.webhooks.noRoute}`);
    lines.push(`hookherald_webhooks_total{outcome="unauthorized"} ${this.webhooks.unauthorized}`);
    lines.push(`hookherald_webhooks_total{outcome="invalid"} ${this.webhooks.invalidPayload}`);
    lines.push(
      `hookherald_webhooks_total{outcome="downstream_error"} ${this.webhooks.downstreamErrors}`,
    );
    lines.push("");

    lines.push("# HELP hookherald_webhook_avg_duration_ms Average webhook handling latency");
    lines.push("# TYPE hookherald_webhook_avg_duration_ms gauge");
    for (const [slug, rm] of this.perRoute) {
      lines.push(`hookherald_webhook_avg_duration_ms{slug="${slug}"} ${rm.avgLatencyMs}`);
    }
    lines.push("");

    lines.push("# HELP hookherald_routes_active Currently registered routes");
    lines.push("# TYPE hookherald_routes_active gauge");
    lines.push(`hookherald_routes_active ${extra?.routesActive ?? 0}`);
    lines.push("");

    lines.push("# HELP hookherald_registrations_total Total registrations");
    lines.push("# TYPE hookherald_registrations_total counter");
    lines.push(`hookherald_registrations_total ${this.registrations}`);
    lines.push("");

    lines.push("# HELP hookherald_unregistrations_total Total unregistrations");
    lines.push("# TYPE hookherald_unregistrations_total counter");
    lines.push(`hookherald_unregistrations_total ${this.unregistrations}`);

    return lines.join("\n") + "\n";
  }

  getStats() {
    return {
      uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
      requests: {
        total: this.requests.total,
        byStatus: Object.fromEntries(this.requests.byStatus),
      },
      webhooks: { ...this.webhooks },
      perRoute: Object.fromEntries(this.perRoute),
      registrations: this.registrations,
      unregistrations: this.unregistrations,
    };
  }
}

// --- Trace Helpers ---

export function createTrace() {
  const spans: TraceSpan[] = [];
  const origin = performance.now();

  return {
    spans,
    span(name: string): TraceSpan {
      const startMs = Math.round(performance.now() - origin);
      const s: TraceSpan = { name, startMs, endMs: startMs, durationMs: 0 };
      spans.push(s);
      return s;
    },
    end(span: TraceSpan) {
      span.endMs = Math.round(performance.now() - origin);
      span.durationMs = span.endMs - span.startMs;
    },
    elapsed(): number {
      return Math.round(performance.now() - origin);
    },
  };
}

// --- Payload truncation ---

const MAX_PAYLOAD_SIZE = 10 * 1024; // 10KB

export function truncatePayload(payload: any): any {
  const str = JSON.stringify(payload);
  if (str.length <= MAX_PAYLOAD_SIZE) return payload;
  return { _truncated: true, _originalSize: str.length, preview: str.slice(0, MAX_PAYLOAD_SIZE) };
}

// --- UUID helper ---

export function newEventId(): string {
  return randomUUID();
}

// --- Event factory ---

export function createRouterEvent(
  type: RouterEvent["type"],
  slug: string,
  overrides: Partial<RouterEvent> = {},
): RouterEvent {
  return {
    id: newEventId(),
    timestamp: new Date().toISOString(),
    type,
    slug,
    routingDecision: null,
    durationMs: 0,
    responseStatus: 200,
    ...overrides,
  };
}
