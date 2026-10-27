const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const STATE_FILE = path.join(CLAUDE_DIR, 'argon-state.json');
const SMART_ROUTER_SCRIPT = path.join(CLAUDE_DIR, 'hooks', 'smart-router.js');

function checkPort(port, timeout = 250) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeout);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, '127.0.0.1');
  });
}

async function ensureRouterAlive() {
  if (await checkPort(20129)) return;
  try {
    if (fs.existsSync(SMART_ROUTER_SCRIPT)) {
      const child = spawn(process.execPath, [SMART_ROUTER_SCRIPT], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      });
      child.unref();
      for (let i = 0; i < 8; i++) {
        await new Promise(r => setTimeout(r, 150));
        if (await checkPort(20129)) break;
      }
    }
  } catch {}
}

function updateUltraState(mode) {
  try {
    let cur = {};
    if (fs.existsSync(STATE_FILE)) {
      cur = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
    cur.ultraMode = mode;
    cur.ultraTs = Date.now();
    fs.writeFileSync(STATE_FILE, JSON.stringify(cur));
  } catch {}
}

const WORKFLOW_QUICK_GUIDE = [
  'ULTRACODE MODE ENABLED: Optimize for the most exhaustive, rigorous, and verified engineering solution.',
  'When orchestrating multi-step or parallel work with the Workflow tool, pass plain JavaScript inline via `script` (never TypeScript, never Date.now()/Math.random()/new Date()).',
  'Every Workflow script MUST start with a pure literal `export const meta = { name, description, phases }` and pass zero-arg thunks `() => agent(...)` to `parallel(...)`:',
  '```js',
  'export const meta = {',
  '  name: "deep-task",',
  '  description: "Parallel analysis and verification",',
  '  phases: [{ title: "Analyze" }, { title: "Verify" }]',
  '};',
  'phase("Analyze");',
  'const parts = await parallel([',
  '  () => agent("Analyze module A in detail", { label: "analyze:A", phase: "Analyze" }),',
  '  () => agent("Analyze module B in detail", { label: "analyze:B", phase: "Analyze" })',
  ']);',
  'phase("Verify");',
  'const verified = await agent("Cross-check findings: " + JSON.stringify(parts.filter(Boolean)), { label: "verify:all", phase: "Verify" });',
  'return { parts: parts.filter(Boolean), verified };',
  '```',
  'Keep workflow fan-out focused (2 to 4 subagents) and never pass `model` or `effort` inside `agent()` options so subagents inherit the active session model.'
].join('\n');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', async () => {
  try {
    await ensureRouterAlive();

    const data = JSON.parse(raw || '{}');
    const tp = data.transcript_path;
    const prompt = (data.prompt || '').trim();

    if (tp && fs.existsSync(tp) && !prompt.startsWith('/') && !prompt.toLowerCase().includes('force')) {
      const stat = fs.statSync(tp);
      const idleMinutes = (Date.now() - stat.mtimeMs) / 60000;
      if (stat.size > 80000 && idleMinutes > 60) {
        const out = {
          decision: 'block',
          reason: `Cache expired (${Math.round(idleMinutes)}m idle). Run /clear first to avoid re-caching old history (state is already saved).`
        };
        process.stdout.write(JSON.stringify(out));
        process.exit(0);
      }
    }

    const hasUltracode = /\bultracode\b/i.test(prompt);
    const hasUltrathink = /\bultrathink\b/i.test(prompt);

    if (hasUltracode || hasUltrathink) {
      const mode = hasUltracode ? 'ultracode' : 'ultrathink';
      updateUltraState(mode);
      const banner = hasUltracode
        ? '⚡ Ultracode active · Multi-agent Workflow orchestration & exhaustive verification enabled'
        : '✦ Ultrathink active · Maximum deep reasoning enabled for this turn';
      const directive = hasUltracode
        ? WORKFLOW_QUICK_GUIDE
        : 'ULTRATHINK MODE ENABLED: Perform deep, exhaustive step-by-step reasoning before acting.';

      process.stdout.write(JSON.stringify({
        systemMessage: banner,
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: directive
        }
      }));
      process.exit(0);
    } else if (!prompt.startsWith('/')) {
      updateUltraState(null);
    }
  } catch {}
  process.exit(0);
});
