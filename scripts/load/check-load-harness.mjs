#!/usr/bin/env node

import assert from 'node:assert/strict';
import { buildAuthHeaders } from './lib/auth.mjs';
import { createDefaultConfig, createExecutionPlan, loadHarnessConfig } from './lib/config.mjs';
import { evaluateGates, summarizeMetrics } from './lib/metrics.mjs';
import { buildDashboardTimeline } from './lib/scenarios.mjs';
import { createSeededRng, jainFairnessIndex, mergeConfig } from './lib/util.mjs';

async function expectReject(fn, pattern) {
  let failed = false;
  try {
    await fn();
  } catch (error) {
    failed = true;
    assert.match(String(error.message || error), pattern);
  }
  assert.equal(failed, true, `Expected rejection matching ${pattern}`);
}

async function main() {
  const baseConfig = createDefaultConfig();

  {
    const rngA = createSeededRng(200);
    const rngB = createSeededRng(200);
    const samplesA = Array.from({ length: 5 }, () => rngA());
    const samplesB = Array.from({ length: 5 }, () => rngB());
    assert.deepEqual(samplesA, samplesB);
  }

  {
    const timelineA = buildDashboardTimeline(baseConfig, [
      { id: 'u1' },
      { id: 'u2' },
      { id: 'u3' },
    ]);
    const timelineB = buildDashboardTimeline(baseConfig, [
      { id: 'u1' },
      { id: 'u2' },
      { id: 'u3' },
    ]);
    assert.deepEqual(timelineA, timelineB);
    assert.equal(timelineA.length, 6);
  }

  {
    const headers = buildAuthHeaders({ sessionCookie: 'nextgen_session=abc', id: 'cookie-user' });
    assert.equal(headers.Cookie, 'nextgen_session=abc');
  }

  {
    const headers = buildAuthHeaders({ bearerToken: 'token-123', id: 'token-user' });
    assert.equal(headers.Authorization, 'Bearer token-123');
  }

  {
    const plan = createExecutionPlan(baseConfig, 200);
    assert.equal(plan[0].scenario, 'dashboard');
    assert.equal(plan[0].totalSequences, 400);
  }

  {
    await expectReject(() => loadHarnessConfig({
      cliArgs: {
        scenarios: 'crawlBurst',
        users: 'scripts/load/fixtures/sample-users.json',
      },
      cwd: process.cwd(),
    }), /allowWrites=true/);
  }

  {
    await expectReject(() => loadHarnessConfig({
      cliArgs: {
        'allow-writes': true,
        'allow-db-restart': false,
        scenarios: 'restart',
        users: 'scripts/load/fixtures/sample-users.json',
      },
      cwd: process.cwd(),
    }), /allowDbRestart=true/);
  }

  {
    const metrics = summarizeMetrics([
      { durationMs: 100, ok: true, scenario: 'dashboard', status: 200, step: 'a', userId: 'u1' },
      { durationMs: 125, ok: true, scenario: 'dashboard', status: 200, step: 'a', userId: 'u2' },
      { durationMs: 500, ok: false, scenario: 'dashboard', status: 500, step: 'b', userId: 'u2' },
    ]);
    assert.equal(metrics.overall.requests, 3);
    assert.equal(metrics.overall.failures, 1);
    assert.equal(metrics.byScenario.dashboard.failures, 1);
  }

  {
    const config = mergeConfig(baseConfig, {
      gates: {
        dashboardP95Ms: 300,
        dashboardP99Ms: 600,
        maxErrorRate: 0.5,
      },
    });
    const metrics = summarizeMetrics([
      { durationMs: 100, ok: true, scenario: 'dashboard', status: 200, step: 'a', userId: 'u1' },
      { durationMs: 200, ok: true, scenario: 'dashboard', status: 200, step: 'a', userId: 'u2' },
    ]);
    const gates = evaluateGates(metrics, {}, config);
    assert.equal(gates.passed, true);
  }

  {
    assert.equal(jainFairnessIndex([1, 1, 1, 1]), 1);
    assert.ok(jainFairnessIndex([0, 1, 4]) < 1);
  }

  console.log(JSON.stringify({
    ok: true,
    tests: 10,
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || error);
  process.exit(1);
});
