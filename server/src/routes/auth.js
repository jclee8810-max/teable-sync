import express from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { readFileSync, writeFileSync, existsSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { signToken, authMiddleware } from '../middleware/auth.js';
import { appendAuditLog } from '../services/auditLog.js';
import { ROLES, ensureOwner, isAdmin, isOwner, roleLabel } from '../services/roles.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data');
const USERS_FILE = join(DATA_DIR, 'users.json');

const router = express.Router();

function loadUsers() {
  if (!existsSync(USERS_FILE)) {
    writeFileSync(USERS_FILE, JSON.stringify([], 'utf-8'));
  }
  const rawUsers = JSON.parse(readFileSync(USERS_FILE, 'utf-8'));
  const hadOwner = rawUsers.some((user) => user.role === ROLES.OWNER);
  const users = ensureOwner(rawUsers);
  if (!hadOwner && users.some((user) => user.role === ROLES.OWNER)) {
    saveUsers(users);
  }
  return users;
}

function saveUsers(users) {
  const tmpFile = `${USERS_FILE}.tmp`;
  writeFileSync(tmpFile, JSON.stringify(users, null, 2), 'utf-8');
  renameSync(tmpFile, USERS_FILE);
}

function sanitizeUser(user) {
  const { passwordHash, teableOAuthToken, ...safeUser } = user;
  return safeUser;
}

// GET /api/auth/me
router.get('/me', authMiddleware, (req, res) => {
  const users = loadUsers();
  const user = users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  res.json(sanitizeUser(user));
});

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: '邮箱和密码不能为空' });
  }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@.]+$/;
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
    role: isFirst ? ROLES.OWNER : ROLES.USER,
    createdAt: new Date().toISOString(),
  };
  users.push(user);
  saveUsers(users);

  const token = signToken({ id: user.id, email: user.email, role: user.role });
  res.json({ token, user: sanitizeUser(user) });
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
  res.json({ token, user: sanitizeUser(user) });
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
  if (!isAdmin(req.user)) {
    return res.status(403).json({ error: '仅系统所有者或超级管理员可查看用户' });
  }
  const users = loadUsers();
  res.json(users.map(sanitizeUser));
});

// ─── Teable OAuth Login ───────────────────────────────────────────────
// Teable OAuth default config (overridable via env vars)
const TEABLE_OAUTH_HOST = process.env.TEABLE_OAUTH_HOST || 'http://localhost:3000';
const TEABLE_OAUTH_CLIENT_ID = process.env.TEABLE_OAUTH_CLIENT_ID || '';
const TEABLE_OAUTH_CLIENT_SECRET = process.env.TEABLE_OAUTH_CLIENT_SECRET || '';
const SYNC_SERVER_PORT = process.env.PORT || 3101;
const FRONTEND_BASE_URL = process.env.FRONTEND_BASE_URL || `http://localhost:${SYNC_SERVER_PORT}`;
// 用于 OAuth 回调，生产环境必须设置（如 https://sync.yourcompany.com）
const SERVER_PUBLIC_URL = process.env.SERVER_PUBLIC_URL || `http://localhost:${SYNC_SERVER_PORT}`;

// In-memory stores for login OAuth state and one-time frontend exchange codes
const loginOAuthState = new Map();
const loginCodeStore = new Map();
const LOGIN_CODE_TTL_MS = 5 * 60 * 1000;

// POST /api/auth/teable-token-exchange
// Exchanges the short-lived OAuth callback code for a JWT.
router.post('/teable-token-exchange', (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: '缺少 code' });

  const stored = loginCodeStore.get(code);
  if (!stored) return res.status(400).json({ error: '登录 code 无效或已过期' });
  loginCodeStore.delete(code);

  if (Date.now() - stored.createdAt > LOGIN_CODE_TTL_MS) {
    return res.status(400).json({ error: '登录 code 已过期' });
  }

  res.json({ token: stored.token, user: stored.user });
});

