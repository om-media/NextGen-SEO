import path from 'node:path';
import { addIsoDays, mergeConfig, normalizeUrlBase, parseDurationMs, readJsonFile, resolveDateRange } from './util.mjs';

const MUTATING_SCENARIOS = ['crawlBurst', 'internalLinksBurst', 'cancellation'];
const SCENARIO_NAMES = ['dashboard', 'crawlBurst', 'internalLinksBurst', 'bge', 'cancellation', 'fairness', 'restart'];

function booleanFromCli(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

export function createDefaultConfig() {
  const dashboardRange = resolveDateRange(28);
  const internalLinksRange = resolveDateRange(30);

  return {
    baseUrl: 'http://127.0.0.1:3000',
    workerBaseUrl: 'http://127.0.0.1:8091',
    vus: 200,
    seed: 200,
    requestTimeoutMs: 30_000,
    planOnly: false,
    allowWrites: false,
    allowDbRestart: false,
    outputPath: null,
    auth: {
      usersPath: null,
      allowAuthReuse: false,
      bootstrapConcurrency: 2,
      loginPath: '/api/auth/login',
    },
    dashboard: {
      loopsPerUser: 2,
      rampMs: 60_000,
      thinkTimeMinMs: 250,
      thinkTimeMaxMs: 1250,
      coverageRange: dashboardRange,
      includeCrawlPages: true,
      includeCrawlLinks: true,
      includeOpportunities: true,
    },
    scenarios: {
      dashboard: {
        enabled: true,
      },
      crawlBurst: {
        enabled: false,
        count: 12,
        includeQueryStrings: false,
        maxDepth: 2,
        maxPages: 250,
        renderMode: 'html',
        respectRobots: true,
        startUrl: null,
        targets: [],
        userAgent: 'GSC+ Load Harness',
      },
      internalLinksBurst: {
        enabled: false,
        count: 12,
        embeddingModel: 'bge-m3-local',
        embeddingProvider: 'local',
        maxHostedSpend: 0,
        maxPages: 250,
        maxRecommendations: 100,
        maxSentencesPerPage: 25,
        provider: 'local',
        reviewModel: 'local-rules',
        reviewProvider: 'local-rules',
        targets: [],
        range: internalLinksRange,
      },
      bge: {
        enabled: false,
        batches: 24,
        batchSize: 16,
        concurrency: 8,
        normalize: true,
      },
      cancellation: {
        enabled: false,
        crawlPercent: 0.25,
        delayMs: 5_000,
        internalLinksPercent: 0.5,
      },
      fairness: {
        enabled: false,
        maxWaitMs: 180_000,
        pollIntervalMs: 3_000,
      },
      restart: {
        enabled: false,
        command: [],
        cwd: null,
        maxRecoveryMs: 120_000,
        probeIntervalMs: 2_000,
        settleSuccesses: 3,
      },
    },
    gates: {
      maxErrorRate: 0.02,
      dashboardP95Ms: 1_500,
      dashboardP99Ms: 3_500,
      bgeP95Ms: 12_000,
      cancellationSuccessRateMin: 0.9,
      fairnessJainMin: 0.9,
      fairnessMaxStartLagMs: 60_000,
      restartMaxRecoveryMs: 120_000,
    },
  };
}

function setExclusiveScenarios(config, requested) {
  const enabled = new Set(requested.filter(Boolean));
  for (const name of SCENARIO_NAMES) {
    config.scenarios[name].enabled = enabled.has(name);
  }
}

function normalizeTargets(targets) {
  return Array.isArray(targets)
    ? targets
      .map((entry) => ({
        siteUrl: String(entry?.siteUrl || '').trim(),
        startUrl: entry?.startUrl ? String(entry.startUrl).trim() : null,
        userId: entry?.userId ? String(entry.userId).trim() : null,
      }))
      .filter((entry) => entry.siteUrl)
    : [];
}

function validateScenarioNames(requested) {
  const unknown = requested.filter((name) => !SCENARIO_NAMES.includes(name));
  if (unknown.length) {
    throw new Error(`Unknown scenarios: ${unknown.join(', ')}`);
  }
}

export async function loadHarnessConfig({ configPath, cwd = process.cwd(), cliArgs = {} }) {
  let config = createDefaultConfig();

  if (configPath) {
    const fileConfig = await readJsonFile(path.resolve(cwd, configPath));
    config = mergeConfig(config, fileConfig);
  }

  if (cliArgs['base-url']) config.baseUrl = cliArgs['base-url'];
  if (cliArgs['worker-base-url']) config.workerBaseUrl = cliArgs['worker-base-url'];
  if (cliArgs.vus) config.vus = Number(cliArgs.vus);
  if (cliArgs.seed) config.seed = Number(cliArgs.seed);
  if (cliArgs.timeout) config.requestTimeoutMs = parseDurationMs(cliArgs.timeout, config.requestTimeoutMs);
  if (cliArgs['users']) config.auth.usersPath = cliArgs.users;
  if (cliArgs['allow-auth-reuse'] !== undefined) config.auth.allowAuthReuse = booleanFromCli(cliArgs['allow-auth-reuse'], config.auth.allowAuthReuse);
  if (cliArgs['plan-only'] !== undefined) config.planOnly = booleanFromCli(cliArgs['plan-only'], config.planOnly);
  if (cliArgs['allow-writes'] !== undefined) config.allowWrites = booleanFromCli(cliArgs['allow-writes'], config.allowWrites);
  if (cliArgs['allow-db-restart'] !== undefined) config.allowDbRestart = booleanFromCli(cliArgs['allow-db-restart'], config.allowDbRestart);
  if (cliArgs.output) config.outputPath = cliArgs.output;
  if (cliArgs['dashboard-loops']) config.dashboard.loopsPerUser = Number(cliArgs['dashboard-loops']);
  if (cliArgs['dashboard-ramp']) config.dashboard.rampMs = parseDurationMs(cliArgs['dashboard-ramp'], config.dashboard.rampMs);
  if (cliArgs['fairness-wait']) config.scenarios.fairness.maxWaitMs = parseDurationMs(cliArgs['fairness-wait'], config.scenarios.fairness.maxWaitMs);

  if (cliArgs.scenarios) {
    const requested = String(cliArgs.scenarios)
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    validateScenarioNames(requested);
    setExclusiveScenarios(config, requested);
  }

  config.baseUrl = normalizeUrlBase(config.baseUrl);
  config.workerBaseUrl = normalizeUrlBase(config.workerBaseUrl);
  config.requestTimeoutMs = Number(config.requestTimeoutMs);
  config.vus = Number(config.vus);
  config.seed = Number(config.seed);
  config.dashboard.loopsPerUser = Number(config.dashboard.loopsPerUser);
  config.dashboard.rampMs = Number(config.dashboard.rampMs);
  config.dashboard.thinkTimeMinMs = Number(config.dashboard.thinkTimeMinMs);
  config.dashboard.thinkTimeMaxMs = Number(config.dashboard.thinkTimeMaxMs);
  config.scenarios.crawlBurst.count = Number(config.scenarios.crawlBurst.count);
  config.scenarios.internalLinksBurst.count = Number(config.scenarios.internalLinksBurst.count);
  config.scenarios.bge.batches = Number(config.scenarios.bge.batches);
  config.scenarios.bge.batchSize = Number(config.scenarios.bge.batchSize);
  config.scenarios.bge.concurrency = Number(config.scenarios.bge.concurrency);
  config.scenarios.cancellation.delayMs = Number(config.scenarios.cancellation.delayMs);
  config.scenarios.fairness.maxWaitMs = Number(config.scenarios.fairness.maxWaitMs);
  config.scenarios.fairness.pollIntervalMs = Number(config.scenarios.fairness.pollIntervalMs);
  config.scenarios.restart.maxRecoveryMs = Number(config.scenarios.restart.maxRecoveryMs);
  config.scenarios.restart.probeIntervalMs = Number(config.scenarios.restart.probeIntervalMs);
  config.scenarios.restart.settleSuccesses = Number(config.scenarios.restart.settleSuccesses);
  config.scenarios.restart.command = Array.isArray(config.scenarios.restart.command) ? config.scenarios.restart.command : [];
  config.scenarios.crawlBurst.targets = normalizeTargets(config.scenarios.crawlBurst.targets);
  config.scenarios.internalLinksBurst.targets = normalizeTargets(config.scenarios.internalLinksBurst.targets);

  const coverageRange = config.dashboard.coverageRange || {};
  if (!coverageRange.startDate || !coverageRange.endDate) {
    config.dashboard.coverageRange = resolveDateRange(28);
  }

  const internalRange = config.scenarios.internalLinksBurst.range || {};
  if (!internalRange.startDate || !internalRange.endDate) {
    config.scenarios.internalLinksBurst.range = resolveDateRange(30);
  }

  if (!config.baseUrl.startsWith('http://') && !config.baseUrl.startsWith('https://')) {
    throw new Error(`baseUrl must be an absolute HTTP(S) URL. Received: ${config.baseUrl}`);
  }
  if (!config.workerBaseUrl.startsWith('http://') && !config.workerBaseUrl.startsWith('https://')) {
    throw new Error(`workerBaseUrl must be an absolute HTTP(S) URL. Received: ${config.workerBaseUrl}`);
  }
  if (!Number.isInteger(config.vus) || config.vus < 1) throw new Error('vus must be a positive integer.');
  if (!Number.isFinite(config.seed)) throw new Error('seed must be numeric.');
  if (!Number.isFinite(config.requestTimeoutMs) || config.requestTimeoutMs < 1000) throw new Error('requestTimeoutMs must be at least 1000.');
  if (!Number.isInteger(config.dashboard.loopsPerUser) || config.dashboard.loopsPerUser < 1) throw new Error('dashboard.loopsPerUser must be at least 1.');
  if (config.dashboard.thinkTimeMaxMs < config.dashboard.thinkTimeMinMs) throw new Error('dashboard.thinkTimeMaxMs must be >= thinkTimeMinMs.');

  const enabledScenarios = SCENARIO_NAMES.filter((name) => config.scenarios[name].enabled);
  if (!enabledScenarios.length) {
    throw new Error('At least one scenario must be enabled.');
  }

  const mutatingEnabled = MUTATING_SCENARIOS.filter((name) => config.scenarios[name].enabled);
  if (!config.planOnly && mutatingEnabled.length && !config.allowWrites) {
    throw new Error(`Mutating scenarios require allowWrites=true. Enabled: ${mutatingEnabled.join(', ')}`);
  }

  if (!config.planOnly && config.scenarios.restart.enabled && !config.allowDbRestart) {
    throw new Error('The restart scenario requires allowDbRestart=true.');
  }
  if (config.scenarios.restart.enabled && config.scenarios.restart.command.length === 0) {
    throw new Error('The restart scenario requires scenarios.restart.command to be a non-empty array.');
  }
  if (!config.planOnly && !config.auth.usersPath && enabledScenarios.some((name) => name !== 'bge')) {
    throw new Error('Provide auth.usersPath or --users unless you are running only the bge scenario.');
  }

  return config;
}

export function createExecutionPlan(config, userCount) {
  const plan = [];
  if (config.scenarios.dashboard.enabled) {
    plan.push({
      scenario: 'dashboard',
      kind: 'read-only',
      users: userCount,
      loopsPerUser: config.dashboard.loopsPerUser,
      totalSequences: userCount * config.dashboard.loopsPerUser,
    });
  }
  if (config.scenarios.crawlBurst.enabled) {
    plan.push({
      scenario: 'crawlBurst',
      kind: 'mutating',
      targets: config.scenarios.crawlBurst.targets.length || config.scenarios.crawlBurst.count,
      startUrl: config.scenarios.crawlBurst.startUrl || 'derived-from-site',
    });
  }
  if (config.scenarios.internalLinksBurst.enabled) {
    plan.push({
      scenario: 'internalLinksBurst',
      kind: 'mutating',
      targets: config.scenarios.internalLinksBurst.targets.length || config.scenarios.internalLinksBurst.count,
      range: config.scenarios.internalLinksBurst.range,
    });
  }
  if (config.scenarios.bge.enabled) {
    plan.push({
      scenario: 'bge',
      kind: 'worker-load',
      batches: config.scenarios.bge.batches,
      batchSize: config.scenarios.bge.batchSize,
      concurrency: config.scenarios.bge.concurrency,
    });
  }
  if (config.scenarios.cancellation.enabled) {
    plan.push({
      scenario: 'cancellation',
      kind: 'mutating',
      delayMs: config.scenarios.cancellation.delayMs,
    });
  }
  if (config.scenarios.fairness.enabled) {
    plan.push({
      scenario: 'fairness',
      kind: 'observer',
      maxWaitMs: config.scenarios.fairness.maxWaitMs,
      pollIntervalMs: config.scenarios.fairness.pollIntervalMs,
    });
  }
  if (config.scenarios.restart.enabled) {
    plan.push({
      scenario: 'restart',
      kind: 'failure-injection',
      command: config.scenarios.restart.command,
      maxRecoveryMs: config.scenarios.restart.maxRecoveryMs,
    });
  }
  return plan;
}

export function buildInternalLinksRetryRange(endDate, days = 30) {
  return {
    endDate,
    startDate: addIsoDays(endDate, -(Math.max(1, Number(days || 30)) - 1)),
  };
}

