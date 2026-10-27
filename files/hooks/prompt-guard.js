const fs = require('fs');
const os = require('os');
const path = require('path');

const STATE_FILE = path.join(os.homedir(), '.claude', 'argon-state.json');

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

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', () => {
  try {
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
        ? '⚡ Ultracode active · Exhaustive multi-step verification & maximum reasoning enabled for this turn'
        : '✦ Ultrathink active · Maximum deep reasoning enabled for this turn';
      const directive = hasUltracode
        ? 'ULTRACODE MODE ENABLED: Optimize for the most exhaustive, rigorous, and complete engineering solution — not the fastest or shortest. Verify every assumption, edge case, and cross-file dependency before finalizing.'
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
