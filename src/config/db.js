'use strict';

const mysql = require('mysql2/promise');
const { setTimeout: delay } = require('node:timers/promises');

const RETRYABLE_CODES = new Set(['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT']);

/**
 * Cria o pool e centraliza o ciclo de vida de uma transação.
 * O callback só deve produzir efeitos no banco: em deadlock ele pode repetir.
 * options.pool permite testar falhas de transporte sem simular o SQL do serviço.
 */
function createDatabase(config, options = {}) {
  const pool = options.pool || mysql.createPool({
    ...config,
    waitForConnections: true,
    queueLimit: 100,
    supportBigNumbers: true,
    bigNumberStrings: true,
    decimalNumbers: false,
    dateStrings: true,
    timezone: 'Z',
    charset: 'utf8mb4',
    multipleStatements: false,
  });
  const maxRetries = options.maxRetries ?? 2;
  const retryDelayMs = options.retryDelayMs ?? 15;

  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 5) {
    throw new TypeError('maxRetries deve ser um inteiro entre 0 e 5.');
  }

  if (!options.pool) {
    pool.on('connection', connection => {
      // Este comando entra na fila antes da conexão ser entregue ao consumidor.
      connection.query("SET SESSION time_zone = '+00:00'", error => {
        if (error) connection.destroy();
      });
    });
  }

  async function withTransaction(callback) {
    for (let attempt = 0; ; attempt += 1) {
      const connection = await pool.getConnection();
      let discardConnection = false;
      let retry = false;
      try {
        await connection.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
        await connection.beginTransaction();
        const result = await callback(connection);
        await connection.commit();
        return result;
      } catch (error) {
        // Inclui timeout: o MySQL pode ter desfeito apenas a instrução que falhou.
        // Rollback explícito sempre desfaz também as instruções anteriores.
        try {
          await connection.rollback();
        } catch (rollbackError) {
          discardConnection = true;
          error.rollbackError = rollbackError;
        }
        retry = !discardConnection && attempt < maxRetries
          && (RETRYABLE_CODES.has(error.code) || error.errno === 1213 || error.errno === 1205);
        // Falhas de conexão/commit têm resultado possivelmente desconhecido.
        // Nunca repetimos automaticamente essas falhas.
        if (!retry) throw error;
      } finally {
        if (discardConnection) connection.destroy();
        else connection.release();
      }
      if (retryDelayMs > 0) await delay(retryDelayMs * (attempt + 1));
    }
  }

  return {
    pool,
    withTransaction,
    async ping() {
      await pool.query('SELECT 1');
      return true;
    },
    close() { return pool.end(); },
  };
}

module.exports = { createDatabase };
