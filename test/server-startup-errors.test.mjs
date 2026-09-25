import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import process from "node:process";
import { after, before, describe, test } from "node:test";

import { SERVER_SCRIPT, createSandbox, sandboxEnv, startServer, stopServer } from "./helpers/server-sandbox.mjs";

const STACK_FRAME_PATTERN = /^\s+at /m;

function runServerScript(sandbox, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER_SCRIPT, ...args], {
      env: sandboxEnv(sandbox),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("the GUI server reports startup errors without a stack trace", () => {
  let sandbox;

  before(() => {
    sandbox = createSandbox();
  });

  after(() => {
    fs.rmSync(sandbox.root, { recursive: true, force: true });
  });

  test("a second server on a busy port exits with code 1 and says the port is already in use", async () => {
    const first = await startServer(sandbox);
    try {
      const busyPort = new URL(first.url).port;

      const second = await runServerScript(sandbox, ["--port", busyPort, "--no-open"]);

      assert.equal(second.code, 1);
      assert.match(second.stderr, /already in use/);
      assert.match(second.stderr, new RegExp(busyPort));
      assert.doesNotMatch(second.stderr, STACK_FRAME_PATTERN);
    } finally {
      await stopServer(first);
    }
  });

  test("an invalid --port exits with code 1 and a one-line message", async () => {
    const result = await runServerScript(sandbox, ["--port", "not-a-port", "--no-open"]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /--port must be an integer/);
    assert.doesNotMatch(result.stderr, STACK_FRAME_PATTERN);
  });
});