// GET /api/auth/teable-login
// Redirect browser to Teable authorization page
router.get('/teable-login', (req, res) => {
  const nonce = crypto.randomBytes(16).toString('hex');
  const state = Buffer.from(JSON.stringify({ nonce, type: 'login' })).toString('base64url');

  loginOAuthState.set(nonce, { createdAt: Date.now() });
  setTimeout(() => loginOAuthState.delete(nonce), 10 * 60 * 1000);

  const redirectUri = `${SERVER_PUBLIC_URL}/api/auth/teable-callback`;
  const authUrl =
    `${TEABLE_OAUTH_HOST}/api/oauth/authorize?` +
    `response_type=code&` +
    `client_id=${TEABLE_OAUTH_CLIENT_ID}&` +
    `redirect_uri=${encodeURIComponent(redirectUri)}&` +
    `scope=${encodeURIComponent('record|read table|read user|email_read')}&` +
    `state=${state}`;

  console.log(`[Auth OAuth] Redirecting to Teable for login, callback=${redirectUri}`);
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
        redirect_uri: `${SERVER_PUBLIC_URL}/api/auth/teable-callback`,
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

    // Get Teable user info — required for login
    const meUrl = `${TEABLE_OAUTH_HOST}/api/auth/user`;
    const meRes = await fetch(meUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    console.log(`[Auth OAuth] User info response: ${meRes.status}`);

    if (!meRes.ok) {
      const errText = await meRes.text().catch(() => '');
      console.error(`[Auth OAuth] User info failed: ${meRes.status} - ${errText}`);
      throw new Error(`无法获取 Teable 用户信息（${meRes.status}），请确保 OAuth App 有 user:email_read 权限`);
    }

    const teableUser = await meRes.json();

    const email = teableUser?.email;
    if (!email) {
      throw new Error('Teable 用户没有邮箱信息，请检查账户配置');
    }

    // Find or create user
    const users = loadUsers();
    let user = users.find(u => u.email === email);

    if (!user) {
      const isFirst = users.length === 0;
      user = {
        id: crypto.randomUUID(),
        email,
        passwordHash: await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10),
        role: isFirst ? ROLES.OWNER : ROLES.USER,
        teableOAuthToken: accessToken,
        createdAt: new Date().toISOString(),
      };
      users.push(user);
      saveUsers(users);
      console.log(`[Auth OAuth] Auto-created user from Teable login`);
    } else {
      const idx = users.findIndex(u => u.id === user.id);
      users[idx].teableOAuthToken = accessToken;
      saveUsers(users);
    }

    // Issue JWT
    const jwtToken = signToken({ id: user.id, email: user.email, role: user.role });
    const safeUser = sanitizeUser(user);
    const loginCode = crypto.randomBytes(32).toString('hex');
    loginCodeStore.set(loginCode, { token: jwtToken, user: safeUser, createdAt: Date.now() });
    setTimeout(() => loginCodeStore.delete(loginCode), LOGIN_CODE_TTL_MS);

    // Redirect with a short-lived one-time code instead of a bearer token.
    const redirectUrl = `${FRONTEND_BASE_URL}/?oauth_code=${loginCode}`;
    console.log(`[Auth OAuth] Redirecting to frontend after successful login`);
    res.redirect(redirectUrl);

  } catch (err) {
    console.error(`[Auth OAuth] Error: ${err.message}`);
    res.redirect(`${FRONTEND_BASE_URL}/?auth_error=${encodeURIComponent(err.message)}`);
  }
});

// ─── User Management ─────────────────────────────────────────────────────

// DELETE /api/auth/users/:id
router.delete('/users/:id', authMiddleware, (req, res) => {
  if (!isOwner(req.user)) {
    return res.status(403).json({ error: '仅系统所有者可操作' });
  }
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: '不能删除自己' });
  }
  let users = loadUsers();
  const target = users.find(u => u.id === req.params.id);
  if (!target) return res.status(404).json({ error: '用户不存在' });
  if (isAdmin(target)) {
    return res.status(400).json({ error: '不能删除系统所有者或超级管理员' });
  }
  users = users.filter(u => u.id !== req.params.id);
  saveUsers(users);
  appendAuditLog(req.user, 'user.delete', {
    resourceType: 'user',
    resourceId: target.id,
    resourceName: target.email,
    message: `删除用户 ${target.email}`,
  });
  res.json({ ok: true });
});

// PUT /api/auth/users/:id/role — 分配角色（仅 owner）
router.put('/users/:id/role', authMiddleware, (req, res) => {
  if (!isOwner(req.user)) {
    return res.status(403).json({ error: '仅系统所有者可调整角色' });
  }
  const { role } = req.body;
  if (![ROLES.USER, ROLES.SUPER_ADMIN].includes(role)) {
    return res.status(400).json({ error: '角色只能是普通用户或超级管理员' });
  }
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: '不能修改自己的角色' });
  }
  const users = loadUsers();
  const idx = users.findIndex(u => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '用户不存在' });
  if (users[idx].role === ROLES.OWNER) {
    return res.status(400).json({ error: '不能修改系统所有者角色' });
  }
  const previousRole = users[idx].role;
  users[idx].role = role;
  saveUsers(users);
  appendAuditLog(req.user, 'user.role.update', {
    resourceType: 'user',
    resourceId: users[idx].id,
    resourceName: users[idx].email,
    message: `更新用户角色 ${users[idx].email}: ${roleLabel(previousRole)} -> ${roleLabel(role)}`,
    metadata: { previousRole, role },
  });
  res.json(sanitizeUser(users[idx]));
});

export default router;
