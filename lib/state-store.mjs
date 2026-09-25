import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

// Same protocol and timings as the Codex Companion plugin's state.mjs updateState lock.
export const STATE_LOCK_NAME = "state.lock";
const LOCK_DEFAULTS = { staleMs: 5_000, maxWaitMs: 3_000, retryDelayMs: 20 };
const RENAME_RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const RENAME_ATTEMPTS = 10;
const RENAME_RETRY_DELAY_MS = 25;

export class StateLockBusyError extends Error {
  constructor(lockFile) {
    super("The state file is locked by another writer; try again.");
    this.name = "StateLockBusyError";
    this.lockFile = lockFile;
  }
}

function tryCreateLock(lockFile) {
  try {
    const fd = fs.openSync(lockFile, "wx");
    fs.writeFileSync(fd, String(process.pid));
    fs.closeSync(fd);
    return true;
  } catch (error) {
    if (error.code === "EEXIST") {
      return false;
    }
    throw error;
  }
}

function removeLockIfStale(lockFile, staleMs) {
  try {
    if (Date.now() - fs.statSync(lockFile).mtimeMs > staleMs) {
      fs.unlinkSync(lockFile);
    }
  } catch {
    // Released or taken over by another writer in the meantime; the next attempt decides.
  }
}

export async function acquireStateLock(stateDir, options = {}) {
  const { staleMs, maxWaitMs, retryDelayMs } = { ...LOCK_DEFAULTS, ...options };
  const lockFile = path.join(stateDir, STATE_LOCK_NAME);
  const deadline = Date.now() + maxWaitMs;

  while (!tryCreateLock(lockFile)) {
    removeLockIfStale(lockFile, staleMs);
    if (Date.now() > deadline) {
      return null;
    }
    await delay(retryDelayMs);
  }
  return lockFile;
}

export function releaseStateLock(lockFile) {
  try {
    fs.unlinkSync(lockFile);
  } catch {
    // Already removed by stale-lock recovery elsewhere.
  }
}

export async function withStateLock(stateDir, action, options) {
  const lockFile = await acquireStateLock(stateDir, options);
  if (!lockFile) {
    throw new StateLockBusyError(path.join(stateDir, STATE_LOCK_NAME));
  }

  try {
    return await action();
  } finally {
    releaseStateLock(lockFile);
  }
}

function isRetryableRenameError(error) {
  return Boolean(error) && RENAME_RETRY_CODES.has(error.code);
}

async function renameWithRetries(from, to, renameFile) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      renameFile(from, to);
      return;
    } catch (error) {
      if (!isRetryableRenameError(error) || attempt >= RENAME_ATTEMPTS) {
        throw error;
      }
      await delay(RENAME_RETRY_DELAY_MS);
    }
  }
}

export async function writeStateAtomic(statePath, state, { renameFile = fs.renameSync } = {}) {
  const tempPath = `${statePath}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

  try {
    await renameWithRetries(tempPath, statePath, renameFile);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
}
