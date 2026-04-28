import express from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { signToken, authMiddleware } from '../middleware/auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data');
const USERS_FILE = join(DATA_DIR, 'users.json');

const router = express.Router();

function loadUsers() {
  if (!existsSync(USERS_FILE)) {
    writeFileSync(USERS_FILE, JSON.stringify([], 'utf-8'));
  }
  return JSON.parse(readFileSync(USERS_FILE, 'utf-8'));
}

function saveUsers(users) {
  writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf-8');
}

// GET /api/auth/me
router.get('/me', authMiddleware, (req, res) => {
  const users = loadUsers();
  const user = users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  const { passwordHash, ...safeUser } = user;
  res.json(safeUser);
});

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: '邮箱和密码不能为空' });
  }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: '请输入有效的邮箱地址' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: '密码至少6个字符' });
  }

  const users = loadUsers();
  if (users.some(u => u.email === email)) {
    return res.status(409).json({ error: '该邮箱已被注册' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const isFirst = users.length === 0;
  const user = {
    id: crypto.randomUUID(),
    email,
    passwordHash,
    role: isFirst ? 'super_admin' : 'user',
    createdAt: new Date().toISOString(),
  };
  users.push(user);
  saveUsers(users);

  const token = signToken({ id: user.id, email: user.email, role: user.role });
  const { passwordHash: _, ...safeUser } = user;
  res.json({ token, user: safeUser });
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: '邮箱和密码不能为空' });
  }

  const users = loadUsers();
  const user = users.find(u => u.email === email);
  if (!user) {
    return res.status(401).json({ error: '邮箱或密码错误' });
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    return res.status(401).json({ error: '邮箱或密码错误' });
  }

  const token = signToken({ id: user.id, email: user.email, role: user.role });
  const { passwordHash: _, ...safeUser } = user;
  res.json({ token, user: safeUser });
});

// PUT /api/auth/password
router.put('/password', authMiddleware, async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  if (!oldPassword || !newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: '请提供旧密码和新密码（至少6字符）' });
  }

  const users = loadUsers();
  const idx = users.findIndex(u => u.id === req.user.id);
  if (idx === -1) return res.status(404).json({ error: '用户不存在' });

  const valid = await bcrypt.compare(oldPassword, users[idx].passwordHash);
  if (!valid) return res.status(401).json({ error: '旧密码错误' });

  users[idx].passwordHash = await bcrypt.hash(newPassword, 10);
  saveUsers(users);

  res.json({ ok: true });
});

// GET /api/auth/users
router.get('/users', authMiddleware, (req, res) => {
  if (req.user.role !== 'super_admin') {
    return res.status(403).json({ error: '仅超级管理员可操作' });
  }
  const users = loadUsers();
  res.json(users.map(({ passwordHash, ...u }) => u));
});

// ─── Teable OAuth Login ───────────────────────────────────────────────
// Teable OAuth default config (overridable via env vars)
const TEABLE_OAUTH_HOST = process.env.TEABLE_OAUTH_HOST || 'http://localhost:3000';
const TEABLE_OAUTH_CLIENT_ID = process.env.TEABLE_OAUTH_CLIENT_ID || '';
const TEABLE_OAUTH_CLIENT_SECRET = process.env.TEABLE_OAUTH_CLIENT_SECRET || '';
const SYNC_SERVER_PORT = process.env.PORT || 3100;
const FRONTEND_BASE_URL = process.env.FRONTEND_BASE_URL || 'http://localhost:5174';

// In-memory store for login OAuth state
const loginOAuthState = new Map();

// GET /api/auth/teable-login
// Redirect browser to Teable authorization page
router.get('/teable-login', (req, res) => {
  const nonce = crypto.randomBytes(16).toString('hex');
  const state = Buffer.from(JSON.stringify({ nonce, type: 'login' })).toString('base64url');

  loginOAuthState.set(nonce, { createdAt: Date.now() });
  setTimeout(() => loginOAuthState.delete(nonce), 10 * 60 * 1000);

  const redirectUri = `http://localhost:${SYNC_SERVER_PORT}/api/auth/teable-callback`;
  const authUrl = `${TEABLE_OAUTH_HOST}/oauth/authorize?${new URLSearchParams({
    client_id: TEABLE_OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    state,
  }).toString()}`;

  console.log(`[Auth OAuth] Redirecting to Teable: ${authUrl}`);
  res.redirect(authUrl);
});

