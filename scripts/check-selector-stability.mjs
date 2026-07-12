import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const source = fs.readFileSync('src/App.tsx', 'utf8');
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

assert(
  source.includes('useSelectorRequestGate<"gsc" | "bing" | "ga4" | "onboarding-ga4">()'),
  'App must gate selector fetches through useSelectorRequestGate',
);
assert(
  source.includes('resolveSourceSwitchSelection({'),
  'App must restore source-scoped selector state through resolveSourceSwitchSelection',
);
assert(
  source.includes('selectedSiteCacheKey(user.uid, persistenceSource)'),
  'Workspace site persistence must be scoped by data source',
);
assert(
  source.includes('getWorkspaceSiteForGa4Property(propertyId, selectedSite, accessibleGa4Sites, accessibleWorkspaceSites)'),
  'GA4 property selection must resolve the matching workspace site through shared helpers',
);

const tempRoot = path.resolve('.tmp', 'selector-stability-check');
fs.mkdirSync(tempRoot, { recursive: true });

const compileTargets = [
  'src/lib/siteSelection.ts',
  'src/lib/useSelectorRequestGate.ts',
  'src/lib/siteSelection.test.ts',
  'src/lib/useSelectorRequestGate.test.ts',
];

for (const inputPath of compileTargets) {
  const sourceText = fs.readFileSync(inputPath, 'utf8');
  const transpiled = ts.transpileModule(sourceText, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      jsx: ts.JsxEmit.ReactJSX,
    },
    fileName: inputPath,
  });
  const outputPath = path.resolve(tempRoot, inputPath).replace(/\.ts$/, '.mjs');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const fixedOutput = transpiled.outputText.replace(
    /from "(\.\.?\/[^".]+)"/g,
    'from "$1.mjs"',
  );
  fs.writeFileSync(outputPath, fixedOutput);
}

const siteSelectionTests = await import(pathToFileURL(path.resolve(tempRoot, 'src/lib/siteSelection.test.mjs')).href);
const requestGateTests = await import(pathToFileURL(path.resolve(tempRoot, 'src/lib/useSelectorRequestGate.test.mjs')).href);

await requestGateTests.runSelectorRequestGateTests();
siteSelectionTests.runSiteSelectionTests();

console.log('Selector stability check passed');
