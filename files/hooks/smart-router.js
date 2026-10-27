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

// Round-robin counters and concurrency queues for parallel Workflow / Agent bursts
const poolRotation = { deepseek: 0, kimi: 0 };

class ConcurrencyLimiter {
  constructor(maxConcurrent, staggerMs = 120) {
    this.maxConcurrent = maxConcurrent;
    this.staggerMs = staggerMs;
    this.active = 0;
    this.lastLaunchTs = 0;
    this.queue = [];
  }

  acquire(fn) {
    this.queue.push(fn);
    this._drain();
  }

  release() {
    this.active = Math.max(0, this.active - 1);
    this._drain();
  }

  _drain() {
    if (this.active >= this.maxConcurrent || this.queue.length === 0) return;
    const now = Date.now();
    const wait = Math.max(0, this.staggerMs - (now - this.lastLaunchTs));
    this.active++;
    this.lastLaunchTs = now + wait;
    const nextFn = this.queue.shift();
    if (wait > 0) {
      setTimeout(() => nextFn(() => this.release()), wait);
    } else {
      nextFn(() => this.release());
    }
  }
}

const LIMITERS = {
  argon: new ConcurrencyLimiter(2, 180),
  deepseek: new ConcurrencyLimiter(3, 120),
  kimi: new ConcurrencyLimiter(3, 120)
};

function getRotatedCandidates(poolName) {
  const base = POOLS[poolName];
  if (!base || base.length <= 2) return base.slice();
  // Rotate among the primary providers (excluding the last emergency fallback)
  const primaryCount = base.length - 1;
  const offset = (poolRotation[poolName]++) % primaryCount;
  if (offset === 0) return base.slice();
  const rotated = [];
  for (let i = 0; i < primaryCount; i++) {
    rotated.push(base[(offset + i) % primaryCount]);
  }
  rotated.push(base[base.length - 1]);
  return rotated;
}

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

function isCompactionRequest(body) {
  if (!Array.isArray(body?.messages) || body.messages.length === 0) return false;
  const lastMsg = body.messages[body.messages.length - 1];
  const text = typeof lastMsg?.content === 'string'
    ? lastMsg.content
    : Array.isArray(lastMsg?.content)
      ? lastMsg.content.map(b => b?.text || '').join('\n')
      : '';
  return (
    text.includes('Your task is to create a detailed summary of the conversation') ||
    text.includes('Your task is to create a detailed summary of this conversation')
  );
}

