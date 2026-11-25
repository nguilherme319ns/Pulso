'use strict';

const assert = require('node:assert/strict');
const { describe, it, before, after } = require('node:test');
const { randomUUID } = require('node:crypto');
const { startTestApp, testDatabaseName, concurrent } = require('./helpers');

const enabled = process.env.MYSQL_TEST === '1';

describe('Proteção do banco de testes', () => {
  it('recusa nomes comuns e o mesmo banco configurado para a aplicação', () => {
    assert.equal(testDatabaseName({ DB_NAME: 'conta_digital' }), 'conta_digital_test');
    assert.equal(testDatabaseName({ DB_NAME: 'conta_digital', TEST_DB_NAME: 'isolado_test' }), 'isolado_test');
    for (const name of ['conta_digital', 'production', 'x_test; DROP DATABASE x', 'x-test', 'x_test`']) {
      assert.throws(() => testDatabaseName({ TEST_DB_NAME: name }));
    }
    assert.throws(() => testDatabaseName({ DB_NAME: 'mesmo_test', TEST_DB_NAME: 'mesmo_test' }));
    assert.throws(() => testDatabaseName({ DB_NAME: 'MESMO_test', TEST_DB_NAME: 'mesmo_test' }));
  });
});

describe('API + MySQL real: consistência financeira', {
  concurrency: 1,
  timeout: 240000,
  skip: enabled ? false : 'MySQL não habilitado: execute npm test ou npm run test:integration. Nenhuma garantia SQL é simulada.',
}, () => {
  let api;
  before(async () => { api = await startTestApp(); });
  after(async () => { if (api) await api.close(); });

  it('responde ao healthcheck com conexão SQL disponível', async () => {
    const response = await api.request('GET', '/health');
    assert.equal(response.status, 200);
    assert.equal((await api.request('GET', '/ready')).status, 200);
  });

  it('cadastra cliente e conta, armazena somente hash e autentica', async () => {
    const owner = await api.customer();
    assert.ok(Number.isSafeInteger(owner.customer.id));
    assert.equal(owner.customer.email, owner.credentials.email);
    assert.equal(owner.account.customer_id, owner.customer.id);
    assert.equal(owner.account.balance_cents, 0);
    assert.equal(typeof owner.token, 'string');
    assert.equal(owner.customer.password, undefined);
    assert.equal(owner.customer.password_hash, undefined);
    const [rows] = await api.db.pool.execute('SELECT password_hash FROM customers WHERE id = ?', [owner.customer.id]);
    assert.notEqual(rows[0].password_hash, owner.credentials.password);
    assert.equal(await require('bcryptjs').compare(owner.credentials.password, rows[0].password_hash), true);

    const login = await api.request('POST', '/auth/login', {
      body: { email: owner.credentials.email, password: owner.credentials.password },
    });
    assert.equal(login.status, 200);
    assert.equal(login.body.customer.id, owner.customer.id);
    assert.equal(typeof login.body.token, 'string');
    assert.equal(login.body.customer.password_hash, undefined);
    const denied = await api.request('POST', '/auth/login', {
      body: { email: owner.credentials.email, password: 'outra-senha-invalida' },
    });
    assert.equal(denied.status, 401);
    assert.equal(denied.body.error.code, 'INVALID_CREDENTIALS');
    const duplicate = await api.request('POST', '/auth/register', { body: owner.credentials });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'EMAIL_IN_USE');
    const [accounts] = await api.db.pool.execute('SELECT id FROM accounts WHERE customer_id = ?', [owner.customer.id]);
    assert.equal(accounts.length, 1);
  });

  it('exige JWT e não expõe nem movimenta contas de outro cliente', async () => {
    const alice = await api.customer();
    const bob = await api.customer();
    assert.equal((await api.request('GET', '/accounts')).status, 401);
    assert.equal((await api.request('GET', '/accounts', { token: 'token-invalido' })).status, 401);
    for (const path of [`/accounts/${bob.account.id}`, `/accounts/${bob.account.id}/statement`]) {
      const response = await api.request('GET', path, { token: alice.token });
      assert.equal(response.status, 404);
      assert.equal(response.body.error.code, 'ACCOUNT_NOT_FOUND');
    }
    for (const action of ['deposits', 'withdrawals']) {
      const response = await api.request('POST', `/accounts/${bob.account.id}/${action}`, {
        token: alice.token, key: randomUUID(), body: { amount_cents: 100 },
      });
      assert.equal(response.status, 404);
    }
    const response = await api.request('POST', '/transfers', {
      token: alice.token,
      key: randomUUID(),
      body: { from_account_id: bob.account.id, to_account_id: alice.account.id, amount_cents: 1 },
    });
    assert.equal(response.status, 404);
    assert.equal(await api.balance(bob.account.id), 0n);
    const opened = await api.request('POST', '/accounts', { token: alice.token, body: {} });
    assert.equal(opened.status, 201);
    api.accountIds.add(opened.body.account.id);
    const list = await api.request('GET', '/accounts', { token: alice.token });
    assert.equal(list.status, 200);
    assert.equal(list.body.accounts.length, 2);
    assert.ok(list.body.accounts.every(account => account.customer_id === alice.customer.id));
  });

  it('rejeita valores inválidos, inclusive fora da precisão inteira do JSON', async () => {
    const owner = await api.customer();
    const invalidAmounts = [0, -1, 1.5, '100', null, true, {}, Number.MAX_SAFE_INTEGER + 1, 1e50];
    for (const amount of invalidAmounts) {
      const response = await api.deposit(owner, amount);
      assert.equal(response.status, 400, `amount_cents inválido: ${JSON.stringify(amount)}`);
      assert.equal(response.body.error.code, 'INVALID_AMOUNT');
    }
    const roundedFraction = await api.request('POST', `/accounts/${owner.account.id}/deposits`, {
      token: owner.token,
      key: randomUUID(),
      rawBody: '{"amount_cents":9007199254740990.1}',
    });
    assert.equal(roundedFraction.status, 400);
    assert.equal(await api.balance(owner.account.id), 0n);
    const [rows] = await api.db.pool.execute('SELECT id FROM ledger_entries WHERE account_id = ?', [owner.account.id]);
    assert.equal(rows.length, 0);
  });

  it('exige chave de idempotência válida nas três movimentações', async () => {
    const alice = await api.customer();
    const bob = await api.customer();
    for (const key of [undefined, '', 'curta', 'chave com espaco']) {
      const options = { token: alice.token, key, body: { amount_cents: 1 } };
      for (const action of ['deposits', 'withdrawals']) {
        const response = await api.request('POST', `/accounts/${alice.account.id}/${action}`, options);
        assert.equal(response.status, 400);
        assert.equal(response.body.error.code, 'INVALID_IDEMPOTENCY_KEY');
      }
      const transfer = await api.request('POST', '/transfers', {
        ...options, body: { from_account_id: alice.account.id, to_account_id: bob.account.id, amount_cents: 1 },
      });
      assert.equal(transfer.status, 400);
      assert.equal(transfer.body.error.code, 'INVALID_IDEMPOTENCY_KEY');
    }
  });

  it('deposita e saca centavos exatos, com saldos históricos no ledger', async () => {
    const owner = await api.customer();
    const deposit = await api.deposit(owner, 1051);
    assert.equal(deposit.status, 201);
    assert.equal(deposit.body.operation.amount_cents, 1051);
    assert.equal(deposit.body.operation.type, 'deposit');
    assert.equal(deposit.body.ledger_entries.length, 1);
    assert.equal(deposit.body.ledger_entries[0].direction, 'credit');
    assert.equal(deposit.body.ledger_entries[0].balance_after_cents, 1051);
    assert.equal(typeof deposit.body.ledger_entries[0].id, 'string');
    const withdrawal = await api.withdraw(owner, 1001);
    assert.equal(withdrawal.status, 201);
    assert.equal(withdrawal.body.operation.type, 'withdrawal');
    assert.equal(withdrawal.body.ledger_entries[0].direction, 'debit');
    assert.equal(withdrawal.body.ledger_entries[0].balance_after_cents, 50);
    assert.equal(await api.balance(owner.account.id), 50n);
    await api.assertBalanced(owner.account.id);
  });

  it('transfere em uma única operação com duas contrapartidas de mesmo valor', async () => {
    const alice = await api.customer();
    const bob = await api.customer();
    assert.equal((await api.deposit(alice, 5000)).status, 201);
    const response = await api.transfer(alice, bob, 1251);
    assert.equal(response.status, 201);
    assert.equal(response.body.replayed, false);
    assert.equal(response.headers.get('Idempotency-Replayed'), 'false');
    const operation = response.body.operation;
    assert.equal(operation.type, 'transfer');
    assert.equal(operation.from_account_id, alice.account.id);
    assert.equal(operation.to_account_id, bob.account.id);
    assert.equal(operation.amount_cents, 1251);
    // A resposta da origem não pode revelar o saldo privado do destinatário.
    assert.equal(response.body.ledger_entries.length, 1);
    const debit = response.body.ledger_entries.find(entry => entry.direction === 'debit');
    const [storedEntries] = await api.db.pool.execute('SELECT * FROM ledger_entries WHERE operation_id = ?', [operation.id]);
    assert.equal(storedEntries.length, 2);
    const credit = storedEntries.find(entry => entry.direction === 'credit');
    assert.equal(debit.account_id, alice.account.id);
    assert.equal(credit.account_id, bob.account.id);
    assert.equal(debit.operation_id, operation.id);
    assert.equal(credit.operation_id, operation.id);
    assert.equal(BigInt(debit.amount_cents), BigInt(credit.amount_cents));
    assert.equal(debit.balance_after_cents, 3749);
    assert.equal(BigInt(credit.balance_after_cents), 1251n);
    const destinationStatement = await api.request('GET', `/accounts/${bob.account.id}/statement`, { token: bob.token });
    assert.equal(destinationStatement.status, 200);
    assert.equal(destinationStatement.body.entries[0].direction, 'credit');
    assert.equal(destinationStatement.body.entries[0].amount_cents, 1251);
    assert.equal((await api.balance(alice.account.id)) + (await api.balance(bob.account.id)), 5000n);
    await api.assertBalanced(alice.account.id);
    await api.assertBalanced(bob.account.id);
  });

  it('saldo insuficiente não grava débito, operação nem chave de idempotência', async () => {
    const alice = await api.customer();
    const bob = await api.customer();
    const key = randomUUID();
    const rejected = await api.transfer(alice, bob, 1, key);
    assert.equal(rejected.status, 422);
    assert.equal(rejected.body.error.code, 'INSUFFICIENT_FUNDS');
    assert.equal(await api.operationCount(alice.account.id, key), 0);
    assert.equal((await api.withdraw(alice, 1)).body.error.code, 'INSUFFICIENT_FUNDS');
    const [rows] = await api.db.pool.execute('SELECT id FROM ledger_entries WHERE account_id IN (?, ?)', [alice.account.id, bob.account.id]);
    assert.equal(rows.length, 0);
    assert.equal((await api.deposit(alice, 1)).status, 201);
    assert.equal((await api.transfer(alice, bob, 1, key)).status, 201);
  });

  it('recusa auto-transferência e destino inexistente sem modificar a origem', async () => {
    const owner = await api.customer();
    assert.equal((await api.deposit(owner, 100)).status, 201);
    const self = await api.transfer(owner, owner, 1);
    assert.equal(self.status, 400);
    assert.equal(self.body.error.code, 'SAME_ACCOUNT');
    const missing = await api.transfer(owner, 4294967295, 1);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'DESTINATION_ACCOUNT_NOT_FOUND');
    assert.equal(await api.balance(owner.account.id), 100n);
  });

  it('protege o limite inteiro exato e reverte transferência para destino cheio', async () => {
    const alice = await api.customer();
    const bob = await api.customer();
    const max = Number.MAX_SAFE_INTEGER;
    assert.equal((await api.deposit(bob, max)).status, 201);
    const extra = await api.deposit(bob, 1);
    assert.equal(extra.status, 422);
    assert.equal(extra.body.error.code, 'BALANCE_LIMIT_EXCEEDED');
    assert.equal((await api.deposit(alice, 100)).status, 201);
    const key = randomUUID();
    const response = await api.transfer(alice, bob, 1, key);
    assert.equal(response.status, 422);
    assert.equal(response.body.error.code, 'BALANCE_LIMIT_EXCEEDED');
    assert.equal(await api.balance(alice.account.id), 100n);
    assert.equal(await api.balance(bob.account.id), BigInt(max));
    assert.equal(await api.operationCount(alice.account.id, key), 0);
    await api.assertBalanced(alice.account.id);
    await api.assertBalanced(bob.account.id);
  });

  it('depósitos simultâneos com a mesma chave creditam uma única vez', async () => {
    const owner = await api.customer();
    const key = randomUUID();
    const responses = await concurrent(Array.from({ length: 12 }, () => api.deposit(owner, 100, key)));
    assert.equal(responses.filter(response => response.status === 201).length, 1);
    assert.equal(responses.filter(response => response.status === 200).length, 11);
    assert.equal(new Set(responses.map(response => response.body.operation.id)).size, 1);
    assert.equal(await api.balance(owner.account.id), 100n);
    assert.equal(await api.operationCount(owner.account.id, key), 1);
    const [entries] = await api.db.pool.execute('SELECT id FROM ledger_entries WHERE account_id = ?', [owner.account.id]);
    assert.equal(entries.length, 1);
  });

  it('saques simultâneos com a mesma chave debitam uma única vez', async () => {
    const owner = await api.customer();
    assert.equal((await api.deposit(owner, 1000)).status, 201);
    const key = randomUUID();
    const responses = await concurrent(Array.from({ length: 10 }, () => api.withdraw(owner, 75, key)));
    assert.equal(responses.filter(response => response.status === 201).length, 1);
    assert.equal(responses.filter(response => response.status === 200).length, 9);
    assert.equal(await api.balance(owner.account.id), 925n);
    assert.equal(await api.operationCount(owner.account.id, key), 1);
    await api.assertBalanced(owner.account.id);
  });

  it('transferências simultâneas idempotentes movem dinheiro uma única vez', async () => {
    const alice = await api.customer();
    const bob = await api.customer();
    assert.equal((await api.deposit(alice, 1000)).status, 201);
    const key = randomUUID();
    const responses = await concurrent(Array.from({ length: 12 }, () => api.transfer(alice, bob, 250, key)));
    assert.equal(responses.filter(response => response.status === 201).length, 1);
    assert.equal(responses.filter(response => response.status === 200).length, 11);
    const first = responses.find(response => response.status === 201);
    for (const response of responses.filter(item => item.status === 200)) {
      assert.equal(response.body.replayed, true);
      assert.equal(response.headers.get('Idempotency-Replayed'), 'true');
      assert.deepEqual(response.body.operation, first.body.operation);
      assert.deepEqual(response.body.ledger_entries, first.body.ledger_entries);
    }
    assert.equal(await api.balance(alice.account.id), 750n);
    assert.equal(await api.balance(bob.account.id), 250n);
    assert.equal(await api.operationCount(alice.account.id, key), 1);
    const [entries] = await api.db.pool.execute('SELECT id FROM ledger_entries WHERE operation_id = ?', [first.body.operation.id]);
    assert.equal(entries.length, 2);
    // A resposta repetida deve conservar os saldos históricos originais.
    assert.equal((await api.deposit(alice, 99)).status, 201);
    const replay = await api.transfer(alice, bob, 250, key);
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body.ledger_entries, first.body.ledger_entries);
  });

  it('a mesma chave com dados diferentes falha, inclusive entre tipos e destinos', async () => {
    const alice = await api.customer();
    const bob = await api.customer();
    const carol = await api.customer();
    const depositKey = randomUUID();
    assert.equal((await api.deposit(alice, 1000, depositKey)).status, 201);
    for (const response of [await api.deposit(alice, 999, depositKey), await api.withdraw(alice, 1000, depositKey)]) {
      assert.equal(response.status, 422);
      assert.equal(response.body.error.code, 'IDEMPOTENCY_KEY_REUSED');
    }
    const transferKey = randomUUID();
    assert.equal((await api.transfer(alice, bob, 100, transferKey)).status, 201);
    for (const response of [await api.transfer(alice, bob, 101, transferKey), await api.transfer(alice, carol, 100, transferKey)]) {
      assert.equal(response.status, 422);
      assert.equal(response.body.error.code, 'IDEMPOTENCY_KEY_REUSED');
    }
    // O escopo é a conta: clientes diferentes podem gerar a mesma chave.
    assert.equal((await api.deposit(bob, 5, depositKey)).status, 201);
    assert.equal(await api.balance(alice.account.id), 900n);
    assert.equal(await api.balance(bob.account.id), 105n);
    assert.equal(await api.balance(carol.account.id), 0n);
  });

  it('uma segunda instância da API recupera a operação original do banco', async () => {
    const alice = await api.customer();
    const bob = await api.customer();
    assert.equal((await api.deposit(alice, 1000)).status, 201);
    const key = randomUUID();
    const first = await api.transfer(alice, bob, 300, key);
    assert.equal(first.status, 201);
    const secondInstance = await startTestApp();
    try {
      const replay = await secondInstance.transfer(alice, bob, 300, key);
      assert.equal(replay.status, 200);
      assert.equal(replay.body.replayed, true);
      assert.deepEqual(replay.body.operation, first.body.operation);
      assert.deepEqual(replay.body.ledger_entries, first.body.ledger_entries);
      assert.equal(await api.balance(alice.account.id), 700n);
      assert.equal(await api.balance(bob.account.id), 300n);
      assert.equal(await api.operationCount(alice.account.id, key), 1);
    } finally {
      await secondInstance.close();
    }
  });

  it('concorrência entre saques e transferências não permite gastar o mesmo saldo', async () => {
    const alice = await api.customer();
    const bob = await api.customer();
    assert.equal((await api.deposit(alice, 1000)).status, 201);
    const responses = await concurrent(Array.from({ length: 20 }, (_, index) =>
      index % 2 ? api.withdraw(alice, 100) : api.transfer(alice, bob, 100)));
    assert.equal(responses.filter(response => response.status === 201).length, 10);
    const rejected = responses.filter(response => response.status === 422);
    assert.equal(rejected.length, 10);
    assert.ok(rejected.every(response => response.body.error.code === 'INSUFFICIENT_FUNDS'));
    assert.equal(await api.balance(alice.account.id), 0n);
    const transferred = responses.filter(response => response.status === 201 && response.body.operation.type === 'transfer').length;
    assert.equal(await api.balance(bob.account.id), BigInt(transferred * 100));
    await api.assertBalanced(alice.account.id);
    await api.assertBalanced(bob.account.id);
  });

  it('transferências cruzadas concorrentes conservam o total e concluem sem erro', async () => {
    const alice = await api.customer();
    const bob = await api.customer();
    assert.equal((await api.deposit(alice, 10000)).status, 201);
    assert.equal((await api.deposit(bob, 10000)).status, 201);
    const responses = await concurrent(Array.from({ length: 40 }, (_, index) =>
      index % 2 ? api.transfer(alice, bob, 5) : api.transfer(bob, alice, 5)));
    for (const response of responses) assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(await api.balance(alice.account.id), 10000n);
    assert.equal(await api.balance(bob.account.id), 10000n);
    await api.assertBalanced(alice.account.id);
    await api.assertBalanced(bob.account.id);
  });

  it('extrato usa cursor exclusivo e não duplica linhas se houver novo depósito entre páginas', async () => {
    const owner = await api.customer();
    const expectedIds = [];
    for (let index = 0; index < 5; index++) {
      const response = await api.deposit(owner, index + 1);
      assert.equal(response.status, 201);
      expectedIds.unshift(response.body.ledger_entries[0].id);
    }
    const first = await api.request('GET', `/accounts/${owner.account.id}/statement?limit=2`, { token: owner.token });
    assert.equal(first.status, 200);
    assert.equal(first.body.account_id, owner.account.id);
    assert.deepEqual(first.body.entries.map(entry => entry.id), expectedIds.slice(0, 2));
    assert.equal(first.body.pagination.has_more, true);
    assert.equal(first.body.pagination.next_cursor, first.body.entries[1].id);
    const seen = first.body.entries.map(entry => entry.id);
    assert.equal((await api.deposit(owner, 99)).status, 201);
    let cursor = first.body.pagination.next_cursor;
    while (cursor) {
      const page = await api.request('GET', `/accounts/${owner.account.id}/statement?limit=2&before=${cursor}`, { token: owner.token });
      assert.equal(page.status, 200);
      assert.equal(page.body.pagination.limit, 2);
      seen.push(...page.body.entries.map(entry => entry.id));
      cursor = page.body.pagination.next_cursor;
      assert.equal(page.body.pagination.has_more, cursor !== null);
    }
    assert.deepEqual(seen, expectedIds);
    assert.equal(new Set(seen).size, seen.length);
    for (const query of ['limit=0', 'limit=101', 'limit=1.5', 'before=abc', 'before=-1']) {
      const response = await api.request('GET', `/accounts/${owner.account.id}/statement?${query}`, { token: owner.token });
      assert.equal(response.status, 400);
    }
  });

  it('ordena o extrato por id mesmo quando vários lançamentos têm o mesmo instante', async () => {
    const owner = await api.customer();
    const ids = [];
    // Fixture SQL consistente: timestamps iguais não podem causar perda de página.
    await api.db.withTransaction(async connection => {
      await connection.execute('SELECT id FROM accounts WHERE id = ? FOR UPDATE', [owner.account.id]);
      for (let index = 1; index <= 3; index++) {
        const operationId = randomUUID();
        await connection.execute(
          `INSERT INTO operations (id, type, idempotency_account_id, idempotency_key, request_hash, to_account_id, amount_cents, created_at)
           VALUES (?, 'deposit', ?, ?, ?, ?, 1, '2026-01-01 00:00:00.000000')`,
          [operationId, owner.account.id, randomUUID(), 'a'.repeat(64), owner.account.id],
        );
        const [result] = await connection.execute(
          `INSERT INTO ledger_entries (operation_id, account_id, direction, amount_cents, balance_after_cents, created_at)
           VALUES (?, ?, 'credit', 1, ?, '2026-01-01 00:00:00.000000')`,
          [operationId, owner.account.id, index],
        );
        ids.unshift(String(result.insertId));
      }
      await connection.execute('UPDATE accounts SET balance_cents = 3 WHERE id = ?', [owner.account.id]);
    });
    let cursor = '';
    const seen = [];
    for (let index = 0; index < 3; index++) {
      const page = await api.request('GET', `/accounts/${owner.account.id}/statement?limit=1${cursor ? `&before=${cursor}` : ''}`, { token: owner.token });
      assert.equal(page.status, 200);
      assert.equal(page.body.entries.length, 1);
      seen.push(page.body.entries[0].id);
      cursor = page.body.pagination.next_cursor;
    }
    assert.equal(cursor, null);
    assert.deepEqual(seen, ids);
    await api.assertBalanced(owner.account.id);
  });

  it('falha SQL no crédito reverte débito, crédito, operação, ledger e chave', async () => {
    const alice = await api.customer();
    const bob = await api.customer();
    assert.equal((await api.deposit(alice, 1000)).status, 201);
    const key = randomUUID();
    const trigger = `test_credit_failure_${randomUUID().replaceAll('-', '')}`;
    assert.match(trigger, /^[a-z0-9_]+$/);
    await api.db.pool.query(
      `CREATE TRIGGER \`${trigger}\` BEFORE INSERT ON ledger_entries FOR EACH ROW
       BEGIN
         IF NEW.account_id = ${Number(bob.account.id)} AND NEW.direction = 'credit' THEN
           SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'injected_test_credit_failure';
         END IF;
       END`,
    );
    try {
      const response = await api.transfer(alice, bob, 500, key);
      assert.equal(response.status, 500);
      assert.equal(await api.balance(alice.account.id), 1000n);
      assert.equal(await api.balance(bob.account.id), 0n);
      assert.equal(await api.operationCount(alice.account.id, key), 0);
      const [entries] = await api.db.pool.execute('SELECT id, direction FROM ledger_entries WHERE account_id IN (?, ?)', [alice.account.id, bob.account.id]);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].direction, 'credit');
    } finally {
      await api.db.pool.query(`DROP TRIGGER \`${trigger}\``);
    }
    const retried = await api.transfer(alice, bob, 500, key);
    assert.equal(retried.status, 201);
    assert.equal(await api.balance(alice.account.id), 500n);
    assert.equal(await api.balance(bob.account.id), 500n);
    await api.assertBalanced(alice.account.id);
    await api.assertBalanced(bob.account.id);
  });

  it('banco impede edição/remoção do ledger e das operações e saldo fora dos limites', async () => {
    const owner = await api.customer();
    const response = await api.deposit(owner, 100);
    assert.equal(response.status, 201);
    const entryId = response.body.ledger_entries[0].id;
    const operationId = response.body.operation.id;
    await assert.rejects(api.db.pool.execute('UPDATE ledger_entries SET amount_cents = 1 WHERE id = ?', [entryId]));
    await assert.rejects(api.db.pool.execute('DELETE FROM ledger_entries WHERE id = ?', [entryId]));
    await assert.rejects(api.db.pool.execute('UPDATE operations SET amount_cents = 1 WHERE id = ?', [operationId]));
    await assert.rejects(api.db.pool.execute('DELETE FROM operations WHERE id = ?', [operationId]));
    await assert.rejects(api.db.pool.execute('UPDATE accounts SET balance_cents = -1 WHERE id = ?', [owner.account.id]));
    await assert.rejects(api.db.pool.execute('UPDATE accounts SET balance_cents = ? WHERE id = ?', ['9007199254740992', owner.account.id]));
    assert.equal(await api.balance(owner.account.id), 100n);
    await api.assertBalanced(owner.account.id);
  });

  it('concilia o saldo de todas as contas criadas pela suíte com seus lançamentos', async () => {
    for (const accountId of api.accountIds) await api.assertBalanced(accountId);
  });
});
