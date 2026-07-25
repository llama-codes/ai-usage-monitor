# Claude quota provider

Claude Code supplies quota through its command statusline JSON. The hook reads
stdin, prints a compact line on every path, and exits successfully. It never
uses network, token, OAuth, or credential files.

When `rate_limits` is present, the hook validates `five_hour` and `seven_day`.
Each window contains `used_percentage` from 0 through 100 and `resets_at` as
Unix seconds. The cache stores used percentage so later warning thresholds can
use the same direction as Codex. The visible remaining value is
`100 - usedPercent`.

Both hook and Electron resolve this cache:

```text
%LOCALAPPDATA%\AIUsageMonitor\claude-quota-v1.json
```

Tests may set `AUM_DATA_DIR` to an isolated directory. Cache v1 is:

```json
{
  "version": 1,
  "capturedAt": 1799999900,
  "fiveHour": {
    "usedPercent": 54,
    "resetsAt": 1800000000
  },
  "sevenDay": {
    "usedPercent": 12,
    "resetsAt": 1800604800
  }
}
```

At least one window is required. The hook writes a unique same-directory
temporary file and atomically renames it. Missing `rate_limits` is expected
before the first Claude API response and does not erase an earlier cache.
Malformed input also leaves the earlier cache intact.
Input larger than 1 MiB is drained without buffering, prints
`Claude usage unavailable`, exits successfully, and leaves the cache intact.

The Electron reader reports:

- `connected` for a valid cache;
- `no-data-yet` when no cache exists;
- `error` for unreadable, corrupt, or incompatible cache.

It carries the cache's `capturedAt` without applying a stale threshold. Values
freeze when no live Claude Code event invokes the statusline, so Step 6 must
render cache age and freshness truthfully.

Run the fixture-only probe with:

```powershell
npm run probe:claude
```

The probe creates a temporary directory, runs the hook against the checked-in
fixture, reads the result through the provider, prints only the shared
snapshot, and removes the directory.

## Installer safety

The installer accepts explicit settings and compiled statusline paths. It
parses JSON or JSONC and refuses an invalid root or any existing `statusLine`.
It preserves all existing bytes around one top-level insertion, including
comments, indentation, CRLF, and trailing newline. Before changing settings it
creates an exact sibling backup:

```text
settings.json.ai-usage-monitor.bak
```

An existing backup stops installation. The updated settings are written to a
unique same-directory temporary file and atomically renamed. A failed write or
rename leaves the original settings intact. The exact backup bytes retain the
source settings file mode. No hooks, permissions, model, plugins, or other
keys are edited.

The configured command is `node "<absolute compiled path>"`. Quoting supports
spaces and works when Claude Code launches the command through Git Bash or
PowerShell. Node must be available on `PATH`.

The compiled path must be on the real filesystem. An `app.asar` path is
rejected because an external Node process cannot reliably execute an
ASAR-internal entrypoint. Paths containing `"`, `$`, backtick, or a newline are
also rejected before any backup or write so Git Bash and PowerShell cannot
interpolate the generated command. The installer verifies the entrypoint and
its compiled cache dependency are regular files. A valid deployment therefore
preserves this complete relative layout:

```text
dist-tools/
├── scripts/
│   └── statusline.js
└── src/
    └── shared/
        └── claude-cache.js
```

Packaging these files inside `app.asar` is build evidence only; it is not a
deployable statusline command. Before live activation, Step 8 must copy or
extract the complete compiled layout into an app-owned real-filesystem
directory and pass that external `statusline.js` path to the installer.

The CLI intentionally requires both paths:

```powershell
npm run claude:install -- --settings <copy> --statusline <compiled-js>
```

Do not point it at live settings until the user explicitly authorizes that
write. `npm run verify:claude-installer` operates only on a temporary copy and
proves the live file's hash and modification time are unchanged.
