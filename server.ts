/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express from "express";
import path from "path";
import cors from "cors";
import { createServer as createViteServer } from "vite";
import { spawn, ChildProcess, execSync } from "child_process";
import fs from "fs";
import net from "net";
import dns from "dns";
import type { AppState, XmrigStats, MiningStatus, DiagnosticCheck } from "./src/types";

const app = express();
const PORT = 3000;
const HOST = "0.0.0.0";
const XMRIG_API_PORT = 4444;

app.use(cors());
app.use(express.json());

// Simple JSON DB for persistence
const DB_FILE = path.join(process.cwd(), "db.json");
interface DBState {
  walletAddress: string;
  totalEarnedXMR: number;
  sessions: { start: number; end: number | null; earned: number }[];
  transactions: { id: string; amount: number; status: string; date: number }[];
}

let db: DBState = {
  walletAddress: process.env.WALLET_ADDRESS || "44WFFiHCGdULtqqTAjYxRV2fQvLetfYZAgKBKd1weMTDNM4L1SVv7PhQ6uuvLZzrXLXKtGFnT1gFcLKZsgx4b5AfVbZYQ1d",
  totalEarnedXMR: 0,
  sessions: [],
  transactions: [],
};

if (fs.existsSync(DB_FILE)) {
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
  } catch (e) {
    console.error("[DB] Failed to read db.json", e);
  }
}

function saveDb() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  } catch (e) {
    console.error("[DB] Failed to save db.json", e);
  }
}

// Configuration
const WALLET_ADDRESS = process.env.WALLET_ADDRESS || "44WFFiHCGdULtqqTAjYxRV2fQvLetfYZAgKBKd1weMTDNM4L1SVv7PhQ6uuvLZzrXLXKtGFnT1gFcLKZsgx4b5AfVbZYQ1d";
const WORKER_ID = process.env.WORKER_ID || "moneygain_worker_01";
const POOL_URL = process.env.POOL_URL || "pool.supportxmr.com:3333";
const THREADS_COUNT = parseInt(process.env.THREADS || "8", 10);
const XMRIG_PATH = process.env.XMRIG_PATH || path.join(process.cwd(), "xmrig");

// Supervisor state
let minerProcess: ChildProcess | null = null;
let isMiningActive = false;
let sessionStartTime: number | null = null;
let currentMiningStatus: MiningStatus = "STARTING";
let miningError: string | null = null;
let reconnectAttempt = 0;
let reconnectTimer: NodeJS.Timeout | null = null;
let lastAcceptedShares = 0;
let lastShareTime = 0;
let lastKnownPool = "";

let xmrigStats: XmrigStats = {
  hashrate: null,
  hashrate10s: null,
  hashrate60s: null,
  hashrate15m: null,
  highestHashrate: null,
  accepted: 0,
  rejected: 0,
  poolConnected: false,
  poolUrl: "",
  diff: 0,
  lastShare: 0,
  workerRunning: false,
  uptimeSeconds: 0,
  statusText: "Initializing engine..."
};

// Check if xmrig binary is available & executable
function getResolvedMinerBinary(): string | null {
  if (fs.existsSync(XMRIG_PATH)) {
    try {
      fs.accessSync(XMRIG_PATH, fs.constants.X_OK);
      return XMRIG_PATH;
    } catch {
      try {
        fs.chmodSync(XMRIG_PATH, 0o755);
        return XMRIG_PATH;
      } catch {}
    }
    return XMRIG_PATH;
  }
  const localXmrig = path.join(process.cwd(), "xmrig");
  if (fs.existsSync(localXmrig)) {
    try {
      fs.chmodSync(localXmrig, 0o755);
    } catch {}
    return localXmrig;
  }
  return null;
}

function checkXmrigAvailable(): boolean {
  return getResolvedMinerBinary() !== null;
}

// Kill any orphaned xmrig processes
function killOrphanedMiners() {
  try {
    execSync("pkill -9 xmrig", { stdio: "ignore" });
  } catch {}
}

// Price & Balance State
let currentPriceUSD = 0;
let currentPriceIDR = 0;
let poolBalanceXMR = 0;
let poolPaidXMR = 0;

async function fetchPrice() {
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=monero&vs_currencies=usd,idr");
    if (res.ok) {
      const data = (await res.json()) as any;
      if (data && data.monero) {
        currentPriceUSD = data.monero.usd || 0;
        currentPriceIDR = data.monero.idr || 0;
        broadcastState();
      }
    }
  } catch (err) {
    // Non-fatal network fetch error
  }
}

