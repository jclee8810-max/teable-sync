import express from 'express';
import { readFileSync, writeFileSync, existsSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { authMiddleware } from '../middleware/auth.js';
import { canReadConnection, canWriteConnection } from '../services/accessControl.js';
import { decryptConfigSecrets, encryptConfigSecrets } from '../services/secretStore.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data');
const CONFIG_FILE = join(DATA_DIR, 'config.json');

// In-memory state store (connectionId -> { nonce, connectionId, createdAt })
// For production, use Redis or DB
const oauthState = new Map();

const router = express.Router();

function loadConfig() {
  return decryptConfigSecrets(JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')));
}

function saveConfig(config) {
  const tmpFile = `${CONFIG_FILE}.tmp`;
  writeFileSync(tmpFile, JSON.stringify(encryptConfigSecrets(config), null, 2), 'utf-8');
  renameSync(tmpFile, CONFIG_FILE);
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function base64UrlEncode(str) {
  return Buffer.from(str).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function base64UrlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64').toString('utf-8');
}

/**
 * Build Teable OAuth authorization URL.
 * For self-hosted: teableHost = e.g. http://localhost:3000
 * For cloud: teableHost = https://app.teable.ai (uses same paths)
 */
function buildAuthUrl(teableHost, clientId, redirectUri, state) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    state,
  });
  return `${teableHost.replace(/\/$/, '')}/oauth/authorize?${params.toString()}`;
}

// ─── Step 1: Initiate OAuth ───────────────────────────────────────────────────
// POST /api/oauth/teable/start
// Body: { connectionId, teableHost, clientId, clientSecret }
router.post('/teable/start', authMiddleware, async (req, res) => {
  const { connectionId, teableHost, clientId, clientSecret } = req.body;

  if (!connectionId || !teableHost || !clientId || !clientSecret) {
    return res.status(400).json({ error: '缺少必要参数：connectionId, teableHost, clientId, clientSecret' });
  }

  // Validate connection exists and belongs to user
  const config = loadConfig();
  const conn = config.connections.find(c => c.id === connectionId);
  if (!conn) return res.status(404).json({ error: '连接不存在' });
  if (conn.type !== 'teable') return res.status(400).json({ error: '仅支持 Teable 类型连接' });
  if (!canWriteConnection(req.user, conn)) return res.status(403).json({ error: '无权操作此连接' });

  // Build redirect URI — prefer env var for production LAN deployments
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const serverPublicUrl = (process.env.SERVER_PUBLIC_URL || `${proto}://${host}`).replace(/\/$/, '');
  if (!serverPublicUrl || serverPublicUrl.endsWith('://')) {
    return res.status(400).json({ error: '无法确定 OAuth 回调地址，请设置 SERVER_PUBLIC_URL' });
  }
  const redirectUri = `${serverPublicUrl}/api/oauth/teable/callback`;

  // Generate state with nonce + connectionId
  const nonce = crypto.randomBytes(16).toString('hex');
  const stateObj = { connectionId, nonce };
  const state = base64UrlEncode(JSON.stringify(stateObj));

  // Store state temporarily (expire in 10 min)
  oauthState.set(state, {
    nonce,
    connectionId,
    teableHost,
    clientId,
    clientSecret,
    redirectUri,
    createdAt: Date.now(),
  });
  setTimeout(() => oauthState.delete(state), 10 * 60 * 1000);

  // Build Teable authorization URL
  const authUrl = buildAuthUrl(teableHost, clientId, redirectUri, state);

  console.log(`[OAuth] Initiating flow for connection ${connectionId}, callback=${redirectUri}`);

  // Return the URL — frontend should redirect browser to this URL
  res.json({ authUrl, state });
});

