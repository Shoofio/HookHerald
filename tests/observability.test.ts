import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  EventStore,
  MetricsCollector,
  createTrace,
  endSpan,
  closeSpan,
  truncatePayload,
  newEventId,
  type RouterEvent,
} from "../src/observability.js";

// --- Helper ---

function makeEvent(overrides: Partial<RouterEvent> = {}): RouterEvent {
  return {
    id: newEventId(),
    timestamp: new Date().toISOString(),
    type: "webhook",
    slug: "group/project-alpha",
    routingDecision: "forwarded",
    durationMs: 10,
    responseStatus: 200,
    ...overrides,
  };
}

// --- EventStore ---

describe("EventStore", () => {
  let store: EventStore;

  beforeEach(() => {
    store = new EventStore(5);
  });

  it("starts empty", () => {
    assert.equal(store.count, 0);
    assert.deepEqual(store.getRecent(), []);
  });

  it("pushes and retrieves events", () => {
    const e = makeEvent({ slug: "a/b" });
    store.push(e);
    assert.equal(store.count, 1);
    assert.equal(store.getRecent()[0].slug, "a/b");
  });

  it("returns recent events in reverse order", () => {
    store.push(makeEvent({ slug: "first" }));
    store.push(makeEvent({ slug: "second" }));
    store.push(makeEvent({ slug: "third" }));
    const recent = store.getRecent();
    assert.equal(recent[0].slug, "third");
    assert.equal(recent[2].slug, "first");
  });

  it("respects limit and offset", () => {
    for (let i = 0; i < 5; i++) store.push(makeEvent({ slug: `s${i}` }));
    const page = store.getRecent(2, 1);
    assert.equal(page.length, 2);
    assert.equal(page[0].slug, "s3"); // second most recent
    assert.equal(page[1].slug, "s2");
  });

  it("evicts oldest when at capacity", () => {
    for (let i = 0; i < 7; i++) store.push(makeEvent({ slug: `s${i}` }));
    assert.equal(store.count, 5);
    // oldest two (s0, s1) should be gone
    const all = store.getRecent(10);
    const slugs = all.map((e) => e.slug);
    assert.ok(!slugs.includes("s0"));
    assert.ok(!slugs.includes("s1"));
    assert.ok(slugs.includes("s6"));
  });

  it("getById finds matching event", () => {
    const e = makeEvent();
    store.push(e);
    assert.equal(store.getById(e.id)?.id, e.id);
  });

  it("getById returns undefined for missing id", () => {
    assert.equal(store.getById("nope"), undefined);
  });

  it("getBySlug filters correctly", () => {
    store.push(makeEvent({ slug: "a/one" }));
    store.push(makeEvent({ slug: "b/two" }));
    store.push(makeEvent({ slug: "a/one" }));
    const results = store.getBySlug("a/one");
    assert.equal(results.length, 2);
    assert.ok(results.every((e) => e.slug === "a/one"));
  });

  it("getBySlug respects limit", () => {
    for (let i = 0; i < 5; i++) store.push(makeEvent({ slug: "x/y" }));
    const results = store.getBySlug("x/y", 2);
    assert.equal(results.length, 2);
  });
});

// --- MetricsCollector ---

