import { HttpError } from "./job-target.mjs";

const LOOPBACK_NAMES = ["127.0.0.1", "localhost"];
const DEFAULT_HTTP_PORT = 80;
const JSON_MEDIA_TYPE = "application/json";

function loopbackAuthorities(port) {
  const withPort = LOOPBACK_NAMES.map((name) => `${name}:${port}`);
  // Browsers drop the default port from Host and Origin.
  return port === DEFAULT_HTTP_PORT ? [...withPort, ...LOOPBACK_NAMES] : withPort;
}

export function isLoopbackHost(host, port) {
  return typeof host === "string" && loopbackAuthorities(port).includes(host.toLowerCase());
}

export function isOwnOrigin(origin, port) {
  const normalized = origin.toLowerCase();
  return loopbackAuthorities(port).some((authority) => normalized === `http://${authority}`);
}

export function isJsonContentType(contentType) {
  const mediaType = (contentType ?? "").split(";")[0].trim().toLowerCase();
  return mediaType === JSON_MEDIA_TYPE;
}

function assertTrustedPost(headers, port) {
  if (headers.origin !== undefined && !isOwnOrigin(headers.origin, port)) {
    throw new HttpError(403, "Cross-origin requests are not allowed.");
  }
  if (!isJsonContentType(headers["content-type"])) {
    throw new HttpError(415, "Content-Type must be application/json.");
  }
}

export function assertLoopbackRequest({ method, headers, port }) {
  if (!isLoopbackHost(headers.host, port)) {
    throw new HttpError(403, "Host must be 127.0.0.1 or localhost on the dashboard's port.");
  }
  if (method === "POST") {
    assertTrustedPost(headers, port);
  }
}
