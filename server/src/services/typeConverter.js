// Type converter for SQL → Teable field mapping
// Provides type compatibility matrix + value converters

/**
 * SQL type → Teable type compatibility matrix
 * Each entry: { safe: boolean, warning?: string, converter: (value) => convertedValue }
 */
export const TYPE_COMPATIBILITY = {
  // Integer types → number
  int: {
    number: { safe: true, converter: (v) => Number(v) },
    singleLineText: { safe: false, warning: '数字转文本，排序/筛选会失效', converter: (v) => String(v) },
  },
  bigint: {
    number: { safe: true, converter: (v) => Number(v) },
    singleLineText: { safe: false, warning: '大整数可能溢出', converter: (v) => String(v) },
  },
  smallint: {
    number: { safe: true, converter: (v) => Number(v) },
    singleLineText: { safe: false, warning: '数字转文本', converter: (v) => String(v) },
  },
  tinyint: {
    number: { safe: true, converter: (v) => Number(v) },
    singleLineText: { safe: false, warning: '数字转文本', converter: (v) => String(v) },
  },

  // Decimal types → number
  decimal: {
    number: { safe: true, converter: (v) => Number(v) },
    singleLineText: { safe: false, warning: '精度可能丢失', converter: (v) => String(v) },
  },
  numeric: {
    number: { safe: true, converter: (v) => Number(v) },
    singleLineText: { safe: false, warning: '精度可能丢失', converter: (v) => String(v) },
  },
  float: {
    number: { safe: true, converter: (v) => Number(v) },
    singleLineText: { safe: false, warning: '浮点精度问题', converter: (v) => String(v) },
  },
  double: {
    number: { safe: true, converter: (v) => Number(v) },
    singleLineText: { safe: false, warning: '浮点精度问题', converter: (v) => String(v) },
  },
  real: {
    number: { safe: true, converter: (v) => Number(v) },
    singleLineText: { safe: false, warning: '浮点精度问题', converter: (v) => String(v) },
  },
  money: {
    number: { safe: true, converter: (v) => Number(v) },
    singleLineText: { safe: false, warning: '金额转文本', converter: (v) => String(v) },
  },

  // Boolean → checkbox
  bit: {
    checkbox: { safe: true, converter: (v) => Boolean(v) },
    number: { safe: false, warning: '布尔转数字(0/1)', converter: (v) => v ? 1 : 0 },
    singleLineText: { safe: false, warning: '布尔转文本', converter: (v) => v ? 'true' : 'false' },
  },
  boolean: {
    checkbox: { safe: true, converter: (v) => Boolean(v) },
    number: { safe: false, warning: '布尔转数字', converter: (v) => v ? 1 : 0 },
    singleLineText: { safe: false, warning: '布尔转文本', converter: (v) => v ? 'true' : 'false' },
  },
  bool: {
    checkbox: { safe: true, converter: (v) => Boolean(v) },
    number: { safe: false, warning: '布尔转数字', converter: (v) => v ? 1 : 0 },
    singleLineText: { safe: false, warning: '布尔转文本', converter: (v) => v ? 'true' : 'false' },
  },

  // Date/Time → date
  datetime: {
    date: { safe: true, converter: (v) => convertDateToISO(v, true) },
    singleLineText: { safe: false, warning: '时间转文本', converter: (v) => convertDateToISO(v, false) },
  },
  timestamp: {
    date: { safe: true, converter: (v) => convertDateToISO(v, true) },
    singleLineText: { safe: false, warning: '时间转文本', converter: (v) => convertDateToISO(v, false) },
  },
  date: {
    date: { safe: true, converter: (v) => convertDateToISO(v, true) },
    singleLineText: { safe: false, warning: '日期转文本', converter: (v) => convertDateToISO(v, true) },
  },
  smalldatetime: {
    date: { safe: true, converter: (v) => convertDateToISO(v, true) },
    singleLineText: { safe: false, warning: '时间转文本', converter: (v) => convertDateToISO(v, false) },
  },
  datetime2: {
    date: { safe: true, converter: (v) => convertDateToISO(v, true) },
    singleLineText: { safe: false, warning: '时间转文本', converter: (v) => convertDateToISO(v, false) },
  },
  time: {
    singleLineText: { safe: false, warning: '时间无日期部分', converter: (v) => String(v) },
  },

  // Text → singleLineText / longText
  varchar: {
    singleLineText: { safe: true, converter: (v) => String(v) },
    longText: { safe: true, converter: (v) => String(v) },
    number: { safe: false, warning: '文本转数字可能失败', converter: tryParseNumber },
  },
  nvarchar: {
    singleLineText: { safe: true, converter: (v) => String(v) },
    longText: { safe: true, converter: (v) => String(v) },
    number: { safe: false, warning: '文本转数字可能失败', converter: tryParseNumber },
  },
  char: {
    singleLineText: { safe: true, converter: (v) => String(v).trim() },
    longText: { safe: true, converter: (v) => String(v).trim() },
  },
  nchar: {
    singleLineText: { safe: true, converter: (v) => String(v).trim() },
    longText: { safe: true, converter: (v) => String(v).trim() },
  },
  text: {
    longText: { safe: true, converter: (v) => String(v) },
    singleLineText: { safe: false, warning: '长文本可能截断', converter: (v) => String(v) },
  },
  ntext: {
    longText: { safe: true, converter: (v) => String(v) },
    singleLineText: { safe: false, warning: '长文本可能截断', converter: (v) => String(v) },
  },
  json: {
    longText: { safe: true, converter: (v) => typeof v === 'object' ? JSON.stringify(v) : String(v) },
    singleLineText: { safe: false, warning: 'JSON转文本', converter: (v) => typeof v === 'object' ? JSON.stringify(v) : String(v) },
  },
  xml: {
    longText: { safe: true, converter: (v) => String(v) },
    singleLineText: { safe: false, warning: 'XML转文本', converter: (v) => String(v) },
  },

  // Binary → attachment (not supported, skip)
  binary: {
    attachment: { safe: false, warning: '二进制附件暂不支持', converter: () => null },
  },
  varbinary: {
    attachment: { safe: false, warning: '二进制附件暂不支持', converter: () => null },
  },
  blob: {
    attachment: { safe: false, warning: '二进制附件暂不支持', converter: () => null },
  },
  image: {
    attachment: { safe: false, warning: '图片附件暂不支持', converter: () => null },
  },

  // GUID → singleLineText
  uniqueidentifier: {
    singleLineText: { safe: true, converter: (v) => String(v) },
  },
  uuid: {
    singleLineText: { safe: true, converter: (v) => String(v) },
  },
};

