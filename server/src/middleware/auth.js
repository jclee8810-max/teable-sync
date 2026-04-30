import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.warn('[Auth] ⚠️ JWT_SECRET not set! Using insecure fallback for development only.');
  console.warn('[Auth] In production, set JWT_SECRET environment variable.');
}
const _jwtSecret = JWT_SECRET || 'teable-sync-dev-only-secret-CHANGE-ME';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h';

function signToken(payload) {
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
  req.user = decoded;
  next();
}

export function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const decoded = verifyToken(token);
    if (decoded) req.user = decoded;
  }
  next();
}

export { JWT_SECRET };
