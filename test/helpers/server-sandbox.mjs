import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SERVER_SCRIPT = fileURLToPath(new URL("../../bin/codex-dashboard-server.mjs", import.meta.url));
export const REPO_DIR_NAME = "demo-repo-0123456789abcdef";

export function createSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccd-server-"));
  const home = path.join(root, "home");
  const temp = path.join(root, "temp");
  const baseDir = path.join(temp, "codex-companion");
  const repoDir = path.join(baseDir, REPO_DIR_NAME);
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(repoDir, "jobs"), { recursive: true });
  return { root, home, temp, baseDir, repoDir, statePath: path.join(repoDir, "state.json") };
}

export function sandboxEnv(sandbox) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(comspec|userprofile|home|temp|tmp|tmpdir)$/i.test(key)),
  );
  // An unusable shell makes the server's Windows "start <url>" fail instead of opening a browser.
  env.ComSpec = path.join(sandbox.root, "no-shell.exe");
  env.USERPROFILE = sandbox.home;
  env.HOME = sandbox.home;
  env.TEMP = sandbox.temp;
  env.TMP = sandbox.temp;
  env.TMPDIR = sandbox.temp;
  return env;
}

export function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

export function waitForListening(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("Codex Dashboard running at")) {
        resolve();
      }
    });
    child.once("exit", (code) => reject(new Error(`server exited early with code ${code}`)));
  });
}

export async function startServer(sandbox) {
  const port = await findFreePort();
  const child = spawn(process.execPath, [SERVER_SCRIPT, "--port", String(port)], {
    env: sandboxEnv(sandbox),
    stdio: ["ignore", "pipe", "inherit"],
    windowsHide: true,
  });
  await waitForListening(child);
  return { child, url: `http://127.0.0.1:${port}` };
}

export function stopServer(server) {
  return new Promise((resolve) => {
    if (server.child.exitCode !== null) {
      resolve();
      return;
    }
    server.child.once("exit", () => resolve());
    server.child.kill();
  });
}

export async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, payload: await response.json() };
}

export function buildJob(overrides) {
  return {
    id: "task-demo-1",
    status: "queued",
    phase: "queued",
    title: "Demo job",
    pid: null,
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
    ...overrides,
  };
}

export function writeStateFixture(sandbox, jobs) {
  const text = `${JSON.stringify({ version: 1, config: {}, jobs }, null, 2)}\n`;
  fs.writeFileSync(sandbox.statePath, text, "utf8");
  return text;
}

export function readState(sandbox) {
  return JSON.parse(fs.readFileSync(sandbox.statePath, "utf8"));
}

export function jobTarget(sandbox, jobId) {
  return { baseDir: sandbox.baseDir, dirName: REPO_DIR_NAME, jobId };
}
