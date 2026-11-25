'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

function testDatabaseName(env = process.env) {
  const name = env.TEST_DB_NAME || 'conta_digital_test';
  const normalName = env.DB_NAME || 'conta_digital';
  if (!/^[A-Za-z][A-Za-z0-9_]{0,58}_test$/.test(name)
      || name.toLowerCase() === normalName.toLowerCase()) {
    throw new Error('TEST_DB_NAME deve terminar em _test e ser diferente de DB_NAME.');
  }
  return name;
}

async function startTestApp(env = process.env) {
  const { loadConfig } = require('../src/config/env');
  const { createDatabase } = require('../src/config/db');
  const { setupDatabase } = require('../scripts/setup-db');
  const { createApp } = require('../src/app');
  const config = loadConfig({
    ...env,
    NODE_ENV: 'test',
    DB_NAME: testDatabaseName(env),
    JWT_SECRET: 'integration-tests-only-1f47bb4e1f004eca9d36b644eeaf05c2',
    JWT_EXPIRES_IN: '1h',
  });
  await setupDatabase(config.db);
  const db = createDatabase(config.db);
  let server;
  try {
    await db.ping();
    const app = createApp({ db, config });
    server = await new Promise((resolve, reject) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
      listener.once('error', reject);
    });
  } catch (error) {
    await db.close();
    throw error;
  }
  const url = `http://127.0.0.1:${server.address().port}`;
  const accountIds = new Set();

  async function request(method, path, { token, key, body, rawBody, headers = {} } = {}) {
    const response = await fetch(`${url}${path}`, {
      method,
      headers: {
        ...(body !== undefined || rawBody !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(key !== undefined ? { 'Idempotency-Key': key } : {}),
        ...headers,
      },
      body: rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
    const text = await response.text();
    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`Resposta HTTP ${response.status} não contém JSON em ${method} ${path}.`);
    }
    return { status: response.status, headers: response.headers, body: json };
  }

  async function customer() {
    const credentials = {
      name: 'Cliente de teste',
      email: `test-${randomUUID()}@example.test`,
      password: 'Senha-forte-123!',
    };
    const response = await request('POST', '/auth/register', { body: credentials });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    accountIds.add(response.body.account.id);
    return { ...response.body, credentials };
  }

  async function deposit(owner, amount, key = randomUUID(), accountId = owner.account.id) {
    return request('POST', `/accounts/${accountId}/deposits`, {
      token: owner.token,
      key,
      body: { amount_cents: amount },
    });
  }

  async function withdraw(owner, amount, key = randomUUID(), accountId = owner.account.id) {
    return request('POST', `/accounts/${accountId}/withdrawals`, {
      token: owner.token,
      key,
      body: { amount_cents: amount },
    });
  }

  async function transfer(owner, destination, amount, key = randomUUID()) {
    return request('POST', '/transfers', {
      token: owner.token,
      key,
      body: {
        from_account_id: owner.account.id,
        to_account_id: typeof destination === 'number' ? destination : destination.account.id,
        amount_cents: amount,
      },
    });
  }

  async function balance(accountId) {
    const [rows] = await db.pool.execute('SELECT balance_cents FROM accounts WHERE id = ?', [accountId]);
    assert.equal(rows.length, 1);
    return BigInt(rows[0].balance_cents);
  }

  async function assertBalanced(accountId) {
    const [rows] = await db.pool.execute(
      `SELECT a.balance_cents,
              COALESCE(SUM(CASE WHEN l.direction = 'credit' THEN l.amount_cents ELSE -l.amount_cents END), 0) AS ledger_balance
       FROM accounts a LEFT JOIN ledger_entries l ON l.account_id = a.id
       WHERE a.id = ? GROUP BY a.id, a.balance_cents`,
      [accountId],
    );
    assert.equal(rows.length, 1);
    assert.equal(BigInt(rows[0].balance_cents), BigInt(rows[0].ledger_balance));
    assert.ok(BigInt(rows[0].balance_cents) >= 0n);
  }

  async function operationCount(accountId, key) {
    const [rows] = await db.pool.execute(
      'SELECT COUNT(*) AS total FROM operations WHERE idempotency_account_id = ? AND idempotency_key = ?',
      [accountId, key],
    );
    return Number(rows[0].total);
  }

  async function close() {
    await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeIdleConnections?.();
    });
    await db.close();
  }

  return { db, config, url, accountIds, request, customer, deposit, withdraw, transfer, balance, assertBalanced, operationCount, close };
}

async function concurrent(tasks) {
  const results = await Promise.allSettled(tasks);
  for (const result of results) {
    assert.equal(result.status, 'fulfilled', result.reason?.stack || 'Requisição concorrente não concluída.');
  }
  return results.map(result => result.value);
}

module.exports = { testDatabaseName, startTestApp, concurrent };
