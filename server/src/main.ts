import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';

const config = loadConfig();
const { fastify, purge } = await buildApp(config);

const timer = setInterval(() => void purge().catch((err) => fastify.log.error({ err }, 'purge failed')), 3600_000);
await purge();

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => {
    clearInterval(timer);
    fastify.log.info({ sig }, 'shutting down');
    void fastify.close().then(() => process.exit(0));
  });
}

await fastify.listen({ host: config.HOST, port: config.PORT });