/**
 * Normalize SQL type name for lookup
 */
export function normalizeSqlType(sqlType) {
  const t = (sqlType || '').toLowerCase();
  // Handle type with parameters: varchar(255) → varchar
  const baseType = t.split('(')[0].split(' ')[0];
  // Map aliases
  const aliases = {
    'character varying': 'varchar',
    'character': 'char',
    'integer': 'int',
    'smallint': 'smallint',
    'bigint': 'bigint',
    'real': 'real',
    'double precision': 'double',
    'timestamp without time zone': 'timestamp',
    'timestamp with time zone': 'timestamp',
    'time without time zone': 'time',
    'time with time zone': 'time',
    'bytea': 'binary',
  };
  return aliases[baseType] || baseType;
}

/**
 * Get best Teable type suggestion for a SQL type
 */
export function suggestTeableType(sqlType) {
  const norm = normalizeSqlType(sqlType);
  const compat = TYPE_COMPATIBILITY[norm];
  if (!compat) {
    // Default to singleLineText for unknown types
    return { type: 'singleLineText', safe: false, warning: '未知类型，默认为文本' };
  }
  // Find the safest type
  for (const [teableType, info] of Object.entries(compat)) {
    if (info.safe) {
      return { type: teableType, safe: true, options: getDefaultOptions(teableType, sqlType) };
    }
  }
  // No safe type, use first available
  const [teableType, info] = Object.entries(compat)[0];
  return { type: teableType, safe: false, warning: info.warning, options: getDefaultOptions(teableType, sqlType) };
}

