![Landing](assets/screenshots/landing.png)

Track your AI coding quota across Claude Code, Codex, VSCode Copilot, Copilot CLI, Cursor, Antigravity, Gemini CLI, and Kiro — all from one place inside VS Code-compatible editors like VS Code, Cursor, and Antigravity.

## Why?

Most AI coding tools don't make it easy to check how much quota you have left. You end up guessing, or hunting through web dashboards while you're in the middle of a flow. mana.bar puts all your limits in one glance — right inside your editor.

- Read-only. Never touches your quota.
- Auto-detects credentials you've already set up.
- No accounts, no sign-ups, no telemetry.

## Features

### Dashboard

A full-screen webview with live progress rings, multi-window quota bars, per-model breakdowns, and reset countdowns. Toggle between "used" and "remaining" display modes.

![Dashboard](assets/screenshots/dashboard.png)

### Sidebar

Compact tree view in the activity bar. One-line usage summary per service, expandable for model-level detail.

![Sidebar](assets/screenshots/sidebar.png)

### Status Bar

Always-visible usage at the bottom of your editor. Click to open the dashboard.

![Status Bar](assets/screenshots/status-bar.png)

Hover for a quick summary — choose between a regular table or a monospaced block layout.

| Regular | Monospaced |
|---------|------------|
| ![Regular tooltip](assets/screenshots/hover-standard.png) | ![Monospaced tooltip](assets/screenshots/hover-monospaced.png) |

### Settings

Enable or disable individual services, adjust polling intervals, pick your display mode, and hide services you don't need — all from the settings tab inside the dashboard.

![Settings](assets/screenshots/settings.png)

## Supported Services

| Service | Auth | How it works |
|---------|------|--------------|
| **Antigravity** | `~/.antigravity_cockpit/credentials.json` or cached local quota data | Reads cached quota files when available, otherwise queries Google quota endpoints directly |
| **Claude Code** | Anthropic OAuth (keychain / `.credentials.json`) | Reads 5-hour and 7-day utilization from the Anthropic usage API |
| **Codex** | `~/.codex/auth.json` or OS keychain | Spawns `codex app-server` and queries rate limits via JSON-RPC |
| **Copilot CLI** | `~/.copilot/config.json` plus OS keychain / SecretStorage / `hosts.json` | Reads usage from GitHub Copilot's entitlement API |
| **Cursor** | Cursor local auth DB (`state.vscdb`) or `MANA_BAR_CURSOR_ACCESS_TOKEN` | Calls Cursor dashboard APIs to show monthly spend plus Auto + Composer / API split usage when available |
| **Gemini CLI** | Google OAuth (keychain / `oauth_creds.json`) | Queries `cloudcode-pa.googleapis.com` quota endpoints |
| **Kiro** | Kiro CLI SQLite DB (`kiro-cli/data.sqlite3`) or Kiro IDE (`~/.aws/sso/cache/kiro-auth-token.json`) | Queries the CodeWhisperer usage API for credit consumption and plan limits |
| **VSCode Copilot** | VS Code's built-in Copilot session | Reads usage from GitHub Copilot's entitlement API |

Providers use read-only endpoints and short-lived caching (typically 1-3 minutes).

## Install

[VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=binhonglee.mana-bar) · [Open VSX](https://open-vsx.org/extension/binhonglee/mana-bar)

## Configuration

Use the Settings tab inside the dashboard to configure the extension.

| Setting | Default | Description |
|---------|---------|-------------|
| Polling Interval | 120s | How often to refresh usage data (10s–5min) |
| Display Mode | Remaining | Show quota as "used" or "remaining" |
| Tooltip Layout | Regular | Status bar hover style: table or monospaced blocks |
| Services | All Enabled | Enable/disable each provider individually |
| Hidden Services | none | Hide specific services from the sidebar and status bar |

## License

MIT
