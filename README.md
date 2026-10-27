# claude-router

Local smart router, multi-model pool, and project-scoped session hooks for Claude Code.

## Features
- **Models (`/model`)**: `Gemini 4 Argon`, `DeepSeek V4.1 Flash 1017`, `Kimi K3`, plus native Claude models.
- **Reasoning (`∴`) & Effort (`/effort`)**: Full `low` / `medium` / `high` / `xhigh` / `max` support with live thinking blocks across all models.
- **Priority Failover Pool**: Routes `DeepSeek V4.1` and `Kimi K3` through `Cline` -> `CodeBuddy Intl` -> `KiloCode`.
- **1h Prompt Cache & Project Memory**: `1h` prompt caching enabled; auto-snapshots isolated per project (`~/.claude/projects/<slug>/memory`), clean start in `$HOME`.
- **Quota Tracking**: Live `5h` and `7d` usage for Claude and Google Antigravity in the statusline and `/usage`.
- **Background Auto-Start**: Starts `omniroute` (`:20128`) and `smart-router.js` (`:20129`) silently on `claude` launch (hidden on Windows, detached on Linux/macOS).

## Install (Windows & Linux)

```bash
npm install -g omniroute
git clone https://github.com/nullptrowo/claude-router.git
cd claude-router
node install.js
```

## Connect Providers

1. Start OmniRoute once:
   ```bash
   omniroute serve --no-open
   ```
2. Connect **Cline** and **CodeBuddy Intl**:
   ```bash
   node connect-oauth-pool.js
   ```
3. (Optional) Open `http://127.0.0.1:20128` to connect **Google Antigravity (`agy`)** and **KiloCode (`kilocode`)**.
4. Run `claude`.
