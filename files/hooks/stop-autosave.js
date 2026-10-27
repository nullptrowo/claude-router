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

    const content = fs.readFileSync(tp, 'utf8');
    const lines = content.split('\n');

    const userPrompts = [];
    const assistantNotes = [];
    const recentTools = [];
    const editedFiles = new Set();

    const startIdx = Math.max(0, lines.length - 250);
    for (let i = startIdx; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      try {
        const entry = JSON.parse(lines[i]);
        const msg = entry.message;
        if (!msg) continue;

        if (entry.type === 'user' && msg.content) {
          if (typeof msg.content === 'string' && !msg.content.startsWith('[STATE')) {
            userPrompts.push(msg.content.slice(0, 300));
          } else if (Array.isArray(msg.content)) {
            for (const b of msg.content) {
              if (b.type === 'text' && b.text && !b.text.startsWith('[STATE')) {
                userPrompts.push(b.text.slice(0, 300));
              }
            }
          }
        } else if (entry.type === 'assistant' && Array.isArray(msg.content)) {
          for (const b of msg.content) {
            if (b.type === 'text' && b.text && b.text.trim().length > 10) {
              assistantNotes.push(b.text.trim());
            } else if (b.type === 'tool_use') {
              const name = b.name || 'tool';
              const inp = b.input || {};
              if (name === 'Bash' && inp.command) {
                recentTools.push(`- Bash: \`${inp.command.replace(/\n/g, ' ').slice(0, 220)}\``);
              } else if ((name === 'Edit' || name === 'Write' || name === 'MultiEdit') && inp.file_path) {
                editedFiles.add(inp.file_path);
                recentTools.push(`- ${name}: \`${inp.file_path}\``);
              } else if (name === 'Read' && inp.file_path) {
                recentTools.push(`- Read: \`${inp.file_path}\``);
              } else {
                recentTools.push(`- ${name}: \`${JSON.stringify(inp).slice(0, 150)}\``);
              }
            }
          }
        }
      } catch {}
    }

    if (editedFiles.size === 0 && recentTools.length === 0 && assistantNotes.length === 0) {
      process.exit(0);
    }

    fs.mkdirSync(memDir, { recursive: true });
    const snapFile = path.join(memDir, 'auto-session-snapshot.md');
    let md = `---\nname: auto-session-snapshot\ndescription: "Last session state (files, commands, replies)"\n---\n\n`;

    if (editedFiles.size > 0) {
      md += `## Modified Files\n`;
      for (const f of editedFiles) md += `- \`${f}\`\n`;
      md += `\n`;
    }

    if (recentTools.length > 0) {
      md += `## Last Commands & Tools\n`;
      md += recentTools.slice(-12).join('\n') + `\n\n`;
    }

    if (userPrompts.length > 0) {
      md += `## Last User Prompts\n`;
      for (const p of userPrompts.slice(-3)) md += `> ${p.replace(/\n/g, ' ')}\n\n`;
    }

    if (assistantNotes.length > 0) {
      md += `## Last Assistant Replies\n`;
      md += assistantNotes.slice(-6).join('\n\n---\n\n') + `\n`;
    }

    fs.writeFileSync(snapFile, md);
  } catch {}
  process.exit(0);
});
