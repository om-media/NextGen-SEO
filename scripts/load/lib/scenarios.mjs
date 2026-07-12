import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createSeededRng, jainFairnessIndex, pickOne, runWithConcurrency, sleep, summarizeDurations } from './util.mjs';

function dedupeTargets(users) {
  const unique = new Map();
  for (const user of users) {
    if (!user.siteUrl || unique.has(user.siteUrl)) continue;
    unique.set(user.siteUrl, {
      siteUrl: user.siteUrl,
      startUrl: user.startUrl || null,
      userId: user.id,
    });
  }
  return [...unique.values()];
}

function pickBurstTargets(users, explicitTargets, count, rng) {
  const seedTargets = explicitTargets?.length ? explicitTargets : dedupeTargets(users);
  if (!seedTargets.length) {
    throw new Error('No site targets are available for the selected burst scenario.');
  }

  const picked = [];
  const pool = [...seedTargets];
  while (picked.length < count) {
    const target = pool.length ? pool.splice(Math.floor(rng() * pool.length), 1)[0] : pickOne(seedTargets, rng);
    const fallbackUser = users.find((user) => user.id === target.userId && user.siteUrl === target.siteUrl)
      || users.find((user) => user.siteUrl === target.siteUrl)
      || pickOne(users, rng);
    picked.push({
      ...target,
      user: fallbackUser,
    });
  }

  return picked;
}

function chooseSiteContext(user, sessionPayload, workspacePayload) {
  return {
    propertyId: user.propertyId || workspacePayload?.ga4PropertyId || sessionPayload?.profile?.activatedGa4PropertyId || null,
    siteUrl: user.siteUrl
      || sessionPayload?.profile?.activatedSiteUrl
      || workspacePayload?.sites?.find((site) => site?.isDefault)?.siteUrl
      || workspacePayload?.sites?.[0]?.siteUrl
      || null,
    startUrl: user.startUrl || null,
  };
}

export function buildDashboardTimeline(config, users) {
  const rng = createSeededRng(config.seed);
  const tasks = [];
  const rampWindow = Math.max(1, config.dashboard.rampMs);

  for (let index = 0; index < users.length; index += 1) {
    const user = users[index];
    const baseStart = Math.floor((rampWindow / users.length) * index);
    for (let loop = 0; loop < config.dashboard.loopsPerUser; loop += 1) {
      const jitter = Math.floor(
        config.dashboard.thinkTimeMinMs
        + rng() * (config.dashboard.thinkTimeMaxMs - config.dashboard.thinkTimeMinMs + 1),
      );
      tasks.push({
        loop: loop + 1,
        scheduledAtMs: baseStart + loop * jitter,
        user,
      });
    }
  }

  tasks.sort((left, right) => left.scheduledAtMs - right.scheduledAtMs || left.user.id.localeCompare(right.user.id));
  return tasks;
}

async function runDashboardSequence(client, config, user, loop) {
  const session = await client.request({
    path: '/api/auth/session',
    scenario: 'dashboard',
    step: 'auth-session',
    user,
  });

  const workspace = await client.request({
    path: '/api/workspace/sites/status',
    scenario: 'dashboard',
    step: 'workspace-sites',
    user,
  });

  const context = chooseSiteContext(user, session.data, workspace.data);
  if (!context.siteUrl) {
    return { skipped: true, userId: user.id };
  }

  await client.request({
    path: '/api/warehouse/status',
    query: { siteUrl: context.siteUrl },
    scenario: 'dashboard',
    step: 'warehouse-status',
    user,
  });

  await client.request({
    path: '/api/warehouse/coverage',
    query: {
      endDate: config.dashboard.coverageRange.endDate,
      propertyId: context.propertyId,
      siteUrl: context.siteUrl,
      startDate: config.dashboard.coverageRange.startDate,
    },
    scenario: 'dashboard',
    step: 'warehouse-coverage',
    user,
  });

  await client.request({
    path: '/api/crawl/status',
    query: { siteUrl: context.siteUrl },
    scenario: 'dashboard',
    step: 'crawl-status',
    user,
  });

  await client.request({
    path: '/api/crawl/jobs',
    query: { limit: 5, siteUrl: context.siteUrl },
    scenario: 'dashboard',
    step: 'crawl-jobs',
    user,
  });

  if (config.dashboard.includeCrawlPages) {
    await client.request({
      path: '/api/crawl/pages',
      query: { limit: 25, offset: 0, siteUrl: context.siteUrl },
      scenario: 'dashboard',
      step: 'crawl-pages',
      user,
    });
  }

  if (config.dashboard.includeCrawlLinks) {
    await client.request({
      path: '/api/crawl/links',
      query: { limit: 25, offset: 0, siteUrl: context.siteUrl },
      scenario: 'dashboard',
      step: 'crawl-links',
      user,
    });
  }

  await client.request({
    path: '/api/internal-links/jobs',
    query: { limit: 5, siteUrl: context.siteUrl },
    scenario: 'dashboard',
    step: 'internal-link-jobs',
    user,
  });

  if (config.dashboard.includeOpportunities) {
    await client.request({
      path: '/api/internal-links/opportunities',
      query: {
        endDate: config.scenarios.internalLinksBurst.range.endDate,
        limit: 25,
        offset: 0,
        siteUrl: context.siteUrl,
        startDate: config.scenarios.internalLinksBurst.range.startDate,
      },
      scenario: 'dashboard',
      step: 'internal-link-opportunities',
      user,
    });
  }

  return {
    loop,
    siteUrl: context.siteUrl,
    skipped: false,
    userId: user.id,
  };
}

