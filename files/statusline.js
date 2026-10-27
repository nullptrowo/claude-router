const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const CACHE_FILE = path.join(HOME, '.claude', 'live-usage-cache.json');
const CREDS_FILE = path.join(HOME, '.claude', '.credentials.json');
const SETTINGS_FILE = path.join(HOME, '.claude', 'settings.json');
const CLAUDE_JSON_FILE = path.join(HOME, '.claude.json');
const OMNI_DB = path.join(HOME, '.omniroute', 'storage.sqlite');
const CACHE_TTL_MS = 20000;

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
        sevenDayUsed: +(100 - (w.remainingPercentage ?? 100)).toFixed(2),
        sevenDayResetIso: w.resetAt || null,
        sevenDayResetEpoch: w.resetAt ? Math.floor(new Date(w.resetAt).getTime() / 1000) : null,
        fiveHourUsed: s ? +(100 - (s.remainingPercentage ?? 100)).toFixed(2) : 0,
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

    let activeEffort = 'Med';
    try {
      const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      const modelKey = isArgon ? 'claude-argon-4'
                     : isDeepSeek ? 'claude-deepseek-v4-1-flash-1017'
                     : isKimi ? 'claude-kimi-k3'
                     : null;
      const effRaw = ((modelKey && s.modelSettings?.[modelKey]?.effortLevel) || s.effortLevel || 'medium').toLowerCase();
      if (effRaw === 'max') activeEffort = 'Max';
      else if (effRaw === 'xhigh') activeEffort = 'xHigh';
      else if (effRaw === 'high') activeEffort = 'High';
      else if (effRaw === 'low') activeEffort = 'Low';
      else activeEffort = 'Med';
    } catch {}

    const model = isArgon ? `Argon ${activeEffort}`
                : isDeepSeek ? `DeepSeek V4.1 Flash 1017 (${activeEffort})`
                : isKimi ? `Kimi K3 (${activeEffort})`
                : rawModelId.includes('opus') ? `Opus 5.5 (${activeEffort})`
                : rawModelId.includes('sonnet') ? `Sonnet 5.5 (${activeEffort})`
                : rawModelId.includes('haiku') ? `Haiku 5.5 (${activeEffort})`
                : rawModelId.includes('fable') ? `Fable 5.1 (${activeEffort})`
                : (data.model?.display_name || 'Claude');
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

    syncClaudeJsonUsage(live, agy, fmtTimeLeft);

    const makeBar = (pct, len = 8) => {
      if (pct == null || isNaN(pct)) return '';
      const clamped = Math.max(0, Math.min(100, pct));
      const filled = Math.round((clamped / 100) * len);
      return '█'.repeat(filled) + '░'.repeat(len - filled);
    };

    const ctxPct = data.context_window?.used_percentage;
    const ctxTokens = data.context_window?.total_input_tokens || data.context_window?.current_usage?.input_tokens;

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
      if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
      if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
      return String(n);
    };

    const totalInputAll = inTok + cacheWrite + cacheRead;
    const cacheHitPct = totalInputAll > 0 ? ((cacheRead / totalInputAll) * 100).toFixed(1) : '0.0';
    const ttlStr = ttlLeftMin > 0 ? `${ttlLeftMin}m` : 'EXPIRED';

    const parts = [];
    parts.push(model);

    if (isArgon && agy) {
      const claudeNote = claude7d != null ? ` (Claude ${Math.round(Number(claude7d))}%)` : '';
      const wStr = `7d ${makeBar(agy.sevenDayUsed, 8)} ${agy.sevenDayUsed.toFixed(1)}%${claudeNote}${agy.sevenDayResetEpoch ? ` ${fmtTimeLeft(agy.sevenDayResetEpoch)}` : ''}`;
      const fStr = `5h ${makeBar(agy.fiveHourUsed, 5)} ${agy.fiveHourUsed.toFixed(1)}%${agy.fiveHourResetEpoch ? ` ${fmtTimeLeft(agy.fiveHourResetEpoch)}` : ''}`;
      parts.push(wStr);
      parts.push(fStr);
    } else if (claude7d != null || claude5h != null) {
      const agyNote = agy ? ` (AGY ${agy.sevenDayUsed.toFixed(1)}%/${agy.fiveHourUsed.toFixed(1)}%)` : '';
      const wStr = claude7d != null ? `7d ${makeBar(claude7d, 8)} ${Math.round(Number(claude7d))}%${agyNote}${claude7dEpoch ? ` ${fmtTimeLeft(claude7dEpoch)}` : ''}` : '';
      const fStr = claude5h != null ? `5h ${makeBar(claude5h, 5)} ${Math.round(Number(claude5h))}%${claude5hEpoch ? ` ${fmtTimeLeft(claude5hEpoch)}` : ''}` : '';
      if (wStr) parts.push(wStr);
      if (fStr) parts.push(fStr);
    }

    parts.push(`out:${fmtK(outTok)} cw:${fmtK(cacheWrite)} cr:${fmtK(cacheRead)} hit:${cacheHitPct}% ttl:${ttlStr}`);

    const activeCtx = ctxTokens || lastCtx;
    const activePct = ctxPct != null ? `${Number(ctxPct).toFixed(0)}%` : `${Math.round((activeCtx / 1000000) * 100)}%`;
    parts.push(`ctx:${fmtK(activeCtx)}(${activePct}) ${turns}t`);

    process.stdout.write(parts.join(' | '));
  } catch (e) {
    process.stdout.write('ready');
  }
});
