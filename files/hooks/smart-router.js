const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
const PORT = 20129;
const OMNIROUTE_HOST = '127.0.0.1';
const OMNIROUTE_PORT = 20128;
const ANTHROPIC_HOST = 'api.anthropic.com';
const STATE_FILE = path.join(CLAUDE_DIR, 'argon-state.json');
const SETTINGS_FILE = path.join(CLAUDE_DIR, 'settings.json');
const CREDENTIALS_FILE = path.join(CLAUDE_DIR, '.credentials.json');
const CLAUDE_JSON_FILE = path.join(HOME, '.claude.json');
const OMNI_DB = path.join(HOME, '.omniroute', 'storage.sqlite');

function getOmniRouteKey() {
  try {
    if (fs.existsSync(OMNI_DB)) {
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(OMNI_DB, { readOnly: true });
      const row = db.prepare('SELECT key FROM api_keys LIMIT 1').get();
      db.close();
      if (row?.key) return row.key;
    }
  } catch {}
  return 'sk-omniroute-local';
}

const OMNIROUTE_KEY = getOmniRouteKey();

// Multi-provider priority pools (fastest latency & highest tok/s first)
const POOLS = {
  deepseek: [
    'cl/deepseek/deepseek-v4.1-flash-1017',
    'cl/deepseek/deepseek-v4.1-flash',
    'cbai/deepseek-v4.1-flash',
    'cl/deepseek/deepseek-v4-flash',
    'kc/reflection/beam-free'
  ],
  kimi: [
    'cl/moonshotai/kimi-k3',
    'cbai/kimi-k3',
    'kc/reflection/beam-free'
  ]
};

function readAgyQuota() {
  try {
    if (!fs.existsSync(OMNI_DB)) return null;
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
        sevenDayReset: w.resetAt || null,
        fiveHourUsed: s ? +(100 - (s.remainingPercentage ?? 100)).toFixed(2) : 0,
        fiveHourReset: s?.resetAt || null
      };
    }
  } catch {}
  return null;
}

function fmtCountdown(iso) {
  if (!iso) return '';
  const diff = Math.max(0, Math.floor((new Date(iso).getTime() - Date.now()) / 1000));
  const d = Math.floor(diff / 86400);
  const h = Math.floor((diff % 86400) / 3600);
  const m = Math.floor((diff % 3600) / 60);
  if (d > 0) return `${d}d${h}h`;
  if (h > 0) return `${h}h${m}m`;
  return `${m}m`;
}

function getConfiguredEffort(modelKey) {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    return (
      (modelKey && s.modelSettings?.[modelKey]?.effortLevel) ||
      s.modelSettings?.['claude-argon-4']?.effortLevel ||
      s.effortLevel ||
      'medium'
    ).toLowerCase();
  } catch {
    return 'medium';
  }
}

function isUltraActive() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const st = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (st.ultraMode && Date.now() - (st.ultraTs || 0) < 600000) {
        return true;
      }
    }
  } catch {}
  return false;
}

function extractEffort(body, modelKey) {
  if (isUltraActive()) return 'high';
  let effort = (body.output_config?.effort || body.effort || body.reasoning_effort || '').toLowerCase();
  if (!effort && body.thinking?.budget_tokens) {
    const b = Number(body.thinking.budget_tokens);
    effort = b >= 14000 ? 'high' : b <= 4096 ? 'low' : 'medium';
  }
  if (!effort) effort = getConfiguredEffort(modelKey);

  // Custom upstream APIs (Google Antigravity & OpenAI-compatible DeepSeek/Kimi pools)
  // accept 'low' | 'medium' | 'high'. Map 'xhigh'/'max' safely to 'high'.
  if (effort === 'max' || effort === 'xhigh' || effort === 'high') {
    return 'high';
  }
  if (effort === 'low') {
    return 'low';
  }
  return 'medium';
}

function ensureAuthHeaders(headers) {
  if (!headers['authorization'] && !headers['x-api-key']) {
    try {
      const creds = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'));
      const tok = creds.claudeAiOauth?.accessToken;
      if (tok) headers['authorization'] = `Bearer ${tok}`;
    } catch {}
  }
}