export async function runDashboardScenario(client, config, users, state) {
  const timeline = buildDashboardTimeline(config, users);
  state.dashboardTimeline = timeline;
  if (config.planOnly) {
    return {
      plannedSequences: timeline.length,
    };
  }

  const startedAt = Date.now();
  const results = await Promise.all(timeline.map(async (task) => {
    const delayMs = Math.max(0, task.scheduledAtMs - (Date.now() - startedAt));
    if (delayMs > 0) {
      await sleep(delayMs);
    }
    return runDashboardSequence(client, config, task.user, task.loop);
  }));

  state.dashboardResult = {
    plannedSequences: timeline.length,
    skippedSequences: results.filter((result) => result?.skipped).length,
  };
  return state.dashboardResult;
}

export async function runCrawlBurstScenario(client, config, users, state) {
  const rng = createSeededRng(config.seed + 11);
  const targets = pickBurstTargets(users, config.scenarios.crawlBurst.targets, config.scenarios.crawlBurst.count, rng);
  state.crawlJobs = state.crawlJobs || [];

  if (config.planOnly) {
    return { plannedJobs: targets.length };
  }

  const results = await Promise.all(targets.map(async (target) => {
    const response = await client.request({
      body: {
        includeQueryStrings: config.scenarios.crawlBurst.includeQueryStrings,
        maxDepth: config.scenarios.crawlBurst.maxDepth,
        maxPages: config.scenarios.crawlBurst.maxPages,
        renderMode: config.scenarios.crawlBurst.renderMode,
        respectRobots: config.scenarios.crawlBurst.respectRobots,
        siteUrl: target.siteUrl,
        startUrl: target.startUrl || config.scenarios.crawlBurst.startUrl || target.siteUrl,
        userAgent: config.scenarios.crawlBurst.userAgent,
      },
      method: 'POST',
      path: '/api/crawl/start',
      scenario: 'crawlBurst',
      step: 'queue-crawl',
      user: target.user,
    });

    const job = response.data?.job || null;
    if (job?.id) {
      state.crawlJobs.push({
        acceptedAt: Date.now(),
        id: job.id,
        siteUrl: target.siteUrl,
        status: job.status,
        user: target.user,
      });
    }
    return job;
  }));

  return {
    queuedJobs: results.filter(Boolean).length,
  };
}

export async function runInternalLinksBurstScenario(client, config, users, state) {
  const rng = createSeededRng(config.seed + 29);
  const targets = pickBurstTargets(users, config.scenarios.internalLinksBurst.targets, config.scenarios.internalLinksBurst.count, rng);
  state.internalLinkJobs = state.internalLinkJobs || [];

  if (config.planOnly) {
    return { plannedJobs: targets.length };
  }

  const results = await Promise.all(targets.map(async (target) => {
    const response = await client.request({
      acceptableStatuses: [409],
      body: {
        embeddingModel: config.scenarios.internalLinksBurst.embeddingModel,
        embeddingProvider: config.scenarios.internalLinksBurst.embeddingProvider,
        endDate: config.scenarios.internalLinksBurst.range.endDate,
        maxHostedSpend: config.scenarios.internalLinksBurst.maxHostedSpend,
        maxPages: config.scenarios.internalLinksBurst.maxPages,
        maxRecommendations: config.scenarios.internalLinksBurst.maxRecommendations,
        maxSentencesPerPage: config.scenarios.internalLinksBurst.maxSentencesPerPage,
        provider: config.scenarios.internalLinksBurst.provider,
        reviewModel: config.scenarios.internalLinksBurst.reviewModel,
        reviewProvider: config.scenarios.internalLinksBurst.reviewProvider,
        siteUrl: target.siteUrl,
        startDate: config.scenarios.internalLinksBurst.range.startDate,
      },
      method: 'POST',
      path: '/api/internal-links/analyze',
      scenario: 'internalLinksBurst',
      step: 'queue-internal-links',
      user: target.user,
    });

    const job = response.data?.job || null;
    if (job?.id) {
      state.internalLinkJobs.push({
        acceptedAt: Date.now(),
        id: job.id,
        siteUrl: target.siteUrl,
        status: job.status,
        user: target.user,
      });
    }
    return {
      conflict: response.status === 409,
      job,
    };
  }));

  return {
    conflicts: results.filter((result) => result.conflict).length,
    queuedJobs: results.filter((result) => result.job).length,
  };
}