async function fetchPoolStats() {
  try {
    const res = await fetch(`https://supportxmr.com/api/miner/${WALLET_ADDRESS}/stats`);
    if (res.ok) {
      const data = (await res.json()) as any;
      if (data) {
        poolPaidXMR = (data.amtPaid || 0) / 1e12;
        poolBalanceXMR = (data.amtDue || 0) / 1e12;
        db.totalEarnedXMR = poolPaidXMR + poolBalanceXMR;
        saveDb();
        broadcastState();
      }
    }
  } catch (err) {
    // Non-fatal network fetch error
  }
}

// Format CLI Arguments for XMRig
function buildXmrigArgs(): string[] {
  const args: string[] = [];

  // Parse and normalize primary pool
  let primaryPool = POOL_URL.trim();
  let isTlsPrimary = false;

  if (primaryPool.startsWith("stratum+ssl://") || primaryPool.startsWith("ssl://") || primaryPool.startsWith("tls://")) {
    isTlsPrimary = true;
    primaryPool = primaryPool.replace(/^(stratum\+ssl:\/\/|ssl:\/\/|tls:\/\/)/, "");
  } else if (primaryPool.startsWith("stratum+tcp://") || primaryPool.startsWith("tcp://")) {
    primaryPool = primaryPool.replace(/^(stratum\+tcp:\/\/|tcp:\/\/)/, "");
  }

  if (primaryPool.includes(":443") || primaryPool.includes("donate.v2.xmrig.com")) {
    isTlsPrimary = true;
  }

  // Primary Pool
  args.push("-o", primaryPool);
  if (isTlsPrimary) {
    args.push("--tls");
  }

  // Backup Pools for uninterrupted 24/7 mining (Valid SupportXMR stratum TCP ports)
  if (primaryPool !== "pool.supportxmr.com:3333") {
    args.push("-o", "pool.supportxmr.com:3333");
  }
  if (primaryPool !== "pool.supportxmr.com:5555") {
    args.push("-o", "pool.supportxmr.com:5555");
  }
  if (primaryPool !== "pool.supportxmr.com:7777") {
    args.push("-o", "pool.supportxmr.com:7777");
  }

  // Auth & Identity
  args.push("-u", WALLET_ADDRESS);
  args.push("-p", WORKER_ID);
  args.push("--rig-id", WORKER_ID);
  args.push("-k"); // Keepalive
  args.push("--coin", "monero");

  // Essential runtime flags for container virtualization stability
  args.push("--no-huge-pages"); // Avoid Bus errors in unprivileged containers
  args.push("--http-host", "127.0.0.1");
  args.push("--http-port", XMRIG_API_PORT.toString());
  args.push("-t", THREADS_COUNT.toString());
  args.push("--print-time", "2");
  args.push("--no-color");

  return args;
}

// Parse stdout lines from XMRig in real time
function handleMinerStdout(line: string) {
  const trimmed = line.trim();
  if (!trimmed) return;

  // Log in server console
  if (trimmed.includes("use pool") || trimmed.includes("new job") || trimmed.includes("speed") || trimmed.includes("accepted") || trimmed.includes("dataset ready") || trimmed.includes("error")) {
    console.log(`[Mining] ${trimmed}`);
  }

  // Match pool connection
  const poolMatch = trimmed.match(/use pool\s+([^\s]+)/i);
  if (poolMatch) {
    lastKnownPool = poolMatch[1];
    xmrigStats.poolConnected = true;
    xmrigStats.poolUrl = lastKnownPool;
    if (currentMiningStatus !== "HASHING") {
      currentMiningStatus = "CONNECTED";
    }
    broadcastState();
  }

  // Match dataset ready
  if (trimmed.includes("dataset ready") || trimmed.includes("READY threads")) {
    if (currentMiningStatus !== "HASHING") {
      currentMiningStatus = "CONNECTED";
    }
    broadcastState();
  }

  // Match accepted share: e.g. "accepted (1/0) diff 75000 (42 ms)"
  const acceptedMatch = trimmed.match(/accepted\s*\((\d+)\/(\d+)\)/i);
  if (acceptedMatch) {
    const good = parseInt(acceptedMatch[1], 10);
    const total = parseInt(acceptedMatch[2], 10);
    xmrigStats.accepted = good;
    xmrigStats.rejected = Math.max(0, total - good);
    lastShareTime = Date.now();
    xmrigStats.lastShare = lastShareTime;
    broadcastState();
  }

  // Match speed report: e.g. "speed 10s/60s/15m 434.8 n/a n/a H/s"
  const speedMatch = trimmed.match(/speed\s+10s\/60s\/15m\s+([0-9.]+)\s+/i);
  if (speedMatch) {
    const rate = parseFloat(speedMatch[1]);
    if (!isNaN(rate) && rate > 0) {
      xmrigStats.hashrate = rate;
      xmrigStats.hashrate10s = rate;
      currentMiningStatus = "HASHING";
      broadcastState();
    }
  }

  // Match connection errors
  if (trimmed.includes("connect error") || trimmed.includes("read error") || trimmed.includes("connection refused")) {
    if (currentMiningStatus !== "HASHING") {
      currentMiningStatus = "DISCONNECTED";
      xmrigStats.poolConnected = false;
      broadcastState();
    }
  }
}

