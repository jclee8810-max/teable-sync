import jwt from 'jsonwebtoken';
import { readFileSync, writeFileSync, existsSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ensureOwner } from '../services/roles.js';
import { logger } from '../services/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || process.env.RUNTIME_STORE_DATA_DIR || join(__dirname, '..', '..', 'data');
const USERS_FILE = join(DATA_DIR, 'users.json');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  logger.warn('[Auth] JWT_SECRET not set. Using insecure fallback for development only.');
  logger.warn('[Auth] In production, set JWT_SECRET environment variable.');
}
const _jwtSecret = JWT_SECRET || 'teable-sync-dev-only-secret-CHANGE-ME';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h';

export function signToken(payload) {
  if (!_jwtSecret.includes('CHANGE-ME') && !JWT_SECRET) {
    // Still warn but allow dev mode
  }
  return jwt.sign(payload, _jwtSecret, { expiresIn: JWT_EXPIRES_IN });
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, _jwtSecret);
  } catch {
    return null;
  }
}

function saveUsers(users) {
  const tmpFile = `${USERS_FILE}.tmp`;
  writeFileSync(tmpFile, JSON.stringify(users, null, 2), 'utf-8');
  renameSync(tmpFile, USERS_FILE);
}

function loadCurrentUser(decoded) {
  if (!decoded?.id || !existsSync(USERS_FILE)) return decoded;
  try {
    const rawUsers = JSON.parse(readFileSync(USERS_FILE, 'utf-8'));
    const hadOwner = rawUsers.some((user) => user.role === 'owner');
    const users = ensureOwner(rawUsers);
    if (!hadOwner && users.some((user) => user.role === 'owner')) {
      saveUsers(users);
    }
    const current = users.find((user) => user.id === decoded.id);
    if (!current) return null;
    return {
      id: current.id,
      email: current.email,
      role: current.role,
      iat: decoded.iat,
      exp: decoded.exp,
    };
  } catch {
    return decoded;
  }
}

export function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未登录' });
  }
  const token = authHeader.slice(7);
  const decoded = verifyToken(token);
  if (!decoded) {
    return res.status(401).json({ error: 'Token无效或已过期' });
  }
  const currentUser = loadCurrentUser(decoded);
  if (!currentUser) {
    return res.status(401).json({ error: '用户不存在或已被删除' });
  }
  req.user = currentUser;
  next();
}

export function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const decoded = verifyToken(token);
    if (decoded) req.user = loadCurrentUser(decoded) || undefined;
  }
  next();
}

export { JWT_SECRET };
