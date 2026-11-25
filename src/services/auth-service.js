'use strict';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { AppError } = require('../utils/errors');
const serialize = require('../utils/serialize');

// Valid bcrypt hash used when no customer is found, keeping the expensive step.
const DUMMY_HASH = '$2a$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxuHCL6jPTXzULUGfHxJH.K.Ula';

function createAuthService(db, config) {
  function tokenFor(id) {
    return jwt.sign({}, config.jwtSecret, {
      algorithm: 'HS256', subject: String(id), issuer: config.jwtIssuer,
      audience: config.jwtAudience, expiresIn: config.jwtExpiresIn,
    });
  }

  async function register(input) {
    // Password hashing happens before locks are acquired.
    const passwordHash = await bcrypt.hash(input.password, config.bcryptRounds);
    let result;
    try {
      result = await db.withTransaction(async (conn) => {
        const [insert] = await conn.execute(
          'INSERT INTO customers (name, email, password_hash) VALUES (?, ?, ?)',
          [input.name, input.email, passwordHash],
        );
        const customerId = insert.insertId;
        const [accountInsert] = await conn.execute('INSERT INTO accounts (customer_id) VALUES (?)', [customerId]);
        const [[customer]] = await conn.execute('SELECT * FROM customers WHERE id = ?', [customerId]);
        const [[account]] = await conn.execute('SELECT * FROM accounts WHERE id = ?', [accountInsert.insertId]);
        return { customer: serialize.customer(customer), account: serialize.account(account) };
      });
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') throw new AppError(409, 'EMAIL_IN_USE', 'Email já cadastrado.');
      throw error;
    }
    return { ...result, token: tokenFor(result.customer.id) };
  }

  async function login(input) {
    const [[customer]] = await db.pool.execute('SELECT * FROM customers WHERE email = ?', [input.email]);
    const valid = await bcrypt.compare(input.password, customer ? customer.password_hash : DUMMY_HASH);
    if (!customer || !valid) throw new AppError(401, 'INVALID_CREDENTIALS', 'Email ou senha inválidos.');
    return { customer: serialize.customer(customer), token: tokenFor(customer.id) };
  }

  return { register, login };
}

module.exports = { createAuthService };
