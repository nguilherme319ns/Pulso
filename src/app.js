'use strict';

const express = require('express');
const path = require('node:path');

const { AppError } = require('./utils/errors');
const { errorHandler } = require('./middlewares/error-handler');
const { createAuthService } = require('./services/auth-service');
const { createAccountService } = require('./services/account-service');
const { createMoneyService } = require('./services/money-service');
const { createAuthController } = require('./controllers/auth-controller');
const { createAccountController } = require('./controllers/account-controller');
const { createMoneyController } = require('./controllers/money-controller');
const { createRoutes } = require('./routes');

const PUBLIC_DIRECTORY = path.join(__dirname, '..', 'public');

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

function createApp({ db, config }) {
  const app = express();

  app.disable('x-powered-by');
  app.set('query parser', 'simple');

  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.set('X-Frame-Options', 'DENY');
    next();
  });

  app.use(express.json({
    limit: '16kb',
    strict: true,
    inflate: false,
    verify: (req, res, body) => {
      req.rawJson = body.toString('utf8');
    },
  }));

  app.use(
    '/assets',
    express.static(path.join(PUBLIC_DIRECTORY, 'assets'), {
      dotfiles: 'deny',
      index: false,
      redirect: false,
      fallthrough: false,
      cacheControl: false,
      lastModified: false,
      etag: false,
    }),
    (error, req, res, next) => {
      if (error.status === 403 || error.status === 404) {
        return next(new AppError(
          404,
          'ASSET_NOT_FOUND',
          'Arquivo da interface não encontrado.',
        ));
      }

      if (error.status === 405) {
        return next(new AppError(
          405,
          'METHOD_NOT_ALLOWED',
          'Método não permitido para arquivos da interface.',
        ));
      }

      return next(error);
    },
  );

  app.get('/', (req, res, next) => {
    res.sendFile(
      path.join(PUBLIC_DIRECTORY, 'index.html'),
      { cacheControl: false, lastModified: false },
      (error) => {
        if (!error) return;

        if (error.code === 'ENOENT') {
          return next(new AppError(
            503,
            'FRONTEND_NOT_INSTALLED',
            'A pasta public da interface ainda não foi instalada neste projeto.',
          ));
        }

        return next(error);
      },
    );
  });

  app.get('/api/info', (req, res) => {
    res.json({
      service: 'API Conta Digital Pulso',
      version: '1.3.1',
      mode: 'simulacao',
      interface: '/',
      health: '/health',
      readiness: '/ready',
      market: '/api/market/quotes',
    });
  });

  app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  app.get('/ready', async (req, res) => {
    try {
      await db.ping();
      await db.pool.query('SELECT id FROM customers LIMIT 0');
      await db.pool.query('SELECT id FROM accounts LIMIT 0');
      await db.pool.query('SELECT id FROM operations LIMIT 0');
      await db.pool.query('SELECT id FROM ledger_entries LIMIT 0');

      res.json({ status: 'ready', database: 'up' });
    } catch {
      res.status(503).json({
        status: 'not_ready',
        database: 'unavailable_or_schema_missing',
      });
    }
  });

  // Dados públicos da bolsa: esta rota deve vir ANTES das rotas
  // da conta digital, que possuem autenticação própria.
  // Não permite comprar, vender ou movimentar valores.
  app.use('/api/market', require('./investments-market'));

  app.use(createRoutes({
    config,
    auth: createAuthController(createAuthService(db, config)),
    accounts: createAccountController(createAccountService(db)),
    money: createMoneyController(createMoneyService(db)),
  }));

  app.use((req, res, next) => {
    next(new AppError(
      404,
      'ROUTE_NOT_FOUND',
      'Rota não encontrada.',
    ));
  });

  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
