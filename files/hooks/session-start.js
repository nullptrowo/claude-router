const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync, spawn } = require('child_process');

function resolveProjectMemoryDir(data) {
  const cwd = path.resolve(data?.cwd || process.cwd());
  const home = path.resolve(os.homedir());
  const genericDirs = new Set([
    home.toLowerCase(),
    path.join(home, 'Documents').toLowerCase(),
    path.join(home, 'Desktop').toLowerCase(),
    path.join(home, 'Downloads').toLowerCase(),
    'c:\\windows\\system32',
    '/root',
    '/tmp'
  ]);
  if (genericDirs.has(cwd.toLowerCase())) {
    return null;
  }
  if (data?.transcript_path && data.transcript_path.includes(path.join('.claude', 'projects'))) {
    return path.join(path.dirname(data.transcript_path), 'memory');
  }
  const slug = cwd.replace(/[:\\/]/g, '-');
  return path.join(home, '.claude', 'projects', slug, 'memory');
}

function findOmniRouteBin() {
  const candidates = [
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', 'omniroute', 'bin', 'omniroute.mjs'),
    '/usr/local/lib/node_modules/omniroute/bin/omniroute.mjs',
    '/usr/lib/node_modules/omniroute/bin/omniroute.mjs'
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  try {
    const npmRoot = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['root', '-g'], { encoding: 'utf8', timeout: 2000 }).trim();
    const p = path.join(npmRoot, 'omniroute', 'bin', 'omniroute.mjs');
    if (fs.existsSync(p)) return p;
  } catch {}
  return null;
}

function spawnDetachedHidden(scriptPath, args = []) {
  try {
    const dnsFix = path.join(os.homedir(), '.claude', 'hooks', 'dns-fix.js');
    const nodeArgs = fs.existsSync(dnsFix)
      ? ['--require', dnsFix, scriptPath, ...args]
      : [scriptPath, ...args];

    if (process.platform === 'win32') {
      // Use wscript.exe (GUI subsystem) + WScript.Shell.Run(..., 0, False) so Windows 11
      // Default Terminal (WindowsTerminal.exe) never pops up a visible console window.
      const vbsPath = path.join(os.homedir(), '.claude', 'hooks', 'launch-hidden.vbs');
      const vbsCode = 'Set sh = CreateObject("WScript.Shell")\r\n' +
        'Dim args()\r\n' +
        'ReDim args(WScript.Arguments.Count - 1)\r\n' +
        'For i = 0 To WScript.Arguments.Count - 1\r\n' +
        '  args(i) = """" & WScript.Arguments(i) & """"\r\n' +
        'Next\r\n' +
        'sh.Run Join(args, " "), 0, False\r\n';
      if (!fs.existsSync(vbsPath)) {
        fs.writeFileSync(vbsPath, vbsCode, 'utf8');
      }
      const child = spawn('wscript.exe', ['//B', '//Nologo', vbsPath, process.execPath, ...nodeArgs], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      });
      child.unref();
    } else {
      const child = spawn(process.execPath, nodeArgs, {
        detached: true,
        stdio: 'ignore'
      });
      child.unref();
    }
  } catch {}
}

function ensureService(url, scriptPath, args = []) {
  return new Promise((resolve) => {
    if (!scriptPath) return resolve(false);
    const req = http.get(url, { timeout: 600 }, () => resolve(true));
    req.on('error', () => {
      spawnDetachedHidden(scriptPath, args);
      resolve(false);
    });
    req.on('timeout', () => {
      req.destroy();
      spawnDetachedHidden(scriptPath, args);
      resolve(false);
    });
  });
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', async () => {
  try {
    const data = JSON.parse(raw || '{}');
    const omniBin = findOmniRouteBin();
    const routerBin = path.join(os.homedir(), '.claude', 'hooks', 'smart-router.js');

    await Promise.all([
      ensureService('http://127.0.0.1:20128/api/monitoring/health', omniBin, ['serve', '--no-open']),
      ensureService('http://127.0.0.1:20129/health', routerBin, [])
    ]);

    const memDir = resolveProjectMemoryDir(data);
    if (!memDir || !fs.existsSync(memDir)) {
      process.exit(0);
    }

    const files = fs.readdirSync(memDir)
      .filter(f => f.endsWith('.md') && f !== 'MEMORY.md')
      .map(f => {
        const full = path.join(memDir, f);
        return { name: f, full, mtime: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 3);

    if (files.length === 0) {
      process.exit(0);
    }

    let injected = '[STATE RESTORED]:\n';
    for (const f of files) {
      const content = fs.readFileSync(f.full, 'utf8');
      injected += `\n--- ${f.name} ---\n${content}\n`;
    }

    const out = {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: injected
      }
    };
    process.stdout.write(JSON.stringify(out));
  } catch (e) {
    process.exit(0);
  }
});
