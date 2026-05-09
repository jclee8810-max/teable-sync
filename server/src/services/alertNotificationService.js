const DEFAULT_SETTINGS = {
  enabled: false,
  channel: 'webhook',
  webhookUrl: '',
  minSeverity: 'critical',
  cooldownMinutes: 30,
  includeWarnings: false,
  lastSent: {},
  lastError: null,
  lastTestAt: null,
  lastSentAt: null,
};

const SEVERITY_RANK = { critical: 3, warning: 2, info: 1 };

function clone(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

export function normalizeAlertNotificationSettings(settings = {}) {
  const next = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  next.enabled = next.enabled === true;
  next.channel = next.channel || 'webhook';
  next.minSeverity = ['critical', 'warning', 'info'].includes(next.minSeverity) ? next.minSeverity : 'critical';
  next.cooldownMinutes = Math.min(1440, Math.max(1, Number(next.cooldownMinutes || DEFAULT_SETTINGS.cooldownMinutes)));
  next.includeWarnings = next.minSeverity === 'warning' || next.minSeverity === 'info' || next.includeWarnings === true;
  next.lastSent = next.lastSent && typeof next.lastSent === 'object' ? next.lastSent : {};
  return next;
}

export function sanitizeAlertNotificationSettings(settings = {}) {
  const next = normalizeAlertNotificationSettings(settings);
  return {
    ...next,
    webhookUrl: next.webhookUrl ? maskWebhookUrl(next.webhookUrl) : '',
    hasWebhookUrl: Boolean(next.webhookUrl),
  };
}

function maskWebhookUrl(url) {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.length > 12 ? `${parsed.pathname.slice(0, 8)}...${parsed.pathname.slice(-4)}` : parsed.pathname;
    return `${parsed.protocol}//${parsed.host}${path}`;
  } catch {
    return '已配置';
  }
}

export function cleanAlertNotificationInput(body = {}, current = {}) {
  const base = normalizeAlertNotificationSettings(current);
  const next = {
    ...base,
    enabled: body.enabled === true,
    channel: 'webhook',
    minSeverity: body.minSeverity,
    cooldownMinutes: body.cooldownMinutes,
    includeWarnings: body.includeWarnings,
  };
  if (typeof body.webhookUrl === 'string') {
    const value = body.webhookUrl.trim();
    if (value) {
      const parsed = new URL(value);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Webhook URL 必须是 HTTP 或 HTTPS 地址');
      next.webhookUrl = value;
    } else {
      next.webhookUrl = '';
    }
  }
  return normalizeAlertNotificationSettings(next);
}

function shouldSendAlert(alert, settings, now = Date.now()) {
  const minRank = SEVERITY_RANK[settings.minSeverity] || SEVERITY_RANK.critical;
  if ((SEVERITY_RANK[alert.severity] || 0) < minRank) return false;
  const last = settings.lastSent?.[alert.id] ? new Date(settings.lastSent[alert.id]).getTime() : 0;
  const cooldownMs = Number(settings.cooldownMinutes || DEFAULT_SETTINGS.cooldownMinutes) * 60 * 1000;
  return !last || now - last >= cooldownMs;
}

export function buildAlertWebhookPayload({ alert, snapshot, appUrl = null, test = false }) {
  return {
    source: 'teable-sync',
    event: test ? 'alert.test' : 'alert.open',
    sentAt: new Date().toISOString(),
    severity: alert.severity,
    type: alert.type,
    title: alert.title,
    message: alert.message,
    alertId: alert.id,
    taskId: alert.taskId,
    taskName: alert.taskName,
    runId: alert.metadata?.runId || alert.metadata?.latestRunId || null,
    suggestedAction: alert.metadata?.suggestedAction || defaultSuggestedAction(alert),
    appUrl,
    metadata: alert.metadata || {},
    summary: snapshot?.summary ? clone(snapshot.summary) : null,
    teable: {
      title: `[Teable Sync] ${alert.title}`,
      content: `${alert.message}${alert.taskName ? `\n任务：${alert.taskName}` : ''}`,
      severity: alert.severity,
    },
  };
}

function defaultSuggestedAction(alert) {
  if (alert.type === 'sync_failure') return '打开任务失败批次，重试或清理失败记录';
  if (alert.type === 'recent_failed') return '打开任务详情查看最近日志和运行历史';
  if (alert.type === 'connection') return '重新测试数据源连接';
  if (alert.type === 'scheduler_missing') return '停止并重新启动该自动任务';
  if (alert.type === 'stale_task') return '检查调度器状态和最近运行日志';
  return '打开 Teable Sync 观测告警页面查看详情';
}

async function postWebhook(url, payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Webhook returned ${res.status}: ${text.slice(0, 300)}`);
    return { status: res.status, body: text.slice(0, 500) };
  } finally {
    clearTimeout(timeout);
  }
}

export async function sendAlertNotifications({ settings, snapshot, appUrl = null }) {
  const nextSettings = normalizeAlertNotificationSettings(settings);
  if (!nextSettings.enabled || !nextSettings.webhookUrl) return { sent: 0, skipped: true, settings: nextSettings };
  const now = Date.now();
  const candidates = (snapshot.alerts || []).filter((alert) => shouldSendAlert(alert, nextSettings, now));
  let sent = 0;
  for (const alert of candidates) {
    await postWebhook(nextSettings.webhookUrl, buildAlertWebhookPayload({ alert, snapshot, appUrl }));
    nextSettings.lastSent[alert.id] = new Date().toISOString();
    nextSettings.lastSentAt = nextSettings.lastSent[alert.id];
    sent += 1;
  }
  nextSettings.lastError = null;
  return { sent, skipped: false, settings: nextSettings };
}

export async function sendTestAlertNotification({ settings, appUrl = null }) {
  const nextSettings = normalizeAlertNotificationSettings(settings);
  if (!nextSettings.webhookUrl) throw new Error('请先配置 Webhook URL');
  const alert = {
    id: `test-${Date.now()}`,
    severity: 'critical',
    type: 'test',
    title: '测试告警通知',
    message: '这是一条来自 Teable Sync 的测试告警。Teable 自动化可以基于此 payload 记录告警或继续推送。',
    taskId: null,
    taskName: null,
    metadata: { test: true },
  };
  const result = await postWebhook(nextSettings.webhookUrl, buildAlertWebhookPayload({ alert, snapshot: null, appUrl, test: true }));
  nextSettings.lastTestAt = new Date().toISOString();
  nextSettings.lastError = null;
  return { success: true, result, settings: nextSettings };
}