// Start Miner with Process Supervision & Reconnect Backoff
function startMiner() {
  if (minerProcess) {
    return;
  }

  const binary = getResolvedMinerBinary();
  if (!binary) {
    miningError = "XMRig binary not found or not executable in this environment";
    currentMiningStatus = "ERROR";
    console.error(`[Mining] ${miningError}`);
    broadcastState();
    return;
  }

  miningError = null;
  currentMiningStatus = "STARTING";
  isMiningActive = true;
  if (!sessionStartTime) {
    sessionStartTime = Date.now();
  }

  // Clean up any old process before spawning
  killOrphanedMiners();

  const args = buildXmrigArgs();
  console.log(`[Mining] Starting XMRig with ${THREADS_COUNT} threads...`);
  console.log(`[Mining] Pool: ${POOL_URL}`);
  console.log(`[Mining] Worker: ${WORKER_ID}`);
  console.log(`[Mining] Binary: ${binary}`);

  try {
    minerProcess = spawn(binary, args, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    xmrigStats.workerRunning = true;
    broadcastState();

    minerProcess.stdout?.on("data", (chunk: Buffer) => {
      const lines = chunk.toString().split("\n");
      for (const line of lines) {
        handleMinerStdout(line);
      }
    });

    minerProcess.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) {
        console.error(`[Mining STDERR] ${text}`);
      }
    });

    minerProcess.on("error", (err: Error) => {
      console.error(`[Mining] Process error:`, err);
      minerProcess = null;
      isMiningActive = false;
      currentMiningStatus = "ERROR";
      miningError = `Process error: ${err.message}`;
      xmrigStats.workerRunning = false;
      xmrigStats.poolConnected = false;
      broadcastState();
      scheduleReconnect();
    });

    minerProcess.on("exit", (code: number | null, signal: string | null) => {
      console.warn(`[Mining] Process exited with code ${code}, signal: ${signal}`);
      minerProcess = null;
      isMiningActive = false;
      xmrigStats.workerRunning = false;
      xmrigStats.poolConnected = false;
      
      if (currentMiningStatus !== "STOPPED") {
        currentMiningStatus = code === 0 ? "DISCONNECTED" : "ERROR";
        if (code !== 0) {
          miningError = `Miner exited unexpectedly (code ${code})`;
        }
      }
      
      broadcastState();
      scheduleReconnect();
    });
  } catch (err: any) {
    console.error(`[Mining] Failed to spawn miner:`, err);
    minerProcess = null;
    isMiningActive = false;
    currentMiningStatus = "ERROR";
    miningError = `Spawn error: ${err.message}`;
    broadcastState();
    scheduleReconnect();
  }
}

// Exponential Backoff Reconnect (2s, 4s, 8s, 16s, 30s, max 60s)
function scheduleReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
  }

  const backoffDelays = [2000, 4000, 8000, 16000, 30000, 60000];
  const delay = backoffDelays[Math.min(reconnectAttempt, backoffDelays.length - 1)];
  reconnectAttempt++;

  console.log(`[Mining] Auto-reconnecting in ${delay / 1000}s (attempt ${reconnectAttempt})...`);
  reconnectTimer = setTimeout(() => {
    startMiner();
  }, delay);
}

