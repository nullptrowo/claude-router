const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const CACHE_FILE = path.join(HOME, '.claude', 'live-usage-cache.json');
const CREDS_FILE = path.join(HOME, '.claude', '.credentials.json');
const SETTINGS_FILE = path.join(HOME, '.claude', 'settings.json');
const STATE_FILE = path.join(HOME, '.claude', 'argon-state.json');
const CLAUDE_JSON_FILE = path.join(HOME, '.claude.json');
const OMNI_DB = path.join(HOME, '.omniroute', 'storage.sqlite');
const CACHE_TTL_MS = 20000;

// TrueColor ANSI helpers (Zero emojis, official Claude Code TUI palette)
const RST = '\x1b[0m';
const BOLD = '\x1b[1m';
const fg = (r, g, b) => `\x1b[38;2;${r};${g};${b}m`;

const C = {
  coral: fg(217, 119, 87),      // Claude native (#d97757)
  blue: fg(121, 192, 255),      // Gemini Argon (#79c0ff)
  green: fg(63, 185, 80),       // DeepSeek / Healthy (<50%) (#3fb950)
  amber: fg(210, 153, 34),      // Warning (50-80%) (#d29922)
  red: fg(248, 81, 73),         // Critical (>80%) (#f85149)
  purple: fg(210, 168, 255),    // Kimi / Context (#d2a8ff)
  white: fg(230, 237, 243),     // Primary value (#e6edf3)
  muted: fg(139, 148, 158),     // Secondary label (#8b949e)
  dim: fg(72, 79, 88),          // Separator | (#484f58)
  track: fg(48, 54, 61),        // Empty bar track (#30363d)
  // Official Claude Code effort palette (from claude.exe vt[])
  effLow: fg(250, 195, 95),     // warning (rgb 250,195,95)
  effMed: fg(63, 185, 80),      // success (rgb 63,185,80)
  effHigh: fg(106, 155, 204),   // permission (rgb 106,155,204)
  effXHigh: fg(208, 180, 255),  // autoAccept-shimmer (#d0b4ff)
  effUltra: fg(175, 95, 255),   // effortUltra (electric violet)
  rbRed: fg(235, 95, 87),       // rainbow_red
  rbYellow: fg(250, 195, 95),   // rainbow_yellow
  rbViolet: fg(200, 130, 180)   // rainbow_violet
};

function formatEffortBadge(effort) {
  if (effort === 'Max') {
    return `${BOLD}${C.rbRed}M${C.rbYellow}a${C.rbViolet}x${RST}`;
  }
  if (effort === 'xHigh') return `${BOLD}${C.effXHigh}xHigh${RST}`;
  if (effort === 'High') return `${C.effHigh}High${RST}`;
  if (effort === 'Low') return `${C.effLow}Low${RST}`;
  return `${C.effMed}Med${RST}`;
}

function pctColor(pct) {
  const n = Number(pct) || 0;
  if (n >= 80) return C.red;
  if (n >= 50) return C.amber;
  return C.green;
}

function makeGauge(pct, len = 7) {
  if (pct == null || isNaN(pct)) return '';
  const clamped = Math.max(0, Math.min(100, Number(pct)));
  const filled = clamped > 0 ? Math.max(1, Math.round((clamped / 100) * len)) : 0;
  const empty = Math.max(0, len - filled);
  const col = pctColor(clamped);
  return `${col}${'━'.repeat(filled)}${C.track}${'━'.repeat(empty)}${RST}`;
}

function readAgyQuota() {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(OMNI_DB, { readOnly: true });
    const rows = db.prepare('SELECT value FROM key_value WHERE namespace = ?').all('providerLimitsCache');
    db.close();
    let best = null;
    for (const r of rows) {
      const d = JSON.parse(r.value);
      if (d.quotas?.gemini_weekly) {
        if (!best || (d.fetchedAt && d.fetchedAt > best.fetchedAt)) {
          best = d;
        }
      }
    }
    if (best && best.quotas?.gemini_weekly) {
      const w = best.quotas.gemini_weekly;
      const s = best.quotas.gemini_session;
      return {
        sevenDayUsed: +(100 - (w.remainingPercentage ?? 100)).toFixed(1),
        sevenDayResetIso: w.resetAt || null,
        sevenDayResetEpoch: w.resetAt ? Math.floor(new Date(w.resetAt).getTime() / 1000) : null,
        fiveHourUsed: s ? +(100 - (s.remainingPercentage ?? 100)).toFixed(1) : 0,
        fiveHourResetIso: s?.resetAt || null,
        fiveHourResetEpoch: s?.resetAt ? Math.floor(new Date(s.resetAt).getTime() / 1000) : null
      };
    }
  } catch {}
  return null;
}

