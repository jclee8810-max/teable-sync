import { ensureTeableFields, getTeableFields, teableRequest } from './server/src/services/teableService.js';
import { getSourceSchema } from './server/src/services/dbService.js';
import { loadConfig } from './server/src/utils/config.js';

const config = loadConfig();
const mssqlConn = config.connections.find(c => c.type === 'mssql');
const teableConn = config.connections.find(c => c.type === 'teable');

// 找一个目标表，用 Products 源表测试（字段少）
const tableId = 'bsetestProducts'; // 待替换

async function main() {
  // 1. 获取源表 schema
  const srcSchema = await getSourceSchema(mssqlConn, 'Products');
  console.log('源表字段:');
  srcSchema.forEach(c => console.log(`  ${c.name} (${c.type})`));

  // 2. 获取目标表现有字段
  const tgtFields = await getTeableFields(teableConn, tableId);
  console.log('\n目标表现有字段:');
  tgtFields.forEach(f => console.log(`  ${f.name} [${f.type}]`));

  // 3. 测试自动建字段
  const result = await ensureTeableFields(
    teableConn, tableId, srcSchema, {}, tgtFields,
    (level, msg) => console.log(`[${level}] ${msg}`)
  );
  console.log('\n结果:', JSON.stringify(result, null, 2));
}

main().catch(console.error);