// Polling XMRig HTTP API for High-Precision Telemetry
async function pollXmrigApi() {
  if (!isMiningActive && !minerProcess) {
    return;
  }

  try {
    const res = await fetch(`http://127.0.0.1:${XMRIG_API_PORT}/2/summary`, {
      signal: AbortSignal.timeout(1500)
    });

    if (res.ok) {
      const data = (await res.json()) as any;
      if (data) {
        // Reset reconnect attempts on successful communication
        reconnectAttempt = 0;

        const isConnected = Boolean(data.connection?.pool);
        const poolName = data.connection?.pool || lastKnownPool || POOL_URL;
        const diff = data.connection?.diff || 0;
        const uptime = data.uptime || 0;

        const goodShares = Number(data.results?.shares_good) || 0;
        const totalShares = Number(data.results?.shares_total) || 0;
        const rejectedShares = Math.max(0, totalShares - goodShares);

        if (goodShares > lastAcceptedShares) {
          lastShareTime = Date.now();
          lastAcceptedShares = goodShares;
        }

        // Extract hashrates
        let rate10s: number | null = null;
        let rate60s: number | null = null;
        let rate15m: number | null = null;

        if (Array.isArray(data.hashrate?.total)) {
          if (typeof data.hashrate.total[0] === "number") rate10s = data.hashrate.total[0];
          if (typeof data.hashrate.total[1] === "number") rate60s = data.hashrate.total[1];
          if (typeof data.hashrate.total[2] === "number") rate15m = data.hashrate.total[2];
        }

        const highest = typeof data.hashrate?.highest === "number" ? data.hashrate.highest : null;
        const primaryRate = rate10s ?? rate60s ?? highest;

        // Determine granular status
        if (isConnected && primaryRate !== null && primaryRate > 0) {
          currentMiningStatus = "HASHING";
        } else if (isConnected) {
          currentMiningStatus = "CONNECTED";
        } else if (data.connection?.failures > 0) {
          currentMiningStatus = "DISCONNECTED";
        } else {
          currentMiningStatus = "CONNECTING";
        }

        xmrigStats = {
          hashrate: primaryRate,
          hashrate10s: rate10s,
          hashrate60s: rate60s,
          hashrate15m: rate15m,
          highestHashrate: highest,
          accepted: goodShares,
          rejected: rejectedShares,
          poolConnected: isConnected,
          poolUrl: poolName,
          diff,
          lastShare: lastShareTime,
          workerRunning: true,
          uptimeSeconds: uptime,
          statusText: currentMiningStatus
        };

        broadcastState();
      }
    }
  } catch (err) {
    // API not ready yet during initial dataset generation
    if (minerProcess) {
      if (currentMiningStatus === "STARTING" || currentMiningStatus === "CONNECTING") {
        xmrigStats.workerRunning = true;
      }
    }
  }
}

// 2-Second Central Telemetry Polling Loop
setInterval(pollXmrigApi, 2000);

// Periodic Market Data & Pool Balance Refresh
fetchPrice();
fetchPoolStats();
setInterval(() => {
  fetchPrice();
  fetchPoolStats();
}, 60000);

// SSE Streaming
const clients = new Set<express.Response>();

app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  // Send initial state immediately
  res.write(`data: ${JSON.stringify(getState())}\n\n`);

  clients.add(res);

  req.on("close", () => {
    clients.delete(res);
  });
});

function broadcastState() {
  const state = JSON.stringify(getState());
  clients.forEach((client) => {
    try {
      client.write(`data: ${state}\n\n`);
    } catch {}
  });
}

function getState(): AppState {
  const xmrigAvailable = checkXmrigAvailable();
  return {
    isMining: isMiningActive,
    miningStatus: currentMiningStatus,
    sessionStartTime,
    currentSessionEarned: poolBalanceXMR,
    totalEarnedXMR: db.totalEarnedXMR,
    balance: poolBalanceXMR,
    walletAddress: WALLET_ADDRESS,
    priceUSD: currentPriceUSD,
    priceIDR: currentPriceIDR,
    isBackendAvailable: xmrigAvailable,
    miningError: xmrigAvailable ? miningError : "XMRig unavailable in this runtime",
    transactions: db.transactions,
    xmrigStats,
    threads: THREADS_COUNT,
    autoMining: true,
    poolName: xmrigStats.poolUrl || POOL_URL,
    workerId: WORKER_ID
  };
}

