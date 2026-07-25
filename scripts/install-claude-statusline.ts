import path from "node:path";
import { installClaudeStatusLine } from "../src/main/providers/claude-installer";

function readArgument(name: string): string | null {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && value.length > 0 ? value : null;
}

async function main(): Promise<void> {
  const settingsPath = readArgument("--settings");
  const statusLinePath = readArgument("--statusline");
  if (!settingsPath || !statusLinePath) {
    process.stderr.write(
      "Usage: install-claude-statusline --settings <path> --statusline <compiled-js-path>\n",
    );
    process.exitCode = 2;
    return;
  }

  const result = await installClaudeStatusLine({
    settingsPath: path.resolve(settingsPath),
    compiledStatusLinePath: path.resolve(statusLinePath),
  });
  if (result.status === "installed") {
    process.stdout.write("Claude statusline installed; backup created.\n");
    return;
  }
  process.stderr.write(`${result.message}\n`);
  process.exitCode = 1;
}

void main().catch(() => {
  process.stderr.write("Claude statusline installation failed safely.\n");
  process.exitCode = 1;
});
