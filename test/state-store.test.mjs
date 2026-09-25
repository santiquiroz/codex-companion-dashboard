import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, test } from "node:test";

import {
  STATE_LOCK_NAME,
  StateLockBusyError,
  acquireStateLock,
  releaseStateLock,
  withStateLock,
  writeStateAtomic,
} from "../lib/state-store.mjs";

const FAST_LOCK = { maxWaitMs: 60, retryDelayMs: 5 };

function ageFile(filePath, milliseconds) {
  const past = new Date(Date.now() - milliseconds);
  fs.utimesSync(filePath, past, past);
}

function renameFailingWith(code, failures) {
  let remaining = failures;
  return (from, to) => {
    if (remaining > 0) {
      remaining -= 1;
      throw Object.assign(new Error(`simulated ${code}`), { code });
    }
    fs.renameSync(from, to);
  };
}

describe("state-store", () => {
  let stateDir;
  let lockFile;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccd-state-store-"));
    lockFile = path.join(stateDir, STATE_LOCK_NAME);
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  test("acquireStateLock creates state.lock holding this process's PID", async () => {
    const acquired = await acquireStateLock(stateDir, FAST_LOCK);

    assert.equal(acquired, lockFile);
    assert.equal(fs.readFileSync(lockFile, "utf8"), String(process.pid));
  });

  test("acquireStateLock gives up with null while another writer holds a fresh lock", async () => {
    fs.writeFileSync(lockFile, "424242");

    const acquired = await acquireStateLock(stateDir, FAST_LOCK);

    assert.equal(acquired, null);
    assert.equal(fs.readFileSync(lockFile, "utf8"), "424242");
  });

  test("acquireStateLock takes over a lock older than the stale threshold", async () => {
    fs.writeFileSync(lockFile, "424242");
    ageFile(lockFile, 10_000);

    const acquired = await acquireStateLock(stateDir, FAST_LOCK);

    assert.equal(acquired, lockFile);
    assert.equal(fs.readFileSync(lockFile, "utf8"), String(process.pid));
  });

  test("releaseStateLock tolerates a lock that is already gone", () => {
    assert.doesNotThrow(() => releaseStateLock(lockFile));
  });

  test("withStateLock releases the lock even when the action throws", async () => {
    await assert.rejects(
      withStateLock(stateDir, () => {
        throw new Error("boom");
      }, FAST_LOCK),
      /boom/,
    );

    assert.equal(fs.existsSync(lockFile), false);
  });

  test("withStateLock rejects with StateLockBusyError without running the action", async () => {
    fs.writeFileSync(lockFile, "424242");
    let ran = false;

    await assert.rejects(
      withStateLock(stateDir, () => {
        ran = true;
      }, FAST_LOCK),
      StateLockBusyError,
    );

    assert.equal(ran, false);
    assert.ok(fs.existsSync(lockFile));
  });

  test("writeStateAtomic replaces the file and leaves no temporary file", async () => {
    const statePath = path.join(stateDir, "state.json");
    fs.writeFileSync(statePath, "old");

    await writeStateAtomic(statePath, { jobs: [{ id: "a" }] });

    assert.deepEqual(JSON.parse(fs.readFileSync(statePath, "utf8")), { jobs: [{ id: "a" }] });
    assert.deepEqual(fs.readdirSync(stateDir), ["state.json"]);
  });

  test("writeStateAtomic retries transient Windows rename errors", async () => {
    const statePath = path.join(stateDir, "state.json");

    await writeStateAtomic(statePath, { jobs: [] }, { renameFile: renameFailingWith("EBUSY", 2) });

    assert.deepEqual(JSON.parse(fs.readFileSync(statePath, "utf8")), { jobs: [] });
  });

  test("writeStateAtomic removes the temporary file and keeps the original when rename fails", async () => {
    const statePath = path.join(stateDir, "state.json");
    fs.writeFileSync(statePath, "original");

    await assert.rejects(
      writeStateAtomic(statePath, { jobs: [] }, { renameFile: renameFailingWith("ENOSPC", 1) }),
      /simulated ENOSPC/,
    );

    assert.equal(fs.readFileSync(statePath, "utf8"), "original");
    assert.deepEqual(fs.readdirSync(stateDir), ["state.json"]);
  });
});
