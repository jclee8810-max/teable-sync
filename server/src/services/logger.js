const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
const currentLevel = LEVELS[String(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;
const SENSITIVE_KEY_RE = /(password|token|secret|authorization|cookie|clientsecret|oauthclientsecret|teableoauthtoken)/i;
const BEARER_RE = /Bearer\s+[A-Za-z0-9._~+/-]+/gi;
const TOKEN_RE = /([?&](?:token|access_token|oauth_token|client_secret)=)[^&\s]+/gi;

function shouldLog(level) {
  return (LEVELS[level] ?? LEVELS.info) >= currentLevel;
}

export function redact(value) {
  if (value === null || value === undefined) return value;
  if (value instanceof Error) return value;
  if (typeof value === 'string') {
    return value.replace(BEARER_RE, 'Bearer [REDACTED]').replace(TOKEN_RE, '$1[REDACTED]');
  }
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY_RE.test(key) ? '[REDACTED]' : redact(item);
    }
    return out;
  }
  return value;
}

function formatArg(arg) {
  if (arg instanceof Error) return arg.stack || arg.message;
  const safe = redact(arg);
  if (typeof safe === 'string') return safe;
  try {
    return JSON.stringify(safe);
  } catch {
    return String(safe);
  }
}

function write(level, args) {
  if (!shouldLog(level)) return;
  const line = args.map(formatArg).join(' ');
  const prefix = `[${new Date().toISOString()}] [${level.toUpperCase()}]`;
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  sink(`${prefix} ${line}`);
}

export const logger = {
  debug: (...args) => write('debug', args),
  info: (...args) => write('info', args),
  warn: (...args) => write('warn', args),
  error: (...args) => write('error', args),
};

export default logger;