function syncClaudeJsonUsage(live, agy) {
  try {
    if (!agy) return;
    if (!fs.existsSync(CLAUDE_JSON_FILE)) return;
    const cfg = JSON.parse(fs.readFileSync(CLAUDE_JSON_FILE, 'utf8'));
    if (!cfg.cachedGrowthBookFeatures) cfg.cachedGrowthBookFeatures = {};
    cfg.cachedGrowthBookFeatures.tengu_usage_overage_included_models = [
      'Fable',
      'Fable 5',
      'Fable 5.1',
      'Gemini 4 Argon'
    ];
    cfg.cachedGrowthBookFeatures.tengu_workflows_enabled = true;
    cfg.cachedGrowthBookFeatures.tengu_turtle_carbon = true;

    if (!cfg.cachedUsageUtilization || !cfg.cachedUsageUtilization.utilization) return;
    const u = cfg.cachedUsageUtilization.utilization;
    if (live?.five_hour) u.five_hour = live.five_hour;
    if (live?.seven_day) u.seven_day = live.seven_day;

    if (!Array.isArray(u.limits)) u.limits = [];
    u.limits = u.limits.filter(x => x?.scope?.model?.display_name !== 'Gemini 4 Argon');
    u.limits.push({
      kind: 'weekly_scoped',
      group: 'weekly',
      percent: agy.sevenDayUsed,
      severity: 'normal',
      resets_at: agy.sevenDayResetIso,
      scope: {
        model: {
          id: null,
          display_name: 'Gemini 4 Argon'
        },
        surface: null
      },
      is_active: false
    });

    u.wattle_ember = {
      label: 'Current session (Gemini 4 Argon)',
      utilization: agy.fiveHourUsed,
      resets_at: agy.fiveHourResetIso,
      periods: [
        { starts_at: '2026-10-20T00:00:00Z', ends_at: agy.fiveHourResetIso || '2026-11-01T00:00:00Z' },
        { starts_at: agy.fiveHourResetIso || '2026-11-01T00:00:00Z', ends_at: '2099-01-01T00:00:00Z' }
      ]
    };
    cfg.cachedUsageUtilization.fetchedAtMs = Date.now();
    fs.writeFileSync(CLAUDE_JSON_FILE, JSON.stringify(cfg, null, 2));
  } catch {}
}

