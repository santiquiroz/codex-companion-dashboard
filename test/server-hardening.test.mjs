import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { after, before, describe, test } from "node:test";

import { createServer } from "../bin/codex-dashboard-server.mjs";
import { buildJob, createSandbox, jobTarget, writeStateFixture } from "./helpers/server-sandbox.mjs";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(() => resolve()));
}

function rawRequest(port, { method = "GET", path = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, method, path, headers }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        text += chunk;
      });
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, text }));
    });
    request.once("error", reject);
    request.end(body);
  });
}

function postJsonTo(port, path, body, headers = {}) {
  return rawRequest(port, {
    method: "POST",
    path,
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function inlineBlock(html, tag) {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(html);
  return match[1];
}

function sha256Source(text) {
  return `'sha256-${crypto.createHash("sha256").update(text, "utf8").digest("base64")}'`;
}

describe("the GUI server only answers loopback requests from its own page", () => {
  let sandbox;
  let server;
  let port;

  before(async () => {
    sandbox = createSandbox();
    server = createServer({ baseDirs: [sandbox.baseDir], openBrowser: false, launchBrowser: () => {} });
    port = await listen(server);
  });

  after(async () => {
    await close(server);
    fs.rmSync(sandbox.root, { recursive: true, force: true });
  });

  test("a foreign Host header is rejected with 403 before any job is read", async () => {
    writeStateFixture(sandbox, [buildJob({ id: "secret-1", status: "completed", phase: "done" })]);

    const response = await rawRequest(port, { path: "/api/jobs", headers: { Host: "evil.example" } });

    assert.equal(response.status, 403);
    assert.doesNotMatch(response.text, /secret-1/);
  });

  test("a rebinding Host that keeps the port but not the loopback name is rejected", async () => {
    const response = await rawRequest(port, { path: "/", headers: { Host: `evil.example:${port}` } });

    assert.equal(response.status, 403);
  });

  test("127.0.0.1 and localhost with the listening port are both accepted", async () => {
    const byAddress = await rawRequest(port, { path: "/api/jobs", headers: { Host: `127.0.0.1:${port}` } });
    const byName = await rawRequest(port, { path: "/api/jobs", headers: { Host: `LOCALHOST:${port}` } });

    assert.equal(byAddress.status, 200);
    assert.equal(byName.status, 200);
  });

  test("a POST with a text/plain body is rejected with 415 and leaves the state untouched", async () => {
    const stateText = writeStateFixture(sandbox, [buildJob({ id: "stale-1", status: "running", pid: 99_999_999 })]);

    const response = await rawRequest(port, {
      method: "POST",
      path: "/api/jobs/purge-stale",
      headers: { "Content-Type": "text/plain" },
      body: "{}",
    });

    assert.equal(response.status, 415);
    assert.equal(fs.readFileSync(sandbox.statePath, "utf8"), stateText);
  });

  test("a POST without a Content-Type is rejected with 415", async () => {
    const response = await rawRequest(port, { method: "POST", path: "/api/jobs/purge-stale" });

    assert.equal(response.status, 415);
  });

  test("a POST from a foreign Origin is rejected with 403 and leaves the state untouched", async () => {
    const stateText = writeStateFixture(sandbox, [buildJob({ id: "done-1", status: "completed", phase: "done" })]);

    const response = await postJsonTo(port, "/api/jobs/delete", jobTarget(sandbox, "done-1"), {
      Origin: "http://evil.example",
    });

    assert.equal(response.status, 403);
    assert.equal(fs.readFileSync(sandbox.statePath, "utf8"), stateText);
  });

  test("a POST from the dashboard's own origin with a JSON charset still succeeds", async () => {
    writeStateFixture(sandbox, [buildJob({ id: "done-1", status: "completed", phase: "done" })]);

    const response = await postJsonTo(port, "/api/jobs/delete", jobTarget(sandbox, "done-1"), {
      Origin: `http://localhost:${port}`,
      "Content-Type": "application/json; charset=utf-8",
    });

    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.text).deleted, "done-1");
  });

  test("a legitimate POST for an unknown job still answers 404", async () => {
    writeStateFixture(sandbox, []);

    const response = await postJsonTo(port, "/api/jobs/cancel", jobTarget(sandbox, "missing-1"), {
      Origin: `http://127.0.0.1:${port}`,
    });

    assert.equal(response.status, 404);
  });

  test("the page forbids framing and only runs its own inline script and style", async () => {
    const response = await rawRequest(port, { path: "/" });
    const policy = response.headers["content-security-policy"];

    assert.equal(response.status, 200);
    assert.equal(response.headers["x-frame-options"], "DENY");
    assert.match(policy, /default-src 'none'/);
    assert.match(policy, /frame-ancestors 'none'/);
    assert.match(policy, /connect-src 'self'/);
    assert.ok(policy.includes(`script-src ${sha256Source(inlineBlock(response.text, "script"))}`), policy);
    assert.ok(policy.includes(`style-src ${sha256Source(inlineBlock(response.text, "style"))}`), policy);
  });

  test("API responses forbid framing too", async () => {
    const response = await rawRequest(port, { path: "/api/jobs" });

    assert.equal(response.headers["x-frame-options"], "DENY");
  });
});
