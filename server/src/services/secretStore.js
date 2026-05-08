import crypto from 'crypto';

const SECRET_FIELDS = ['password', 'token', 'oauthClientSecret', 'teableOAuthToken'];
const NOTIFICATION_SECRET_FIELDS = ['webhookUrl'];
const ENCRYPTION_PREFIX = 'enc:v1:';

function getEncryptionKey() {
  const raw = process.env.CONFIG_ENCRYPTION_KEY || process.env.JWT_SECRET || '';
  if (!raw) return null;
  return crypto.createHash('sha256').update(raw).digest();
}

export function isEncryptedSecret(value) {
  return typeof value === 'string' && value.startsWith(ENCRYPTION_PREFIX);
}

export function encryptSecret(value) {
  if (value === undefined || value === null || value === '' || isEncryptedSecret(value)) return value;
  const key = getEncryptionKey();
  if (!key) return value;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENCRYPTION_PREFIX + Buffer.concat([iv, tag, encrypted]).toString('base64');
}

export function decryptSecret(value) {
  if (!isEncryptedSecret(value)) return value;
  const key = getEncryptionKey();
  if (!key) throw new Error('CONFIG_ENCRYPTION_KEY/JWT_SECRET is required to decrypt saved secrets');
  const payload = Buffer.from(value.slice(ENCRYPTION_PREFIX.length), 'base64');
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const encrypted = payload.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

export function encryptConnectionSecrets(conn) {
  const next = { ...conn };
  for (const field of SECRET_FIELDS) {
    if (next[field]) next[field] = encryptSecret(next[field]);
  }
  return next;
}

export function decryptConnectionSecrets(conn) {
  const next = { ...conn };
  for (const field of SECRET_FIELDS) {
    if (next[field]) next[field] = decryptSecret(next[field]);
  }
  return next;
}

export function decryptConfigSecrets(config) {
  return {
    ...config,
    connections: (config.connections || []).map(decryptConnectionSecrets),
    alertNotifications: decryptAlertNotificationSecrets(config.alertNotifications || {}),
  };
}

export function encryptConfigSecrets(config) {
  return {
    ...config,
    connections: (config.connections || []).map(encryptConnectionSecrets),
    alertNotifications: encryptAlertNotificationSecrets(config.alertNotifications || {}),
  };
}

export function encryptAlertNotificationSecrets(settings) {
  const next = { ...(settings || {}) };
  for (const field of NOTIFICATION_SECRET_FIELDS) {
    if (next[field]) next[field] = encryptSecret(next[field]);
  }
  return next;
}

export function decryptAlertNotificationSecrets(settings) {
  const next = { ...(settings || {}) };
  for (const field of NOTIFICATION_SECRET_FIELDS) {
    if (next[field]) next[field] = decryptSecret(next[field]);
  }
  return next;
}
