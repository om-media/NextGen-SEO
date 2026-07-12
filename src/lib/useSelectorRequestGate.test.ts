import assert from "node:assert/strict";

import { createSelectorRequestGate } from "./useSelectorRequestGate";

export async function runSelectorRequestGateTests() {
  const gate = createSelectorRequestGate<"gsc">();
  const applied: string[] = [];

  const staleRequestId = gate.begin("gsc");
  const freshRequestId = gate.begin("gsc");

  await Promise.all([
    Promise.resolve().then(() => {
      if (gate.isCurrent("gsc", staleRequestId)) {
        applied.push("stale");
      }
    }),
    Promise.resolve().then(() => {
      if (gate.isCurrent("gsc", freshRequestId)) {
        applied.push("fresh");
      }
    }),
  ]);

  assert.deepEqual(applied, ["fresh"]);

  const ga4Gate = createSelectorRequestGate<"ga4">();
  const requestId = ga4Gate.begin("ga4");
  ga4Gate.cancel("ga4");
  assert.equal(ga4Gate.isCurrent("ga4", requestId), false);
}
