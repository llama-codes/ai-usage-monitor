const { spawnSync } = require("node:child_process");
const path = require("node:path");

const executable = path.resolve(
  "out",
  "AIUsageMonitor-win32-x64",
  "AIUsageMonitor.exe",
);
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;

const result = spawnSync(executable, ["--self-test"], {
  cwd: process.cwd(),
  env: environment,
  encoding: "utf8",
  timeout: 30_000,
});

if (result.error) {
  throw result.error;
}
if (result.status !== 0) {
  process.stderr.write(result.stderr || result.stdout);
  throw new Error(`Packaged smoke test exited with ${result.status}`);
}
if (!result.stdout.includes('"event":"self-test-pass"')) {
  process.stderr.write(result.stdout);
  throw new Error("Packaged smoke test did not report self-test-pass");
}
if (
  !result.stdout.includes('"event":"self-test-icon-pass"') ||
  !result.stdout.includes('"packaged":true')
) {
  process.stderr.write(result.stdout);
  throw new Error("Packaged smoke test did not load the checked-in tray icon");
}

process.stdout.write(
  "PASS: packaged app loaded checked-in tray artwork and completed its self-test.\n",
);
