import { execFile } from "node:child_process";
import fs from "node:fs";
import process from "node:process";

const COMPANION_SCRIPT = "codex-companion.mjs";
const TASK_WORKER_ARG = "task-worker";
const JOB_ID_FLAG = "--job-id";
const INSPECT_TIMEOUT_MS = 5_000;
const WINDOWS_NOT_FOUND_EXIT = 3;
const DEFAULT_CACHE_TTL_MS = 5_000;

function isValidPid(value) {
  return Number.isInteger(value) && value > 0;
}

function isProcessPresent(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user or is elevated.
    return error.code === "EPERM";
  }
}

function runCommand(file, args) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { encoding: "utf8", timeout: INSPECT_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

function windowsCommandLineScript(pid) {
  return [
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
    `$p = Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId=${pid}'`,
    `if ($null -eq $p) { exit ${WINDOWS_NOT_FOUND_EXIT} }`,
    "[Console]::Out.Write([string]$p.CommandLine)",
  ].join("; ");
}

async function inspectWindowsProcess(pid) {
  try {
    const stdout = await runCommand("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      windowsCommandLineScript(pid),
    ]);
    return { exists: true, commandLine: stdout.trim() || null };
  } catch (error) {
    if (error.code === WINDOWS_NOT_FOUND_EXIT) {
      return { exists: false };
    }
    throw error;
  }
}

function inspectLinuxProcess(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return { exists: true, commandLine: raw.split("\0").join(" ").trim() || null };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { exists: false };
    }
    throw error;
  }
}

async function inspectPosixProcess(pid) {
  try {
    const stdout = await runCommand("ps", ["-o", "command=", "-p", String(pid)]);
    return { exists: true, commandLine: stdout.trim() || null };
  } catch (error) {
    if (error.code === 1) {
      return { exists: false };
    }
    throw error;
  }
}

function readCommandLine(pid) {
  if (process.platform === "win32") {
    return inspectWindowsProcess(pid);
  }
  if (process.platform === "linux") {
    return inspectLinuxProcess(pid);
  }
  return inspectPosixProcess(pid);
}

export async function inspectProcess(pid) {
  if (!isProcessPresent(pid)) {
    return { exists: false };
  }
  return readCommandLine(pid);
}

function commandLineTokens(commandLine) {
  return commandLine
    .split(/\s+/)
    .map((token) => token.replace(/["']/g, ""))
    .filter(Boolean);
}

function hasJobIdArgument(tokens, jobId) {
  return tokens.some(
    (token, index) =>
      token === `${JOB_ID_FLAG}=${jobId}` || (token === JOB_ID_FLAG && tokens[index + 1] === jobId),
  );
}

function tokenBasename(token) {
  return token.split(/[\\/]/).pop().toLowerCase();
}

function runsCompanionScript(tokens) {
  return tokens.some((token) => tokenBasename(token) === COMPANION_SCRIPT);
}

export function isJobCommandLine(commandLine, jobId) {
  const tokens = commandLineTokens(commandLine);
  if (!runsCompanionScript(tokens)) {
    return false;
  }
  if (!tokens.includes(TASK_WORKER_ARG)) {
    return true;
  }
  return hasJobIdArgument(tokens, jobId);
}

export function livenessFromInspection(inspection, jobId) {
  if (!inspection.exists) {
    return false;
  }
  if (!inspection.commandLine) {
    return null;
  }
  return isJobCommandLine(inspection.commandLine, jobId);
}

async function settleInspection(inspect, pid) {
  try {
    return await inspect(pid);
  } catch (error) {
    return { error };
  }
}

function livenessFromSettled(settled, jobId) {
  return settled.error ? null : livenessFromInspection(settled, jobId);
}

export function createLivenessProbe({
  inspect = inspectProcess,
  ttlMs = DEFAULT_CACHE_TTL_MS,
  now = Date.now,
} = {}) {
  const cache = new Map();

  function dropExpired(currentTime) {
    for (const [pid, entry] of cache) {
      if (currentTime - entry.at >= ttlMs) {
        cache.delete(pid);
      }
    }
  }

  function cachedInspection(pid) {
    const currentTime = now();
    dropExpired(currentTime);
    if (!cache.has(pid)) {
      cache.set(pid, { at: currentTime, settled: settleInspection(inspect, pid) });
    }
    return cache.get(pid).settled;
  }

  async function probe(job) {
    if (!isValidPid(job.pid)) {
      return null;
    }
    return livenessFromSettled(await cachedInspection(job.pid), job.id);
  }

  async function probeFresh(job) {
    if (!isValidPid(job.pid)) {
      return null;
    }
    cache.delete(job.pid);
    return livenessFromSettled(await cachedInspection(job.pid), job.id);
  }

  return { probe, probeFresh };
}

export async function killIfJobProcess(job, { probe, kill }) {
  if ((await probe.probeFresh(job)) !== true) {
    return false;
  }
  kill(job.pid);
  return true;
}
