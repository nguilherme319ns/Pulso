'use strict';

const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const target = path.join(root, '.env');

try {
  const template = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  const contents = template
    .replace('__GENERATE_DB_PASSWORD__', randomBytes(24).toString('hex'))
    .replace('__GENERATE_JWT_SECRET__', randomBytes(32).toString('hex'))
    .replace('__GENERATE_ROOT_PASSWORD__', randomBytes(24).toString('hex'));
  fs.writeFileSync(target, contents, { flag: 'wx', mode: 0o600 });
  console.log('.env criado com segredos aleatórios para este ambiente.');
  console.log('Docker: execute docker compose up --build -d.');
  console.log('MySQL já instalado: ajuste DB_USER e DB_PASSWORD no .env para a sua instalação.');
} catch (error) {
  if (error.code === 'EEXIST') {
    console.log('.env já existe e foi preservado.');
    console.log('Confira os campos de .env.example e use JWT_SECRET com pelo menos 32 bytes.');
  } else {
    console.error(`Não foi possível criar .env (${error.code || 'erro de arquivo'}).`);
    process.exitCode = 1;
  }
}
