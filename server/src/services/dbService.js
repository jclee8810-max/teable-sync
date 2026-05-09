// Database service - unified interface for SQL Server, MySQL, PostgreSQL
// With connection pool caching and database override

import { logger } from './logger.js';

const DRIVERS = {
  mssql: () => import('mssql'),
  mysql: () => import('mysql2/promise'),
  pg: () => import('pg'),
};

// Connection pool cache with expiry (30 min idle)
const poolCache = new Map();
const POOL_TTL = 30 * 60 * 1000; // 30 minutes

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of poolCache) {
    if (now - entry.lastUsed > POOL_TTL) {
      try {
        if (entry.type === 'mssql') entry.pool.close();
        else if (entry.type === 'pg') entry.pool.end();
      } catch (e) { /* ignore close errors */ }
      poolCache.delete(key);
      logger.debug(`连接池过期已释放: ${key}`);
    }
  }
}, 5 * 60 * 1000); // check every 5 min

function getPoolKey(conn, database) {
  return `${conn.id}:${database || conn.database || 'default'}`;
}

async function getPool(conn, database) {
  const key = getPoolKey(conn, database);
  if (poolCache.has(key)) {
    const entry = poolCache.get(key);
    entry.lastUsed = Date.now();
    return entry;
  }

  const db = database || conn.database;

  switch (conn.type) {
    case 'mssql': {
      const mssqlModule = await DRIVERS.mssql();
      const mssql = mssqlModule.default || mssqlModule;
      const pool = new mssql.ConnectionPool({
        server: conn.host,
        port: parseInt(conn.port) || 1433,
        user: conn.username,
        password: conn.password,
        database: db,
        options: { encrypt: false, trustServerCertificate: true },
        pool: { max: 5, idleTimeoutMillis: 30000 },
      });
      await pool.connect();
      poolCache.set(key, { type: 'mssql', pool, lastUsed: Date.now() });
      return poolCache.get(key);
    }
    case 'mysql': {
      const mysql = await DRIVERS.mysql();
      const pool = mysql.createPool({
        host: conn.host,
        port: parseInt(conn.port) || 3306,
        user: conn.username,
        password: conn.password,
        database: db,
      });
      poolCache.set(key, { type: 'mysql', pool, lastUsed: Date.now() });
      return poolCache.get(key);
    }
    case 'pg': {
      const { Pool } = await DRIVERS.pg();
      const pool = new Pool({
        host: conn.host,
        port: parseInt(conn.port) || 5432,
        user: conn.username,
        password: conn.password,
        database: db,
      });
      poolCache.set(key, { type: 'pg', pool, lastUsed: Date.now() });
      return poolCache.get(key);
    }
    default:
      throw new Error(`Unsupported database type: ${conn.type}`);
  }
}

export async function testConnection(conn) {
  const { type, pool } = await getPool(conn);
  switch (type) {
    case 'mssql': {
      const result = await pool.request().query('SELECT @@VERSION as version');
      return { version: result.recordset[0].version.substring(0, 80) };
    }
    case 'mysql': {
      const [rows] = await pool.execute('SELECT VERSION() as version');
      return { version: rows[0].version };
    }
    case 'pg': {
      const res = await pool.query('SELECT version()');
      return { version: res.rows[0].version.substring(0, 80) };
    }
  }
}

export async function query(conn, sql, params = [], database = null) {
  const { type, pool } = await getPool(conn, database);

  switch (type) {
    case 'mssql': {
      const request = pool.request();
      if (params.length > 0) {
        let idx = 0;
        const mssqlSql = sql.replace(/\?/g, () => {
          const pName = `@p${idx}`;
          request.input(`p${idx}`, params[idx]);
          idx++;
          return pName;
        });
        const result = await request.query(mssqlSql);
        return result.recordset;
      }
      const result = await request.query(sql);
      return result.recordset;
    }
    case 'mysql': {
      const [rows] = await pool.execute(sql, params);
      return rows;
    }
    case 'pg': {
      const res = await pool.query(sql, params);
      return res.rows;
    }
    default:
      throw new Error(`Unsupported database type: ${type}`);
  }
}

export async function getTables(conn, database = null) {
  let sql;
  const db = database || conn.database;
  switch (conn.type) {
    case 'mssql':
      if (db && db !== conn.database) {
        // Query a different database
        sql = `SELECT TABLE_NAME as name, TABLE_TYPE as type FROM [${db.replace(/]/g, ']]')}].INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`;
      } else {
        sql = `SELECT TABLE_NAME as name, TABLE_TYPE as type FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`;
      }
      break;
    case 'mysql':
      sql = `SELECT TABLE_NAME as name, TABLE_TYPE as type FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`;
      break;
    case 'pg':
      sql = `SELECT table_name as name, 'BASE TABLE' as type FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`;
      break;
  }
  return query(conn, sql, [], database);
}

export async function getTableSchema(conn, tableName, database = null) {
  let sql;
  switch (conn.type) {
    case 'mssql':
      sql = `SELECT COLUMN_NAME as name, DATA_TYPE as type, IS_NULLABLE as nullable, CHARACTER_MAXIMUM_LENGTH as maxLength FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = ? ORDER BY ORDINAL_POSITION`;
      break;
    case 'mysql':
      sql = `SELECT COLUMN_NAME as name, DATA_TYPE as type, IS_NULLABLE as nullable, CHARACTER_MAXIMUM_LENGTH as maxLength FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`;
      break;
    case 'pg':
      sql = `SELECT column_name as name, data_type as type, is_nullable as nullable, character_maximum_length as "maxLength" FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`;
      break;
  }
  return query(conn, sql, [tableName], database);
}
