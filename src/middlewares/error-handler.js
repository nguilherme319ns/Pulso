'use strict';

const { AppError } = require('../utils/errors');

const UNAVAILABLE = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND',
  'PROTOCOL_CONNECTION_LOST', 'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR',
  'ER_CON_COUNT_ERROR', 'ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT',
]);

function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  if (error instanceof AppError) {
    return res.status(error.status).json({ error: { code: error.code, message: error.message } });
  }
  if (error.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Corpo JSON inválido.' } });
  }
  if (error.type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'O corpo da requisição ultrapassa 16 KB.' } });
  }
  if (error.status === 415) {
    return res.status(415).json({ error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Envie JSON UTF-8 sem codificação compactada.' } });
  }
  if (UNAVAILABLE.has(error.code)) {
    res.set('Retry-After', '1');
    return res.status(503).json({ error: {
      code: 'DATABASE_UNAVAILABLE',
      message: 'Banco indisponível ou ocupado. Para uma operação financeira, repita com a mesma Idempotency-Key.',
    } });
  }
  // Do not log request bodies, tokens, passwords, SQL values or database errors.
  console.error('[api-error]', error.code || error.name || 'UNKNOWN_ERROR');
  return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Erro interno. Se for uma operação financeira, repita com a mesma Idempotency-Key.' } });
}

module.exports = { errorHandler };