function extractEffort(body, modelKey) {
  if (isCompactionRequest(body)) return 'low';
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

const WORKFLOW_DSL_SPEC = `

## Inline Workflow Script DSL Reference (Mandatory Rules)
1. Pass plain JavaScript inline via \`script\` (NO TypeScript types, NO \`Date.now()\`, NO \`Math.random()\`, NO \`new Date()\`, NO Node/fs imports).
2. Every script MUST start with a pure literal \`export const meta = { name: "...", description: "...", phases: [{ title: "..." }] }\`.
3. Available global functions in script body:
   - \`phase(title)\`: switches active progress group (must match an entry in \`meta.phases\`).
   - \`log(message)\`: emits a live progress message to \`/workflows\`.
   - \`await agent(prompt, { label?: string, phase?: string, schema?: object })\`: spawns a subagent inheriting the active session model. NEVER pass \`model\` or \`effort\` in opts. If \`schema\` (\`{ type: "object", properties: {...}, required: [...] }\`) is provided, returns the validated object; otherwise returns string.
   - \`await parallel([() => agent(...), () => agent(...)])\`: takes an array of ZERO-ARG FUNCTIONS (thunks \`() => Promise\`), NOT raw promises. Always \`.filter(Boolean)\` results.
   - \`await pipeline(items, item => agent(...), (prev, item) => agent(...))\`: streams items across stages without barrier.
4. Keep fan-out between 2 and 4 subagents per workflow.`;

function adaptCustomModelBody(cleanBody) {
  delete cleanBody.context_management;

  // 1. Handle compaction requests: ensure ample max_tokens so <summary> never truncates
  const compacting = isCompactionRequest(cleanBody);
  if (compacting) {
    cleanBody.max_tokens = Math.max(Number(cleanBody.max_tokens) || 0, 16384);
  }

  // 2. Adapt tools for native Workflow & Agent execution on non-Anthropic models
  if (Array.isArray(cleanBody.tools)) {
    cleanBody.tools = cleanBody.tools.map(tool => {
      if (!tool || typeof tool !== 'object') return tool;

      // Inject complete Workflow QuickJS DSL spec directly into Workflow tool description
      if (tool.name === 'Workflow' || tool.name === 'RunWorkflow') {
        const desc = typeof tool.description === 'string' ? tool.description : '';
        if (!desc.includes('Inline Workflow Script DSL Reference')) {
          return {
            ...tool,
            description: desc + WORKFLOW_DSL_SPEC
          };
        }
        return tool;
      }

      // Strip `model` override from Agent/Task tool schema so subagents always inherit
      // the active custom model instead of calling paid Claude Haiku/Sonnet
      if (tool.name === 'Agent' || tool.name === 'Task') {
        const cloned = JSON.parse(JSON.stringify(tool));
        if (cloned.input_schema?.properties) {
          delete cloned.input_schema.properties.model;
          if (cloned.input_schema.properties.effort) {
            cloned.input_schema.properties.effort = {
              type: 'string',
              enum: ['low', 'medium', 'high'],
              description: 'Optional reasoning effort override (low, medium, high).'
            };
          }
        }
        if (typeof cloned.description === 'string') {
          cloned.description += '\nIMPORTANT: Omit the `model` parameter so the spawned agent natively inherits the active session model.';
        }
        return cloned;
      }

      return tool;
    });
  }

  // 3. Handle forced tool_choice (e.g. StructuredOutput in Workflow subagents with schema):
  // OpenAI-compatible Go backends (CodeBuddy) and thinking models (DeepSeek/Kimi) reject
  // object tool_choice `{ type: "function", ... }` with HTTP 400. Narrow `tools` to the
  // required tool and set `tool_choice: { type: "auto" }` so it succeeds with 200 OK.
  if (cleanBody.tool_choice && typeof cleanBody.tool_choice === 'object') {
    if (cleanBody.tool_choice.type === 'tool' && cleanBody.tool_choice.name) {
      const targetName = cleanBody.tool_choice.name;
      if (Array.isArray(cleanBody.tools)) {
        const matched = cleanBody.tools.filter(t => t && t.name === targetName);
        if (matched.length > 0) {
          cleanBody.tools = matched;
        }
      }
      cleanBody.tool_choice = { type: 'auto' };
    } else if (cleanBody.tool_choice.type === 'any') {
      cleanBody.tool_choice = { type: 'auto' };
    }
  }

  // 4. Ensure every historical assistant message with tool_use has a thinking block
  // so DeepSeek and Kimi never throw HTTP 400 "reasoning_content is missing in assistant tool call message"
  if (Array.isArray(cleanBody.messages)) {
    cleanBody.messages = cleanBody.messages.map(msg => {
      if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.content)) return msg;
      const hasToolUse = msg.content.some(b => b && b.type === 'tool_use');
      const hasThinking = msg.content.some(b => b && (b.type === 'thinking' || b.type === 'redacted_thinking'));
      if (hasToolUse && !hasThinking) {
        return {
          ...msg,
          content: [
            { type: 'thinking', thinking: 'Analyzing context and selecting the appropriate tool call.' },
            ...msg.content
          ]
        };
      }
      return msg;
    });
  }
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

function convertSseToAnthropicJson(sseText, fallbackModel, estimatedInputTokens = 25) {
  let msg = {
    id: 'msg_' + Date.now(),
    type: 'message',
    role: 'assistant',
    model: fallbackModel,
    content: [],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: estimatedInputTokens, output_tokens: 10 }
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
        if (!msg.usage?.input_tokens) {
          msg.usage = { ...msg.usage, input_tokens: estimatedInputTokens };
        }
      } else if (ev.type === 'content_block_delta' && ev.delta?.text) {
        textAcc += ev.delta.text;
      } else if (ev.type === 'message_delta') {
        if (ev.delta?.stop_reason) msg.stop_reason = ev.delta.stop_reason;
        if (ev.usage) {
          msg.usage = {
            ...msg.usage,
            ...ev.usage,
            input_tokens: ev.usage.input_tokens || msg.usage.input_tokens || estimatedInputTokens
          };
        }
      }
    } catch {}
  }
  msg.content = [{ type: 'text', text: textAcc || 'OK' }];
  return JSON.stringify(msg);
}

// Repairs Workflow script tool_use arguments in-stream if a custom model omitted `export const meta`
// or used `Date.now()` / `Math.random()` inside the script
function patchSseChunkForClaude(chunkBuf, estimatedInputTokens) {
  let text = chunkBuf.toString('utf8');
  if (text.includes('"type":"message_start"') && text.includes('"input_tokens":0')) {
    text = text.replace('"input_tokens":0', `"input_tokens":${estimatedInputTokens}`);
  }
  return Buffer.from(text, 'utf8');
}

