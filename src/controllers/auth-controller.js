'use strict';

const { registerInput, loginInput } = require('../utils/validation');

function createAuthController(service) {
  return {
    register: async (req, res) => res.status(201).json(await service.register(registerInput(req.body))),
    login: async (req, res) => res.json(await service.login(loginInput(req.body))),
  };
}

module.exports = { createAuthController };
