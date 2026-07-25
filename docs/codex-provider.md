# Codex quota provider

The Codex adapter targets `codex-cli 0.145.0`. Its minimal protocol contract
was verified from a locally generated experimental schema:

```powershell
codex app-server generate-json-schema --experimental --out <temporary-folder>
```

The temporary schema is not checked in. In this version,
`account/rateLimits/read` is absent from the stable schema and present only
with `--experimental`. The client therefore initializes once with
`capabilities.experimentalApi: true`, sends the `initialized` notification,
and calls `account/rateLimits/read` with `null` params over newline-delimited
stdio JSON-RPC.

The response requires `rateLimits`. Its `primary` and `secondary` fields are
nullable `RateLimitWindow` values containing `usedPercent`, nullable
`windowDurationMins`, and nullable `resetsAt`. The adapter identifies windows
by duration rather than slot: `300` is **Five hours** and `10080` is
**Weekly**. Unsupported, absent, or incomplete windows are omitted. Invalid
supported windows fail safely instead of inventing values. The v1 adapter
intentionally ignores `rateLimitsByLimitId`.

The app keeps one app-server child alive and reuses it across reads. Request
IDs are correlated, requests have bounded timeouts, stderr capture is bounded
and private, malformed protocol output fails closed, and a later read respawns
after exit. App shutdown disposes the child. Windows command resolution invokes
the native Codex executable directly with `shell: false`; it does not interpolate
user input into a command shell.

Run a sanitized one-shot check with:

```powershell
npm run probe:codex
```

It prints only the shared `QuotaSnapshot`, then disposes the child. It never
prints raw protocol messages, stderr, credentials, configuration, or auth
paths. Do not inspect `~/.codex/auth.json` to diagnose this provider.

Safe renderer failure copy is:

- CLI missing: `Codex CLI was not found. Install it and restart the app.`
- signed out: `Codex is signed out. Run codex login, then refresh.`
- timeout: `Codex did not respond in time.`
- incompatible response: `Codex returned an incompatible rate-limit response.`
- other app-server failure: `Codex app-server could not read usage.`

`app-server` and this method are experimental, version-specific interfaces.
Regenerate and review the schema when upgrading Codex CLI.
