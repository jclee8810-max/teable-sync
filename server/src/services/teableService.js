// Teable API service - corrected API paths

async function teableRequest(conn, path, options = {}) {
  const baseUrl = (conn.host || conn.baseUrl || '').replace(/\/+$/, '');
  const url = `${baseUrl}${path}`;
  const headers = {
    Authorization: `Bearer ${conn.token}`,
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };

  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Teable API ${res.status}: ${text}`);
  }
  return res.json();
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

export async function getTeableRecords(conn, tableId, options = {}) {
  const params = new URLSearchParams();
  if (options.fieldKeyType) params.set('fieldKeyType', options.fieldKeyType || 'name');
  if (options.filter) params.set('filter', JSON.stringify(options.filter));
  if (options.sort) params.set('sort', JSON.stringify(options.sort));
  if (options.take) params.set('take', options.take);
  if (options.skip) params.set('skip', options.skip);

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

// ─── Field creation (auto field creation for new tables) ────────────────────


/**
 * Convert SQL column type to Teable field type + default options
 */
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
 */
export async function ensureTeableFields(conn, tableId, sourceSchema, columnMapping, existingFields, log) {
  const existingFieldNames = new Set(existingFields.map(f => f.name));
  const createdFields = [];
  const skippedAttachmentCols = [];
  const mapping = {};


  for (const col of sourceSchema) {
    const tgtName = columnMapping[col.name] || col.name;
    if (existingFieldNames.has(tgtName)) {
      mapping[col.name] = tgtName;
      continue;
    }

    // Field doesn't exist → try to create it
    const info = sqlTypeToTeable(col.type);
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
      // If creation fails (e.g. permission), skip this column
      log('warn', `  ⚠️ 创建字段失败 ${col.name}: ${e.message}`);
      mapping[col.name] = col.name; // still try to map to itself in case target has it
    }
  }

  if (skippedAttachmentCols.length > 0) {
    log('warn', `  ⚠️ 跳过附件字段(暂不支持同步): ${skippedAttachmentCols.join(', ')}`);
  }

  return { mapping, createdFields, skippedAttachmentCols };
}
