const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function hash(filePath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}

function invoke(scriptPath, directory, input) {
  const result = spawnSync(process.execPath, [scriptPath], {
    input,
    encoding: "utf8",
    env: { ...process.env, AUM_DATA_DIR: directory },
    windowsHide: true,
    timeout: 5_000,
  });
  if (result.error || result.status !== 0 || result.stderr !== "") {
    throw new Error("Statusline CLI did not fail safely.");
  }
  return result.stdout.trim();
}

function main() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "aum-statusline-cli-"),
  );
  try {
    const scriptPath = path.join(
      __dirname,
      "..",
      "dist-tools",
      "scripts",
      "statusline.js",
    );
    const fixture = fs.readFileSync(
      path.join(
        __dirname,
        "..",
        "fixtures",
        "claude-statusline-valid.json",
      ),
      "utf8",
    );
    const valid = invoke(scriptPath, directory, fixture);
    const cachePath = path.join(directory, "claude-quota-v1.json");
    const before = hash(cachePath);
    const absent = invoke(scriptPath, directory, '{"model":"claude"}');
    const afterAbsent = hash(cachePath);
    const malformed = invoke(scriptPath, directory, "{");
    const afterMalformed = hash(cachePath);
    const oversized = invoke(
      scriptPath,
      directory,
      Buffer.alloc(1024 * 1024 + 1, 0x61),
    );
    const afterOversized = hash(cachePath);
    if (
      before !== afterAbsent ||
      before !== afterMalformed ||
      before !== afterOversized
    ) {
      throw new Error("Statusline CLI clobbered its last valid cache.");
    }
    process.stdout.write(
      `${JSON.stringify({
        valid,
        absent,
        malformed,
        oversized,
        cachePreserved: true,
      })}\n`,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

try {
  main();
} catch {
  process.stderr.write("Statusline CLI verification failed safely.\n");
  process.exitCode = 1;
}
