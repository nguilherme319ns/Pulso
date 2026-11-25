'use strict';

const { AppError } = require('../utils/errors');
const serialize = require('../utils/serialize');

function notFound() {
  return new AppError(404, 'ACCOUNT_NOT_FOUND', 'Conta não encontrada.');
}

function createAccountService(db) {
  async function get(customerId, accountId) {
    const [[row]] = await db.pool.execute('SELECT * FROM accounts WHERE id = ? AND customer_id = ?', [accountId, customerId]);
    if (!row) throw notFound();
    return serialize.account(row);
  }

  async function list(customerId) {
    const [rows] = await db.pool.execute('SELECT * FROM accounts WHERE customer_id = ? ORDER BY id', [customerId]);
    return rows.map(serialize.account);
  }

  async function create(customerId) {
    return db.withTransaction(async (conn) => {
      const [[customer]] = await conn.execute('SELECT id FROM customers WHERE id = ? FOR SHARE', [customerId]);
      if (!customer) throw new AppError(401, 'UNAUTHORIZED', 'Cliente não encontrado. Faça login novamente.');
      const [insert] = await conn.execute('INSERT INTO accounts (customer_id) VALUES (?)', [customerId]);
      const [[row]] = await conn.execute('SELECT * FROM accounts WHERE id = ?', [insert.insertId]);
      return serialize.account(row);
    });
  }

  async function statement(customerId, accountId, { limit, before }) {
    await get(customerId, accountId);
    const params = [accountId];
    let cursor = '';
    if (before !== null) {
      cursor = ' AND le.id < ?';
      params.push(before);
    }
    // limit comes only from validated 1..100 integer input; query uses limit+1
    // to distinguish a full last page from a page that really has a successor.
    const [rows] = await db.pool.execute(
      `SELECT le.*, o.type, o.from_account_id, o.to_account_id
       FROM ledger_entries le JOIN operations o ON o.id = le.operation_id
       WHERE le.account_id = ?${cursor} ORDER BY le.id DESC LIMIT ${limit + 1}`,
      params,
    );
    const hasMore = rows.length > limit;
    const entries = rows.slice(0, limit).map((row) => ({
      ...serialize.ledgerEntry(row),
      type: row.type,
      counterparty_account_id: row.type === 'transfer'
        ? Number(row.direction === 'debit' ? row.to_account_id : row.from_account_id)
        : null,
    }));
    return {
      account_id: accountId, entries,
      pagination: { limit, next_cursor: hasMore ? entries.at(-1).id : null, has_more: hasMore },
    };
  }

  return { get, list, create, statement };
}

module.exports = { createAccountService };
