import { getTableSchema } from './dbService.js';
import { getTeableFields, teableFieldToSourceColumn } from './teableService.js';

function normalizeField(field) {
  return {
    name: field.name,
    type: field.type || field.dataType || 'unknown',
  };
}

function normalizeFields(fields = []) {
  return fields.map(normalizeField).filter((field) => field.name).sort((a, b) => a.name.localeCompare(b.name));
}

export async function getCurrentTaskSchema(task, srcConn, tgtConn) {
  const sourceFields = srcConn.type === 'teable'
    ? normalizeFields((await getTeableFields(srcConn, task.sourceTable)).map(teableFieldToSourceColumn))
    : normalizeFields(await getTableSchema(srcConn, task.sourceTable, task.sourceDatabase || null));
  const targetFields = normalizeFields(await getTeableFields(tgtConn, task.targetTableId));
  return {
    capturedAt: new Date().toISOString(),
    source: {
      connectionId: task.sourceConnectionId || task.sourceId,
      table: task.sourceTable,
      database: task.sourceDatabase || null,
      fields: sourceFields,
    },
    target: {
      connectionId: task.targetConnectionId || task.targetId,
      tableId: task.targetTableId,
      fields: targetFields,
    },
  };
}

function diffFieldSet(previous = [], current = []) {
  const prevMap = new Map(previous.map((field) => [field.name, field]));
  const currMap = new Map(current.map((field) => [field.name, field]));
  const added = [];
  const removed = [];
  const typeChanged = [];

  for (const [name, field] of currMap.entries()) {
    if (!prevMap.has(name)) added.push(field);
  }
  for (const [name, field] of prevMap.entries()) {
    if (!currMap.has(name)) removed.push(field);
    else if (String(currMap.get(name).type) !== String(field.type)) {
      typeChanged.push({ name, before: field.type, after: currMap.get(name).type });
    }
  }

  return { added, removed, typeChanged };
}

export async function detectTaskSchemaDrift(task, srcConn, tgtConn) {
  const snapshot = task.schemaSnapshot || null;
  const current = await getCurrentTaskSchema(task, srcConn, tgtConn);
  if (!snapshot) {
    return {
      status: 'no_snapshot',
      hasSnapshot: false,
      changed: false,
      snapshotAt: null,
      checkedAt: current.capturedAt,
      current,
      source: { added: [], removed: [], typeChanged: [] },
      target: { added: [], removed: [], typeChanged: [] },
      summary: { added: 0, removed: 0, typeChanged: 0 },
    };
  }

  const source = diffFieldSet(snapshot.source?.fields || [], current.source.fields);
  const target = diffFieldSet(snapshot.target?.fields || [], current.target.fields);
  const summary = {
    added: source.added.length + target.added.length,
    removed: source.removed.length + target.removed.length,
    typeChanged: source.typeChanged.length + target.typeChanged.length,
  };
  const changed = summary.added + summary.removed + summary.typeChanged > 0;
  return {
    status: changed ? 'changed' : 'unchanged',
    hasSnapshot: true,
    changed,
    snapshotAt: snapshot.capturedAt || null,
    checkedAt: current.capturedAt,
    current,
    source,
    target,
    summary,
  };
}
