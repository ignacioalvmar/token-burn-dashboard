# Token Burn — Session Visualizer

A VS Code / Cursor extension that shows a live dashboard of token usage and cost in your AI chat sessions.

## Features

- **Live tab** — KPIs tick up in real time, a 2-minute stacked burn chart, and a streaming event list
- **History tab** — per-message breakdown with in/out tokens, tool counts, and cost
- **Session summary** — totals, top model, heaviest turn, and auto-generated observations
- **Settings tab** — shows which log file is being read, with deep links to VS Code settings
- **Status bar** — flame icon with running token + cost totals; click to open the dashboard
- **Budget alerts** — warns at 75% and 100% of the configured session budget

## How it works

Token Burn reads Cursor / VS Code's chat history from local storage in **read-only** mode. No data leaves your machine.

It probes these paths in order:
- macOS: `~/Library/Application Support/{Cursor,Code,Code - Insiders}/User/globalStorage/state.vscdb`
- Windows: `%APPDATA%/{Cursor,Code,Code - Insiders}/User/globalStorage/state.vscdb`
- Linux: `~/.config/{Cursor,Code,Code - Insiders}/User/globalStorage/state.vscdb`

If no log file is found (or `better-sqlite3` failed to build for your Node version), the dashboard falls back to a synthetic demo stream so you can still see the UI.

## Development

```bash
cd token-burn-extension
npm install
npm run compile
# then in VS Code: F5 to launch the Extension Development Host
```

## Commands

| Command | What it does |
|---|---|
| `Token Burn: Open Dashboard` | Opens the dashboard in an editor tab |
| `Token Burn: Refresh` | Force a re-poll of the log file |
| `Token Burn: Reveal Log File` | Opens the detected log file in your OS file manager |

## Settings

| Key | Default | Description |
|---|---|---|
| `tokenBurn.budget.sessionUSD` | `2.00` | Warn at 75% and 100% |
| `tokenBurn.budget.dailyUSD`   | `20.00` | Soft daily budget |
| `tokenBurn.pollIntervalMs`    | `2500` | How often to re-scan the log |
| `tokenBurn.logPathOverride`   | `""` | Explicit path to `state.vscdb` |
| `tokenBurn.pricing`           | see package.json | Price per 1M tokens, per model |

## Notes

- Cursor's chat log schema has changed across versions. The reader is intentionally defensive: it scans for any JSON blob containing `tokensIn`/`tokensOut` (or `usage.input_tokens`/`output_tokens`) and coerces what it finds.
- If you see demo data when you expect live data, open the Settings tab inside the dashboard to see which path was tried and why it failed.
- Pricing is user-configurable and ships with Anthropic + OpenAI defaults. Add rows for any model id Cursor reports.