/**
 * Get default options for Teable field type
 */
function getDefaultOptions(teableType, sqlType) {
  const t = normalizeSqlType(sqlType);
  if (teableType === 'number') {
    if (t.includes('int')) return { formatting: { precision: 0, type: 'decimal' } };
    if (t.includes('decimal') || t.includes('numeric')) return { formatting: { precision: 2, type: 'decimal' } };
    return { formatting: { precision: 2, type: 'decimal' } };
  }
  if (teableType === 'date') {
    return { formatting: { date: 'YYYY-MM-DD', time: 'None', timeZone: 'Asia/Shanghai' } };
  }
  return {};
}

/**
 * Convert a value from SQL type to Teable type
 */
function normalizeTeableFieldType(type) {
  return String(type || '').toLowerCase().replace(/[_-]/g, '');
}

function convertTeableValue(value, sourceType, targetType) {
  const src = normalizeTeableFieldType(sourceType);
  const tgt = normalizeTeableFieldType(targetType);
  if (src === tgt) return value;
  if (['singlelinetext', 'longtext'].includes(tgt)) {
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }
  if (tgt === 'number') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (tgt === 'checkbox') return Boolean(value);
  if (tgt === 'date') return convertDateToISO(value, false);
  return value;
}

export function convertValue(value, sqlType, teableType) {
  if (value === null || value === undefined) return null;

  if (String(sqlType || '').startsWith('teable:')) {
    return convertTeableValue(value, String(sqlType).slice(7), teableType);
  }
  
  const norm = normalizeSqlType(sqlType);
  const compat = TYPE_COMPATIBILITY[norm];
  if (!compat) return value; // Unknown type, pass through
  
  const typeInfo = compat[teableType];
  if (!typeInfo) {
    // Target type not in compatibility matrix, try safe conversion
    console.warn(`No converter for ${norm} → ${teableType}, passing raw value`);
    return value;
  }
  
  try {
    return typeInfo.converter(value);
  } catch (e) {
    console.warn(`Conversion failed for ${norm} → ${teableType}: ${e.message}`);
    return null;
  }
}

/**
 * Check if a SQL → Teable type mapping is safe
 */
function isTextType(type) {
  return ['singlelinetext', 'longtext'].includes(normalizeTeableFieldType(type));
}

export function isTypeCompatible(sqlType, teableType) {
  if (String(sqlType || '').startsWith('teable:')) {
    const src = normalizeTeableFieldType(String(sqlType).slice(7));
    const tgt = normalizeTeableFieldType(teableType);
    if (src === tgt) return { safe: true, warning: null };
    if (isTextType(tgt)) return { safe: false, warning: 'Teable 字段转文本，格式可能变化' };
    if (src === 'number' && tgt === 'number') return { safe: true, warning: null };
    if (src === 'date' && tgt === 'date') return { safe: true, warning: null };
    if (src === 'checkbox' && tgt === 'checkbox') return { safe: true, warning: null };
    return { safe: false, warning: '不兼容的目标类型' };
  }

  const norm = normalizeSqlType(sqlType);
  const compat = TYPE_COMPATIBILITY[norm];
  if (!compat) return { safe: false, warning: '未知SQL类型' };
  
  const typeInfo = compat[teableType];
  if (!typeInfo) return { safe: false, warning: '不兼容的目标类型' };
  
  return { safe: typeInfo.safe, warning: typeInfo.warning || null };
}

// Helper functions

function convertDateToISO(value, dateOnly = false) {
  if (value instanceof Date) {
    const iso = value.toISOString();
    return dateOnly ? iso.split('T')[0] : iso;
  }
  if (typeof value === 'string') {
    // Already a string, try to parse and format
    const d = new Date(value);
    if (isNaN(d.getTime())) return value; // Invalid date, return raw
    const iso = d.toISOString();
    return dateOnly ? iso.split('T')[0] : iso;
  }
  return String(value);
}

function tryParseNumber(value) {
  if (typeof value === 'number') return value;
  const n = Number(value);
  return isNaN(n) ? value : n; // Return original if can't parse
}