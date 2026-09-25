import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { assertLoopbackRequest, isJsonContentType, isLoopbackHost, isOwnOrigin } from "../lib/loopback-guard.mjs";

const PORT = 4317;

function statusOf(request) {
  try {
    assertLoopbackRequest(request);
    return "allowed";
  } catch (error) {
    return error.statusCode;
  }
}

describe("isLoopbackHost", () => {
  test("accepts the loopback names only with the listening port", () => {
    assert.equal(isLoopbackHost("127.0.0.1:4317", PORT), true);
    assert.equal(isLoopbackHost("localhost:4317", PORT), true);
    assert.equal(isLoopbackHost("localhost:4318", PORT), false);
    assert.equal(isLoopbackHost("localhost", PORT), false);
    assert.equal(isLoopbackHost("evil.example:4317", PORT), false);
    assert.equal(isLoopbackHost(undefined, PORT), false);
  });

  test("accepts a bare loopback name on port 80, where browsers omit the port", () => {
    assert.equal(isLoopbackHost("localhost", 80), true);
    assert.equal(isLoopbackHost("127.0.0.1:80", 80), true);
  });
});

describe("isOwnOrigin", () => {
  test("accepts only http origins of the dashboard itself", () => {
    assert.equal(isOwnOrigin("http://127.0.0.1:4317", PORT), true);
    assert.equal(isOwnOrigin("http://LOCALHOST:4317", PORT), true);
    assert.equal(isOwnOrigin("https://127.0.0.1:4317", PORT), false);
    assert.equal(isOwnOrigin("http://evil.example", PORT), false);
    assert.equal(isOwnOrigin("null", PORT), false);
  });
});

describe("isJsonContentType", () => {
  test("matches the media type and ignores parameters and case", () => {
    assert.equal(isJsonContentType("application/json"), true);
    assert.equal(isJsonContentType("Application/JSON; charset=utf-8"), true);
    assert.equal(isJsonContentType("text/plain"), false);
    assert.equal(isJsonContentType("application/json-patch+json"), false);
    assert.equal(isJsonContentType(undefined), false);
  });
});

describe("assertLoopbackRequest", () => {
  const host = "127.0.0.1:4317";

  test("rejects a foreign host with 403 whatever the method", () => {
    assert.equal(statusOf({ method: "GET", headers: { host: "evil.example" }, port: PORT }), 403);
  });

  test("lets GET through without Origin or Content-Type checks", () => {
    assert.equal(statusOf({ method: "GET", headers: { host, origin: "http://evil.example" }, port: PORT }), "allowed");
  });

  test("checks the Origin before the Content-Type on POST", () => {
    const headers = { host, origin: "http://evil.example", "content-type": "text/plain" };

    assert.equal(statusOf({ method: "POST", headers, port: PORT }), 403);
  });

  test("rejects a non-JSON POST with 415 and accepts a same-origin JSON POST", () => {
    assert.equal(statusOf({ method: "POST", headers: { host, "content-type": "text/plain" }, port: PORT }), 415);
    assert.equal(
      statusOf({
        method: "POST",
        headers: { host, origin: "http://127.0.0.1:4317", "content-type": "application/json" },
        port: PORT,
      }),
      "allowed",
    );
  });
});