// Diagnostics Checker
async function runDiagnostics(): Promise<DiagnosticCheck[]> {
  const checks: DiagnosticCheck[] = [];

  // 1. Check binary existence
  const binary = getResolvedMinerBinary();
  if (binary && fs.existsSync(binary)) {
    checks.push({ name: "XMRig Binary", status: "ok", message: `Found binary at ${binary}` });
  } else {
    checks.push({ name: "XMRig Binary", status: "error", message: "XMRig binary not found" });
  }

  // 2. Check executability & version
  try {
    const versionOutput = execSync(`${binary || "./xmrig"} --version`, { encoding: "utf-8", timeout: 3000 });
    checks.push({ name: "XMRig Executable", status: "ok", message: versionOutput.split("\n")[0] });
  } catch (e: any) {
    checks.push({ name: "XMRig Executable", status: "error", message: `Execution failed: ${e.message}` });
  }

  // 3. Check Pool DNS resolution
  const cleanUrl = POOL_URL.replace(/^(stratum\+tcp:\/\/|stratum\+ssl:\/\/|ssl:\/\/|tcp:\/\/|https:\/\/|http:\/\/)/, "");
  const parts = cleanUrl.split(":");
  const host = parts[0];
  const port = parseInt(parts[1] || "3333", 10);
  try {
    const addresses = await dns.promises.resolve4(host);
    checks.push({ name: "Pool DNS Resolution", status: "ok", message: `Resolved ${host} -> ${addresses.join(", ")}` });
  } catch (e: any) {
    checks.push({ name: "Pool DNS Resolution", status: "warning", message: `DNS lookup failed for ${host}: ${e.message}` });
  }

  // 4. Check Pool TCP Connectivity
  try {
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ host, port, timeout: 4000 }, () => {
        socket.end();
        resolve();
      });
      socket.on("error", reject);
      socket.on("timeout", () => {
        socket.destroy();
        reject(new Error("TCP connection timed out"));
      });
    });
    checks.push({ name: "Pool TCP Reachable", status: "ok", message: `Successfully connected to ${host}:${port}` });
  } catch (e: any) {
    checks.push({ name: "Pool TCP Reachable", status: "warning", message: `TCP test warning: ${e.message}` });
  }

  // 5. Miner Process Status
  if (minerProcess && !minerProcess.killed) {
    checks.push({ name: "Miner Process", status: "ok", message: `Process running (PID: ${minerProcess.pid})` });
  } else {
    checks.push({ name: "Miner Process", status: "warning", message: "Miner process not active" });
  }

  // 6. Pool Connection Status
  if (xmrigStats.poolConnected) {
    checks.push({ name: "Pool Connected", status: "ok", message: `Active connection to ${xmrigStats.poolUrl}` });
  } else {
    checks.push({ name: "Pool Connected", status: "warning", message: "Pool connection pending" });
  }

  // 7. Hashrate Telemetry
  if (xmrigStats.hashrate !== null && xmrigStats.hashrate > 0) {
    checks.push({ name: "Hashrate Telemetry", status: "ok", message: `Realtime hashrate: ${xmrigStats.hashrate.toFixed(2)} H/s` });
  } else {
    checks.push({ name: "Hashrate Telemetry", status: "warning", message: "Waiting for first hashrate report" });
  }

  // 8. SSE Streaming Status
  checks.push({ name: "SSE Stream", status: "ok", message: `${clients.size} active client connection(s)` });

  return checks;
}

// REST Endpoints
app.get("/api/state", (req, res) => {
  res.json(getState());
});

app.get("/api/mining/stats", (req, res) => {
  res.json(xmrigStats);
});

app.get("/api/mining/diagnostics", async (req, res) => {
  const diagnostics = await runDiagnostics();
  res.json({
    status: currentMiningStatus,
    timestamp: Date.now(),
    diagnostics
  });
});

app.post("/api/mine/start", (req, res) => {
  if (minerProcess) {
    return res.json({ success: true, message: "Auto-mining already active" });
  }
  startMiner();
  res.json({ success: true, message: "Auto-mining started" });
});

app.post("/api/mine/stop", (req, res) => {
  res.status(403).json({ error: "Manual stop is disabled. Auto-Mining mode is permanently enabled." });
});

// Auto-start mining on boot
setTimeout(() => {
  console.log("[Auto-Mining] Initializing autonomous mining engine...");
  startMiner();
}, 500);

// Graceful Cleanup on Process Exit
function cleanup() {
  if (minerProcess) {
    try {
      console.log("[Mining] Stopping miner child process...");
      minerProcess.kill("SIGTERM");
    } catch {}
  }
  killOrphanedMiners();
}

process.on("SIGINT", () => {
  cleanup();
  process.exit(0);
});

process.on("SIGTERM", () => {
  cleanup();
  process.exit(0);
});

process.on("exit", cleanup);

// Start Server with Vite Middleware attached first
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, HOST, () => {
    console.log(`Mining server running on http://${HOST}:${PORT}`);
  });
}

startServer();
