import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";

const SECRET = "test-secret";

let router: ChildProcess;
let BASE: string;

function waitForPort(proc: ChildProcess, timeoutMs = 5000): Promise<number> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => reject(new Error("Router did not emit port within timeout")), timeoutMs);

    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      const match = stderr.match(/HOOKHERALD_PORT=(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(parseInt(match[1], 10));
      }
    });

    proc.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Router exited with code ${code} before emitting port`));
    });
  });
}

before(async () => {
  router = spawn("npx", ["tsx", "src/webhook-router.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ROUTER_PORT: "0",
      WEBHOOK_SECRET: SECRET,
    },
    stdio: ["pipe", "ignore", "pipe"],
  });

  const port = await waitForPort(router);
  BASE = `http://127.0.0.1:${port}`;
});

after(async () => {
  router?.kill("SIGTERM");
  // Wait for process to exit before finishing
  await new Promise<void>((resolve) => {
    if (!router) return resolve();
    router.on("exit", () => resolve());
    setTimeout(() => {
      router?.kill("SIGKILL");
      resolve();
    }, 2000);
  });
});

// --- Helper ---

async function post(path: string, body: any, headers: Record<string, string> = {}) {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

// --- Registration ---

describe("Router: registration", () => {
  it("registers a route", async () => {
    const res = await post("/register", { project_slug: "test/alpha", port: 55000 });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
  });

  it("rejects registration with missing fields", async () => {
    const res = await post("/register", { project_slug: "test/no-port" });
    assert.equal(res.status, 400);
  });

  it("shows registered routes", async () => {
    const res = await fetch(`${BASE}/routes`);
    const data = await res.json();
    assert.ok(data["test/alpha"]);
    assert.equal(data["test/alpha"].port, 55000);
    assert.equal(data["test/alpha"].status, "unknown");
  });

  it("unregisters a route", async () => {
    await post("/register", { project_slug: "test/temp", port: 55001 });
    const res = await post("/unregister", { project_slug: "test/temp" });
    assert.equal(res.status, 200);

    const routes = await (await fetch(`${BASE}/routes`)).json();
    assert.equal(routes["test/temp"], undefined);
  });

  it("rejects unregister with missing slug", async () => {
    const res = await post("/unregister", {});
    assert.equal(res.status, 400);
  });
});

// --- Webhook auth ---

describe("Router: webhook auth", () => {
  it("rejects missing token", async () => {
    const res = await post("/", { project_slug: "test/alpha" });
    assert.equal(res.status, 401);
  });

  it("rejects wrong token", async () => {
    const res = await post("/", { project_slug: "test/alpha" }, { "X-Gitlab-Token": "wrong" });
    assert.equal(res.status, 401);
  });
});

// --- Webhook routing ---

describe("Router: webhook routing", () => {
  it("returns 400 for invalid JSON", async () => {
    const res = await fetch(`${BASE}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Gitlab-Token": SECRET },
      body: "not json",
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error.includes("invalid JSON"));
  });

  it("returns 400 for missing project_slug", async () => {
    const res = await post("/", { foo: "bar" }, { "X-Gitlab-Token": SECRET });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error.includes("project_slug"));
  });

  it("returns 404 for unregistered project", async () => {
    const res = await post(
      "/",
      { project_slug: "unknown/project" },
      { "X-Gitlab-Token": SECRET },
    );
    assert.equal(res.status, 404);
  });

  it("returns 502 when downstream is unreachable", async () => {
    // test/alpha is registered on port 55000 which has nothing listening
    const res = await post(
      "/",
      {
        project_slug: "test/alpha",
        pipeline_status: "success",
        mr_iid: "1",
        branch: "main",
        commit_sha: "abc123",
        commit_title: "test",
        pipeline_url: "http://example.com",
      },
      { "X-Gitlab-Token": SECRET },
    );
    assert.equal(res.status, 502);
  });

  it("forwards to a live downstream", async () => {
    // Spin up a tiny HTTP server as a fake downstream
    const { createServer } = await import("node:http");
    const downstream = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });

    await new Promise<void>((resolve) => downstream.listen(0, "127.0.0.1", resolve));
    const dsPort = (downstream.address() as any).port;

    try {
      // Register route pointing to our downstream
      await post("/register", { project_slug: "test/live", port: dsPort });

      const res = await post(
        "/",
        {
          project_slug: "test/live",
          pipeline_status: "failed",
          mr_iid: "99",
          branch: "feature/x",
          commit_sha: "deadbeef",
          commit_title: "break things",
          pipeline_url: "http://ci.test/99",
        },
        { "X-Gitlab-Token": SECRET },
      );
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.ok, true);
      assert.equal(data.forwarded_to, dsPort);

      // Verify route status updated
      const routes = await (await fetch(`${BASE}/routes`)).json();
      assert.equal(routes["test/live"].status, "up");
      assert.equal(routes["test/live"].eventCount, 1);
    } finally {
      downstream.close();
      await post("/unregister", { project_slug: "test/live" });
    }
  });
});

// --- API endpoints ---

describe("Router: API", () => {
  it("GET /api/events returns events array", async () => {
    const res = await fetch(`${BASE}/api/events`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data));
  });

  it("GET /api/events?slug= filters by slug", async () => {
    const res = await fetch(`${BASE}/api/events?slug=test/alpha`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data));
    assert.ok(data.every((e: any) => e.slug === "test/alpha"));
  });

  it("GET /api/stats returns stats object", async () => {
    const res = await fetch(`${BASE}/api/stats`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(typeof data.uptimeSeconds === "number");
    assert.ok(typeof data.requests.total === "number");
    assert.ok(typeof data.routesActive === "number");
  });

  it("GET /metrics returns prometheus format", async () => {
    const res = await fetch(`${BASE}/metrics`);
    assert.equal(res.status, 200);
    assert.ok(res.headers.get("content-type")?.includes("text/plain"));
    const text = await res.text();
    assert.ok(text.includes("hookherald_uptime_seconds"));
    assert.ok(text.includes("hookherald_requests_total"));
    // __ROUTES_COUNT__ should be replaced with actual count
    assert.ok(!text.includes("__ROUTES_COUNT__"));
  });

  it("GET /routes returns routes object", async () => {
    const res = await fetch(`${BASE}/routes`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(typeof data === "object");
  });

  it("GET unknown path returns 404", async () => {
    const res = await fetch(`${BASE}/nonexistent`);
    assert.equal(res.status, 404);
  });
});

// --- SSE ---

describe("Router: SSE", () => {
  it("GET /events/stream returns SSE headers and init event", async () => {
    const controller = new AbortController();
    const res = await fetch(`${BASE}/events/stream`, { signal: controller.signal });
    assert.equal(res.status, 200);
    assert.ok(res.headers.get("content-type")?.includes("text/event-stream"));

    // Read just the init event
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    assert.ok(text.includes("event: init"));
    assert.ok(text.includes('"routes"'));

    controller.abort();
  });
});

// --- Route status transitions ---

describe("Router: route status transitions", () => {
  it("marks route as down when downstream is unreachable, then up when it recovers", async () => {
    const { createServer } = await import("node:http");

    // Register on a port with nothing listening
    await post("/register", { project_slug: "test/flaky", port: 59999 });

    // Send webhook — downstream unreachable → status should be "down"
    await post(
      "/",
      { project_slug: "test/flaky", pipeline_status: "success" },
      { "X-Gitlab-Token": SECRET },
    );
    let routes = await (await fetch(`${BASE}/routes`)).json();
    assert.equal(routes["test/flaky"].status, "down");
    assert.equal(routes["test/flaky"].errorCount, 1);

    // Now start a downstream on a new port and re-register
    const downstream = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => downstream.listen(0, "127.0.0.1", resolve));
    const dsPort = (downstream.address() as any).port;

    await post("/register", { project_slug: "test/flaky", port: dsPort });

    // Send webhook — downstream is alive → status should be "up"
    await post(
      "/",
      { project_slug: "test/flaky", pipeline_status: "success" },
      { "X-Gitlab-Token": SECRET },
    );
    routes = await (await fetch(`${BASE}/routes`)).json();
    assert.equal(routes["test/flaky"].status, "up");

    downstream.close();
    await post("/unregister", { project_slug: "test/flaky" });
  });
});

// --- Re-registration ---

describe("Router: re-registration", () => {
  it("overwrites route when same slug registers with different port", async () => {
    await post("/register", { project_slug: "test/reregister", port: 60001 });
    let routes = await (await fetch(`${BASE}/routes`)).json();
    assert.equal(routes["test/reregister"].port, 60001);

    // Re-register with different port
    await post("/register", { project_slug: "test/reregister", port: 60002 });
    routes = await (await fetch(`${BASE}/routes`)).json();
    assert.equal(routes["test/reregister"].port, 60002);
    // Should be a fresh RouteInfo
    assert.equal(routes["test/reregister"].eventCount, 0);
    assert.equal(routes["test/reregister"].status, "unknown");

    await post("/unregister", { project_slug: "test/reregister" });
  });
});

// --- Multi-route routing ---

describe("Router: multi-route routing", () => {
  it("routes events to correct downstream based on slug", async () => {
    const { createServer } = await import("node:http");
    const receivedByA: string[] = [];
    const receivedByB: string[] = [];

    const dsA = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      receivedByA.push(body.project_slug);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });

    const dsB = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      receivedByB.push(body.project_slug);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });

    await new Promise<void>((resolve) => dsA.listen(0, "127.0.0.1", resolve));
    await new Promise<void>((resolve) => dsB.listen(0, "127.0.0.1", resolve));
    const portA = (dsA.address() as any).port;
    const portB = (dsB.address() as any).port;

    try {
      await post("/register", { project_slug: "multi/alpha", port: portA });
      await post("/register", { project_slug: "multi/beta", port: portB });

      // Send events to both
      await post(
        "/",
        { project_slug: "multi/alpha", pipeline_status: "success" },
        { "X-Gitlab-Token": SECRET },
      );
      await post(
        "/",
        { project_slug: "multi/beta", pipeline_status: "failed" },
        { "X-Gitlab-Token": SECRET },
      );
      await post(
        "/",
        { project_slug: "multi/alpha", pipeline_status: "failed" },
        { "X-Gitlab-Token": SECRET },
      );

      assert.deepEqual(receivedByA, ["multi/alpha", "multi/alpha"]);
      assert.deepEqual(receivedByB, ["multi/beta"]);
    } finally {
      dsA.close();
      dsB.close();
      await post("/unregister", { project_slug: "multi/alpha" });
      await post("/unregister", { project_slug: "multi/beta" });
    }
  });
});

// --- Port conflict ---

describe("Router: port conflict", () => {
  it("fails to start a second router on the same port", async () => {
    // Extract the actual port the first router is using
    const actualPort = new URL(BASE).port;

    const second = spawn("npx", ["tsx", "src/webhook-router.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ROUTER_PORT: actualPort,
        WEBHOOK_SECRET: SECRET,
      },
      stdio: ["pipe", "ignore", "ignore"],
    });

    const exitCode = await new Promise<number | null>((resolve) => {
      second.on("exit", (code) => resolve(code));
      // Timeout in case it somehow stays alive
      setTimeout(() => {
        second.kill("SIGTERM");
        resolve(null);
      }, 5000);
    });

    assert.ok(exitCode !== 0, "Second router should exit with non-zero code on port conflict");
  });
});
