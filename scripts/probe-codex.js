const { CodexQuotaProvider } = require("../dist/main/providers/codex.js");

async function main() {
  const provider = new CodexQuotaProvider();
  try {
    const snapshot = await provider.readQuota();
    process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
    if (snapshot.connectionState !== "connected") {
      process.exitCode = 1;
    }
  } finally {
    provider.dispose();
  }
}

main().catch(() => {
  process.stderr.write("Codex usage probe failed safely.\n");
  process.exitCode = 1;
});
