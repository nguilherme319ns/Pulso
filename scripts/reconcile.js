'use strict';

const path = require('node:path');
const { createDatabase } = require('../src/config/db');
const { readDatabaseConfig } = require('./setup-db');

/** Auditoria em snapshot consistente: não muda saldos, movimentos ou cadastros. */
async function reconcileDatabase(pool) {
  const connection = await pool.getConnection();
  try {
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    const [accounts] = await connection.query('SELECT id, balance_cents FROM accounts ORDER BY id');
    const [operations] = await connection.query(
      'SELECT id, type, from_account_id, to_account_id, amount_cents FROM operations ORDER BY id',
    );
    const [entries] = await connection.query(
      'SELECT id, account_id, operation_id, direction, amount_cents, balance_after_cents FROM ledger_entries ORDER BY id',
    );
    const discrepancies = [];
    const balances = new Map(accounts.map(account => [String(account.id), 0n]));
    const byOperation = new Map();

    for (const entry of entries) {
      const accountId = String(entry.account_id);
      const prior = balances.get(accountId);
      if (prior === undefined) {
        discrepancies.push({ code: 'UNKNOWN_LEDGER_ACCOUNT', entry_id: String(entry.id), account_id: accountId });
        continue;
      }
      const amount = BigInt(entry.amount_cents);
      const next = prior + (entry.direction === 'credit' ? amount : -amount);
      balances.set(accountId, next);
      if (next !== BigInt(entry.balance_after_cents) || next < 0n) {
        discrepancies.push({
          code: 'LEDGER_RUNNING_BALANCE_MISMATCH', entry_id: String(entry.id), account_id: accountId,
          expected_cents: String(next), actual_cents: String(entry.balance_after_cents),
        });
      }
      const group = byOperation.get(entry.operation_id) || [];
      group.push(entry);
      byOperation.set(entry.operation_id, group);
    }

    for (const account of accounts) {
      const expected = balances.get(String(account.id));
      if (expected !== BigInt(account.balance_cents)) {
        discrepancies.push({
          code: 'ACCOUNT_BALANCE_MISMATCH', account_id: account.id,
          expected_cents: String(expected), actual_cents: String(account.balance_cents),
        });
      }
    }

    const knownOperations = new Set();
    for (const operation of operations) {
      knownOperations.add(operation.id);
      const group = byOperation.get(operation.id) || [];
      const expected = [];
      if (operation.type === 'withdrawal' || operation.type === 'transfer') {
        expected.push({ account_id: operation.from_account_id, direction: 'debit' });
      }
      if (operation.type === 'deposit' || operation.type === 'transfer') {
        expected.push({ account_id: operation.to_account_id, direction: 'credit' });
      }
      if (expected.length === 0 || group.length !== expected.length || !expected.every(wanted => group.some(entry =>
        String(entry.account_id) === String(wanted.account_id)
          && entry.direction === wanted.direction
          && BigInt(entry.amount_cents) === BigInt(operation.amount_cents)))) {
        discrepancies.push({ code: 'OPERATION_ENTRIES_MISMATCH', operation_id: operation.id });
      }
    }
    for (const operationId of byOperation.keys()) {
      if (!knownOperations.has(operationId)) {
        discrepancies.push({ code: 'UNKNOWN_LEDGER_OPERATION', operation_id: operationId });
      }
    }
    await connection.commit();
    return {
      ok: discrepancies.length === 0,
      checked_accounts: accounts.length,
      checked_operations: operations.length,
      checked_entries: entries.length,
      discrepancies,
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function main() {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const db = createDatabase(readDatabaseConfig());
  try {
    const report = await reconcileDatabase(db.pool);
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  } finally {
    await db.close();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(`Falha na reconciliação: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { reconcileDatabase };