function forwardToAnthropic(req, res, bodyBuf) {
  const headers = { ...req.headers, host: ANTHROPIC_HOST };
  ensureAuthHeaders(headers);
  delete headers['content-length'];
  if (bodyBuf) headers['content-length'] = Buffer.byteLength(bodyBuf);

  // Intercept GET /api/oauth/usage to inject Google Antigravity (Gemini 4 Argon) bar into /usage
  if (req.method === 'GET' && req.url && req.url.startsWith('/api/oauth/usage')) {
    delete headers['accept-encoding'];
    const upstream = https.request({
      hostname: ANTHROPIC_HOST,
      port: 443,
      path: req.url,
      method: 'GET',
      headers
    }, (upRes) => {
      const chunks = [];
      upRes.on('data', c => chunks.push(c));
      upRes.on('end', () => {
        const raw = Buffer.concat(chunks);
        if (upRes.statusCode === 200) {
          try {
            const parsed = JSON.parse(raw.toString('utf8'));
            const agy = readAgyQuota();
            if (agy) {
              parsed.wattle_ember = {
                label: `Gemini 4 Argon (AGY 5x) · 7d: ${agy.sevenDayUsed}% (${fmtCountdown(agy.sevenDayReset)}) · 5h: ${agy.fiveHourUsed}% (${fmtCountdown(agy.fiveHourReset)})`,
                utilization: Math.round(agy.sevenDayUsed),
                resets_at: agy.sevenDayReset
              };
            }
            const outBuf = Buffer.from(JSON.stringify(parsed), 'utf8');
            const outHeaders = { ...upRes.headers, 'content-length': outBuf.length };
            delete outHeaders['content-encoding'];
            delete outHeaders['transfer-encoding'];
            res.writeHead(200, outHeaders);
            return res.end(outBuf);
          } catch {}
        }
        res.writeHead(upRes.statusCode || 200, upRes.headers);
        res.end(raw);
      });
    });
    upstream.on('error', (err) => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'api_error', message: err.message } }));
    });
    return upstream.end();
  }

  const upstream = https.request({
    hostname: ANTHROPIC_HOST,
    port: 443,
    path: req.url,
    method: req.method,
    headers
  }, (upRes) => {
    res.writeHead(upRes.statusCode || 200, upRes.headers);
    upRes.pipe(res);
  });

  upstream.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
    }
    res.end(JSON.stringify({ error: { type: 'api_error', message: err.message } }));
  });

  if (bodyBuf) upstream.end(bodyBuf);
  else req.pipe(upstream);
}

function saveRouterState(modelKey, effort, providerModel) {
  try {
    let prev = {};
    if (fs.existsSync(STATE_FILE)) {
      prev = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      ...prev,
      model: modelKey,
      effort,
      providerModel,
      ts: Date.now()
    }));
  } catch {}
}

function convertSseToAnthropicJson(sseText, fallbackModel) {
  let msg = {
    id: 'msg_' + Date.now(),
    type: 'message',
    role: 'assistant',
    model: fallbackModel,
    content: [],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 }
  };
  let textAcc = '';
  for (const line of sseText.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const raw = line.slice(5).trim();
    if (!raw || raw === '[DONE]') continue;
    try {
      const ev = JSON.parse(raw);
      if (ev.type === 'message_start' && ev.message) {
        msg = { ...msg, ...ev.message, content: [] };
      } else if (ev.type === 'content_block_delta' && ev.delta?.text) {
        textAcc += ev.delta.text;
      } else if (ev.type === 'message_delta') {
        if (ev.delta?.stop_reason) msg.stop_reason = ev.delta.stop_reason;
        if (ev.usage) msg.usage = { ...msg.usage, ...ev.usage };
      }
    } catch {}
  }
  msg.content = [{ type: 'text', text: textAcc || 'OK' }];
  return JSON.stringify(msg);
}

