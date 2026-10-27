# claude-router

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20Linux%20%7C%20macOS-1f2328)](install.js)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-1M%20Context%20%2B%20Multi--Model-d97757)](files/settings.template.json)

Zero-overhead local smart router, priority failover pool, and project-scoped memory hooks for **Claude Code**.

Switch between **Claude Opus 4.7 / Sonnet 4.6**, **Gemini 4 Argon**, **DeepSeek V4.1 Flash**, and **Kimi K3** directly from `/model` with live `Thought (∴)` streaming, full `/effort` (`low` to `max`), and a unified `Claude + AGY` quota statusline.

```text
> /model
  1. Default (Opus 4.7 · 1M context)
  2. Sonnet 4.6 (1M context)
  3. Gemini 4 Argon          [Google Antigravity · CLI Pool · 1M]
  4. DeepSeek V4.1 Flash     [Cline -> CodeBuddy -> KiloCode · 256K]
  5. Kimi K3                 [Cline -> CodeBuddy -> KiloCode · 256K]

∴ Thought for 4s (ctrl+o to expand)
  Analyzing packet simulation and movement prediction constraints...

Opus 4.7 | 📁 project (main*) | Ctx: 14% | 5h: 18% (3h12m) | 7d: 41% | AGY 5h: 9%
```

## Highlights

- **Native `/model` & `/effort` Controls**: Use `low`, `medium`, `high`, `xhigh`, and `max` effort across Claude, Gemini 4 Argon, DeepSeek V4.1, and Kimi K3 without restarting Claude Code.
- **Visible `Thought (∴)` Streaming**: Translates reasoning blocks (`thinking_delta`) and thinking budgets across Anthropic, OpenAI-compatible, and Google Antigravity endpoints.
- **Priority OAuth Failover Pool**: Routes `DeepSeek V4.1` and `Kimi K3` through `Cline` -> `CodeBuddy Intl` -> `KiloCode` with automatic fallback on rate limits.
- **Dual Quota Statusline & `/usage`**: Real-time `5h` and `7d` quota tracking for both Anthropic OAuth and Google Antigravity (`AGY`) in the bottom bar and `/usage`.
- **1M Context + 1h Prompt Cache**: Unlocks full `1M` context capacity with `ENABLE_PROMPT_CACHING_1H` enabled by default.
- **Project-Scoped Memory Hooks**: Snapshots active task state before compaction (`PreCompact`) and on exit (`Stop`) inside `~/.claude/projects/<slug>/memory`. Starts 100% clean in `$HOME`.
- **Silent Auto-Start**: Launches `omniroute` (`:20128`) and `smart-router.js` (`:20129`) automatically in the background when `claude` starts (`windowsHide: true` on Windows, detached daemon on Linux/macOS).

## Architecture

| Port / Hook | Component | Role |
| :--- | :--- | :--- |
| `127.0.0.1:20129` | `smart-router.js` | Intercepts `/v1/messages`, maps `/model` & `/effort`, merges `Claude + AGY` `/api/oauth/usage`, forwards native Claude traffic to `api.anthropic.com` and custom models to `:20128`. |
| `127.0.0.1:20128` | `omniroute` | Manages OAuth pools (`agy`, `cline`, `codebuddy-intl`, `kilocode`) and SSE stream conversion. |
| `SessionStart` | `ensure-omniroute.js` + `session-start.js` | Boots router daemons if offline and injects project memory only when inside a project directory. |
| `PreCompact` / `Stop` | `pre-compact.js` + `stop-autosave.js` | Saves active state before context compaction and on session stop. |

## Quickstart (Windows / Linux / macOS)

```bash
npm install -g omniroute
git clone https://github.com/nullptrowo/claude-router.git
cd claude-router
node install.js
```

## Connect OAuth Providers

1. Start OmniRoute once:
   ```bash
   omniroute serve --no-open
   ```
2. Authenticate **Cline** and **CodeBuddy Intl** (headless OAuth helper):
   ```bash
   node connect-oauth-pool.js
   ```
3. *(Optional)* Open `http://127.0.0.1:20128` to connect **Google Antigravity (`agy`)** and **KiloCode (`kilocode`)**.
4. Run `claude`.

## License

[MIT](LICENSE)
