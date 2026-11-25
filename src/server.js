'use strict';

require('dotenv').config();
const { loadConfig } = require('./config/env');
const { createDatabase } = require('./config/db');
const { createApp } = require('./app');

async function main() {
  const config = loadConfig();
  const db = createDatabase(config.db);
  const app = createApp({ db, config });
  // Listen even if MySQL is temporarily offline: /health diagnoses the HTTP
  // process; /ready diagnoses database connectivity and schema separately.
  const server = app.listen(config.port, config.host, () => {
    const displayHost = config.host === '0.0.0.0' ? 'localhost' : config.host;
    console.log(`API Conta Digital: http://${displayHost}:${config.port}`);
    console.log('Liveness: /health | Banco e tabelas: /ready | Encerrar: Ctrl+C');
    db.ping().catch((error) => console.error(`MySQL indisponível (${error.code || 'erro'}). Confira DB_HOST, DB_PORT e DB_USER; execute npm run db:setup.`));
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.on('error', async (error) => {
    console.error(error.code === 'EADDRINUSE'
      ? `Porta ${config.port} em uso. Encerre a outra instância ou altere PORT no .env.`
      : `Não foi possível iniciar HTTP (${error.code || 'erro'}).`);
    await db.close();
    process.exitCode = 1;
  });

  let stopping = false;
  function shutdown() {
    if (stopping) return;
    stopping = true;
    server.close(async () => {
      await db.close();
      process.exitCode = 0;
    });
    // Keep time bounded only after a shutdown signal. Active requests get a
    // chance to finish their transaction before their connections are closed.
    setTimeout(() => process.exit(1), 10_000).unref();
  }
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return { app, db, server };
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Falha na configuração: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main };