function forwardPoolToOmniRoute(req, res, baseBody, candidates, modelKey, effort, idx = 0) {
  const candidate = candidates[idx];
  const callerWantsStream = baseBody.stream === true;
  const forceUpstreamStream = !callerWantsStream && candidate.startsWith('cl/');

  const bodyObj = {
    ...baseBody,
    model: candidate,
    stream: callerWantsStream || forceUpstreamStream
  };

  const payload = Buffer.from(JSON.stringify(bodyObj), 'utf8');
  const headers = {
    'content-type': 'application/json',
    'content-length': payload.length,
    'authorization': `Bearer ${OMNIROUTE_KEY}`,
    'anthropic-version': req.headers['anthropic-version'] || '2023-06-01'
  };
  if (callerWantsStream || forceUpstreamStream) {
    headers['accept'] = 'text/event-stream';
  } else if (req.headers['accept']) {
    headers['accept'] = req.headers['accept'];
  }

  const upstream = http.request({
    hostname: OMNIROUTE_HOST,
    port: OMNIROUTE_PORT,
    path: req.url,
    method: req.method,
    headers
  }, (upRes) => {
    const status = upRes.statusCode || 500;
    if (status !== 200 && idx + 1 < candidates.length) {
      upRes.resume();
      return forwardPoolToOmniRoute(req, res, baseBody, candidates, modelKey, effort, idx + 1);
    }

    if (forceUpstreamStream && status === 200) {
      const chunks = [];
      upRes.on('data', c => chunks.push(c));
      upRes.on('end', () => {
        const sseText = Buffer.concat(chunks).toString('utf8');
        if (sseText.includes('event: error') && !sseText.includes('message_start') && idx + 1 < candidates.length) {
          return forwardPoolToOmniRoute(req, res, baseBody, candidates, modelKey, effort, idx + 1);
        }
        saveRouterState(modelKey, effort, candidate);
        const jsonOut = Buffer.from(convertSseToAnthropicJson(sseText, candidate), 'utf8');
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Length': jsonOut.length
        });
        res.end(jsonOut);
      });
      return;
    }

    // For streaming responses when fallback candidates exist, peek until first non-ping SSE event
    if (callerWantsStream && status === 200 && idx + 1 < candidates.length) {
      let decided = false;
      const preChunks = [];
      upRes.on('data', (chunk) => {
        if (decided) {
          res.write(chunk);
          return;
        }
        preChunks.push(chunk);
        const text = Buffer.concat(preChunks).toString('utf8');
        if (text.includes('message_start') || text.includes('content_block')) {
          decided = true;
          saveRouterState(modelKey, effort, candidate);
          res.writeHead(200, upRes.headers);
          for (const c of preChunks) res.write(c);
          preChunks.length = 0;
        } else if (text.includes('event: error') || text.includes('"type":"error"')) {
          decided = true;
          upRes.destroy();
          forwardPoolToOmniRoute(req, res, baseBody, candidates, modelKey, effort, idx + 1);
        }
      });
      upRes.on('end', () => {
        if (!decided) {
          if (idx + 1 < candidates.length) {
            return forwardPoolToOmniRoute(req, res, baseBody, candidates, modelKey, effort, idx + 1);
          }
          res.writeHead(200, upRes.headers);
          for (const c of preChunks) res.write(c);
        }
        if (!res.writableEnded) res.end();
      });
      return;
    }

    saveRouterState(modelKey, effort, candidate);
    res.writeHead(status, upRes.headers);
    upRes.pipe(res);
  });

  upstream.on('error', (err) => {
    if (idx + 1 < candidates.length) {
      return forwardPoolToOmniRoute(req, res, baseBody, candidates, modelKey, effort, idx + 1);
    }
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
    }
    res.end(JSON.stringify({ error: { type: 'api_error', message: 'OmniRoute error: ' + err.message } }));
  });

  upstream.end(payload);
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok' }));
  }

  if (req.method === 'POST' && req.url && req.url.startsWith('/v1/messages')) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const rawBuf = Buffer.concat(chunks);
      let body;
      try {
        body = JSON.parse(rawBuf.toString('utf8'));
      } catch {
        return forwardToAnthropic(req, res, rawBuf);
      }

      const modelStr = String(body.model || '').toLowerCase();
      const isArgon = modelStr.includes('argon');
      const isDeepSeek = modelStr.includes('deepseek-v4-1-flash-1017') || modelStr.includes('deepseek');
      const isKimi = modelStr.includes('kimi-k3') || modelStr.includes('kimi');

      if (isArgon || isDeepSeek || isKimi) {
        // Instant 0ms response for Claude Code's /model validation probe
        if (body.max_tokens === 1 && !body.stream) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            id: 'msg_probe_custom',
            type: 'message',
            role: 'assistant',
            model: body.model,
            content: [{ type: 'text', text: 'Hi' }],
            stop_reason: 'max_tokens',
            stop_sequence: null,
            usage: { input_tokens: 5, output_tokens: 1 }
          }));
        }

        if (req.url.includes('count_tokens')) {
          body.model = 'claude-opus-5-5';
          return forwardToAnthropic(req, res, Buffer.from(JSON.stringify(body), 'utf8'));
        }

        if (isArgon) {
          const effort = extractEffort(body, 'claude-argon-4');
          const targetModel =
            effort === 'high' ? 'agy/gemini-4-argon-high' :
            effort === 'low' ? 'agy/gemini-4-argon-low' :
            'agy/gemini-4-argon-medium';
          const cleanBody = { ...body };
          delete cleanBody.context_management;
          cleanBody.includeThoughts = true;
          cleanBody.thinking = { type: 'adaptive' };
          cleanBody.output_config = { effort };
          return forwardPoolToOmniRoute(req, res, cleanBody, [targetModel], 'claude-argon-4', effort);
        }

        if (isDeepSeek) {
          const effort = extractEffort(body, 'claude-deepseek-v4-1-flash-1017');
          const cleanBody = { ...body };
          delete cleanBody.context_management;
          cleanBody.thinking = { type: 'adaptive' };
          cleanBody.output_config = { effort };
          cleanBody.effort = effort;
          cleanBody.reasoning_effort = effort;
          return forwardPoolToOmniRoute(
            req,
            res,
            cleanBody,
            POOLS.deepseek,
            'claude-deepseek-v4-1-flash-1017',
            effort
          );
        }

        if (isKimi) {
          const effort = extractEffort(body, 'claude-kimi-k3');
          const cleanBody = { ...body };
          delete cleanBody.context_management;
          cleanBody.thinking = { type: 'adaptive' };
          cleanBody.output_config = { effort };
          cleanBody.effort = effort;
          cleanBody.reasoning_effort = effort;
          return forwardPoolToOmniRoute(
            req,
            res,
            cleanBody,
            POOLS.kimi,
            'claude-kimi-k3',
            effort
          );
        }
      }

      return forwardToAnthropic(req, res, rawBuf);
    });
    return;
  }

  forwardToAnthropic(req, res, null);
});