// GET /api/auth/teable-callback
// Teable redirects here after user authorizes
// Auto-creates user and issues JWT
router.get('/teable-callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;

  if (error) {
    console.error(`[Auth OAuth] Teable error: ${error} - ${error_description}`);
    return res.redirect(`${FRONTEND_BASE_URL}/?auth_error=${encodeURIComponent(error_description || error)}`);
  }

  if (!code || !state) {
    return res.status(400).send('Missing code or state');
  }

  let stateObj;
  try {
    stateObj = JSON.parse(Buffer.from(state, 'base64url').toString('utf-8'));
  } catch {
    return res.status(400).send('Invalid state');
  }

  if (stateObj.type !== 'login') {
    return res.status(400).send('Invalid state type');
  }

  const stored = loginOAuthState.get(stateObj.nonce);
  if (!stored) {
    return res.status(400).send('State expired or not found');
  }
  loginOAuthState.delete(stateObj.nonce);

  try {
    // Exchange code for access token
    const tokenUrl = `${TEABLE_OAUTH_HOST}/api/oauth/access_token`;
    const tokenRes = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: `http://localhost:${SYNC_SERVER_PORT}/api/auth/teable-callback`,
        client_id: TEABLE_OAUTH_CLIENT_ID,
        client_secret: TEABLE_OAUTH_CLIENT_SECRET,
      }).toString(),
    });

    if (!tokenRes.ok) {
      const errData = await tokenRes.json().catch(() => ({}));
      throw new Error(`Token exchange failed: ${JSON.stringify(errData)}`);
    }

    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token || tokenData.token;
    if (!accessToken) throw new Error('No access token in response');

    // Get Teable user info
    let teableUser = null;
    try {
      const meRes = await fetch(`${TEABLE_OAUTH_HOST}/api/auth/user/me`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (meRes.ok) teableUser = await meRes.json();
    } catch (e) {
      console.warn(`[Auth OAuth] Could not get user info: ${e.message}`);
    }

    const email = teableUser?.email || `teable_${stateObj.nonce.slice(0, 8)}@oauth.local`;

    // Find or create user
    const users = loadUsers();
    let user = users.find(u => u.email === email);

    if (!user) {
      const isFirst = users.length === 0;
      user = {
        id: crypto.randomUUID(),
        email,
        passwordHash: await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10),
        role: isFirst ? 'super_admin' : 'user',
        teableOAuthToken: accessToken,
        createdAt: new Date().toISOString(),
      };
      users.push(user);
      saveUsers(users);
      console.log(`[Auth OAuth] Auto-created user: ${email}`);
    } else {
      const idx = users.findIndex(u => u.id === user.id);
      users[idx].teableOAuthToken = accessToken;
      saveUsers(users);
    }

    // Issue JWT
    const jwtToken = signToken({ id: user.id, email: user.email, role: user.role });
    const { passwordHash: _, ...safeUser } = user;

    // Redirect to frontend with token
    res.redirect(`${FRONTEND_BASE_URL}/?oauth_token=${jwtToken}&email=${encodeURIComponent(email)}`);

  } catch (err) {
    console.error(`[Auth OAuth] Error: ${err.message}`);
    res.redirect(`${FRONTEND_BASE_URL}/?auth_error=${encodeURIComponent(err.message)}`);
  }
});

// ─── User Management ─────────────────────────────────────────────────────

// DELETE /api/auth/users/:id
router.delete('/users/:id', authMiddleware, (req, res) => {
  if (req.user.role !== 'super_admin') {
    return res.status(403).json({ error: '仅超级管理员可操作' });
  }
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: '不能删除自己' });
  }
  let users = loadUsers();
  const target = users.find(u => u.id === req.params.id);
  if (!target) return res.status(404).json({ error: '用户不存在' });
  if (target.role === 'super_admin') {
    return res.status(400).json({ error: '不能删除其他超级管理员' });
  }
  users = users.filter(u => u.id !== req.params.id);
  saveUsers(users);
  res.json({ ok: true });
});

export default router;