function buildBgeTexts(batchIndex, batchSize) {
  return Array.from({ length: batchSize }, (_, index) => (
    `Load harness batch ${batchIndex + 1}, sentence ${index + 1}: internal links should keep navigation precise, relevant, and editorially useful.`
  ));
}

export async function runBgeScenario(client, config, state) {
  const batches = Array.from({ length: config.scenarios.bge.batches }, (_, index) => index);
  if (config.planOnly) {
    return {
      batches: batches.length,
      batchSize: config.scenarios.bge.batchSize,
    };
  }

  await client.request({
    baseUrl: config.workerBaseUrl,
    path: '/health/ready',
    scenario: 'bge',
    step: 'worker-ready',
  });

  const results = await runWithConcurrency(config.scenarios.bge.concurrency, batches, async (batchIndex) => {
    const response = await client.request({
      baseUrl: config.workerBaseUrl,
      body: {
        normalize: config.scenarios.bge.normalize,
        texts: buildBgeTexts(batchIndex, config.scenarios.bge.batchSize),
      },
      method: 'POST',
      path: '/embed',
      scenario: 'bge',
      step: 'embed-batch',
    });

    const embeddings = Array.isArray(response.data?.embeddings) ? response.data.embeddings : [];
    if (embeddings.length !== config.scenarios.bge.batchSize) {
      throw new Error(`BGE batch ${batchIndex + 1} returned ${embeddings.length} embeddings, expected ${config.scenarios.bge.batchSize}.`);
    }
    return embeddings.length;
  });

  state.bgeResult = {
    batchesCompleted: results.length,
    embeddingsRequested: results.reduce((sum, value) => sum + value, 0),
  };
  return state.bgeResult;
}

function selectCancelableJobs(state, config) {
  const crawlLimit = Math.ceil((state.crawlJobs?.length || 0) * config.scenarios.cancellation.crawlPercent);
  const internalLimit = Math.ceil((state.internalLinkJobs?.length || 0) * config.scenarios.cancellation.internalLinksPercent);
  return {
    crawl: (state.crawlJobs || []).slice(0, crawlLimit),
    internalLinks: (state.internalLinkJobs || []).slice(0, internalLimit),
  };
}

export async function runCancellationScenario(client, config, state) {
  const selected = selectCancelableJobs(state, config);
  if (config.planOnly) {
    return {
      crawl: selected.crawl.length,
      internalLinks: selected.internalLinks.length,
    };
  }

  await sleep(config.scenarios.cancellation.delayMs);
  const cancellations = [];

  for (const job of selected.crawl) {
    cancellations.push(client.request({
      acceptableStatuses: [404],
      body: { jobId: job.id, siteUrl: job.siteUrl },
      method: 'POST',
      path: '/api/crawl/cancel',
      scenario: 'cancellation',
      step: 'cancel-crawl',
      user: job.user,
    }));
  }

  for (const job of selected.internalLinks) {
    cancellations.push(client.request({
      acceptableStatuses: [404, 409],
      method: 'POST',
      path: `/api/internal-links/jobs/${encodeURIComponent(job.id)}/cancel`,
      scenario: 'cancellation',
      step: 'cancel-internal-links',
      user: job.user,
    }));
  }

  const results = await Promise.allSettled(cancellations);
  const succeeded = results.filter((result) => result.status === 'fulfilled').length;
  const total = results.length;
  state.cancellationResult = {
    attempted: total,
    succeeded,
    successRate: total ? Number((succeeded / total).toFixed(4)) : 1,
  };
  return state.cancellationResult;
}

async function observeCrawlJob(client, job) {
  const response = await client.request({
    acceptableStatuses: [404],
    path: '/api/crawl/status',
    query: { jobId: job.id, siteUrl: job.siteUrl },
    scenario: 'fairness',
    step: 'observe-crawl',
    user: job.user,
  });
  return response.data?.job || null;
}

async function observeInternalLinkJob(client, job) {
  const response = await client.request({
    acceptableStatuses: [404],
    path: '/api/internal-links/jobs',
    query: { limit: 20, siteUrl: job.siteUrl },
    scenario: 'fairness',
    step: 'observe-internal-links',
    user: job.user,
  });
  return Array.isArray(response.data?.jobs) ? response.data.jobs.find((entry) => entry.id === job.id) || null : null;
}