function syncClaudeJsonOnStartup() {
  try {
    const agy = readAgyQuota();
    if (!fs.existsSync(CLAUDE_JSON_FILE)) return;
    const cfg = JSON.parse(fs.readFileSync(CLAUDE_JSON_FILE, 'utf8'));
    if (!cfg.cachedGrowthBookFeatures) cfg.cachedGrowthBookFeatures = {};
    const inc = cfg.cachedGrowthBookFeatures.tengu_usage_overage_included_models || ['Fable', 'Fable 5', 'Fable 5.1'];
    if (!inc.includes('Gemini 4 Argon')) inc.push('Gemini 4 Argon');
    cfg.cachedGrowthBookFeatures.tengu_usage_overage_included_models = inc;
    cfg.cachedGrowthBookFeatures.tengu_workflows_enabled = true;
    cfg.cachedGrowthBookFeatures.tengu_turtle_carbon = true;

    if (agy) {
      if (!cfg.cachedUsageUtilization) {
        cfg.cachedUsageUtilization = { utilization: {}, lastUpdated: Date.now() };
      }
      if (!cfg.cachedUsageUtilization.utilization) {
        cfg.cachedUsageUtilization.utilization = {};
      }
      const u = cfg.cachedUsageUtilization.utilization;
      if (!u.limits || typeof u.limits !== 'object') u.limits = {};
      u.limits['Gemini 4 Argon'] = {
        utilization: Math.round(agy.sevenDayUsed),
        resets_at: agy.sevenDayReset
      };
      u.wattle_ember = {
        label: 'Current session (Gemini 4 Argon)',
        utilization: Math.round(agy.fiveHourUsed),
        resets_at: agy.fiveHourReset
      };
      cfg.cachedUsageUtilization.lastUpdated = Date.now();
    }
    fs.writeFileSync(CLAUDE_JSON_FILE, JSON.stringify(cfg, null, 2));
  } catch {}
}

syncClaudeJsonOnStartup();
setInterval(syncClaudeJsonOnStartup, 20000);

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Smart Router listening on http://127.0.0.1:${PORT}`);
});