// ─── Step 2: OAuth Callback ───────────────────────────────────────────────────
// GET /api/oauth/teable/callback
// Called by browser after user authorizes in Teable
// Teable redirects here with ?code=xxx&state=yyy
router.get('/teable/callback', async (req, res) => {
  const frontendBase = process.env.FRONTEND_BASE_URL || `http://localhost:${process.env.PORT || 3101}`;
  const { code, state, error, error_description } = req.query;

  // Handle error from Teable (user denied, etc.)
  if (error) {
    console.error(`[OAuth] Teable returned error: ${error} - ${error_description}`);
    // Redirect back to frontend with error
    return res.redirect(`${frontendBase}/?oauth_error=${encodeURIComponent(error_description || error)}`);
  }

  if (!code || !state) {
    return res.status(400).send('Missing code or state parameter');
  }

  // Validate state
  let stateObj;
  try {
    stateObj = JSON.parse(base64UrlDecode(state));
  } catch (e) {
    return res.status(400).send('Invalid state parameter');
  }

  const stored = oauthState.get(state);
  if (!stored) {
    return res.status(400).send('State not found or expired');
  }
  if (stored.nonce !== stateObj.nonce || stored.connectionId !== stateObj.connectionId) {
    return res.status(400).send('State mismatch');
  }
  oauthState.delete(state); // One-time use

  const { connectionId, teableHost, clientId, clientSecret, redirectUri } = stored;

  console.log(`[OAuth] Callback received for connection ${connectionId}`);

  try {
    // Exchange authorization code for access token
    // Note: Teable self-hosted uses /api/oauth/access_token (not /api/oauth/token)
    const tokenUrl = `${teableHost.replace(/\/$/, '')}/api/oauth/access_token`;
    const tokenRes = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
    });

    const tokenData = await tokenRes.json();
    console.log(`[OAuth] Token response status: ${tokenRes.status}`);

    if (!tokenRes.ok) {
      throw new Error(`Token exchange failed: ${JSON.stringify(tokenData)}`);
    }

    // Extract access token (field name may vary: access_token, token, etc.)
    const accessToken = tokenData.access_token || tokenData.token;
    if (!accessToken) {
      throw new Error(`No access token in response: ${JSON.stringify(tokenData)}`);
    }

    // Optionally verify token by calling /api/auth/me
    let userInfo = null;
    try {
      const meRes = await fetch(`${teableHost.replace(/\/$/, '')}/api/auth/me`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (meRes.ok) {
        userInfo = await meRes.json();
        console.log(`[OAuth] Token verified for connection ${connectionId}`);
      }
    } catch (e) {
      console.warn(`[OAuth] Could not verify token: ${e.message}`);
    }

    // Save token to connection
    const config = loadConfig();
    const connIdx = config.connections.findIndex(c => c.id === connectionId);
    if (connIdx === -1) throw new Error('Connection not found');

    config.connections[connIdx].token = accessToken;
    config.connections[connIdx].oauthClientId = clientId;
    config.connections[connIdx].oauthClientSecret = clientSecret; // Optionally save for token refresh
    if (userInfo) {
      config.connections[connIdx].oauthUserId = userInfo.id;
      config.connections[connIdx].oauthUserEmail = userInfo.email;
    }
    saveConfig(config);

    console.log(`[OAuth] Successfully connected connection ${connectionId}`);

    // Redirect to frontend success page
    const frontendUrl = userInfo
      ? `${frontendBase}/?oauth_success=1&email=${encodeURIComponent(userInfo.email || '')}`
      : `${frontendBase}/?oauth_success=1`;
    res.redirect(frontendUrl);

  } catch (err) {
    console.error(`[OAuth] Error: ${err.message}`);
    res.redirect(`${frontendBase}/?oauth_error=${encodeURIComponent(err.message)}`);
  }
});

// ─── Get OAuth status for a connection ───────────────────────────────────────
// GET /api/oauth/teable/status/:connectionId
router.get('/teable/status/:connectionId', authMiddleware, async (req, res) => {
  const config = loadConfig();
  const conn = config.connections.find(c => c.id === req.params.connectionId);
  if (!conn) return res.status(404).json({ error: '连接不存在' });
  if (!canReadConnection(req.user, conn)) return res.status(403).json({ error: '无权访问此连接' });

  if (!conn.token) {
    return res.json({ connected: false, connectionId: conn.id, name: conn.name });
  }

  // Verify token is still valid
  let valid = false;
  let userInfo = null;
  try {
    // teableHost is stored in the connection config
    const teableHost = conn.host || 'http://localhost:3000';
    const meRes = await fetch(`${teableHost.replace(/\/$/, '')}/api/auth/me`, {
      headers: { Authorization: `Bearer ${conn.token}` },
    });
    if (meRes.ok) {
      userInfo = await meRes.json();
      valid = true;
    }
  } catch (e) {
    valid = false;
  }

  res.json({
    connected: valid,
    connectionId: conn.id,
    name: conn.name,
    email: conn.oauthUserEmail || (userInfo ? userInfo.email : null),
    userId: conn.oauthUserId || (userInfo ? userInfo.id : null),
  });
});

