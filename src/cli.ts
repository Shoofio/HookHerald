import { execSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHANNEL_PATH = resolve(__dirname, "webhook-channel.ts");
const ROUTER_PATH = resolve(__dirname, "webhook-router.ts");

// Resolve tsx loader path relative to this package (works from any CWD)
const require = createRequire(import.meta.url);
const TSX_PATH = dirname(require.resolve("tsx/package.json"));
const PID_DIR = resolve(process.env.HOME || "/tmp", ".hookherald");
const PID_FILE = resolve(PID_DIR, "router.pid");

const DEFAULT_ROUTER_URL = "http://127.0.0.1:9000";
const DEFAULT_PORT = "9000";
const DEFAULT_SECRET = "dev-secret";

const args = process.argv.slice(2);
const command = args[0];

// --- Flag parsing ---

function getFlag(name: string): string | undefined {
  const flag = `--${name}`;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && i + 1 < args.length) return args[i + 1];
  }
  return undefined;
}

function hasFlag(name: string): boolean {
  return args.includes(`--${name}`);
}

// --- Slug detection ---

function detectSlug(): string {
  try {
    const remote = execSync("git remote get-url origin", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    // SSH: git@gitlab.com:group/project.git
    const lastColon = remote.lastIndexOf(":");
    if (lastColon !== -1 && !remote.slice(0, lastColon).includes("/")) {
      const slug = remote.slice(lastColon + 1).replace(/\.git$/, "");
      if (slug.includes("/")) return slug;
    }

    // HTTPS: https://gitlab.com/group/project.git
    try {
      const u = new URL(remote);
      const slug = u.pathname.replace(/^\//, "").replace(/\.git$/, "");
      if (slug.includes("/")) return slug;
    } catch {}
  } catch {}

  return basename(process.cwd());
}

// --- Commands ---

async function cmdInit() {
  const slug = getFlag("slug") || detectSlug();
  const routerUrl = getFlag("router-url") || DEFAULT_ROUTER_URL;
  const mcpPath = resolve(process.cwd(), ".mcp.json");

  let config: any = {};
  if (existsSync(mcpPath)) {
    try {
      config = JSON.parse(readFileSync(mcpPath, "utf-8"));
    } catch {
      console.error("Error: existing .mcp.json is not valid JSON");
      process.exit(1);
    }
  }

  if (!config.mcpServers) config.mcpServers = {};

  config.mcpServers["webhook-channel"] = {
    command: "node",
    args: ["--import", resolve(TSX_PATH, "dist", "esm", "index.mjs"), CHANNEL_PATH],
    env: {
      PROJECT_SLUG: slug,
      ROUTER_URL: routerUrl,
    },
  };

  writeFileSync(mcpPath, JSON.stringify(config, null, 2) + "\n");
  console.log(`Initialized HookHerald for ${slug} in .mcp.json`);
  console.log(`  Channel: ${CHANNEL_PATH}`);
  console.log(`  Router:  ${routerUrl}`);
}

async function cmdStatus() {
  const routerUrl = getFlag("router-url") || DEFAULT_ROUTER_URL;

  let resp: Response;
  try {
    resp = await fetch(`${routerUrl}/api/sessions`, {
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    console.error(`Router not reachable at ${routerUrl}`);
    process.exit(1);
  }

  if (!resp.ok) {
    console.error(`Router returned ${resp.status}`);
    process.exit(1);
  }

  const sessions: any[] = await resp.json();

  if (sessions.length === 0) {
    console.log("No active sessions");
    return;
  }

  console.log(
    "SLUG".padEnd(30) +
      "PORT".padEnd(8) +
      "STATUS".padEnd(10) +
      "EVENTS".padEnd(10) +
      "ERRORS".padEnd(10) +
      "LAST EVENT",
  );
  console.log("-".repeat(88));

  for (const s of sessions) {
    const lastEvent = s.lastEventAt ? timeAgo(s.lastEventAt) : "never";
    console.log(
      String(s.slug).padEnd(30) +
        String(s.port).padEnd(8) +
        String(s.status).padEnd(10) +
        String(s.eventCount).padEnd(10) +
        String(s.errorCount).padEnd(10) +
        lastEvent,
    );
  }
}

async function cmdKill() {
  const slug = args[1];
  if (!slug || slug.startsWith("--")) {
    console.error("Usage: hh kill <slug>");
    process.exit(1);
  }

  const routerUrl = getFlag("router-url") || DEFAULT_ROUTER_URL;

  let resp: Response;
  try {
    resp = await fetch(`${routerUrl}/api/kill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_slug: slug }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    console.error(`Router not reachable at ${routerUrl}`);
    process.exit(1);
  }

  const data = await resp.json();
  if (!resp.ok) {
    console.error(`Error: ${data.error}`);
    process.exit(1);
  }

  console.log(`Killed session: ${data.slug} (port ${data.port}, ${data.eventCount} events)`);
}

function cmdRouter() {
  const subcommand = args[1];

  if (subcommand === "stop") {
    cmdRouterStop();
    return;
  }

  const port = getFlag("port") || process.env.ROUTER_PORT || DEFAULT_PORT;
  const secret = getFlag("secret") || process.env.WEBHOOK_SECRET || DEFAULT_SECRET;
  const bg = hasFlag("bg");

  const child = spawn("node", ["--import", resolve(TSX_PATH, "dist", "esm", "index.mjs"), ROUTER_PATH], {
    env: {
      ...process.env,
      ROUTER_PORT: port,
      WEBHOOK_SECRET: secret,
    },
    stdio: bg ? "ignore" : "inherit",
    detached: bg,
  });

  if (bg) {
    // Write PID file and detach
    mkdirSync(PID_DIR, { recursive: true });
    writeFileSync(PID_FILE, String(child.pid));
    child.unref();
    console.log(`Router started in background (PID ${child.pid}, port ${port})`);
    console.log(`  Stop with: hh router stop`);
  } else {
    // Foreground: forward signals, wait for exit
    process.on("SIGTERM", () => child.kill("SIGTERM"));
    process.on("SIGINT", () => child.kill("SIGINT"));
    child.on("exit", (code) => process.exit(code ?? 0));
  }
}

function cmdRouterStop() {
  if (!existsSync(PID_FILE)) {
    console.error("No background router found (no PID file)");
    process.exit(1);
  }

  const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);

  try {
    process.kill(pid, "SIGTERM");
    console.log(`Stopped router (PID ${pid})`);
  } catch (err: any) {
    if (err.code === "ESRCH") {
      console.log(`Router already stopped (PID ${pid} not found)`);
    } else {
      console.error(`Failed to stop router: ${err.message}`);
      process.exit(1);
    }
  }

  try { unlinkSync(PID_FILE); } catch {}
}

// --- Helpers ---

function timeAgo(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 5) return "just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function usage() {
  console.log(`                                                              ...::::::::..
                              .=%@@@*+=#@
                           -%@*.
                        .%@-
                     *#@*.
                   .=@@*
             :.   =@=.
         =@@*. .=@+
        -@.:  =@+            .-%@@@@@@@@@
        .@*:+@+        .=#@@@@@@@@@@@@@@@
           ..       .%@@@@@%@@@@@@@@@@@@@
                   =@@@@@@+ .@@@@@@@@@@@@
                      .*@@@@@@@@@@@@@@@@@
                  =******@@@@@@@@@@@@@@@@
                   .+@@@@@@@@@@@@@@@@@@@@
                       :%@@@@@@@@@@@@@@@@
                           .-+#@@@@@@@@@@

  HookHerald — webhook relay for Claude Code

Usage: hh <command> [options]

Commands:
  init   [--slug <slug>] [--router-url <url>]   Set up .mcp.json in current directory
  status [--router-url <url>]                    Show active sessions
  kill   <slug> [--router-url <url>]             Bounce a session (Claude Code respawns it)
  router [--port <port>] [--secret <secret>]     Start the webhook router
         [--bg]                                  Run in background
  router stop                                    Stop background router`);
}

// --- Main ---

switch (command) {
  case "init":
    await cmdInit();
    break;
  case "status":
    await cmdStatus();
    break;
  case "kill":
    await cmdKill();
    break;
  case "router":
    cmdRouter();
    break;
  case "--help":
  case "-h":
  case "help":
    usage();
    break;
  default:
    usage();
    if (command) process.exit(1);
}
