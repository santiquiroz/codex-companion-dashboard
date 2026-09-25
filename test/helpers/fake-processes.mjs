import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

const IDLE_SCRIPT = "setInterval(() => {}, 1000);\n";

function writeFakeCompanionScript(sandbox) {
  const scriptPath = path.join(sandbox.root, "scripts", "codex-companion.mjs");
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, IDLE_SCRIPT, "utf8");
  return scriptPath;
}

function spawnIdleProcess(args) {
  return spawn(process.execPath, args, { stdio: "ignore", windowsHide: true });
}

export function spawnForeignProcess() {
  return spawnIdleProcess(["-e", IDLE_SCRIPT]);
}

export function spawnTaskWorker(sandbox, jobId) {
  const scriptPath = writeFakeCompanionScript(sandbox);
  return spawnIdleProcess([scriptPath, "task-worker", "--cwd", sandbox.root, "--job-id", jobId]);
}

export function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    delay(timeoutMs).then(() => false),
  ]);
}

export function stopChild(child) {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill();
  }
}
