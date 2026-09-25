import crypto from "node:crypto";

function inlineBlock(html, tag) {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(html);
  if (!match) {
    throw new Error(`The page has no inline <${tag}> block.`);
  }
  return match[1];
}

function sha256Source(text) {
  return `'sha256-${crypto.createHash("sha256").update(text, "utf8").digest("base64")}'`;
}

export function pageContentSecurityPolicy(html) {
  return [
    "default-src 'none'",
    `script-src ${sha256Source(inlineBlock(html, "script"))}`,
    `style-src ${sha256Source(inlineBlock(html, "style"))}`,
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}