describe("MetricsCollector", () => {
  let m: MetricsCollector;

  beforeEach(() => {
    m = new MetricsCollector();
  });

  it("records requests by status", () => {
    m.recordRequest(200);
    m.recordRequest(200);
    m.recordRequest(404);
    assert.equal(m.requests.total, 3);
    assert.equal(m.requests.byStatus.get(200), 2);
    assert.equal(m.requests.byStatus.get(404), 1);
  });

  it("records webhook outcomes", () => {
    m.recordWebhook("forwarded", "a/b", 50);
    m.recordWebhook("no_route", "c/d", 10);
    m.recordWebhook("unauthorized");
    m.recordWebhook("invalid");
    m.recordWebhook("downstream_error", "a/b", 100);

    assert.equal(m.webhooks.total, 5);
    assert.equal(m.webhooks.forwarded, 1);
    assert.equal(m.webhooks.noRoute, 1);
    assert.equal(m.webhooks.unauthorized, 1);
    assert.equal(m.webhooks.invalidPayload, 1);
    assert.equal(m.webhooks.downstreamErrors, 1);
  });

  it("tracks per-route metrics with avg latency", () => {
    m.recordWebhook("forwarded", "a/b", 100);
    m.recordWebhook("forwarded", "a/b", 200);
    const rm = m.perRoute.get("a/b")!;
    assert.equal(rm.total, 2);
    assert.equal(rm.success, 2);
    assert.equal(rm.avgLatencyMs, 150);
  });

  it("tracks per-route failures", () => {
    m.recordWebhook("downstream_error", "a/b", 50);
    const rm = m.perRoute.get("a/b")!;
    assert.equal(rm.failed, 1);
    assert.equal(rm.success, 0);
  });

  it("getStats returns serializable object", () => {
    m.recordRequest(200);
    m.recordWebhook("forwarded", "x/y", 42);
    m.registrations = 3;
    m.unregistrations = 1;
    const stats = m.getStats();
    assert.equal(stats.requests.total, 1);
    assert.equal(stats.requests.byStatus[200], 1);
    assert.equal(stats.webhooks.forwarded, 1);
    assert.equal(stats.registrations, 3);
    assert.equal(stats.unregistrations, 1);
    assert.equal(stats.perRoute["x/y"].total, 1);
    assert.ok(typeof stats.uptimeSeconds === "number");
  });

  it("formatPrometheus produces valid output", () => {
    m.recordRequest(200);
    m.recordWebhook("forwarded", "slug/a", 100);
    const text = m.formatPrometheus();
    assert.ok(text.includes("hookherald_uptime_seconds"));
    assert.ok(text.includes('hookherald_requests_total{status="200"} 1'));
    assert.ok(text.includes('hookherald_webhooks_total{outcome="forwarded"} 1'));
    assert.ok(text.includes('hookherald_webhook_avg_duration_ms{slug="slug/a"} 100'));
    assert.ok(text.includes("hookherald_registrations_total 0"));
    // Placeholder for routes count
    assert.ok(text.includes("__ROUTES_COUNT__"));
  });
});

// --- Trace helpers ---

describe("createTrace / endSpan / closeSpan", () => {
  it("creates spans with sequential timing", () => {
    const trace = createTrace();
    const s1 = trace.span("first");
    const s2 = trace.span("second");
    assert.equal(trace.spans.length, 2);
    assert.ok(s2.startMs >= s1.startMs);
  });

  it("endSpan sets duration", () => {
    const trace = createTrace();
    const s = trace.span("work");
    // Simulate some time passing
    const busyWait = performance.now() + 5;
    while (performance.now() < busyWait) {}
    endSpan(s);
    // Without origin, endMs = startMs, durationMs = 0
    assert.equal(s.durationMs, 0);
  });

  it("endSpan with origin computes relative timing", () => {
    const origin = performance.now();
    const s = { name: "test", startMs: 10, endMs: 10, durationMs: 0 };
    // Wait a tiny bit so now - origin > 10
    const busyWait = performance.now() + 15;
    while (performance.now() < busyWait) {}
    endSpan(s, origin);
    assert.ok(s.endMs > s.startMs);
    assert.ok(s.durationMs > 0);
  });

  it("closeSpan sets endMs from startMs + durationMs", () => {
    const s = { name: "test", startMs: 100, endMs: 0, durationMs: 50 };
    closeSpan(s);
    assert.equal(s.endMs, 150);
  });
});

// --- truncatePayload ---

describe("truncatePayload", () => {
  it("returns payload as-is when under 10KB", () => {
    const p = { foo: "bar", n: 42 };
    assert.deepEqual(truncatePayload(p), p);
  });

  it("truncates payload over 10KB", () => {
    const big = { data: "x".repeat(15_000) };
    const result = truncatePayload(big);
    assert.equal(result._truncated, true);
    assert.ok(result._originalSize > 10 * 1024);
    assert.equal(result.preview.length, 10 * 1024);
  });
});

// --- newEventId ---

describe("newEventId", () => {
  it("returns a UUID string", () => {
    const id = newEventId();
    assert.ok(typeof id === "string");
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it("returns unique values", () => {
    const ids = new Set(Array.from({ length: 100 }, () => newEventId()));
    assert.equal(ids.size, 100);
  });
});
