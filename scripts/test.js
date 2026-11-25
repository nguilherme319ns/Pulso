'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
require('dotenv').config({ path: path.join(root, '.env') });

const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--integration') || args.length > 1) {
  console.error('Uso: node scripts/test.js [--integration]');
  process.exitCode = 1;
} else {
  const testDatabase = process.env.TEST_DB_NAME || 'conta_digital_test';
  const developmentDatabase = process.env.DB_NAME || 'conta_digital';
  if (!/^[A-Za-z0-9_]+_test$/.test(testDatabase)
      || testDatabase.toLowerCase() === developmentDatabase.toLowerCase()) {
    console.error('TEST_DB_NAME deve terminar em _test e ser diferente de DB_NAME.');
    process.exitCode = 1;
  } else {
    const files = args.includes('--integration')
      ? ['tests/integration.test.js']
      : ['tests/validation.test.js', 'tests/transaction.test.js', 'tests/integration.test.js'];
    console.log(`Testes com MySQL habilitados; banco separado: ${testDatabase}.`);
    console.log('Uma falha de conexão com MySQL reprova a execução; integração não será ignorada.');
    const result = spawnSync(process.execPath, ['--test', ...files], {
      cwd: root,
      env: { ...process.env, MYSQL_TEST: '1', NODE_ENV: 'test', TEST_DB_NAME: testDatabase },
      stdio: 'inherit',
    });
    if (result.error) console.error(`Não foi possível iniciar os testes (${result.error.code || 'erro'}).`);
    process.exitCode = result.status === null ? 1 : result.status;
  }
}
