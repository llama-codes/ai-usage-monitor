const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  runStatusLine,
} = require("../dist-tools/scripts/statusline.js");
const {
  ClaudeQuotaProvider,
} = require("../dist/main/providers/claude.js");

async function main() {
  const directory = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "aum-claude-probe-"),
  );
  const cachePath = path.join(directory, "claude-quota-v1.json");
  try {
    const input = await fs.promises.readFile(
      path.join(__dirname, "..", "fixtures", "claude-statusline-valid.json"),
      "utf8",
    );
    const display = await runStatusLine(input, {
      cachePath,
      capturedAt: 1_799_999_900,
    });
    const snapshot = await new ClaudeQuotaProvider(cachePath).readQuota();
    process.stdout.write(
      `${JSON.stringify({ display, snapshot }, null, 2)}\n`,
    );
    if (snapshot.connectionState !== "connected") {
      process.exitCode = 1;
    }
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
}

main().catch(() => {
  process.stderr.write("Claude usage probe failed safely.\n");
  process.exitCode = 1;
});