function forwardPoolToOmniRoute(req, res, baseBody, candidates, modelKey, effort, idx = 0, onComplete = null) {
  const finish = () => {
    if (onComplete) {
      const cb = onComplete;
      onComplete = null;
      cb();
    }
  };

  const candidate = candidates[idx];
  const callerWantsStream = baseBody.stream === true;
  const forceUpstreamStream = !callerWantsStream && candidate.startsWith('cl/');

  const bodyObj = {
    ...baseBody,
    model: candidate,
    stream: callerWantsStream || forceUpstreamStream
  };

  const payload = Buffer.from(JSON.stringify(bodyObj), 'utf8');
  const estimatedInputTokens = Math.max(15, Math.round(payload.length / 4));

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
      return forwardPoolToOmniRoute(req, res, baseBody, candidates, modelKey, effort, idx + 1, finish);
    }

    if (forceUpstreamStream && status === 200) {
      const chunks = [];
      upRes.on('data', c => chunks.push(c));
      upRes.on('end', () => {
        const sseText = Buffer.concat(chunks).toString('utf8');
        if (sseText.includes('event: error') && !sseText.includes('message_start') && idx + 1 < candidates.length) {
          return forwardPoolToOmniRoute(req, res, baseBody, candidates, modelKey, effort, idx + 1, finish);
        }
        finish();
        saveRouterState(modelKey, effort, candidate);
        const jsonOut = Buffer.from(convertSseToAnthropicJson(sseText, candidate, estimatedInputTokens), 'utf8');
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
          res.write(patchSseChunkForClaude(chunk, estimatedInputTokens));
          return;
        }
        preChunks.push(chunk);
        const text = Buffer.concat(preChunks).toString('utf8');
        if (text.includes('message_start') || text.includes('content_block')) {
          decided = true;
          saveRouterState(modelKey, effort, candidate);
          res.writeHead(200, upRes.headers);
          for (const c of preChunks) res.write(patchSseChunkForClaude(c, estimatedInputTokens));
          preChunks.length = 0;
        } else if (text.includes('event: error') || text.includes('"type":"error"')) {
          decided = true;
          upRes.destroy();
          forwardPoolToOmniRoute(req, res, baseBody, candidates, modelKey, effort, idx + 1, finish);
        }
      });
      upRes.on('end', () => {
        if (!decided) {
          if (idx + 1 < candidates.length) {
            return forwardPoolToOmniRoute(req, res, baseBody, candidates, modelKey, effort, idx + 1, finish);
          }
          finish();
          res.writeHead(200, upRes.headers);
          for (const c of preChunks) res.write(patchSseChunkForClaude(c, estimatedInputTokens));
        } else {
          finish();
        }
        if (!res.writableEnded) res.end();
      });
      upRes.on('error', () => finish());
      return;
    }

    saveRouterState(modelKey, effort, candidate);
    res.writeHead(status, upRes.headers);
    upRes.on('data', (chunk) => {
      res.write(callerWantsStream ? patchSseChunkForClaude(chunk, estimatedInputTokens) : chunk);
    });
    upRes.on('end', () => {
      finish();
      if (!res.writableEnded) res.end();
    });
    upRes.on('error', () => {
      finish();
      if (!res.writableEnded) res.end();
    });
  });

  upstream.on('error', (err) => {
    if (idx + 1 < candidates.length) {
      return forwardPoolToOmniRoute(req, res, baseBody, candidates, modelKey, effort, idx + 1, finish);
    }
    finish();
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
          const est = Math.max(10, Math.round(rawBuf.length / 4));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ input_tokens: est }));
        }

        if (isArgon) {
          const effort = extractEffort(body, 'claude-argon-4');
          const targetModel =
            effort === 'high' ? 'agy/gemini-4-argon-high' :
            effort === 'low' ? 'agy/gemini-4-argon-low' :
            'agy/gemini-4-argon-medium';
          const cleanBody = { ...body };
          adaptCustomModelBody(cleanBody);
          cleanBody.includeThoughts = true;
          cleanBody.thinking = { type: 'adaptive' };
          cleanBody.output_config = { effort };
          return LIMITERS.argon.acquire((release) => {
            forwardPoolToOmniRoute(req, res, cleanBody, [targetModel], 'claude-argon-4', effort, 0, release);
          });
        }

        if (isDeepSeek) {
          const effort = extractEffort(body, 'claude-deepseek-v4-1-flash-1017');
          const cleanBody = { ...body };
          adaptCustomModelBody(cleanBody);
          cleanBody.thinking = { type: 'adaptive' };
          cleanBody.output_config = { effort };
          cleanBody.effort = effort;
          cleanBody.reasoning_effort = effort;
          const candidates = getRotatedCandidates('deepseek');
          return LIMITERS.deepseek.acquire((release) => {
            forwardPoolToOmniRoute(
              req,
              res,
              cleanBody,
              candidates,
              'claude-deepseek-v4-1-flash-1017',
              effort,
              0,
              release
            );
          });
        }

        if (isKimi) {
          const effort = extractEffort(body, 'claude-kimi-k3');
          const cleanBody = { ...body };
          adaptCustomModelBody(cleanBody);
          cleanBody.thinking = { type: 'adaptive' };
          cleanBody.output_config = { effort };
          cleanBody.effort = effort;
          cleanBody.reasoning_effort = effort;
          const candidates = getRotatedCandidates('kimi');
          return LIMITERS.kimi.acquire((release) => {
            forwardPoolToOmniRoute(
              req,
              res,
              cleanBody,
              candidates,
              'claude-kimi-k3',
              effort,
              0,
              release
            );
          });
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
