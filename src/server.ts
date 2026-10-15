import { existsSync } from 'node:fs';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

// Optional .env in the working directory; variables already set in the environment take precedence.
const ENV_FILE = '.env';
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const config = loadConfig();
const app = await buildApp({ config });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info(`${signal} received, shutting down`);
    void app.close().then(() => process.exit(0));
  });
}

try {
  await app.listen({ port: config.port, host: config.host });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
