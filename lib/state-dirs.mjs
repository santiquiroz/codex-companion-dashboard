import os from "node:os";
import path from "node:path";

export function pluginDataStateDir(homeDir = os.homedir()) {
  return path.join(homeDir, ".claude", "plugins", "data", "codex-openai-codex", "state");
}

export function tempStateDir(tempDir = os.tmpdir()) {
  return path.join(tempDir, "codex-companion");
}

export function defaultStateDirs({ homeDir = os.homedir(), tempDir = os.tmpdir() } = {}) {
  return [pluginDataStateDir(homeDir), tempStateDir(tempDir)];
}
