import { formatMs, jainFairnessIndex, summarizeDurations } from './util.mjs';

export function createMetricsCollector() {
  const requests = [];
  const notes = [];

  return {
    notes,
    requests,
    note(message, context = {}) {
      notes.push({
        message,
        timestamp: new Date().toISOString(),
        ...context,
      });
    },
    record(entry) {
      requests.push({
        timestamp: new Date().toISOString(),
        ...entry,
      });
    },
  };
}

function groupBy(records, keyFn) {
  const groups = new Map();
  for (const record of records) {
    const key = keyFn(record);
    const list = groups.get(key) || [];
    list.push(record);
    groups.set(key, list);
  }
  return groups;
}

function summarizeGroup(records) {
  const durations = records.map((record) => record.durationMs);
  const failed = records.filter((record) => !record.ok);
  const conflicts = records.filter((record) => record.status === 409);
  return {
    requests: records.length,
    failures: failed.length,
    conflicts: conflicts.length,
    errorRate: records.length ? Number((failed.length / records.length).toFixed(4)) : 0,
    conflictRate: records.length ? Number((conflicts.length / records.length).toFixed(4)) : 0,
    durations: summarizeDurations(durations),
  };
}

export function summarizeMetrics(requests) {
  const overall = summarizeGroup(requests);
  const byScenario = {};
  const byStep = {};
  const byUser = {};

  for (const [scenario, records] of groupBy(requests, (record) => record.scenario || 'unknown')) {
    byScenario[scenario] = summarizeGroup(records);
  }

  for (const [step, records] of groupBy(requests, (record) => `${record.scenario || 'unknown'}:${record.step || 'unknown'}`)) {
    byStep[step] = summarizeGroup(records);
  }

  for (const [userId, records] of groupBy(requests, (record) => record.userId || 'anonymous')) {
    byUser[userId] = {
      ...summarizeGroup(records),
      meanLatencyMs: records.length ? Number((records.reduce((sum, record) => sum + record.durationMs, 0) / records.length).toFixed(2)) : null,
    };
  }

  const perUserCounts = Object.values(byUser).map((entry) => entry.requests);
  const perUserMeanLatencies = Object.values(byUser)
    .map((entry) => entry.meanLatencyMs)
    .filter(Number.isFinite);

  return {
    overall,
    byScenario,
    byStep,
    byUser,
    fairnessSignals: {
      requestCountJain: jainFairnessIndex(perUserCounts),
      meanLatencyJain: jainFairnessIndex(perUserMeanLatencies),
    },
  };
}

export function evaluateGates(summary, state, config) {
  const gates = [];

  function check(name, passed, detail) {
    gates.push({ name, passed, detail });
  }

  check(
    'overall-error-rate',
    summary.overall.errorRate <= config.gates.maxErrorRate,
    `errorRate=${summary.overall.errorRate} max=${config.gates.maxErrorRate}`,
  );

  const dashboard = summary.byScenario.dashboard;
  if (dashboard?.durations?.p95Ms !== null && dashboard?.durations?.p95Ms !== undefined) {
    check(
      'dashboard-p95',
      dashboard.durations.p95Ms <= config.gates.dashboardP95Ms,
      `p95=${formatMs(dashboard.durations.p95Ms)} max=${formatMs(config.gates.dashboardP95Ms)}`,
    );
    check(
      'dashboard-p99',
      dashboard.durations.p99Ms <= config.gates.dashboardP99Ms,
      `p99=${formatMs(dashboard.durations.p99Ms)} max=${formatMs(config.gates.dashboardP99Ms)}`,
    );
  }

  const bge = summary.byScenario.bge;
  if (bge?.durations?.p95Ms !== null && bge?.durations?.p95Ms !== undefined) {
    check(
      'bge-p95',
      bge.durations.p95Ms <= config.gates.bgeP95Ms,
      `p95=${formatMs(bge.durations.p95Ms)} max=${formatMs(config.gates.bgeP95Ms)}`,
    );
  }

  if (state.cancellationResult) {
    check(
      'cancellation-success-rate',
      state.cancellationResult.successRate >= config.gates.cancellationSuccessRateMin,
      `successRate=${state.cancellationResult.successRate} min=${config.gates.cancellationSuccessRateMin}`,
    );
  }

  if (state.fairnessResult) {
    check(
      'fairness-jain',
      state.fairnessResult.terminalJain >= config.gates.fairnessJainMin,
      `terminalJain=${state.fairnessResult.terminalJain} min=${config.gates.fairnessJainMin}`,
    );
    check(
      'fairness-start-lag',
      state.fairnessResult.maxStartLagMs <= config.gates.fairnessMaxStartLagMs,
      `maxStartLag=${formatMs(state.fairnessResult.maxStartLagMs)} max=${formatMs(config.gates.fairnessMaxStartLagMs)}`,
    );
  }

  if (state.restartResult) {
    check(
      'restart-recovery',
      state.restartResult.recovered && state.restartResult.recoveryMs <= config.gates.restartMaxRecoveryMs,
      `recovered=${state.restartResult.recovered} recovery=${formatMs(state.restartResult.recoveryMs)} max=${formatMs(config.gates.restartMaxRecoveryMs)}`,
    );
  }

  return {
    gates,
    passed: gates.every((gate) => gate.passed),
  };
}
