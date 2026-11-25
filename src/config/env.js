'use strict';

function integer(env, key, fallback, min, max) {
  const value = env[key] ?? String(fallback);
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) {
    throw new Error(`${key} deve ser um inteiro entre ${min} e ${max}.`);
  }
  return Number(value);
}

function loadConfig(env = process.env) {
  const jwtSecret = env.JWT_SECRET || '';
  if (Buffer.byteLength(jwtSecret, 'utf8') < 32 || /^(troque|substitua|change|your[-_]|replace|gere[-_])/i.test(jwtSecret)) {
    throw new Error('JWT_SECRET deve ser aleatório e ter pelo menos 32 bytes. Execute npm run env:init para um novo .env ou gere: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"');
  }
  const jwtExpiresIn = env.JWT_EXPIRES_IN || '1h';
  if (!/^[1-9]\d{0,4}(s|m|h|d)$/.test(jwtExpiresIn)) throw new Error('JWT_EXPIRES_IN inválido. Exemplo: 1h.');
  const database = env.DB_NAME || 'conta_digital';
  if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(database)) throw new Error('DB_NAME inválido. Use letras, números e sublinhado.');
  return {
    nodeEnv: env.NODE_ENV || 'development',
    host: env.HOST || '127.0.0.1',
    port: integer(env, 'PORT', 3000, 1, 65535),
    jwtSecret, jwtExpiresIn,
    jwtIssuer: 'api-conta-digital', jwtAudience: 'conta-digital-client',
    bcryptRounds: 12,
    db: {
      host: env.DB_HOST || '127.0.0.1',
      port: integer(env, 'DB_PORT', 3306, 1, 65535),
      user: env.DB_USER || 'conta_app', password: env.DB_PASSWORD || '', database,
      connectionLimit: integer(env, 'DB_POOL_SIZE', 10, 1, 100),
    },
  };
}

module.exports = { loadConfig };
