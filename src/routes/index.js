'use strict';

const express = require('express');
const { asyncRoute } = require('../utils/errors');
const { authenticate } = require('../middlewares/auth');

function createRoutes({ auth, accounts, money, config }) {
  const router = express.Router();
  router.post('/auth/register', asyncRoute(auth.register));
  router.post('/auth/login', asyncRoute(auth.login));
  router.use(authenticate(config));
  router.get('/accounts', asyncRoute(accounts.list));
  router.post('/accounts', asyncRoute(accounts.create));
  router.get('/accounts/:id', asyncRoute(accounts.get));
  router.get('/accounts/:id/statement', asyncRoute(accounts.statement));
  router.post('/accounts/:id/deposits', asyncRoute(money.deposit));
  router.post('/accounts/:id/withdrawals', asyncRoute(money.withdraw));
  router.post('/transfers', asyncRoute(money.transfer));
  return router;
}

module.exports = { createRoutes };
