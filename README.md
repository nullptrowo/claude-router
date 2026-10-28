# claude-router

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20Linux%20%7C%20macOS-1f2328)](install.js)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-Opus%205.5%20%2B%201M%20Context-d97757)](files/settings.template.json)

Local smart router, multi-provider OAuth failover pool, cross-model subagents, and live quota statusline for **Claude Code**.

Switch between **Claude Opus 5.5 / Fable 5.1 / Sonnet 5.5 / Haiku 5.5**, **Gemini 4 Argon**, **DeepSeek V4.1 Flash 1017**, and **Kimi K3** directly from `/model` with live `Thought (∴)` streaming, native `/workflows` (`ultracode`), cross-model subagent delegation, and a unified `Claude + AGY` statusline.

![claude-router preview](assets/preview.svg)

---

## Models & Subagents Included

| Model in `/model` | Subagent (`@`) | Provider / Pool | Context | Effort Levels | Quota Cost |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Default (Opus 5.5)** | `opus` | Anthropic Native | `1M` | `low` · `med` · `high` · `xhigh` · `max` | Claude OAuth |
| **Fable 5.1** | `fable` | Anthropic Native | `1M` | `low` · `med` · `high` · `xhigh` · `max` | Claude OAuth |
| **Sonnet 5.5** | `sonnet` | Anthropic Native | `1M` | `low` · `med` · `high` · `xhigh` · `max` | Claude OAuth |
| **Haiku 5.5** | `haiku` | Anthropic Native | `1M` | `low` · `med` · `high` | Claude OAuth |
| **Gemini 4 Argon** | `gemini` | Antigravity CLI (`agy`) | `1M` | `low` · `med` · `high` | AGY OAuth (`0%` Claude) |
| **DeepSeek V4.1 Flash 1017** | `deepseek` | CodeBuddy → Cline → KiloCode | `1M` | `low` · `med` · `high` | Free OAuth Pool (`0%` Claude) |
| **Kimi K3** | `kimi` | CodeBuddy → Cline → KiloCode | `1M` | `low` · `med` · `high` | Free OAuth Pool (`0%` Claude) |

---

## Quick Setup (Step by Step)

### 1. Prerequisites
- **Node.js `22+`** (uses built-in `node:sqlite`)
- **Claude Code CLI** installed and logged in (`claude`)
- **OmniRoute** installed globally:
  ```bash
  npm install -g omniroute
  ```

### 2. Install `claude-router`
Clone the repository and run the installer:
```bash
git clone https://github.com/nullptrowo/claude-router.git
cd claude-router
node install.js
```
**What `node install.js` sets up automatically:**
- Generates `~/.claude/settings.json` with your OS paths, `1M` context, `1h` prompt cache, and `/model` picker entries.
- Installs `~/.claude/statusline.js` and `~/.claude/CLAUDE.md`.
- Installs all hooks in `~/.claude/hooks/` (`smart-router.js`, `session-start.js`, `prompt-guard.js`, `pre-compact.js`, `stop-autosave.js`, `dns-fix.js`).
- Installs the 7 cross-model subagents in `~/.claude/agents/` (`opus`, `fable`, `sonnet`, `haiku`, `gemini`, `deepseek`, `kimi`).
- Patches OmniRoute so **Gemini 4 Argon** streams `Thought (∴)` blocks by default and **CodeBuddy Intl** resolves via Tencent EdgeOne's active CNAME on any network.

### 3. Connect OAuth Accounts (One-Time Setup)
1. Start OmniRoute once if it isn't running yet:
   ```bash
   omniroute serve --no-open
   ```
2. Connect **CodeBuddy Intl** (for free 1M **Kimi K3** & **DeepSeek V4.1**) and **Cline**:
   ```bash
   node connect-oauth-pool.js
   ```
   Open the printed login URLs in your browser to authorize.
3. *(Optional)* Open `http://127.0.0.1:20128` in your browser to connect:
   - **Antigravity CLI (`agy`)** → unlocks **Gemini 4 Argon** and the live `AGY` quota bar *(select **Antigravity CLI (`agy`)**, not the legacy `Antigravity` card, as only the CLI profile advertises `gemini-4-argon-*` in the live catalog)*.
   - **KiloCode (`kilocode`)** → adds backup failover capacity to the free pool.
4. Launch Claude Code:
   ```bash
   claude
   ```
   *(From now on, both `omniroute` `:20128` and `smart-router.js` `:20129` start silently in the background whenever you open `claude` or send a prompt).*

---

## How to Use Every Feature

### 1. Switching Models & Effort (`/model`)
- Run `/model` inside Claude Code:
  - Use **Up / Down (`↑` / `↓`)** to pick between **Opus 5.5**, **Fable 5.1**, **Sonnet 5.5**, **Haiku 5.5**, **Gemini 4 Argon**, **DeepSeek V4.1 Flash 1017**, and **Kimi K3**.
  - Use **Left / Right (`←` / `→`)** to change reasoning effort (`Low`, `Med`, `High`, `xHigh`, `Max`).
- You can switch `/model` in the middle of an ongoing conversation at any time; the router automatically normalizes thinking blocks and signatures across providers.

