'use strict';

const { MAX_CENTS } = require('./validation');

function cents(value) {
  const n = BigInt(value);
  if (n < 0n || n > MAX_CENTS) throw new Error('Valor monetário fora do intervalo seguro no banco.');
  return Number(n);
}

function timestamp(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'string') throw new Error('Data inválida no banco.');
  return value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
}

function customer(row) {
  return { id: Number(row.id), name: row.name, email: row.email, created_at: timestamp(row.created_at) };
}

function account(row) {
  return { id: Number(row.id), customer_id: Number(row.customer_id), balance_cents: cents(row.balance_cents), created_at: timestamp(row.created_at) };
}

function operation(row) {
  return {
    id: row.id,
    type: row.type,
    from_account_id: row.from_account_id === null ? null : Number(row.from_account_id),
    to_account_id: row.to_account_id === null ? null : Number(row.to_account_id),
    amount_cents: cents(row.amount_cents),
    created_at: timestamp(row.created_at),
  };
}

function ledgerEntry(row) {
  return {
    id: String(row.id), operation_id: row.operation_id, account_id: Number(row.account_id),
    direction: row.direction, amount_cents: cents(row.amount_cents),
    balance_after_cents: cents(row.balance_after_cents), created_at: timestamp(row.created_at),
  };
}

module.exports = { cents, timestamp, customer, account, operation, ledgerEntry };
