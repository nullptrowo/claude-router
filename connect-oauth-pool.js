const http = require('http');
const os = require('os');
const path = require('path');
const { URL } = require('url');
const { randomUUID } = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { exec } = require('child_process');

const DB_PATH = path.join(os.homedir(), '.omniroute', 'storage.sqlite');
const CLINE_PORT = 49210;
const CLINE_REDIRECT = `http://127.0.0.1:${CLINE_PORT}/callback`;

function openUrl(url) {
  console.log('👉 URL:', url);
  if (process.platform === 'win32') exec(`start "" "${url}"`);
  else if (process.platform === 'darwin') exec(`open "${url}"`);
  else exec(`xdg-open "${url}"`);
}

function saveConnection({ provider, name, email, accessToken, refreshToken, expiresAt, providerSpecificData }) {
  const db = new DatabaseSync(DB_PATH);
  const existing = db.prepare('SELECT id FROM provider_connections WHERE provider = ?').get(provider);
  const id = existing ? existing.id : randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR REPLACE INTO provider_connections (
      id, provider, auth_type, name, email, is_active,
      access_token, refresh_token, expires_at, token_expires_at,
      test_status, provider_specific_data, created_at, updated_at
    ) VALUES (?, ?, 'oauth', ?, ?, 1, ?, ?, ?, ?, 'active', ?, ?, ?)
  `).run(
    id,
    provider,
    name || email || `${provider} OAuth`,
    email || null,
    accessToken,
    refreshToken || null,
    expiresAt || null,
    expiresAt || null,
    JSON.stringify(providerSpecificData || {}),
    now,
    now
  );
  db.close();
  console.log(`[SUCCESS] Saved ${provider} connection (${name || email || id}) to OmniRoute DB!`);
}

const clineServer = http.createServer(async (req, res) => {
  const u = new URL(req.url || '/', `http://127.0.0.1:${CLINE_PORT}`);
  if (u.pathname === '/callback' || u.pathname === '/auth/callback') {
    const code = u.searchParams.get('code');
    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h2>Error: No code received from Cline</h2>');
      return;
    }
    try {
      let tokenData = null;
      try {
        let b64 = decodeURIComponent(code);
        const pad = 4 - (b64.length % 4);
        if (pad !== 4) b64 += '='.repeat(pad);
        const decoded = Buffer.from(b64, 'base64').toString('utf8');
        const lastBrace = decoded.lastIndexOf('}');
        if (lastBrace !== -1) {
          tokenData = JSON.parse(decoded.substring(0, lastBrace + 1));
        }
      } catch {}

      if (!tokenData || !tokenData.accessToken) {
        const r = await fetch('https://api.cline.bot/api/v1/auth/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            grant_type: 'authorization_code',
            code,
            client_type: 'extension',
            redirect_uri: CLINE_REDIRECT
          })
        });
        const j = await r.json();
        tokenData = {
          accessToken: j.data?.accessToken || j.accessToken,
          refreshToken: j.data?.refreshToken || j.refreshToken,
          email: j.data?.userInfo?.email || '',
          expiresAt: j.data?.expiresAt || j.expiresAt
        };
      }

      if (tokenData && tokenData.accessToken) {
        saveConnection({
          provider: 'cline',
          name: tokenData.email || 'Cline Account',
          email: tokenData.email || null,
          accessToken: tokenData.accessToken,
          refreshToken: tokenData.refreshToken,
          expiresAt: tokenData.expiresAt,
          providerSpecificData: { firstName: tokenData.firstName, lastName: tokenData.lastName }
        });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h1 style="font-family:sans-serif;color:#22c55e;text-align:center;margin-top:20vh;">&#10003; Cline connected to OmniRoute.<br><small style="color:#666">You can close this tab.</small></h1>');
      } else {
        throw new Error('No accessToken in response');
      }
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<h2>Error connecting Cline: ${e.message}</h2>`);
    }
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

clineServer.listen(CLINE_PORT, '127.0.0.1', () => {
  const clineAuthUrl = `https://api.cline.bot/api/v1/auth/authorize?client_type=extension&callback_url=${encodeURIComponent(CLINE_REDIRECT)}&redirect_uri=${encodeURIComponent(CLINE_REDIRECT)}`;
  console.log('[CLINE] Callback server ready on', CLINE_REDIRECT);
  openUrl(clineAuthUrl);
});

(async () => {
  try {
    const stateRes = await fetch('https://www.codebuddy.ai/v2/plugin/auth/state?platform=ide', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'CodeBuddy-IDE/1.0.0',
        'X-Requested-With': 'XMLHttpRequest',
        'X-Domain': 'www.codebuddy.ai',
        'X-No-Authorization': 'true',
        'X-No-User-Id': 'true',
        'X-Product': 'SaaS'
      },
      body: JSON.stringify({ platform: 'ide' })
    });
    const stateJson = await stateRes.json();
    if (stateJson.code === 0 && stateJson.data?.state) {
      const state = String(stateJson.data.state);
      const authUrl = String(stateJson.data.authUrl || stateJson.data.url || '');
      console.log('[CODEBUDDY-INTL] Opening login:');
      openUrl(authUrl);

      const timer = setInterval(async () => {
        try {
          const pollRes = await fetch(`https://www.codebuddy.ai/v2/plugin/auth/token?state=${encodeURIComponent(state)}`, {
            headers: {
              Accept: 'application/json',
              'User-Agent': 'CodeBuddy-IDE/1.0.0',
              'X-Requested-With': 'XMLHttpRequest',
              'X-Domain': 'www.codebuddy.ai',
              'X-No-Authorization': 'true',
              'X-No-User-Id': 'true',
              'X-No-Enterprise-Id': 'true',
              'X-No-Department-Info': 'true',
              'X-Product': 'SaaS'
            }
          });
          const pollJson = await pollRes.json();
          if (pollJson.code === 0 && pollJson.data?.accessToken) {
            clearInterval(timer);
            const exp = pollJson.data.expiresIn
              ? new Date(Date.now() + pollJson.data.expiresIn * 1000).toISOString()
              : new Date(Date.now() + 86400 * 1000).toISOString();
            saveConnection({
              provider: 'codebuddy-intl',
              name: 'CodeBuddy Intl (Kimi K3 + DeepSeek V4.1 1M)',
              email: null,
              accessToken: pollJson.data.accessToken,
              refreshToken: pollJson.data.refreshToken || '',
              expiresAt: exp,
              providerSpecificData: {}
            });
          }
        } catch {}
      }, 3000);
    }
  } catch (e) {
    console.error('[CODEBUDDY ERR]', e.message);
  }
})();
