#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { loadUserFixtures, resolveAuthenticatedUsers } from './lib/auth.mjs';
import { createExecutionPlan, loadHarnessConfig } from './lib/config.mjs';
import { createHttpClient } from './lib/http.mjs';
import { createMetricsCollector, evaluateGates, summarizeMetrics } from './lib/metrics.mjs';
import {
  runBgeScenario,
  runCancellationScenario,
  runCrawlBurstScenario,
  runDashboardScenario,
  runFairnessScenario,
  runInternalLinksBurstScenario,
  runRestartScenario,
} from './lib/scenarios.mjs';
import { parseArgs, writeJsonFile } from './lib/util.mjs';

function printHelp() {
  console.log(`Usage: node scripts/load/run-production-load.mjs --config <path> [options]

Options:
  --users <path>               Override auth fixture path
  --scenarios <csv>            dashboard,crawlBurst,internalLinksBurst,bge,cancellation,fairness,restart
  --vus <n>                    Virtual user count (default 200)
  --seed <n>                   Deterministic seed (default 200)
  --plan-only                  Print the execution plan without sending requests
  --allow-writes               Required for crawl/internal-link/cancellation scenarios
  --allow-db-restart           Required for restart scenario
  --dashboard-loops <n>        Override dashboard loops per user
  --dashboard-ramp <dur>       Override dashboard ramp, e.g. 60s or 2m
  --timeout <dur>              Request timeout, e.g. 30s
  --output <path>              Write JSON summary to a file
  --help                       Show this help
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const configPath = args.config || 'scripts/load/fixtures/sample-config.json';
  const config = await loadHarnessConfig({
    cliArgs: args,
    configPath,
    cwd: process.cwd(),
  });

  const users = config.planOnly
    ? (config.auth.usersPath ? await loadUserFixtures(config.auth.usersPath, process.cwd()) : [])
    : await resolveAuthenticatedUsers(config, process.cwd());
  const plan = createExecutionPlan(config, users.length || config.vus);

  if (config.planOnly) {
    console.log(JSON.stringify({
      baseUrl: config.baseUrl,
      plan,
      seed: config.seed,
      users: users.length || config.vus,
      writeArmed: config.allowWrites,
      dbRestartArmed: config.allowDbRestart,
    }, null, 2));
    return;
  }

  const collector = createMetricsCollector();
  const client = createHttpClient(config, collector);
  const state = {
    crawlJobs: [],
    internalLinkJobs: [],
    notes: collector.notes,
    plan,
  };

  if (config.scenarios.dashboard.enabled) {
    await runDashboardScenario(client, config, users, state);
  }
  if (config.scenarios.crawlBurst.enabled) {
    await runCrawlBurstScenario(client, config, users, state);
  }
  if (config.scenarios.internalLinksBurst.enabled) {
    await runInternalLinksBurstScenario(client, config, users, state);
  }
  if (config.scenarios.bge.enabled) {
    await runBgeScenario(client, config, state);
  }
  if (config.scenarios.cancellation.enabled) {
    await runCancellationScenario(client, config, state);
  }
  if (config.scenarios.fairness.enabled) {
    await runFairnessScenario(client, config, state);
  }
  if (config.scenarios.restart.enabled) {
    await runRestartScenario(client, config, users, state);
  }

  const metrics = summarizeMetrics(collector.requests);
  const gates = evaluateGates(metrics, state, config);
  const summary = {
    baseUrl: config.baseUrl,
    generatedAt: new Date().toISOString(),
    gates,
    metrics,
    plan,
    seed: config.seed,
    state: {
      bgeResult: state.bgeResult || null,
      cancellationResult: state.cancellationResult || null,
      dashboardResult: state.dashboardResult || null,
      fairnessResult: state.fairnessResult || null,
      restartResult: state.restartResult || null,
    },
    users: users.length,
  };

  if (config.outputPath) {
    await writeJsonFile(path.resolve(process.cwd(), config.outputPath), summary);
  }

  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = gates.passed ? 0 : 1;
}

main().catch((error) => {
  console.error(error?.stack || error?.message || error);
  process.exit(1);
});


