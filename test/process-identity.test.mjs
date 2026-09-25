import assert from "node:assert/strict";
import process from "node:process";
import { describe, test } from "node:test";

import {
  createLivenessProbe,
  inspectProcess,
  isJobCommandLine,
  killIfJobProcess,
  livenessFromInspection,
} from "../lib/process-identity.mjs";

const JOB = { id: "task-abc123", status: "running", pid: 4242 };
const WORKER_COMMAND_LINE =
  '"C:\\Program Files\\nodejs\\node.exe" C:\\plugins\\codex\\scripts\\codex-companion.mjs task-worker --cwd C:\\repo --job-id task-abc123';
const FOREIGN_COMMAND_LINE = "C:\\Windows\\System32\\svchost.exe -k netsvcs";

function fakeInspect(result) {
  const calls = [];
  const inspect = async (pid) => {
    calls.push(pid);
    if (result instanceof Error) {
      throw result;
    }
    return result;
  };
  return { inspect, calls };
}

function killSpy() {
  const killed = [];
  return { kill: (pid) => killed.push(pid), killed };
}

function permissionError() {
  return Object.assign(new Error("operation not permitted"), { code: "EPERM" });
}

describe("isJobCommandLine", () => {
  test("accepts the task-worker launched for the same job", () => {
    assert.equal(isJobCommandLine(WORKER_COMMAND_LINE, "task-abc123"), true);
  });

  test("rejects a task-worker launched for another job", () => {
    assert.equal(isJobCommandLine(WORKER_COMMAND_LINE, "task-other"), false);
  });

  test("rejects a job id that only prefixes the real one", () => {
    assert.equal(isJobCommandLine(WORKER_COMMAND_LINE, "task-abc"), false);
  });

  test("accepts --job-id=<id> and quoted arguments", () => {
    assert.equal(isJobCommandLine('node codex-companion.mjs task-worker --job-id="task-abc123"', "task-abc123"), true);
    assert.equal(isJobCommandLine("node codex-companion.mjs task-worker --job-id=task-abc123", "task-abc123"), true);
    assert.equal(isJobCommandLine('node codex-companion.mjs task-worker --job-id "task-abc123"', "task-abc123"), true);
  });

  test("accepts a foreground companion process, which carries no job id", () => {
    assert.equal(isJobCommandLine("node /x/codex-companion.mjs review --cwd /repo", "task-abc123"), true);
  });

  test("rejects an unrelated process", () => {
    assert.equal(isJobCommandLine(FOREIGN_COMMAND_LINE, "task-abc123"), false);
  });
});

describe("livenessFromInspection", () => {
  test("a missing process is dead", () => {
    assert.equal(livenessFromInspection({ exists: false }, JOB.id), false);
  });

  test("an existing process whose command line cannot be read is unknown", () => {
    assert.equal(livenessFromInspection({ exists: true, commandLine: null }, JOB.id), null);
  });
});

describe("createLivenessProbe", () => {
  test("a live PID with a foreign command line is not alive", async () => {
    const { inspect } = fakeInspect({ exists: true, commandLine: FOREIGN_COMMAND_LINE });

    assert.equal(await createLivenessProbe({ inspect }).probe(JOB), false);
  });

  test("the job's own task-worker is alive", async () => {
    const { inspect } = fakeInspect({ exists: true, commandLine: WORKER_COMMAND_LINE });

    assert.equal(await createLivenessProbe({ inspect }).probe(JOB), true);
  });

  test("an EPERM inspection error is unknown, not dead", async () => {
    const { inspect } = fakeInspect(permissionError());

    assert.equal(await createLivenessProbe({ inspect }).probe(JOB), null);
  });

  test("a job without a usable PID is unknown and is never inspected", async () => {
    const { inspect, calls } = fakeInspect({ exists: false });
    const probe = createLivenessProbe({ inspect });

    assert.equal(await probe.probe({ ...JOB, pid: null }), null);
    assert.equal(await probe.probe({ ...JOB, pid: 0 }), null);
    assert.equal(await probe.probe({ ...JOB, pid: -1 }), null);
    assert.deepEqual(calls, []);
  });

  test("reuses an inspection within the TTL and repeats it once expired", async () => {
    let clock = 1_000;
    const { inspect, calls } = fakeInspect({ exists: true, commandLine: WORKER_COMMAND_LINE });
    const probe = createLivenessProbe({ inspect, ttlMs: 5_000, now: () => clock });

    await probe.probe(JOB);
    clock += 4_999;
    await probe.probe(JOB);
    clock += 1;
    await probe.probe(JOB);

    assert.deepEqual(calls, [4242, 4242]);
  });

  test("probeFresh bypasses the cached inspection", async () => {
    const { inspect, calls } = fakeInspect({ exists: true, commandLine: WORKER_COMMAND_LINE });
    const probe = createLivenessProbe({ inspect, now: () => 0 });

    await probe.probe(JOB);
    await probe.probeFresh(JOB);

    assert.deepEqual(calls, [4242, 4242]);
  });
});

describe("killIfJobProcess", () => {
  test("does not kill a live PID whose command line is foreign", async () => {
    const { inspect } = fakeInspect({ exists: true, commandLine: FOREIGN_COMMAND_LINE });
    const spy = killSpy();

    const killed = await killIfJobProcess(JOB, { probe: createLivenessProbe({ inspect }), kill: spy.kill });

    assert.equal(killed, false);
    assert.deepEqual(spy.killed, []);
  });

  test("kills the job's own task-worker", async () => {
    const { inspect } = fakeInspect({ exists: true, commandLine: WORKER_COMMAND_LINE });
    const spy = killSpy();

    const killed = await killIfJobProcess(JOB, { probe: createLivenessProbe({ inspect }), kill: spy.kill });

    assert.equal(killed, true);
    assert.deepEqual(spy.killed, [4242]);
  });

  test("does not kill when the identity is unknown", async () => {
    const { inspect } = fakeInspect(permissionError());
    const spy = killSpy();

    await killIfJobProcess(JOB, { probe: createLivenessProbe({ inspect }), kill: spy.kill });

    assert.deepEqual(spy.killed, []);
  });
});

describe("inspectProcess (real platform lookup)", () => {
  test("reads this test process's own command line", async () => {
    const inspection = await inspectProcess(process.pid);

    assert.equal(inspection.exists, true);
    assert.match(inspection.commandLine, /node/i);
  });

  test("reports a PID that is not running as missing", async () => {
    // Odd PIDs never exist on Windows and this one exceeds Linux pid_max.
    assert.deepEqual(await inspectProcess(99_999_999), { exists: false });
  });
});
