'use strict';

const v = require('../utils/validation');

function createAccountController(service) {
  return {
    list: async (req, res) => res.json({ accounts: await service.list(req.customerId) }),
    create: async (req, res) => {
      v.objectBody(req.body || {}, [], []);
      res.status(201).json({ account: await service.create(req.customerId) });
    },
    get: async (req, res) => res.json({ account: await service.get(req.customerId, v.accountId(req.params.id, { fromPath: true })) }),
    statement: async (req, res) => res.json(await service.statement(req.customerId, v.accountId(req.params.id, { fromPath: true }), v.pagination(req.query))),
  };
}

module.exports = { createAccountController };
