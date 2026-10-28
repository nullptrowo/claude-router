const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
const HOOKS_DIR = path.join(CLAUDE_DIR, 'hooks');
const AGENTS_DIR = path.join(CLAUDE_DIR, 'agents');
const SRC_DIR = path.join(__dirname, 'files');

fs.mkdirSync(HOOKS_DIR, { recursive: true });
fs.mkdirSync(AGENTS_DIR, { recursive: true });

// 1. Copy CLAUDE.md, statusline.js, hooks/*.js, and agents/*.md
fs.copyFileSync(path.join(SRC_DIR, 'CLAUDE.md'), path.join(CLAUDE_DIR, 'CLAUDE.md'));
fs.copyFileSync(path.join(SRC_DIR, 'statusline.js'), path.join(CLAUDE_DIR, 'statusline.js'));

for (const h of ['smart-router.js', 'session-start.js', 'stop-autosave.js', 'pre-compact.js', 'prompt-guard.js']) {
  fs.copyFileSync(path.join(SRC_DIR, 'hooks', h), path.join(HOOKS_DIR, h));
}

const srcAgentsDir = path.join(SRC_DIR, 'agents');
if (fs.existsSync(srcAgentsDir)) {
  for (const a of fs.readdirSync(srcAgentsDir).filter(f => f.endsWith('.md'))) {
    fs.copyFileSync(path.join(srcAgentsDir, a), path.join(AGENTS_DIR, a));
  }
}

// 2. Generate settings.json with dynamic cross-platform paths
const claudePosix = CLAUDE_DIR.replace(/\\/g, '/');
const template = fs.readFileSync(path.join(SRC_DIR, 'settings.template.json'), 'utf8');
const rendered = template.replace(/__CLAUDE_DIR__/g, claudePosix);
fs.writeFileSync(path.join(CLAUDE_DIR, 'settings.json'), rendered, 'utf8');

// 3. Patch OmniRoute's Gemini 4 Argon includeThoughts default (if OmniRoute is installed)
function patchOmniRouteThoughts() {
  const roots = [
    path.join(HOME, 'AppData', 'Roaming', 'npm', 'node_modules', 'omniroute'),
    '/usr/local/lib/node_modules/omniroute',
    '/usr/lib/node_modules/omniroute'
  ];
  try {
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const npmRoot = execFileSync(npmCmd, ['root', '-g'], { encoding: 'utf8', timeout: 3000 }).trim();
    roots.unshift(path.join(npmRoot, 'omniroute'));
  } catch {}

  const omniDir = roots.find(r => fs.existsSync(r));
  if (!omniDir) return 0;

  const target = '(!0===n.includeThoughts||!0===n.include_thoughts)&&(o.includeThoughts=!0)';
  const replacement = '(!1!==n.includeThoughts&&!1!==n.include_thoughts)&&(o.includeThoughts=!0)';
  let patched = 0;

  function walk(dir) {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory() && f.name !== 'node_modules') walk(p);
      else if (f.isFile() && /\.(js|mjs|ts)$/.test(f.name)) {
        try {
          const txt = fs.readFileSync(p, 'utf8');
          if (txt.includes(target)) {
            fs.writeFileSync(p, txt.split(target).join(replacement), 'utf8');
            patched++;
          }
        } catch {}
      }
    }
  }
  const distDir = path.join(omniDir, 'dist');
  if (fs.existsSync(distDir)) walk(distDir);
  return patched;
}

const patchedChunks = patchOmniRouteThoughts();

console.log('✓ Claude Code Smart Setup installed in:', CLAUDE_DIR);
if (patchedChunks > 0) {
  console.log(`✓ Patched ${patchedChunks} OmniRoute chunks for Gemini 4 Argon thoughts.`);
}
console.log('✓ Next steps on a new PC:');
console.log('  1. npm install -g omniroute');
console.log('  2. node connect-oauth-pool.js   (connects Cline + CodeBuddy Intl)');
console.log('  3. Run: claude');
