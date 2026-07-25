const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  installClaudeStatusLine,
} = require("../dist/main/providers/claude-installer.js");

function fingerprint(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function main() {
  const profile = process.env.USERPROFILE;
  const livePath = profile
    ? path.join(profile, ".claude", "settings.json")
    : null;
  if (!livePath) {
    process.stdout.write("Live settings unavailable; isolated check skipped.\n");
    return;
  }

  let beforeBytes;
  let beforeStat;
  try {
    [beforeBytes, beforeStat] = await Promise.all([
      fs.promises.readFile(livePath),
      fs.promises.stat(livePath),
    ]);
  } catch {
    process.stdout.write("Live settings unavailable; isolated check skipped.\n");
    return;
  }

  const beforeHash = fingerprint(beforeBytes);
  const directory = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "aum-live-settings-copy-"),
  );
  try {
    const copyPath = path.join(directory, "settings.json");
    await fs.promises.writeFile(copyPath, beforeBytes);
    const deploymentRoot = path.join(directory, "dist-tools");
    const statuslinePath = path.join(
      deploymentRoot,
      "scripts",
      "statusline.js",
    );
    const dependencyPath = path.join(
      deploymentRoot,
      "src",
      "shared",
      "claude-cache.js",
    );
    await Promise.all([
      fs.promises.mkdir(path.dirname(statuslinePath), { recursive: true }),
      fs.promises.mkdir(path.dirname(dependencyPath), { recursive: true }),
    ]);
    await Promise.all([
      fs.promises.writeFile(statuslinePath, "// isolated fixture\n"),
      fs.promises.writeFile(dependencyPath, "// isolated fixture\n"),
    ]);
    const result = await installClaudeStatusLine({
      settingsPath: copyPath,
      compiledStatusLinePath: statuslinePath,
    });

    if (result.status === "installed") {
      const backup = await fs.promises.readFile(result.backupPath);
      if (!backup.equals(beforeBytes)) {
        throw new Error("Isolated installer backup mismatch.");
      }
      const updated = await fs.promises.readFile(copyPath, "utf8");
      if (!updated.includes('"statusLine"')) {
        throw new Error("Isolated installer did not add statusLine.");
      }
    } else if (result.status !== "statusline-conflict") {
      throw new Error("Isolated installer verification failed.");
    }
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }

  const [afterBytes, afterStat] = await Promise.all([
    fs.promises.readFile(livePath),
    fs.promises.stat(livePath),
  ]);
  if (
    fingerprint(afterBytes) !== beforeHash ||
    afterStat.mtimeMs !== beforeStat.mtimeMs
  ) {
    throw new Error("Live Claude settings changed during verification.");
  }
  process.stdout.write(
    "Isolated installer check passed; live settings hash and mtime unchanged.\n",
  );
}

main().catch(() => {
  process.stderr.write("Claude installer verification failed safely.\n");
  process.exitCode = 1;
});
