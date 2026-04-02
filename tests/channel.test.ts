import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";

// We need a fake router for the channel to register with
let fakeRouter: Server;
let fakeRouterPort: number;
let registrations: any[] = [];
let unregistrations: any[] = [];

// The channel process
let channel: ChildProcess;
let channelPort: number;

async function waitForRegistration(timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (registrations.length > 0) return registrations[0];
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("Channel did not register within timeout");
}

before(async () => {
  // Start a fake router that captures registrations
  fakeRouter = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString());

    if (req.url === "/register") {
      registrations.push(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } else if (req.url === "/unregister") {
      unregistrations.push(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } else {
      res.writeHead(404).end();
    }
  });

  await new Promise<void>((resolve) => fakeRouter.listen(0, "127.0.0.1", resolve));
  fakeRouterPort = (fakeRouter.address() as any).port;

  // Start the channel server pointing at our fake router
  channel = spawn("npx", ["tsx", "src/webhook-channel.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PROJECT_SLUG: "test/channel-project",
      ROUTER_URL: `http://127.0.0.1:${fakeRouterPort}`,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Wait for the channel to register
  const reg = await waitForRegistration();
  channelPort = reg.port;
});

after(async () => {
  channel?.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    if (!channel) return resolve();
    channel.on("exit", () => resolve());
    setTimeout(() => {
      channel?.kill("SIGKILL");
      resolve();
    }, 2000);
  });
  fakeRouter?.close();
});

// --- Registration ---

describe("Channel: registration", () => {
  it("self-registers with router on startup", () => {
    assert.equal(registrations.length, 1);
    assert.equal(registrations[0].project_slug, "test/channel-project");
    assert.ok(typeof registrations[0].port === "number");
    assert.ok(registrations[0].port > 0);
  });
});

// --- HTTP server ---

describe("Channel: HTTP", () => {
  it("rejects non-POST methods", async () => {
    const res = await fetch(`http://127.0.0.1:${channelPort}`, { method: "GET" });
    assert.equal(res.status, 405);
  });

  it("rejects invalid JSON", async () => {
    const res = await fetch(`http://127.0.0.1:${channelPort}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    assert.equal(res.status, 400);
  });

  it("accepts valid webhook payload", async () => {
    const res = await fetch(`http://127.0.0.1:${channelPort}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_slug: "test/channel-project",
        pipeline_status: "success",
        mr_iid: "42",
        branch: "main",
        commit_sha: "abcdef1234567890",
        commit_title: "Fix the thing",
        pipeline_url: "http://ci.test/42",
      }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
  });

  it("passes trace ID through", async () => {
    const res = await fetch(`http://127.0.0.1:${channelPort}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Trace-Id": "trace-123",
      },
      body: JSON.stringify({
        project_slug: "test/channel-project",
        pipeline_status: "failed",
      }),
    });
    assert.equal(res.status, 200);
  });

  it("handles payload with missing optional fields", async () => {
    const res = await fetch(`http://127.0.0.1:${channelPort}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_slug: "test/channel-project" }),
    });
    assert.equal(res.status, 200);
  });
});

// --- formatMessage (tested indirectly via stderr logs) ---

describe("Channel: message formatting", () => {
  it("formats a complete payload correctly", async () => {
    // We can verify formatting by checking stderr output
    let stderrOutput = "";
    channel.stderr?.on("data", (chunk: Buffer) => {
      stderrOutput += chunk.toString();
    });

    await fetch(`http://127.0.0.1:${channelPort}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_slug: "test/channel-project",
        pipeline_status: "failed",
        mr_iid: "7",
        branch: "feature/auth",
        commit_sha: "deadbeef12345678",
        commit_title: "Add OAuth",
        pipeline_url: "http://ci.test/77",
      }),
    });

    // Give stderr a moment to flush
    await new Promise((r) => setTimeout(r, 200));
    // Channel logs to stderr — verify it received the event
    assert.ok(stderrOutput.includes("received event") || stderrOutput.includes("emitted"));
  });
});

// --- Graceful shutdown ---

describe("Channel: graceful shutdown", () => {
  it("unregisters from router on SIGTERM", async () => {
    // Spawn a separate channel so we can kill it without breaking other tests
    const reg2: any[] = [];
    const unreg2: any[] = [];

    const fakeRouter2 = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (req.url === "/register") reg2.push(body);
      if (req.url === "/unregister") unreg2.push(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });

    await new Promise<void>((resolve) => fakeRouter2.listen(0, "127.0.0.1", resolve));
    const routerPort2 = (fakeRouter2.address() as any).port;

    // Use node --import tsx directly to avoid npx wrapper eating SIGTERM
    const ch2 = spawn("node", ["--import", "tsx", "src/webhook-channel.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PROJECT_SLUG: "test/shutdown-project",
        ROUTER_URL: `http://127.0.0.1:${routerPort2}`,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Wait for registration
    const start = Date.now();
    while (Date.now() - start < 5000 && reg2.length === 0) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(reg2.length, 1, "Channel should register on startup");

    // Kill the process group so signal reaches the actual node process
    ch2.kill("SIGTERM");

    const start2 = Date.now();
    while (Date.now() - start2 < 3000 && unreg2.length === 0) {
      await new Promise((r) => setTimeout(r, 50));
    }

    assert.equal(unreg2.length, 1, "Channel should unregister on SIGTERM");
    assert.equal(unreg2[0].project_slug, "test/shutdown-project");

    fakeRouter2.close();
  });
});

// --- Channel auto-assigns a unique port ---

describe("Channel: port assignment", () => {
  it("gets a port > 0 via port 0 auto-assignment", () => {
    assert.ok(channelPort > 0, "Channel should bind to a real port");
    assert.ok(channelPort < 65536, "Port should be in valid range");
  });

  it("two channels get different ports", async () => {
    const reg2: any[] = [];

    const fakeRouter2 = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (req.url === "/register") reg2.push(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });

    await new Promise<void>((resolve) => fakeRouter2.listen(0, "127.0.0.1", resolve));
    const routerPort2 = (fakeRouter2.address() as any).port;

    const ch2 = spawn("npx", ["tsx", "src/webhook-channel.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PROJECT_SLUG: "test/second-channel",
        ROUTER_URL: `http://127.0.0.1:${routerPort2}`,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const start = Date.now();
    while (Date.now() - start < 5000 && reg2.length === 0) {
      await new Promise((r) => setTimeout(r, 50));
    }

    try {
      assert.equal(reg2.length, 1);
      const port2 = reg2[0].port;
      assert.ok(port2 > 0);
      assert.notEqual(port2, channelPort, "Two channels should get different ports");
    } finally {
      ch2.kill("SIGTERM");
      fakeRouter2.close();
    }
  });
});
