import { runWorkgraphServerFromEnv } from './server.js';

runWorkgraphServerFromEnv().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    level: 'error',
    event: 'server_start_failed',
    error: message,
  }));
  process.exitCode = 1;
});
