// Teable API service - corrected API paths

const DEFAULT_RETRY_COUNT = 3;
const DEFAULT_RETRY_BASE_MS = 500;
const DEFAULT_REQUEST_GAP_MS = 120;

let lastRequestAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function throttleTeableRequests(options = {}) {
  const gapMs = Number(options.rateLimitMs ?? process.env.TEABLE_RATE_LIMIT_MS ?? DEFAULT_REQUEST_GAP_MS);
  if (gapMs <= 0) return;
  const now = Date.now();
  const waitMs = Math.max(0, lastRequestAt + gapMs - now);
  if (waitMs > 0) await sleep(waitMs);
  lastRequestAt = Date.now();
}

function shouldRetry(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

async function teableRequest(conn, path, options = {}) {
  const baseUrl = (conn.host || conn.baseUrl || '').replace(/\/+$/, '');
  const url = `${baseUrl}${path}`;
  const retryCount = Number(options.retryCount ?? conn.retryCount ?? DEFAULT_RETRY_COUNT);
  const retryBaseMs = Number(options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS);
  const { retryCount: _retryCount, retryBaseMs: _retryBaseMs, rateLimitMs: _rateLimitMs, ...fetchOptions } = options;
  const headers = {
    Authorization: `Bearer ${conn.token}`,
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };

  for (let attempt = 0; attempt <= retryCount; attempt++) {
    await throttleTeableRequests(options);
    let res;
    try {
      res = await fetch(url, { ...fetchOptions, headers });
    } catch (err) {
      if (attempt >= retryCount) throw err;
      await sleep(retryBaseMs * 2 ** attempt);
      continue;
    }

    if (res.ok) {
      if (res.status === 204) return null;
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    }

    const text = await res.text();
    if (attempt < retryCount && shouldRetry(res.status)) {
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(retryAfter) ? retryAfter * 1000 : retryBaseMs * 2 ** attempt);
      continue;
    }
    throw new Error(`Teable API ${res.status}: ${text}`);
  }
}

export async function getTeableSpaces(conn) {
  return teableRequest(conn, '/api/space');
}

export async function getTeableBases(conn) {
  // First get spaces, then get bases for each space
  const spaces = await getTeableSpaces(conn);
  const allBases = [];
  for (const space of spaces) {
    try {
      const bases = await teableRequest(conn, `/api/space/${space.id}/base`);
      allBases.push(...bases);
    } catch (e) {
      // Skip spaces we can't read
      console.warn(`Cannot read space ${space.id}: ${e.message}`);
    }
  }
  return allBases;
}

export async function getTeableBasesBySpace(conn, spaceId) {
  return teableRequest(conn, `/api/space/${spaceId}/base`);
}

export async function getTeableTables(conn, baseId) {
  return teableRequest(conn, `/api/base/${baseId}/table`);
}

export async function getTeableFields(conn, tableId) {
  return teableRequest(conn, `/api/table/${tableId}/field`);
}

export function normalizeTeableRecordsResponse(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.records)) return result.records;
  if (Array.isArray(result?.data?.records)) return result.data.records;
  if (Array.isArray(result?.data)) return result.data;
  return [];
}

export function teableFieldToSourceColumn(field) {
  return {
    name: field.name,
    type: field.type,
    id: field.id,
    options: field.options || {},
  };
}

export async function getTeableRecords(conn, tableId, options = {}) {
  const params = new URLSearchParams();
  params.set('fieldKeyType', options.fieldKeyType || 'name');
  if (options.filter) params.set('filter', JSON.stringify(options.filter));
  if (options.sort) params.set('sort', JSON.stringify(options.sort));
  // Teable record list pagination uses take/skip.
  if (options.take != null) params.set('take', options.take);
  else if (options.pageSize != null) params.set('take', options.pageSize);
  if (options.skip != null) params.set('skip', options.skip);
  else if (options.page != null) params.set('skip', (Math.max(1, Number(options.page)) - 1) * Number(options.pageSize || options.take || 100));

  const qs = params.toString();
  const path = `/api/table/${tableId}/record${qs ? '?' + qs : ''}`;
  return teableRequest(conn, path);
}

export async function createTeableRecords(conn, tableId, records) {
  return teableRequest(conn, `/api/table/${tableId}/record`, {
    method: 'POST',
    body: JSON.stringify({ fieldKeyType: 'name', records }),
  });
}

export async function updateTeableRecords(conn, tableId, records) {
  return teableRequest(conn, `/api/table/${tableId}/record`, {
    method: 'PATCH',
    body: JSON.stringify({ fieldKeyType: 'name', records }),
  });
}

export async function deleteTeableRecords(conn, tableId, recordIds) {
  const ids = Array.isArray(recordIds) ? recordIds : [recordIds];
  if (ids.length === 0) return null;
  const params = new URLSearchParams();
  for (const id of ids) params.append('recordIds[]', id);
  return teableRequest(conn, `/api/table/${tableId}/record?${params.toString()}`, {
    method: 'DELETE',
  });
}

