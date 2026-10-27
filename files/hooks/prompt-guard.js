const fs = require('fs');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(raw || '{}');
    const tp = data.transcript_path;
    const prompt = (data.prompt || '').trim();

    if (!tp || !fs.existsSync(tp) || prompt.startsWith('/') || prompt.toLowerCase().includes('force')) {
      process.exit(0);
    }

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
  } catch {}
  process.exit(0);
});
