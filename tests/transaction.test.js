'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDatabase } = require('../src/config/db');
const { validateDatabaseName, assertSupportedVersion, readDatabaseConfig } = require('../scripts/setup-db');

function makeDatabase({ commitError, rollbackError, maxRetries = 2 } = {}) {
  const events = [];
  let connections = 0;
  const pool = {
    async getConnection() {
      const id = ++connections;
      events.push(`acquire:${id}`);
      return {
        async query(sql) { events.push(`isolation:${id}`); assert.match(sql, /READ COMMITTED$/); },
        async beginTransaction() { events.push(`begin:${id}`); },
        async commit() { events.push(`commit:${id}`); if (commitError) throw commitError; },
        async rollback() { events.push(`rollback:${id}`); if (rollbackError) throw rollbackError; },
        release() { events.push(`release:${id}`); },
        destroy() { events.push(`destroy:${id}`); },
      };
    },
  };
  return { db: createDatabase({}, { pool, retryDelayMs: 0, maxRetries }), events };
}

test('a transação só devolve resultado depois de commit e libera a conexão', async () => {
  const { db, events } = makeDatabase();
  const result = await db.withTransaction(async () => { events.push('write'); return { id: 'ok' }; });
  assert.deepEqual(result, { id: 'ok' });
  assert.deepEqual(events, ['acquire:1', 'isolation:1', 'begin:1', 'write', 'commit:1', 'release:1']);
});

test('falha depois de uma escrita provoca rollback antes da liberação', async () => {
  const { db, events } = makeDatabase();
  const failure = new Error('falha depois do débito');
  await assert.rejects(db.withTransaction(async () => { events.push('debit'); throw failure; }), error => error === failure);
  assert.deepEqual(events, ['acquire:1', 'isolation:1', 'begin:1', 'debit', 'rollback:1', 'release:1']);
});

for (const code of ['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT']) {
  test(`${code}: desfaz toda a transação e só então repete em outra conexão`, async () => {
    const { db, events } = makeDatabase();
    let calls = 0;
    const result = await db.withTransaction(async () => {
      calls += 1;
      events.push(`write:${calls}`);
      if (calls === 1) throw Object.assign(new Error(code), { code });
      return 'committed';
    });
    assert.equal(result, 'committed');
    assert.deepEqual(events, [
      'acquire:1', 'isolation:1', 'begin:1', 'write:1', 'rollback:1', 'release:1',
      'acquire:2', 'isolation:2', 'begin:2', 'write:2', 'commit:2', 'release:2',
    ]);
  });
}

test('as tentativas de deadlock são limitadas', async () => {
  const { db, events } = makeDatabase();
  let calls = 0;
  await assert.rejects(db.withTransaction(async () => {
    calls += 1;
    throw Object.assign(new Error('deadlock'), { code: 'ER_LOCK_DEADLOCK' });
  }), /deadlock/);
  assert.equal(calls, 3);
  assert.equal(events.filter(event => event.startsWith('rollback')).length, 3);
  assert.equal(events.filter(event => event.startsWith('release')).length, 3);
});

test('commit com falha de rede não repete uma operação com resultado desconhecido', async () => {
  const failure = Object.assign(new Error('connection lost'), { code: 'PROTOCOL_CONNECTION_LOST' });
  const { db, events } = makeDatabase({ commitError: failure });
  let calls = 0;
  await assert.rejects(db.withTransaction(async () => { calls += 1; }), error => error === failure);
  assert.equal(calls, 1);
  assert.deepEqual(events, ['acquire:1', 'isolation:1', 'begin:1', 'commit:1', 'rollback:1', 'release:1']);
});

test('falha no rollback descarta a conexão e impede retry automático', async () => {
  const rollbackFailure = new Error('socket lost');
  const { db, events } = makeDatabase({ rollbackError: rollbackFailure });
  const failure = Object.assign(new Error('deadlock'), { code: 'ER_LOCK_DEADLOCK' });
  await assert.rejects(db.withTransaction(async () => { throw failure; }), error => {
    assert.equal(error, failure);
    assert.equal(error.rollbackError, rollbackFailure);
    return true;
  });
  assert.deepEqual(events, ['acquire:1', 'isolation:1', 'begin:1', 'rollback:1', 'destroy:1']);
});

test('nomes de banco são validados antes de interpolar identificadores SQL', () => {
  assert.equal(validateDatabaseName('conta_digital_test'), 'conta_digital_test');
  for (const value of ['conta` DROP DATABASE mysql', 'a;b', 'a b', '', '_test', 'x'.repeat(65)]) {
    assert.throws(() => validateDatabaseName(value));
  }
  assert.throws(() => readDatabaseConfig('conta_digital', {}), /_test/);
  assert.throws(() => readDatabaseConfig(undefined, { NODE_ENV: 'test', DB_NAME: 'conta_digital' }), /_test/);
});

test('servidores que ignoram CHECK são rejeitados', () => {
  assert.throws(() => assertSupportedVersion('5.7.44'), /CHECK/);
  assert.throws(() => assertSupportedVersion('8.0.15'), /CHECK/);
  assert.doesNotThrow(() => assertSupportedVersion('8.0.16'));
  assert.doesNotThrow(() => assertSupportedVersion('8.4.7'));
  assert.throws(() => assertSupportedVersion('10.11.14-MariaDB'), /MariaDB/);
});
