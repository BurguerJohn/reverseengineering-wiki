/** Gateway server: HTTP (MCP + accounts), index polling, mail retries, daily dumps. */
import { spawn } from 'node:child_process';
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
  if (app.config.publishSiteFiles) {
    publishDiscoveryFiles(app.config, REPO_DIR);
    await publishToolSchemas(app, REPO_DIR);
    log(`Setup instructions published at ${app.config.publicUrl}/llms.txt`);
  }
} catch (error) {
  log(`WARNING: could not write llms.txt (${(error as Error).message})`);
}

app.indexer.start(app.config.indexPollSeconds, (error) => log(`index poll failed: ${(error as Error).message}`));

// MediaWiki's job queue ($wgJobRunRate = 0 in custom/REWikiSettings.php): drained here, a few
// seconds after edits, instead of inside every API request.
let jobsRunning = false;
const runJobs = () => {
  if (jobsRunning) return;
  jobsRunning = true;
  const child = spawn(app.config.mw.phpBin, ['maintenance/run.php', 'runJobs', '--maxtime=20', '--quiet'], {
    cwd: app.config.mw.dir, env: app.config.mw.env, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('error', (error) => { jobsRunning = false; log(`runJobs failed: ${error.message}`); });
  child.on('close', (code) => {
    jobsRunning = false;
    if (code) log(`runJobs exited ${code}: ${stderr.slice(0, 300)}`);
  });
};
setTimeout(runJobs, 5_000);
setInterval(runJobs, 15_000);
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
