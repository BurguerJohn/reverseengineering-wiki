/** Gateway server: HTTP (MCP + accounts), index polling, mail retries, daily dumps. */
import { createApp, ensureWikiSetup } from './app.ts';
import { createHttpServer } from './http/server.ts';
import { createDumps, dumpDue } from './dumps.ts';
import { publishDiscoveryFiles, publishToolSchemas } from './http/discovery.ts';
import { REPO_DIR } from './config.ts';

const app = createApp();
const log = (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`);

try {
  await ensureWikiSetup(app);
  log(`MediaWiki reachable at ${app.config.mw.apiUrl}`);
} catch (error) {
  log(`WARNING: MediaWiki setup failed (${(error as Error).message}). Writes will fail until it is reachable.`);
}

try {
  await app.mailer.transport.verify();
  log(`Mail driver "${app.mailer.transport.name}" ready`);
} catch (error) {
  log(`WARNING: mail transport not reachable (${(error as Error).message}). Codes will be queued and retried.`);
}

try {
  publishDiscoveryFiles(app.config, REPO_DIR);
  await publishToolSchemas(app, REPO_DIR);
  log(`Setup instructions published at ${app.config.publicUrl}/llms.txt`);
} catch (error) {
  log(`WARNING: could not write llms.txt (${(error as Error).message})`);
}

app.indexer.start(app.config.indexPollSeconds, (error) => log(`index poll failed: ${(error as Error).message}`));
app.mailer.startWorker();
setInterval(() => app.db.pruneRateEvents(), 3_600_000);

if (app.config.dumpIntervalHours > 0) {
  // Checked hourly against the newest edition on disk, so restarts never postpone it.
  let dumping = false;
  const dumpIfDue = () => {
    if (dumping || !dumpDue(app.config)) return;
    dumping = true;
    createDumps(app, log)
      .then(() => log('dump edition complete'))
      .catch((error) => log(`dump failed: ${(error as Error).message}`))
      .finally(() => { dumping = false; });
  };
  setTimeout(dumpIfDue, 60_000);
  setInterval(dumpIfDue, 3_600_000);
}

const server = createHttpServer(app, app.auth, app.mailer);
server.listen(app.config.port, app.config.host, () => {
  log(`ReverseEngineering.wiki gateway listening on ${app.config.publicUrl} (MCP: ${app.config.publicUrl}/mcp)`);
});

const shutdown = () => {
  app.indexer.stop();
  app.mailer.stopWorker();
  server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
