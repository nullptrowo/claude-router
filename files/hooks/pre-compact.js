const fs = require('fs');
const os = require('os');
const path = require('path');

function resolveProjectMemoryDir(data) {
  const cwd = path.resolve(data?.cwd || process.cwd());
  const home = path.resolve(os.homedir());
  const genericDirs = new Set([
    home.toLowerCase(),
    path.join(home, 'Documents').toLowerCase(),
    path.join(home, 'Desktop').toLowerCase(),
    path.join(home, 'Downloads').toLowerCase(),
    'c:\\windows\\system32'
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

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(raw || '{}');
    const tp = data.transcript_path;
    if (!tp || !fs.existsSync(tp)) process.exit(0);

    const memDir = resolveProjectMemoryDir(data);
    if (!memDir) process.exit(0);

    const lines = fs.readFileSync(tp, 'utf8').split('\n');
    const recentNotes = [];
    for (let i = Math.max(0, lines.length - 150); i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      try {
        const entry = JSON.parse(lines[i]);
        const content = entry.message?.content;
        if (entry.type === 'assistant' && Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text' && block.text && block.text.length > 40) {
              recentNotes.push(block.text.trim());
            }
          }
        }
      } catch {}
    }

    const lastFew = recentNotes.slice(-8).join('\n\n---\n\n');
    if (lastFew) {
      fs.mkdirSync(memDir, { recursive: true });
      const snapFile = path.join(memDir, 'auto-session-snapshot.md');
      const header = `---\nname: auto-session-snapshot\ndescription: "Pre-compact state snapshot"\n---\n\n`;
      fs.writeFileSync(snapFile, header + lastFew);
    }
  } catch {}
  process.exit(0);
});
