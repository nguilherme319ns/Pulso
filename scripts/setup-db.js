'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const mysql = require('mysql2/promise');

function validateDatabaseName(database) {
  if (typeof database !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(database)) {
    throw new Error('Nome de banco inválido: use de 1 a 64 letras, números ou _, começando por letra.');
  }
  return database;
}

function readDatabaseConfig(databaseOverride, env = process.env) {
  const database = validateDatabaseName(databaseOverride || env.DB_NAME || 'conta_digital');
  if (databaseOverride && !database.endsWith('_test')) {
    throw new Error('O argumento de banco alternativo é reservado a bancos com sufixo _test.');
  }
  if (env.NODE_ENV === 'test' && !database.endsWith('_test')) {
    throw new Error('Testes exigem um banco com sufixo _test.');
  }
  const port = Number(env.DB_PORT || 3306);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('DB_PORT inválida.');
  return {
    host: env.DB_HOST || '127.0.0.1',
    port,
    user: env.DB_USER || 'conta_app',
    password: env.DB_PASSWORD || '',
    database,
    connectionLimit: 10,
  };
}

function assertSupportedVersion(version) {
  const match = String(version).match(/^(?:5\.5\.5-)?(\d+)\.(\d+)\.(\d+)/);
  if (!match) throw new Error(`Não foi possível verificar a versão do servidor SQL: ${version}`);
  const [major, minor, patch] = match.slice(1).map(Number);
  const supported = !/mariadb/i.test(version)
    && (major > 8 || (major === 8 && (minor > 0 || patch >= 16)));
  if (!supported) {
    throw new Error('O servidor precisa aplicar CHECK e os bloqueios usados pela API: use MySQL 8.0.16+; MariaDB não é suportado.');
  }
}

async function setupDatabase(dbConfig) {
  const { database: rawDatabase, connectionLimit: ignoredLimit, ...connectionConfig } = dbConfig;
  const database = validateDatabaseName(rawDatabase);
  const connection = await mysql.createConnection({
    ...connectionConfig,
    charset: 'utf8mb4',
    multipleStatements: false,
    supportBigNumbers: true,
    bigNumberStrings: true,
  });
  try {
    const [[{ version }]] = await connection.query('SELECT VERSION() AS version');
    assertSupportedVersion(version);
    const [databases] = await connection.execute(
      'SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [database],
    );
    if (databases.length === 0) {
      // O identificador acima foi validado. Valores de negócio sempre usam parâmetros.
      await connection.query(`CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    }
    await connection.query(`USE \`${database}\``);
    await connection.query("SET SESSION time_zone = '+00:00'");
    const sql = await fs.readFile(path.join(__dirname, '..', 'sql', 'schema.sql'), 'utf8');
    // O arquivo controlado pelo projeto contém apenas triggers de uma instrução.
    const statements = sql.replace(/^\s*--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean);
    for (const statement of statements) {
      const trigger = statement.match(/^CREATE TRIGGER\s+([a-z_]+)/i);
      if (trigger) {
        const [existing] = await connection.execute(
          'SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? AND TRIGGER_NAME = ?',
          [database, trigger[1]],
        );
        if (existing.length > 0) continue;
      }
      try {
        await connection.query(statement);
      } catch (error) {
        // Outra execução de setup pode ter criado a mesma trigger neste intervalo.
        if (!(trigger && (error.code === 'ER_TRG_ALREADY_EXISTS' || error.errno === 1359))) throw error;
      }
    }
    return { database, serverVersion: version };
  } finally {
    await connection.end();
  }
}

async function main() {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  if (process.argv.length > 3) throw new Error('Uso: node scripts/setup-db.js [nome_test]');
  const result = await setupDatabase(readDatabaseConfig(process.argv[2]));
  console.log(`Banco ${result.database} preparado; tabelas e dados existentes foram preservados.`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(`Falha ao preparar o banco: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { setupDatabase, readDatabaseConfig, validateDatabaseName, assertSupportedVersion };
