import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");
const CLI_PATH = resolve(PROJECT_ROOT, "src", "cli.ts");

// Sync helper for commands that don't need a server running
function runCliSync(args: string[], opts: { cwd?: string } = {}): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execSync(`npx tsx ${CLI_PATH} ${args.join(" ")}`, {
      cwd: opts.cwd || PROJECT_ROOT,
      env: process.env,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 15000,
    });
    return { stdout, stderr: "", status: 0 };
  } catch (err: any) {
    return { stdout: err.stdout || "", stderr: err.stderr || "", status: err.status || 1 };
  }
}

// Async helper for commands that need a mock server to respond concurrently
function runCliAsync(args: string[], opts: { cwd?: string } = {}): Promise<{ stdout: string; stderr: string; status: number }> {
  return new Promise((resolve) => {
    const child = spawn("npx", ["tsx", CLI_PATH, ...args], {
      cwd: opts.cwd || PROJECT_ROOT,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => stdout += d.toString());
    child.stderr.on("data", (d: Buffer) => stderr += d.toString());

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ stdout, stderr, status: 1 });
    }, 15000);

    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, status: code ?? 1 });
    });
  });
}

// --- hh init ---

describe("CLI: init", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "hh-test-"));
  });

  afterEach(() => {
    try { unlinkSync(join(tmpDir, ".mcp.json")); } catch {}
  });

  it("creates .mcp.json with correct structure", () => {
    const result = runCliSync(["init", "--slug", "test/project"], { cwd: tmpDir });
    assert.equal(result.status, 0);
    assert.ok(result.stdout.includes("Initialized HookHerald for test/project"));

    const config = JSON.parse(readFileSync(join(tmpDir, ".mcp.json"), "utf-8"));
    assert.ok(config.mcpServers["webhook-channel"]);
    assert.equal(config.mcpServers["webhook-channel"].env.PROJECT_SLUG, "test/project");
    assert.equal(config.mcpServers["webhook-channel"].env.ROUTER_URL, "http://127.0.0.1:9000");
    const chArgs: string[] = config.mcpServers["webhook-channel"].args;
    assert.ok(chArgs.some((a: string) => a.endsWith("webhook-channel.ts")));
  });

  it("merges with existing .mcp.json", () => {
    writeFileSync(join(tmpDir, ".mcp.json"), JSON.stringify({
      mcpServers: {
        "other-server": { command: "echo", args: ["hello"] },
      },
    }));

    const result = runCliSync(["init", "--slug", "test/merge"], { cwd: tmpDir });
    assert.equal(result.status, 0);

    const config = JSON.parse(readFileSync(join(tmpDir, ".mcp.json"), "utf-8"));
    assert.ok(config.mcpServers["other-server"], "existing server should be preserved");
    assert.ok(config.mcpServers["webhook-channel"], "webhook-channel should be added");
  });

  it("respects --router-url flag", () => {
    const result = runCliSync(["init", "--slug", "test/custom", "--router-url", "http://10.0.0.1:8080"], { cwd: tmpDir });
    assert.equal(result.status, 0);

    const config = JSON.parse(readFileSync(join(tmpDir, ".mcp.json"), "utf-8"));
    assert.equal(config.mcpServers["webhook-channel"].env.ROUTER_URL, "http://10.0.0.1:8080");
  });

  it("auto-detects slug from git remote", () => {
    execSync("git init && git remote add origin git@gitlab.com:mygroup/myproject.git", {
      cwd: tmpDir,
      stdio: "pipe",
    });

    const result = runCliSync(["init"], { cwd: tmpDir });
    assert.equal(result.status, 0);

    const config = JSON.parse(readFileSync(join(tmpDir, ".mcp.json"), "utf-8"));
    assert.equal(config.mcpServers["webhook-channel"].env.PROJECT_SLUG, "mygroup/myproject");
  });
});

// --- hh status ---

describe("CLI: status", () => {
  let mockRouter: Server;
  let mockPort: number;

  before(async () => {
    mockRouter = createServer((req, res) => {
      if (req.url === "/api/sessions") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify([
          {
            slug: "group/project",
            port: 45000,
            status: "up",
            registeredAt: new Date().toISOString(),
            lastEventAt: new Date().toISOString(),
            eventCount: 5,
            errorCount: 1,
            avgLatencyMs: 42,
            successCount: 4,
            failedCount: 1,
          },
        ]));
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => mockRouter.listen(0, "127.0.0.1", resolve));
    mockPort = (mockRouter.address() as any).port;
  });

  after(() => { mockRouter.close(); });

  it("displays sessions from router", async () => {
    const result = await runCliAsync(["status", "--router-url", `http://127.0.0.1:${mockPort}`]);
    assert.equal(result.status, 0);
    assert.ok(result.stdout.includes("group/project"));
    assert.ok(result.stdout.includes("45000"));
    assert.ok(result.stdout.includes("up"));
  });

  it("shows error when router is unreachable", async () => {
    const result = await runCliAsync(["status", "--router-url", "http://127.0.0.1:1"]);
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes("not reachable"));
  });
});

// --- hh kill ---

describe("CLI: kill", () => {
  let mockRouter: Server;
  let mockPort: number;
  let lastKillSlug: string | null = null;

  before(async () => {
    mockRouter = createServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/api/kill") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        lastKillSlug = body.project_slug;

        if (body.project_slug === "test/exists") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, slug: "test/exists", port: 45000, eventCount: 3 }));
        } else {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `no route for ${body.project_slug}` }));
        }
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => mockRouter.listen(0, "127.0.0.1", resolve));
    mockPort = (mockRouter.address() as any).port;
  });

  after(() => { mockRouter.close(); });

  it("kills an existing session", async () => {
    const result = await runCliAsync(["kill", "test/exists", "--router-url", `http://127.0.0.1:${mockPort}`]);
    assert.equal(result.status, 0);
    assert.ok(result.stdout.includes("Killed session: test/exists"));
    assert.equal(lastKillSlug, "test/exists");
  });

  it("shows error for nonexistent session", async () => {
    const result = await runCliAsync(["kill", "test/gone", "--router-url", `http://127.0.0.1:${mockPort}`]);
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes("no route"));
  });

  it("shows usage when slug is missing", () => {
    const result = runCliSync(["kill"]);
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes("Usage"));
  });
});

// --- hh (no args / help) ---

describe("CLI: usage", () => {
  it("shows usage with no args", () => {
    const result = runCliSync([]);
    assert.equal(result.status, 0);
    assert.ok(result.stdout.includes("Usage: hh"));
    assert.ok(result.stdout.includes("init"));
    assert.ok(result.stdout.includes("status"));
    assert.ok(result.stdout.includes("kill"));
    assert.ok(result.stdout.includes("router"));
  });

  it("exits 1 for unknown command", () => {
    const result = runCliSync(["bogus"]);
    assert.notEqual(result.status, 0);
  });
});