function fetchLiveOAuthUsage() {
  return new Promise((resolve) => {
    try {
      if (fs.existsSync(CACHE_FILE)) {
        const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
        if (Date.now() - (cached.ts || 0) < CACHE_TTL_MS && cached.data) {
          return resolve(cached.data);
        }
      }
      if (!fs.existsSync(CREDS_FILE)) return resolve(null);
      const creds = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
      const token = creds.claudeAiOauth?.accessToken;
      if (!token) return resolve(null);

      const req = https.get('https://api.anthropic.com/api/oauth/usage', {
        headers: {
          'Authorization': 'Bearer ' + token,
          'anthropic-beta': 'oauth-2025-04-20',
          'User-Agent': 'claude-code/2.1.305',
          'Content-Type': 'application/json'
        },
        timeout: 1500
      }, (res) => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => {
          try {
            if (res.statusCode === 200) {
              const parsed = JSON.parse(body);
              fs.writeFileSync(CACHE_FILE, JSON.stringify({ ts: Date.now(), data: parsed }));
              return resolve(parsed);
            }
          } catch {}
          try {
            if (fs.existsSync(CACHE_FILE)) {
              return resolve(JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')).data);
            }
          } catch {}
          resolve(null);
        });
      });
      req.on('error', () => {
        try {
          if (fs.existsSync(CACHE_FILE)) {
            return resolve(JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')).data);
          }
        } catch {}
        resolve(null);
      });
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });
    } catch {
      resolve(null);
    }
  });
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', async () => {
  try {
    const data = JSON.parse(raw || '{}');
    const rawModelId = (data.model?.id || data.model?.display_name || '').toLowerCase();
    const isArgon = rawModelId.includes('argon');
    const isDeepSeek = rawModelId.includes('deepseek');
    const isKimi = rawModelId.includes('kimi');
    const isOpus = rawModelId.includes('opus');
    const isSonnet = rawModelId.includes('sonnet');
    const isHaiku = rawModelId.includes('haiku');
    const isFable = rawModelId.includes('fable');
    const isCustomCapped = isArgon || isDeepSeek || isKimi;

    // 1. Read live session effort from Claude Code stdin (`data.effort.level`) first
    //    so session-only `/effort max` updates immediately without relying on settings.json.
    let effRaw = (
      data.effort?.level ||
      (typeof data.effort === 'string' ? data.effort : '') ||
      process.env.CLAUDE_EFFORT ||
      ''
    ).toLowerCase();

    try {
      const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      const modelKey = isArgon ? 'claude-argon-4'
                     : isDeepSeek ? 'claude-deepseek-v4-1-flash-1017'
                     : isKimi ? 'claude-kimi-k3'
                     : isOpus ? 'claude-opus-5-5'
                     : isSonnet ? 'claude-sonnet-5-5'
                     : isHaiku ? 'claude-haiku-5-5'
                     : isFable ? 'claude-fable-5-1'
                     : data.model?.id;
      if (!effRaw) {
        effRaw = (
          (modelKey && s.modelSettings?.[modelKey]?.effortLevel) ||
          s.effortLevel ||
          'medium'
        ).toLowerCase();
      }
    } catch {}

    // Custom models (Argon, DeepSeek, Kimi) support Low / Med / High on their upstream APIs
    if (isCustomCapped && (effRaw === 'max' || effRaw === 'xhigh')) {
      effRaw = 'high';
    }

    let activeEffort = 'Med';
    if (effRaw === 'max') activeEffort = 'Max';
    else if (effRaw === 'xhigh') activeEffort = 'xHigh';
    else if (effRaw === 'high') activeEffort = 'High';
    else if (effRaw === 'low') activeEffort = 'Low';

    // Check if ultracode / ultrathink was triggered
    let ultraBadge = '';
    try {
      if (fs.existsSync(STATE_FILE)) {
        const st = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        if (st.ultraMode && Date.now() - (st.ultraTs || 0) < 600000) {
          ultraBadge = st.ultraMode === 'ultracode'
            ? ` ${BOLD}${C.effUltra}⚡Ultracode${RST}`
            : ` ${BOLD}${C.effUltra}✦Ultrathink${RST}`;
        }
      }
    } catch {}

    const modelColor = isArgon ? C.blue
                     : isDeepSeek ? C.green
                     : isKimi ? C.purple
                     : C.coral;

    const modelName = isArgon ? 'Gemini 4 Argon'
                    : isDeepSeek ? 'DeepSeek V4.1'
                    : isKimi ? 'Kimi K3'
                    : isOpus ? 'Opus 5.5'
                    : isSonnet ? 'Sonnet 5.5'
                    : isHaiku ? 'Haiku 5.5'
                    : isFable ? 'Fable 5.1'
                    : (data.model?.display_name || 'Claude');

    const modelBadge = `${BOLD}${modelColor}${modelName}${RST} ${formatEffortBadge(activeEffort)}${ultraBadge}`;
    const tp = data.transcript_path;

    const live = await fetchLiveOAuthUsage();
    const agy = readAgyQuota();

    const rl = data.rate_limits || {};
    const claude5h = live?.five_hour?.utilization ?? rl.five_hour?.used_percentage;
    const claude5hIso = live?.five_hour?.resets_at;
    const claude5hEpoch = claude5hIso ? Math.floor(new Date(claude5hIso).getTime() / 1000) : rl.five_hour?.resets_at;

    const claude7d = live?.seven_day?.utilization ?? rl.seven_day?.used_percentage;
    const claude7dIso = live?.seven_day?.resets_at;
    const claude7dEpoch = claude7dIso ? Math.floor(new Date(claude7dIso).getTime() / 1000) : rl.seven_day?.resets_at;

    const fmtTimeLeft = (epochSec) => {
      if (!epochSec) return '';
      const diff = Math.max(0, epochSec - Math.floor(Date.now() / 1000));
      const d = Math.floor(diff / 86400);
      const h = Math.floor((diff % 86400) / 3600);
      const m = Math.floor((diff % 3600) / 60);
      if (d > 0) return `${d}d${h}h`;
      if (h > 0) return `${h}h${m}m`;
      return `${m}m`;
    };

    syncClaudeJsonUsage(live, agy);

    const ctxPct = data.context_window?.used_percentage;
    const ctxTokens = data.context_window?.total_input_tokens || data.context_window?.current_usage?.input_tokens;
    const ctxMax = data.context_window?.context_window_size || 1000000;

    let inTok = 0, outTok = 0, cacheWrite = 0, cacheRead = 0, turns = 0, lastCtx = 0, ttlLeftMin = 60;
    if (tp && fs.existsSync(tp)) {
      const stat = fs.statSync(tp);
      const idleMin = (Date.now() - stat.mtimeMs) / 60000;
      ttlLeftMin = Math.max(0, Math.round(60 - idleMin));

      const lines = fs.readFileSync(tp, 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          const u = entry.message?.usage || entry.usage;
          if (u) {
            const i = u.input_tokens || 0;
            const o = u.output_tokens || 0;
            const cw = u.cache_creation_input_tokens || 0;
            const cr = u.cache_read_input_tokens || 0;
            if (i + o + cw + cr > 0) {
              inTok += i;
              outTok += o;
              cacheWrite += cw;
              cacheRead += cr;
              turns++;
              lastCtx = i + cw + cr;
            }
          }
        } catch {}
      }
    }

    const fmtK = (n) => {
      if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
      if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
      return String(n);
    };

    const totalInputAll = inTok + cacheWrite + cacheRead;
    const cacheHitNum = totalInputAll > 0 ? (cacheRead / totalInputAll) * 100 : 0;
    const cacheHitPct = cacheHitNum.toFixed(1);
    const hitColor = cacheHitNum >= 80 ? C.green : cacheHitNum >= 50 ? C.amber : C.muted;
    const ttlStr = ttlLeftMin > 0 ? `${C.green}${ttlLeftMin}m${RST}` : `${C.muted}exp${RST}`;

    const parts = [modelBadge];

    if (isArgon && agy) {
      const c7 = claude7d != null ? ` ${C.dim}·${RST} ${C.coral}Claude${RST} ${pctColor(claude7d)}${Math.round(Number(claude7d))}%${RST}` : '';
      const c5 = claude5h != null ? ` ${C.dim}·${RST} ${C.coral}Claude${RST} ${pctColor(claude5h)}${Math.round(Number(claude5h))}%${RST}` : '';
      const wTime = agy.sevenDayResetEpoch ? ` ${C.muted}${fmtTimeLeft(agy.sevenDayResetEpoch)}${RST}` : '';
      const fTime = agy.fiveHourResetEpoch ? ` ${C.muted}${fmtTimeLeft(agy.fiveHourResetEpoch)}${RST}` : '';
      parts.push(`${C.muted}7d${RST} ${makeGauge(agy.sevenDayUsed, 7)} ${pctColor(agy.sevenDayUsed)}${agy.sevenDayUsed.toFixed(0)}%${RST}${wTime}${c7}`);
      parts.push(`${C.muted}5h${RST} ${makeGauge(agy.fiveHourUsed, 5)} ${pctColor(agy.fiveHourUsed)}${agy.fiveHourUsed.toFixed(0)}%${RST}${fTime}${c5}`);
    } else if (claude7d != null || claude5h != null) {
      if (claude7d != null) {
        const wTime = claude7dEpoch ? ` ${C.muted}${fmtTimeLeft(claude7dEpoch)}${RST}` : '';
        const agy7 = agy ? ` ${C.dim}·${RST} ${C.blue}AGY${RST} ${pctColor(agy.sevenDayUsed)}${agy.sevenDayUsed.toFixed(0)}%${RST}` : '';
        parts.push(`${C.muted}7d${RST} ${makeGauge(claude7d, 7)} ${pctColor(claude7d)}${Math.round(Number(claude7d))}%${RST}${wTime}${agy7}`);
      }
      if (claude5h != null) {
        const fTime = claude5hEpoch ? ` ${C.muted}${fmtTimeLeft(claude5hEpoch)}${RST}` : '';
        const agy5 = agy ? ` ${C.dim}·${RST} ${C.blue}AGY${RST} ${pctColor(agy.fiveHourUsed)}${agy.fiveHourUsed.toFixed(0)}%${RST}` : '';
        parts.push(`${C.muted}5h${RST} ${makeGauge(claude5h, 5)} ${pctColor(claude5h)}${Math.round(Number(claude5h))}%${RST}${fTime}${agy5}`);
      }
    }

    parts.push(`${C.muted}cache${RST} ${hitColor}${cacheHitPct}%${RST} ${C.muted}ttl${RST} ${ttlStr} ${C.muted}cr:${fmtK(cacheRead)} out:${fmtK(outTok)}${RST}`);

    const activeCtx = ctxTokens || lastCtx;
    const activePctNum = ctxPct != null ? Number(ctxPct) : (activeCtx / ctxMax) * 100;
    const ctxCol = activePctNum >= 75 ? C.red : activePctNum >= 45 ? C.amber : C.purple;
    parts.push(`${C.muted}ctx${RST} ${ctxCol}${fmtK(activeCtx)} (${activePctNum.toFixed(0)}%)${RST} ${C.muted}${turns}t${RST}`);

    process.stdout.write(parts.join(` ${C.dim}│${RST} `));
  } catch (e) {
    process.stdout.write('ready');
  }
});