// ─── Field creation (auto field creation for new tables) ────────────────────


/**
 * Convert SQL column type to Teable field type + default options
 */
export function sourceTypeToTeable(sourceType) {
  const t = String(sourceType || '').toLowerCase();
  const directTypes = {
    singlelinetext: 'singleLineText',
    longtext: 'longText',
    number: 'number',
    date: 'date',
    checkbox: 'checkbox',
    attachment: 'attachment',
    singleselect: 'singleSelect',
    multipleselect: 'multipleSelect',
  };
  if (directTypes[t]) return { type: directTypes[t], options: {} };
  if (['user', 'createdtime', 'lastmodifiedtime', 'createdby', 'lastmodifiedby', 'autonumber', 'formula', 'rollup', 'link'].includes(t)) {
    return { type: 'singleLineText', options: {} };
  }
  return sqlTypeToTeable(sourceType);
}

export function sqlTypeToTeable(sqlType) {
  const t = (sqlType || '').toLowerCase();
  if (t.includes('int') || t.includes('bigint') || t.includes('smallint') || t.includes('tinyint') || t.includes('serial'))
    return { type: 'number', options: { formatting: { precision: 0, type: 'decimal' } } };
  if (t.includes('decimal') || t.includes('numeric') || t.includes('float') || t.includes('double') || t.includes('real') || t.includes('money'))
    return { type: 'number', options: { formatting: { precision: 2, type: 'decimal' } } };
  if (t.includes('bit') || t.includes('boolean') || t.includes('bool'))
    return { type: 'checkbox', options: {} };
  if (t.includes('date') || t.includes('time') || t.includes('timestamp'))
    return { type: 'date', options: { formatting: { date: 'YYYY-MM-DD', time: 'None', timeZone: 'Asia/Shanghai' } } };
  if (t.includes('binary') || t.includes('blob') || t.includes('image'))
    return { type: 'attachment', options: {} };
  // text types (varchar, text, char, nvarchar, json, xml)
  return { type: 'singleLineText', options: {} };
}

/**
 * Sanitize field name for Teable: trim, max 50 chars, replace spaces with underscores
 */
function sanitizeFieldName(name) {
  return (name || '').trim().substring(0, 50).replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_\u4e00\-\鿿]/g, '_');
}

/**
 * Create a single field in Teable. Returns the created field object.
 */
export async function createTeableField(conn, tableId, fieldName, sqlType) {
  const info = sqlTypeToTeable(sqlType);
  const name = sanitizeFieldName(fieldName);
  return teableRequest(conn, `/api/table/${tableId}/field`, {
    method: 'POST',
    body: JSON.stringify({ name, type: info.type, options: info.options }),
  });
}

/**
 * Ensure target table has all required fields from source schema.
 * Returns a map of sourceColumnName → targetFieldName (either existing or newly created).
 * Skips attachment fields and already-existing fields.
 * P0-2 fix: field creation failure → skip column entirely, do NOT map to non-existent field.
 */
export async function ensureTeableFields(conn, tableId, sourceSchema, columnMapping, existingFields, log) {
  const existingFieldNames = new Set(existingFields.map(f => f.name));
  const createdFields = [];
  const skippedAttachmentCols = [];
  const skippedFailedCols = []; // P0-2: track columns that failed to create
  const mapping = {};


  for (const col of sourceSchema) {
    const tgtName = columnMapping[col.name] || col.name;
    if (existingFieldNames.has(tgtName)) {
      mapping[col.name] = tgtName;
      continue;
    }

    // Field doesn't exist → try to create it
    const info = sourceTypeToTeable(col.type);
    if (info.type === 'attachment') {
      skippedAttachmentCols.push(col.name);
      continue;
    }
    try {
      const created = await createTeableField(conn, tableId, tgtName, col.type);
      mapping[col.name] = created.name; // Teable may rename (e.g. trim spaces)
      createdFields.push({ col: col.name, fieldId: created.id, fieldName: created.name, type: info.type });
      log('info', `  🆕 自动创建字段: ${col.name} (${col.type}) → ${created.name} [${info.type}]`);
    } catch (e) {
      // P0-2 fix: if creation fails, skip this column — do NOT map to non-existent field
      log('warn', `  ⚠️ 创建字段失败 ${col.name}，已跳过: ${e.message}`);
      skippedFailedCols.push(col.name);
      continue;
    }
  }

  if (skippedAttachmentCols.length > 0) {
    log('warn', `  ⚠️ 跳过附件字段(暂不支持同步): ${skippedAttachmentCols.join(', ')}`);
  }
  if (skippedFailedCols.length > 0) {
    log('warn', `  ⚠️ 跳过创建失败的字段(数据不会同步): ${skippedFailedCols.join(', ')}`);
  }

  return { mapping, createdFields, skippedAttachmentCols, skippedFailedCols };
}
