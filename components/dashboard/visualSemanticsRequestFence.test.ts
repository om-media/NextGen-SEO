import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

import {
  createVisualSemanticsRequestFence,
  getVisualSemanticsEvidenceKey,
  getVisualSemanticsWorkspaceKey,
} from "./visualSemanticsRequestFence";

export function runVisualSemanticsRequestFenceTests() {
  const fence = createVisualSemanticsRequestFence();
  const alphaWorkspaceKey = getVisualSemanticsWorkspaceKey({
    activeView: "pages",
    offset: 0,
    search: "",
    siteUrl: "https://alpha.example/",
  });
  const alphaWorkspace = fence.begin("workspace", alphaWorkspaceKey);
  assert.equal(fence.isCurrent("workspace", alphaWorkspace), true);

  const betaWorkspaceKey = getVisualSemanticsWorkspaceKey({
    activeView: "pages",
    offset: 0,
    search: "",
    siteUrl: "https://beta.example/",
  });
  const betaWorkspace = fence.begin("workspace", betaWorkspaceKey);
  assert.equal(fence.isCurrent("workspace", alphaWorkspace), false);
  assert.equal(fence.isCurrent("workspace", betaWorkspace), true);

  const alphaEvidence = fence.begin(
    "evidence",
    getVisualSemanticsEvidenceKey("https://alpha.example/", "/page-1"),
  );
  fence.cancelAll();
  assert.equal(fence.isCurrent("evidence", alphaEvidence), false);

  const betaPageOne = fence.begin(
    "evidence",
    getVisualSemanticsEvidenceKey("https://beta.example/", "/page-1"),
  );
  const betaPageTwo = fence.begin(
    "evidence",
    getVisualSemanticsEvidenceKey("https://beta.example/", "/page-2"),
  );
  assert.equal(fence.isCurrent("evidence", betaPageOne), false);
  assert.equal(fence.isCurrent("evidence", betaPageTwo), true);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runVisualSemanticsRequestFenceTests();
  console.log("Visual semantics request fence tests passed");
}