### 2. Cross-Model Subagents (`Agent` & `@model`)
Every model can spawn subagents on **any other model** (and set a custom `effort` per subagent):
- **Default behavior (protects your quota)**:
  - Standard subagents (`Explore`, `Plan`, `general-purpose`) always inherit the model you currently have selected in `/model`. If you are on **DeepSeek** or **Kimi**, spawning subagents will **never** consume Claude or Gemini quota unless you explicitly ask for them.
- **Delegating across models**:
  - Just ask naturally in your prompt, for example:
    - *"Launch a `deepseek` agent in low effort and a `kimi` agent in high effort to scan the repo in parallel."*
    - *"Use an `opus` agent with max effort to audit the security of this file."*
    - *"Send this to `gemini` and `sonnet` in parallel and compare their solutions."*
  - Or start/message a model agent directly with `@deepseek`, `@kimi`, `@gemini`, `@opus`, `@fable`, `@sonnet`, or `@haiku`.

### 3. `ultracode` (`⚡Ultracode`), `ultrathink` (`✦Ultrathink`) & `/workflows`
- **Keyword Triggers**:
  - Include **`ultracode`** in any prompt (on **any** model) to activate multi-agent workflow orchestration (`⚡Ultracode` badge in the statusline + maximum reasoning effort).
  - Include **`ultrathink`** in any prompt to force maximum deep reasoning (`✦Ultrathink` badge in the statusline).
- **Dynamic Workflows (`/workflows`)**:
  - Works natively on **Claude**, **Gemini 4 Argon**, **DeepSeek V4.1**, and **Kimi K3**.
  - Workflows can even mix models in parallel (e.g. `agent(prompt, { agentType: "deepseek", effort: "low" })` + `agent(prompt, { agentType: "kimi", effort: "high" })`).
  - Use `/workflows` to view live progress of running phases and workers.
- **Rate-Limit Resilience**:
  - During heavy multi-agent workflows (e.g. 8 parallel agents), `smart-router.js` paces concurrent requests (`300ms` stagger), tracks per-provider cooldowns, and automatically runs backoff retry waves (`2.5s` → `5s` → `8s`) if an upstream pool temporarily rate-limits, so long workflows slow down gracefully instead of failing.

### 4. Context Compaction (`/compact`) & Project Memory
- **`/compact` & Auto-Compaction**:
  - Works natively on all 7 models (`1M` `autoCompactWindow`). The router estimates real input tokens on custom pools (`ctx 28.1k (3%)`) and allocates `16k+` output tokens at low latency during compaction so summaries never truncate.
- **Project-Scoped Memory**:
  - Before compaction (`PreCompact`) and when exiting a session (`Stop`), hooks save a snapshot of your active task inside `~/.claude/projects/<slug>/memory` and restore it on `SessionStart` when working inside a project directory (while keeping `$HOME` clean).

### 5. Reading the Statusline & `/usage`
```text
Opus 5.5 High ⚡Ultracode │ 7d ━━━──── 15% 5d1h · AGY 75% │ 5h ━────── 2% 1h54m · AGY 12% │ cache 92.4% ttl 58m │ ctx 45.2k (5%) 4t
```
- **Model + Effort + Mode**: Shows active model, effort color (`Low` / `Med` / `High` / `xHigh` / `Max`), and `⚡Ultracode` or `✦Ultrathink` when active.
- **`7d` & `5h`**: Your real-time **Claude OAuth** weekly and 5-hour usage percentages and reset countdowns, side-by-side with your **Google Antigravity (`AGY`)** quota.
- **`cache` & `ttl`**: Prompt cache hit rate (`%`) and remaining minutes on your 1-hour prompt cache (`ttl 60m`).
- **`ctx`**: Active context window tokens, percentage of the `1M` window, and turn count (`t`).
- **`/usage` command**: Also injects the live **Gemini 4 Argon (AGY 5x)** progress bar directly into Claude Code's native `/usage` modal.

---

## Architecture Overview

| Component | Location | Role |
| :--- | :--- | :--- |
| **`smart-router.js`** | `~/.claude/hooks/smart-router.js` (`:20129`) | Intercepts `/v1/messages`, routes custom models to `:20128` and native Claude to `api.anthropic.com`, injects `Workflow` DSL & `StructuredOutput` compatibility, paces parallel subagents, and merges `AGY` quota into `/api/oauth/usage`. |
| **`omniroute`** | Global daemon (`:20128`) | Manages OAuth tokens (`agy`, `codebuddy-intl`, `cline`, `kilocode`) and protocol translation. |
| **`agents/*.md`** | `~/.claude/agents/*.md` | Native subagent definitions (`opus`, `fable`, `sonnet`, `haiku`, `gemini`, `deepseek`, `kimi`) enabling cross-model delegation. |
| **`prompt-guard.js`** | `~/.claude/hooks/prompt-guard.js` | Auto-heals `:20129` on every prompt, warns before breaking a warm 1h cache, and triggers `ultracode` / `ultrathink`. |
| **`session-start.js`** | `~/.claude/hooks/session-start.js` | Starts `:20128` (with `dns-fix.js`) and `:20129` silently on startup and restores project memory. |
| **`pre-compact.js` / `stop-autosave.js`** | `~/.claude/hooks/` | Snapshots session progress to project memory before compaction and on exit. |

## License

[MIT](LICENSE)