function mergeObservedJob(job, observed) {
  if (!observed) return job;
  const startedAt = observed.startedAt ? Date.parse(observed.startedAt) : null;
  const completedAt = observed.completedAt ? Date.parse(observed.completedAt) : null;
  return {
    ...job,
    completedAt: completedAt || job.completedAt || null,
    firstRunningAt: job.firstRunningAt || startedAt || null,
    status: observed.status || job.status,
  };
}

export async function runFairnessScenario(client, config, state) {
  const combined = [
    ...(state.crawlJobs || []).map((job) => ({ ...job, kind: 'crawl' })),
    ...(state.internalLinkJobs || []).map((job) => ({ ...job, kind: 'internal-links' })),
  ];

  if (!combined.length) {
    state.fairnessResult = {
      maxStartLagMs: 0,
      observedJobs: 0,
      p95StartLagMs: 0,
      terminalJain: 1,
    };
    return state.fairnessResult;
  }

  if (config.planOnly) {
    return { observedJobs: combined.length };
  }

  const deadline = Date.now() + config.scenarios.fairness.maxWaitMs;
  let observedJobs = combined;
  while (Date.now() < deadline) {
    observedJobs = await Promise.all(observedJobs.map(async (job) => {
      const observed = job.kind === 'crawl'
        ? await observeCrawlJob(client, job)
        : await observeInternalLinkJob(client, job);
      return mergeObservedJob(job, observed);
    }));

    const allTerminal = observedJobs.every((job) => ['completed', 'error', 'canceled'].includes(job.status));
    if (allTerminal) break;
    await sleep(config.scenarios.fairness.pollIntervalMs);
  }

  state.crawlJobs = observedJobs.filter((job) => job.kind === 'crawl');
  state.internalLinkJobs = observedJobs.filter((job) => job.kind === 'internal-links');

  const startLags = observedJobs
    .map((job) => (job.firstRunningAt ? job.firstRunningAt - job.acceptedAt : null))
    .filter(Number.isFinite);
  const completedCountsBySite = new Map();
  for (const job of observedJobs) {
    const value = completedCountsBySite.get(job.siteUrl) || 0;
    completedCountsBySite.set(job.siteUrl, value + (['completed', 'canceled'].includes(job.status) ? 1 : 0));
  }

  state.fairnessResult = {
    maxStartLagMs: startLags.length ? Math.max(...startLags) : config.scenarios.fairness.maxWaitMs,
    observedJobs: observedJobs.length,
    p95StartLagMs: summarizeDurations(startLags).p95Ms || 0,
    terminalJain: jainFairnessIndex([...completedCountsBySite.values()]),
  };
  return state.fairnessResult;
}

async function runRestartCommand(command, cwd) {
  const [file, ...args] = command;
  const child = spawn(file, args, {
    cwd: cwd || process.cwd(),
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  const [code] = await once(child, 'close');
  return {
    code: Number(code || 0),
    stderr: stderr.trim(),
    stdout: stdout.trim(),
  };
}

export async function runRestartScenario(client, config, users, state) {
  if (config.planOnly) {
    return {
      command: config.scenarios.restart.command,
    };
  }

  const probeUser = users[0] || null;
  let consecutiveHealthy = 0;
  let hadFailure = false;
  const startedAt = Date.now();
  const commandPromise = runRestartCommand(config.scenarios.restart.command, config.scenarios.restart.cwd);

  while (Date.now() - startedAt <= config.scenarios.restart.maxRecoveryMs) {
    try {
      await client.request({
        acceptableStatuses: [503],
        path: '/api/ready',
        scenario: 'restart',
        step: 'ready-probe',
      });
      if (probeUser) {
        await client.request({
          acceptableStatuses: [401, 503],
          path: '/api/auth/session',
          scenario: 'restart',
          step: 'auth-probe',
          user: probeUser,
        });
      }
      consecutiveHealthy += 1;
      if (hadFailure && consecutiveHealthy >= config.scenarios.restart.settleSuccesses) {
        break;
      }
    } catch {
      hadFailure = true;
      consecutiveHealthy = 0;
    }

    await sleep(config.scenarios.restart.probeIntervalMs);
  }

  const commandResult = await commandPromise;
  state.restartResult = {
    command: config.scenarios.restart.command,
    commandExitCode: commandResult.code,
    recovered: consecutiveHealthy >= config.scenarios.restart.settleSuccesses,
    recoveryMs: Date.now() - startedAt,
    stderr: commandResult.stderr || null,
    stdout: commandResult.stdout || null,
  };
  return state.restartResult;
}
