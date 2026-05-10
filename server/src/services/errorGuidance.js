const RULES = [
  {
    errorType: 'connection_expired',
    severity: 'warning',
    actionTarget: 'connections',
    summary: '数据源测试结果已过期',
    suggestedAction: '前往数据源页面重新测试源端和目标端连接，测试通过后再运行任务。',
    patterns: [/超过\s*30\s*天/i, /测试已过期/i, /重新测试连接/i, /stale connection/i],
  },
  {
    errorType: 'permission',
    severity: 'critical',
    actionTarget: 'connections',
    summary: '连接账号或令牌权限不足',
    suggestedAction: '检查数据源账号、Teable Token、Base/Table 权限，更新后重新测试连接。',
    patterns: [/401|403/i, /unauthorized|forbidden/i, /permission|access denied/i, /权限|无权|未授权/i, /token.*invalid|invalid.*token/i],
  },
  {
    errorType: 'rate_limit',
    severity: 'warning',
    actionTarget: 'task_settings',
    summary: '接口限流或请求配额不足',
    suggestedAction: '降低写入批量或初始化速率，等待冷却后从断点继续运行。',
    patterns: [/429/i, /rate limit|too many requests|quota/i, /限流|请求过多|配额/i],
  },
  {
    errorType: 'timeout',
    severity: 'warning',
    actionTarget: 'task_settings',
    summary: '网络超时或连接被中断',
    suggestedAction: '确认网络和目标服务稳定性；若是大表初始化，建议降低批量后继续初始化。',
    patterns: [/timeout|timed out|etimedout/i, /econnreset|socket hang up|aborted/i, /超时|连接中断/i],
  },
  {
    errorType: 'connection',
    severity: 'critical',
    actionTarget: 'connections',
    summary: '数据源连接不可用',
    suggestedAction: '前往数据源页面重新测试连接；如果失败，请修复地址、账号、密码或 Token。',
    patterns: [/尚未测试通过|最近测试失败/i, /connection not found|connect failed/i, /econnrefused|enotfound|eai_again/i, /连接.*失败|无法连接|数据源.*不可用/i],
  },
  {
    errorType: 'schema_drift',
    severity: 'warning',
    actionTarget: 'task_mapping',
    summary: '源端或目标端字段结构发生变化',
    suggestedAction: '打开任务字段变更检测，刷新字段快照并确认字段映射。',
    patterns: [/schema|snapshot|字段快照|字段变更|表结构/i, /column .*not found|unknown column|field .*not found/i, /字段.*不存在|列.*不存在/i],
  },
  {
    errorType: 'field_mapping',
    severity: 'critical',
    actionTarget: 'task_mapping',
    summary: '字段映射或主键配置不完整',
    suggestedAction: '打开任务配置检查字段映射、主键字段和目标唯一字段，保存后重新预检。',
    patterns: [/mapping|field mapping|primary key|target field|source field/i, /字段映射|主键|唯一字段|目标字段|源字段/i],
  },
  {
    errorType: 'data_type',
    severity: 'warning',
    actionTarget: 'task_mapping',
    summary: '字段值类型转换失败',
    suggestedAction: '检查报错字段的数据类型；必要时调整字段映射、目标字段类型或开启兼容转换。',
    patterns: [/invalid value|cannot convert|type mismatch|invalid date/i, /类型|日期|数字|布尔|转换失败|格式不正确/i],
  },
  {
    errorType: 'initialization_paused',
    severity: 'info',
    actionTarget: 'task_detail',
    summary: '初始化已暂停，可从断点继续',
    suggestedAction: '打开任务详情点击继续初始化，系统会从最近 checkpoint 接着跑。',
    patterns: [/sync_initialization_paused/i, /初始化.*暂停|继续初始化|到达.*运行时间/i],
  },
  {
    errorType: 'cancelled',
    severity: 'info',
    actionTarget: 'task_detail',
    summary: '运行被手动取消',
    suggestedAction: '确认取消是预期操作；需要继续时可手动同步或继续初始化。',
    patterns: [/sync_cancelled|cancelled/i, /已取消|手动取消|取消中/i],
  },
  {
    errorType: 'failure_batch',
    severity: 'critical',
    actionTarget: 'task_failures',
    summary: '存在可重放的失败批次',
    suggestedAction: '打开失败批次页面，先重试单批；确认无效数据后再清理记录。',
    patterns: [/失败批次|retry failures|retry-failures|failed batch/i, /batch|批次/i],
  },
  {
    errorType: 'preflight',
    severity: 'warning',
    actionTarget: 'task_preflight',
    summary: '同步前预检未通过',
    suggestedAction: '重新运行预检，根据阻断项修复连接、字段映射或初始化保护阈值。',
    patterns: [/preflight|预检|阻断同步|保护阈值/i],
  },
];

function messageOf(errorOrMessage) {
  if (!errorOrMessage) return '';
  if (typeof errorOrMessage === 'string') return errorOrMessage;
  return errorOrMessage.message || String(errorOrMessage);
}

export function classifySyncError(errorOrMessage, context = {}) {
  const message = messageOf(errorOrMessage);
  const haystack = [
    message,
    context.status,
    context.trigger,
    context.phase,
    context.taskName,
  ].filter(Boolean).join(' ');

  for (const rule of RULES) {
    if (rule.patterns.some((pattern) => pattern.test(haystack))) {
      return {
        errorType: rule.errorType,
        severity: rule.severity,
        summary: rule.summary,
        suggestedAction: rule.suggestedAction,
        actionTarget: rule.actionTarget,
      };
    }
  }

  return {
    errorType: 'unknown',
    severity: 'warning',
    summary: message ? '同步失败，原因需要进一步排查' : '任务状态异常',
    suggestedAction: '打开任务详情查看运行历史和近期日志；如果有失败批次，优先执行重试。',
    actionTarget: 'task_detail',
  };
}

export function actionTargetLabel(target) {
  const map = {
    connections: '数据源',
    task_mapping: '字段映射',
    task_preflight: '同步前预检',
    task_failures: '失败批次',
    task_detail: '任务详情',
    task_settings: '任务设置',
    observability: '观测告警',
  };
  return map[target] || '任务详情';
}
