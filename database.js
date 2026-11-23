import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import mysql from 'mysql2/promise';

export async function openDatabase(env) {
  if (env.DB_NAME) {
    const pool = mysql.createPool({
      host: env.DB_HOST || 'localhost',
      port: Number(env.DB_PORT || 3306),
      database: env.DB_NAME,
      user: env.DB_USER,
      password: env.DB_PASS,
      timezone: env.DB_TIMEZONE || '+03:30',
      charset: 'utf8mb4',
      connectionLimit: 5
    });
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS profiles (
          id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
          service VARCHAR(16) NOT NULL,
          name VARCHAR(80) NOT NULL,
          data MEDIUMTEXT NOT NULL,
          UNIQUE (service, name)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin
      `);
    } catch (error) {
      await pool.end();
      throw error;
    }
    return {
      async all(sql, ...params) {
        const [rows] = await pool.execute(sql, params);
        return rows;
      },
      async run(sql, ...params) {
        const [result] = await pool.execute(sql, params);
        return { id: result.insertId, changes: result.affectedRows };
      }
    };
  }

  if (!env.DATABASE_PATH) throw new Error('Set DB_NAME and the MySQL connection settings in .env.');

  // Keep existing deployments using their configured SQLite file.
  const { DatabaseSync } = await import('node:sqlite');
  const path = env.DATABASE_PATH === ':memory:' ? ':memory:' : resolve(env.DATABASE_PATH);
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS profiles (
      id INTEGER PRIMARY KEY, service TEXT NOT NULL, name TEXT NOT NULL,
      data TEXT NOT NULL, UNIQUE(service, name)
    );
  `);
  return {
    all: (sql, ...params) => db.prepare(sql).all(...params),
    run(sql, ...params) {
      const result = db.prepare(sql).run(...params);
      return { id: Number(result.lastInsertRowid), changes: result.changes };
    }
  };
}
