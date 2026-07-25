import { ZodError } from 'zod';
import { loadConfig, type Config } from './config/env';
import { buildServer } from './server';

async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    const detail = err instanceof ZodError ? JSON.stringify(err.flatten().fieldErrors) : String(err);
    process.stderr.write(`Invalid configuration: ${detail}\n`);
    process.exit(1);
    return;
  }

  const { app } = await buildServer({ config });

  try {
    await app.listen({ port: config.PORT, host: config.HOST });
  } catch (err) {
    app.log.fatal({ err }, 'failed to start');
    process.exit(1);
    return;
  }

  const shutdown = (signal: string): void => {
    app.log.info({ signal }, 'shutting down');
    app
      .close()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

void main();