// ─── Disconnect OAuth ────────────────────────────────────────────────────────
// DELETE /api/oauth/teable/disconnect/:connectionId
router.delete('/teable/disconnect/:connectionId', authMiddleware, async (req, res) => {
  const config = loadConfig();
  const connIdx = config.connections.findIndex(c => c.id === req.params.connectionId);
  if (connIdx === -1) return res.status(404).json({ error: '连接不存在' });
  if (!canWriteConnection(req.user, config.connections[connIdx])) {
    return res.status(403).json({ error: '无权操作此连接' });
  }

  // Clear OAuth fields but keep other connection info
  delete config.connections[connIdx].token;
  delete config.connections[connIdx].oauthClientId;
  delete config.connections[connIdx].oauthClientSecret;
  delete config.connections[connIdx].oauthUserId;
  delete config.connections[connIdx].oauthUserEmail;

  saveConfig(config);
  res.json({ ok: true });
});

// ─── Create OAuth App on self-hosted Teable ───────────────────────────────────
// POST /api/oauth/teable/app
// Creates an OAuth app in the Teable instance (requires admin)
// Body: { teableHost, email, password, appName, redirectUri }
router.post('/teable/app', authMiddleware, async (req, res) => {
  const { teableHost, email, password, appName, redirectUri } = req.body;

  if (!teableHost || !email || !password || !appName) {
    return res.status(400).json({ error: '缺少必要参数' });
  }

  const baseUrl = teableHost.replace(/\/$/, '');

  try {
    // Step 1: Sign in to Teable
    const signinRes = await fetch(`${baseUrl}/api/auth/signin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const signinData = await signinRes.json();
    if (!signinRes.ok) {
      throw new Error(`登录失败: ${signinData.message || signinData.error || 'Unknown error'}`);
    }
    const cookieHeader = signinRes.headers.get('set-cookie') || '';
    // For cookie-based auth, we need to extract and use the cookie
    const cookie = cookieHeader.split(';')[0] || '';

    console.log(`[OAuth App] Logged in to Teable for app provisioning`);

    // Step 2: Create OAuth app
    const appCreateRes = await fetch(`${baseUrl}/api/oauth/client`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify({
        name: appName,
        redirectUri: redirectUri || `${req.protocol}://${req.headers.host}/api/oauth/teable/callback`,
        homepage: `${process.env.FRONTEND_BASE_URL || `http://localhost:${process.env.PORT || 3101}`}`,
      }),
    });

    let appData;
    const text = await appCreateRes.text();
    try {
      appData = JSON.parse(text);
    } catch {
      appData = { raw: text };
    }

    if (!appCreateRes.ok) {
      throw new Error(`创建 OAuth App 失败: ${JSON.stringify(appData)}`);
    }

    console.log(`[OAuth App] Created app`);

    // Step 3: Generate client secret
    const clientId = appData.clientId || appData.id;
    const secretRes = await fetch(`${baseUrl}/api/oauth/client/${clientId}/secret-generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
      },
    });

    let secretData;
    const secretText = await secretRes.text();
    try {
      secretData = JSON.parse(secretText);
    } catch {
      secretData = { raw: secretText };
    }

    const clientSecret = secretData.clientSecret || secretData.secret || secretData.token;

    res.json({
      success: true,
      clientId,
      clientSecret,
      message: 'OAuth App 创建成功，请保存 clientId 和 clientSecret',
    });

  } catch (err) {
    console.error(`[OAuth App] Error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

export default router;
