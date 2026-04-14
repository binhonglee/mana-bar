# Changelog

## [0.0.4] - 2026-04-13
### Added
- **Kiro provider** — Tracks Kiro usage via CLI SQLite DB or IDE auth token, querying the CodeWhisperer usage API for credit consumption and plan limits.

### Changed
- **Copilot providers** — Deduplicated by account key to avoid showing duplicate entries when both VS Code Copilot and Copilot CLI are enabled.
- **Service ordering** — Service descriptors now sorted alphabetically by name in the UI.
- **Dashboard** — Refined card layout spacing for a more compact appearance.

### Fixed
- **Cursor** — Correctly uses critical percentage for `totalUsed` when `hasAutoSpillover` is enabled.

## [0.0.3] - 2026-03-31
### Added
- **Outage tracking and reporting** — Fetches open outage issues from the GitHub status repo, probes Claude/Codex models, and lets users report outages. The dashboard Status tab shows active outages with verification badges; the sidebar and status bar show outage indicators; cards expose a “Report outage” action; new command `manaBar.reportOutage`.
- **Copilot CLI provider** — Tracks GitHub Copilot CLI usage alongside VS Code Copilot: auth via macOS keychain, Linux `secret-tool`, or `hosts.json`; quota from the GitHub Copilot API; outage detection aligned with other providers. New setting `manaBar.copilotCliModels` for which models to probe during outage checks.
- **Copilot CLI token caching** — After a successful keychain (or fallback) read, the OAuth token is stored in VS Code `SecretStorage` so repeated usage polls do not re-prompt the macOS keychain.
- **Cursor provider** — Usage from Cursor dashboard APIs, with local auth discovery from Cursor’s `state.vscdb` (and optional env overrides documented in the README).
- **Dashboard UX** — When the “time until quota reset” countdown hits zero, the dashboard refreshes automatically and the polling timer resets so the next refresh follows the normal interval.
- **Development** — Script to manually exercise Gemini provider quota discovery and fetching.

### Changed
- **Settings** — Disabling a service clears its cached usage immediately so stale numbers do not linger in the UI.

### Fixed
- **Gemini** — Invalid or unusable reset times are handled safely (provider and shared utilities).
- **UI** — Progress blocks clamp percentage values so block counts stay valid.
- **Codex probes** — Probes pass `--skip-git-repo-check` where appropriate.
- **Outage reporting** — When several models are down and the user chooses “Report all,” a single service-wide issue is opened instead of multiple duplicates; existing service-wide outages are considered before filing model-specific reports.
