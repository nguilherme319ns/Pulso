'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { AppError } = require('../utils/errors');
const { MAX_CENTS } = require('../utils/validation');
const serialize = require('../utils/serialize');

function requestHash({ type, fromAccountId, toAccountId, amount }) {
  // Fixed field order and decimal strings make equivalent requests identical,
  // regardless of HTTP JSON key ordering or whitespace.
  return createHash('sha256').update(JSON.stringify({
    type, from_account_id: fromAccountId, to_account_id: toAccountId, amount_cents: amount.toString(),
  })).digest('hex');
}

function createMoneyService(db) {
  async function response(conn, operationId, scopeAccountId, replayed) {
    const [[operation]] = await conn.execute('SELECT * FROM operations WHERE id = ?', [operationId]);
    const [entries] = await conn.execute(
      'SELECT * FROM ledger_entries WHERE operation_id = ? AND account_id = ? ORDER BY id',
      [operationId, scopeAccountId],
    );
    // Expose only the caller's affected account. Recipient balances are private.
    return { operation: serialize.operation(operation), ledger_entries: entries.map(serialize.ledgerEntry), replayed };
  }

  async function execute(customerId, input) {
    const { type, fromAccountId, toAccountId, amount, key } = input;
    const scopeAccountId = type === 'deposit' ? toAccountId : fromAccountId;
    const hash = requestHash(input);

    return db.withTransaction(async (conn) => {
      const accounts = new Map();
      // Separate equality reads force the actual acquisition order. An ORDER BY
      // over an IN query alone is not relied upon for lock acquisition ordering.
      const ids = [...new Set([fromAccountId, toAccountId].filter((id) => id !== null))].sort((a, b) => a - b);
      for (const id of ids) {
        const [[account]] = await conn.execute('SELECT * FROM accounts WHERE id = ? FOR UPDATE', [id]);
        if (account) accounts.set(id, account);
      }
      const scopedAccount = accounts.get(scopeAccountId);
      if (!scopedAccount || Number(scopedAccount.customer_id) !== customerId) {
        throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'Conta não encontrada.');
      }

      // The source/affected account lock serializes contenders across processes.
      // The unique database index is a second guard, not an in-memory cache.
      const [[existing]] = await conn.execute(
        'SELECT id, request_hash FROM operations WHERE idempotency_account_id = ? AND idempotency_key = ?',
        [scopeAccountId, key],
      );
      if (existing) {
        if (existing.request_hash !== hash) {
          throw new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'Esta Idempotency-Key já foi usada com outros dados nesta conta.');
        }
        return response(conn, existing.id, scopeAccountId, true);
      }

      if (toAccountId !== null && !accounts.has(toAccountId)) {
        throw new AppError(404, 'DESTINATION_ACCOUNT_NOT_FOUND', 'Conta de destino não encontrada.');
      }

      const changes = [];
      if (fromAccountId !== null) {
        const before = BigInt(accounts.get(fromAccountId).balance_cents);
        if (before < amount) throw new AppError(422, 'INSUFFICIENT_FUNDS', 'Saldo insuficiente.');
        changes.push({ accountId: fromAccountId, direction: 'debit', balance: before - amount });
      }
      if (toAccountId !== null) {
        const after = BigInt(accounts.get(toAccountId).balance_cents) + amount;
        if (after > MAX_CENTS) throw new AppError(422, 'BALANCE_LIMIT_EXCEEDED', 'O saldo de destino ultrapassaria o limite permitido.');
        changes.push({ accountId: toAccountId, direction: 'credit', balance: after });
      }

      const operationId = randomUUID();
      await conn.execute(
        `INSERT INTO operations
         (id, type, idempotency_account_id, idempotency_key, request_hash, from_account_id, to_account_id, amount_cents)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [operationId, type, scopeAccountId, key, hash, fromAccountId, toAccountId, amount.toString()],
      );
      for (const change of changes) {
        await conn.execute('UPDATE accounts SET balance_cents = ? WHERE id = ?', [change.balance.toString(), change.accountId]);
        await conn.execute(
          'INSERT INTO ledger_entries (operation_id, account_id, direction, amount_cents, balance_after_cents) VALUES (?, ?, ?, ?, ?)',
          [operationId, change.accountId, change.direction, amount.toString(), change.balance.toString()],
        );
      }
      return response(conn, operationId, scopeAccountId, false);
    });
  }

  return { execute };
}

module.exports = { createMoneyService, requestHash };
