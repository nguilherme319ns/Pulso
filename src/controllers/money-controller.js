'use strict';

const v = require('../utils/validation');
const { AppError } = require('../utils/errors');

function createMoneyController(service) {
  async function send(req, res, input) {
    const key = v.idempotencyKey(req.get('Idempotency-Key'));
    const amount = v.amountCents(req.body.amount_cents);
    v.integerJsonTokens(req.rawJson);
    const result = await service.execute(req.customerId, { ...input, amount, key });
    res.set('Idempotency-Replayed', String(result.replayed));
    return res.status(result.replayed ? 200 : 201).json(result);
  }

  return {
    deposit: async (req, res) => {
      v.objectBody(req.body, ['amount_cents']);
      return send(req, res, { type: 'deposit', fromAccountId: null, toAccountId: v.accountId(req.params.id, { fromPath: true }) });
    },
    withdraw: async (req, res) => {
      v.objectBody(req.body, ['amount_cents']);
      return send(req, res, { type: 'withdrawal', fromAccountId: v.accountId(req.params.id, { fromPath: true }), toAccountId: null });
    },
    transfer: async (req, res) => {
      v.objectBody(req.body, ['from_account_id', 'to_account_id', 'amount_cents']);
      const fromAccountId = v.accountId(req.body.from_account_id);
      const toAccountId = v.accountId(req.body.to_account_id);
      if (fromAccountId === toAccountId) throw new AppError(400, 'SAME_ACCOUNT', 'Origem e destino devem ser contas diferentes.');
      return send(req, res, { type: 'transfer', fromAccountId, toAccountId });
    },
  };
}

module.exports = { createMoneyController };
