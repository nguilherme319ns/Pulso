'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const v = require('../src/utils/validation');
const { cents } = require('../src/utils/serialize');
const { requestHash } = require('../src/services/money-service');
const { loadConfig } = require('../src/config/env');

describe('Inteiros exatos e contrato de entrada', () => {
  it('converte centavos válidos para BigInt sem arredondamento', () => {
    assert.equal(v.amountCents(1), 1n);
    assert.equal(v.amountCents(1050), 1050n);
    assert.equal(v.amountCents(Number.MAX_SAFE_INTEGER), 9007199254740991n);
    assert.equal(cents('9007199254740991'), Number.MAX_SAFE_INTEGER);
    assert.throws(() => cents('9007199254740992'));
    assert.throws(() => cents('-1'));
  });

  it('recusa coerção, frações, zero, negativos e números sem precisão', () => {
    for (const input of [0, -0, -1, 0.01, 10.5, '100', true, null, undefined, {}, [], NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => v.amountCents(input), error => error.code === 'INVALID_AMOUNT');
    }
  });

  it('detecta tokens fracionários que JSON.parse arredondaria silenciosamente', () => {
    const rounded = '{"amount_cents":9007199254740990.1}';
    assert.equal(Number.isSafeInteger(JSON.parse(rounded).amount_cents), true);
    for (const input of [rounded, '{"amount_cents":1.0}', '{"amount_cents":1e3}', '{"amount_cents":9007199254740992}']) {
      assert.throws(() => v.integerJsonTokens(input), error => error.code === 'INVALID_AMOUNT');
    }
    v.integerJsonTokens('{"amount_cents":9007199254740991,"from_account_id":1,"to_account_id":2}');
    v.integerJsonTokens('{"text":"1.5 and \\"quoted\\" numbers","amount_cents":25}');
  });

  it('valida IDs estritamente e mantém cursores BIGINT como strings', () => {
    assert.equal(v.accountId('4294967295', { fromPath: true }), 4294967295);
    for (const value of ['1e3', '1.5', '01', '-1', '0', '4294967296', '1 OR 1=1']) {
      assert.throws(() => v.accountId(value, { fromPath: true }));
    }
    assert.throws(() => v.accountId('1'));
    const result = v.pagination({ before: '18446744073709551615', limit: '100' });
    assert.equal(result.before, '18446744073709551615');
    assert.equal(result.limit, 100);
    assert.deepEqual(v.pagination({}), { limit: 20, before: null });
    for (const query of [{ limit: '101' }, { limit: '0' }, { limit: ['2', '3'] }, { before: '18446744073709551616' }, { before: '0' }, { before: ['1'] }, { offset: '0' }]) {
      assert.throws(() => v.pagination(query));
    }
  });

  it('mantém chaves case-sensitive e rejeita espaços/valores ambíguos', () => {
    assert.equal(v.idempotencyKey('Key-12345'), 'Key-12345');
    assert.notEqual(v.idempotencyKey('Key-12345'), v.idempotencyKey('key-12345'));
    for (const key of [undefined, '', 'curta', 'key 123456', 'key-12345 ', 'x'.repeat(129), 'chave-ação']) {
      assert.throws(() => v.idempotencyKey(key), error => error.code === 'INVALID_IDEMPOTENCY_KEY');
    }
  });

  it('vincula o fingerprint ao tipo, contas e valor exatos', () => {
    const input = { type: 'transfer', fromAccountId: 1, toAccountId: 2, amount: 2500n };
    const hash = requestHash(input);
    assert.equal(hash, requestHash({ amount: 2500n, toAccountId: 2, fromAccountId: 1, type: 'transfer' }));
    for (const change of [{ amount: 2501n }, { toAccountId: 3 }, { fromAccountId: 2 }, { type: 'withdrawal' }]) {
      assert.notEqual(hash, requestHash({ ...input, ...change }));
    }
  });

  it('normaliza email e impede truncamento silencioso de senha no bcrypt', () => {
    const input = { name: '  Nome de teste  ', email: '  EXEMPLO@example.test  ', password: 'senha-segura-123' };
    assert.deepEqual(v.registerInput(input), { name: 'Nome de teste', email: 'exemplo@example.test', password: input.password });
    v.registerInput({ ...input, password: 'x'.repeat(72) });
    v.registerInput({ ...input, password: 'é'.repeat(36) });
    for (const password of ['curta', 'x'.repeat(73), 'é'.repeat(37)]) {
      assert.throws(() => v.registerInput({ ...input, password }));
    }
    assert.throws(() => v.registerInput({ ...input, is_admin: true }));
    assert.throws(() => v.loginInput({ email: input.email, password: 'x'.repeat(73) }));
  });

  it('não permite estruturas de corpo ou campos extras inesperados', () => {
    for (const body of [null, undefined, 1, 'text', []]) assert.throws(() => v.objectBody(body, ['amount_cents']));
    assert.throws(() => v.objectBody({}, ['amount_cents']));
    assert.throws(() => v.objectBody({ amount_cents: 1, balance_cents: 999 }, ['amount_cents']));
  });

  it('falha cedo em segredo curto, porta ou duração de token inválidos', () => {
    const env = { JWT_SECRET: 'local-unit-test-secret-0123456789abcdef' };
    const config = loadConfig(env);
    assert.equal(config.port, 3000);
    assert.equal(config.host, '127.0.0.1');
    assert.equal(config.db.database, 'conta_digital');
    assert.throws(() => loadConfig({ JWT_SECRET: 'curto' }));
    for (const fields of [{ PORT: '3000abc' }, { DB_PORT: '-1' }, { DB_POOL_SIZE: '0' }, { DB_NAME: 'x; DROP DATABASE x' }, { JWT_EXPIRES_IN: '1000' }]) {
      assert.throws(() => loadConfig({ ...env, ...fields }));
    }
  });
});
