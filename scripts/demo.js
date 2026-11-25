'use strict';

const { randomBytes, randomUUID } = require('node:crypto');
const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const baseUrl = (process.env.API_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3000}`).replace(/\/$/, '');

async function request(method, route, { token, body, key } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (key) headers['Idempotency-Key'] = key;
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`${method} ${route}: HTTP ${response.status} ${data.error?.code || 'erro'}`);
  }
  return { status: response.status, data };
}

async function main() {
  await request('GET', '/ready');
  const suffix = randomUUID();
  const password = randomBytes(20).toString('hex');
  const anaEmail = `ana.demo.${suffix}@example.test`;
  const ana = (await request('POST', '/auth/register', {
    body: { name: 'Ana Demonstração', email: anaEmail, password },
  })).data;
  const bruno = (await request('POST', '/auth/register', {
    body: { name: 'Bruno Demonstração', email: `bruno.demo.${suffix}@example.test`, password },
  })).data;
  const login = (await request('POST', '/auth/login', { body: { email: anaEmail, password } })).data;
  const token = login.token;

  await request('POST', `/accounts/${ana.account.id}/deposits`, {
    token, key: randomUUID(), body: { amount_cents: 10000 },
  });
  const transferBody = {
    from_account_id: ana.account.id,
    to_account_id: bruno.account.id,
    amount_cents: 2500,
  };
  const transferKey = randomUUID();
  const original = await request('POST', '/transfers', { token, key: transferKey, body: transferBody });
  const replay = await request('POST', '/transfers', { token, key: transferKey, body: transferBody });
  if (original.status !== 201 || replay.status !== 200 || !replay.data.replayed
      || original.data.operation.id !== replay.data.operation.id) {
    throw new Error('A demonstração de idempotência não retornou a operação original.');
  }
  await request('POST', `/accounts/${ana.account.id}/withdrawals`, {
    token, key: randomUUID(), body: { amount_cents: 1000 },
  });
  const anaBalance = (await request('GET', `/accounts/${ana.account.id}`, { token })).data.account.balance_cents;
  const brunoBalance = (await request('GET', `/accounts/${bruno.account.id}`, { token: bruno.token })).data.account.balance_cents;
  if (anaBalance !== 6500 || brunoBalance !== 2500) {
    throw new Error('Os saldos finais diferem dos saldos esperados.');
  }
  const statement = (await request('GET', `/accounts/${ana.account.id}/statement?limit=10`, { token })).data;
  console.log(JSON.stringify({
    descricao: 'Demonstração concluída com dados fictícios.',
    contas: { ana: ana.account.id, bruno: bruno.account.id },
    deposito_cents: 10000,
    transferencia_cents: 2500,
    primeira_transferencia_http: original.status,
    repeticao_http: replay.status,
    mesma_operacao: original.data.operation.id === replay.data.operation.id,
    saque_cents: 1000,
    saldo_ana_cents: anaBalance,
    saldo_bruno_cents: brunoBalance,
    extrato_ana: statement,
  }, null, 2));
}

main().catch((error) => {
  console.error(`Demonstração interrompida: ${error.message}`);
  console.error('Confira se a API está em execução e se /ready retorna HTTP 200.');
  process.exitCode = 1;
});
