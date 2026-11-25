'use strict';

const { AppError } = require('./errors');

const MAX_CENTS = 9007199254740991n;
const MAX_ACCOUNT_ID = 4294967295;
const MAX_LEDGER_ID = 18446744073709551615n;

function invalid(message) {
  throw new AppError(400, 'VALIDATION_ERROR', message);
}

function objectBody(body, allowed, required = allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    invalid('Envie um objeto JSON.');
  }
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) invalid(`Campo não permitido: ${key}.`);
  }
  for (const key of required) {
    if (!Object.hasOwn(body, key)) invalid(`Campo obrigatório: ${key}.`);
  }
  return body;
}

function accountId(value, { fromPath = false } = {}) {
  if (fromPath) {
    if (typeof value !== 'string' || !/^[1-9]\d{0,9}$/.test(value)) invalid('ID de conta inválido.');
    value = Number(value);
  }
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_ACCOUNT_ID) invalid('ID de conta inválido.');
  return value;
}

function amountCents(value) {
  if (!Number.isSafeInteger(value) || value <= 0 || BigInt(value) > MAX_CENTS) {
    throw new AppError(400, 'INVALID_AMOUNT', 'amount_cents deve ser um inteiro positivo entre 1 e 9007199254740991.');
  }
  return BigInt(value);
}

// JSON.parse can round a large fractional token to an integer. Reject fractional,
// exponential and unsafe numeric literals before trusting the parsed money body.
// Quoted text is skipped, including escaped quotes; valid JSON is parsed by Express.
function integerJsonTokens(raw) {
  if (!raw) return;
  let quoted = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (quoted) {
      if (ch === '\\') i += 1;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === '-' || /[0-9]/.test(ch)) {
      const start = i;
      while (i + 1 < raw.length && !/[\s,}\]]/.test(raw[i + 1])) i += 1;
      const token = raw.slice(start, i + 1);
      if (!/^-?(0|[1-9]\d*)$/.test(token) || !Number.isSafeInteger(Number(token))) {
        throw new AppError(400, 'INVALID_AMOUNT', 'Use inteiros decimais em centavos, sem frações ou notação exponencial.');
      }
    }
  }
}

function idempotencyKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(value)) {
    throw new AppError(400, 'INVALID_IDEMPOTENCY_KEY', 'Envie Idempotency-Key com 8 a 128 caracteres: letras, números, ponto, hífen, dois-pontos ou sublinhado.');
  }
  return value;
}

function registerInput(body) {
  objectBody(body, ['name', 'email', 'password']);
  if (typeof body.name !== 'string' || body.name.trim().length < 2 || body.name.trim().length > 120) {
    invalid('name deve ter entre 2 e 120 caracteres.');
  }
  const email = emailInput(body.email);
  if (typeof body.password !== 'string' || body.password.length < 8 || Buffer.byteLength(body.password, 'utf8') > 72) {
    invalid('password deve ter pelo menos 8 caracteres e no máximo 72 bytes UTF-8.');
  }
  return { name: body.name.trim(), email, password: body.password };
}

function emailInput(value) {
  if (typeof value !== 'string') invalid('Email inválido.');
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) invalid('Email inválido.');
  return email;
}

function loginInput(body) {
  objectBody(body, ['email', 'password']);
  const email = emailInput(body.email);
  if (typeof body.password !== 'string' || !body.password.length || Buffer.byteLength(body.password, 'utf8') > 72) {
    invalid('Senha inválida.');
  }
  return { email, password: body.password };
}

function pagination(query) {
  for (const key of Object.keys(query)) if (!['limit', 'before'].includes(key)) invalid(`Parâmetro não permitido: ${key}.`);
  let limit = 20;
  if (query.limit !== undefined) {
    if (typeof query.limit !== 'string' || !/^[1-9]\d{0,2}$/.test(query.limit)) invalid('limit deve ser um inteiro entre 1 e 100.');
    limit = Number(query.limit);
    if (limit > 100) invalid('limit deve ser um inteiro entre 1 e 100.');
  }
  const before = query.before ?? null;
  if (before !== null && (typeof before !== 'string' || !/^[1-9]\d{0,19}$/.test(before) || BigInt(before) > MAX_LEDGER_ID)) {
    invalid('before deve ser um ID de lançamento válido.');
  }
  return { limit, before };
}

module.exports = { MAX_CENTS, MAX_ACCOUNT_ID, objectBody, accountId, amountCents, integerJsonTokens, idempotencyKey, registerInput, loginInput, pagination };
