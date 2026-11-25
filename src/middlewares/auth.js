'use strict';

const jwt = require('jsonwebtoken');
const { AppError } = require('../utils/errors');
const { MAX_ACCOUNT_ID } = require('../utils/validation');

function authenticate(config) {
  return (req, res, next) => {
    const match = /^Bearer ([^\s]+)$/i.exec(req.get('Authorization') || '');
    if (!match) return next(new AppError(401, 'UNAUTHORIZED', 'Envie Authorization: Bearer <token>.'));
    try {
      const payload = jwt.verify(match[1], config.jwtSecret, {
        algorithms: ['HS256'], issuer: config.jwtIssuer, audience: config.jwtAudience,
      });
      if (!payload || typeof payload !== 'object' || typeof payload.sub !== 'string' ||
          !/^[1-9]\d{0,9}$/.test(payload.sub) || Number(payload.sub) > MAX_ACCOUNT_ID) {
        throw new Error('Subject inválido.');
      }
      req.customerId = Number(payload.sub);
      return next();
    } catch {
      return next(new AppError(401, 'UNAUTHORIZED', 'Token inválido ou expirado.'));
    }
  };
}

module.exports = { authenticate };
