import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const source = fs.readFileSync('src/App.tsx', 'utf8');
const appContentSource = fs.readFileSync('src/components/app/AppContent.tsx', 'utf8');
const bingGridSource = fs.readFileSync('components/dashboard/BingDataGrid.tsx', 'utf8');

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
assert(
  appContentSource.includes('defaultStartUrl={getCrawlDefaultStartUrl(selectedSite)}'),
  'Crawl Inventory must default its start URL from the selected workspace site',
);
assert(
  appContentSource.includes('<BingDataGrid dateRange={dateRange} siteUrl={selectedSite} />'),
  'Bing reports must receive the selected dashboard date range',
);
assert(
  bingGridSource.includes('requestSequence.current !== requestId'),
  'Bing report requests must ignore stale site or date-range responses',
);
assert(
  source.includes("if (dataSource === 'bing')") && source.includes('currentSites.some((site) => site.siteUrl === selectedSite)'),
  'Bing must repair a cached site selection that is absent from the verified Bing site list',
);

const tempRoot = path.resolve('.tmp', 'selector-stability-check');
fs.mkdirSync(tempRoot, { recursive: true });

function transpileToTemp(inputPath, sourceText) {
  const transpiled = ts.transpileModule(sourceText, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      jsx: ts.JsxEmit.ReactJSX,
    },
    fileName: inputPath,
  });
  const outputPath = path.resolve(tempRoot, inputPath)
    .replace(/\.(ts|tsx)$/, '.mjs')
    .replace(/\.js$/, '.mjs');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const fixedOutput = transpiled.outputText.replace(
    /from "(\.\.?\/[^".]+)"/g,
    'from "$1.mjs"',
  );
  fs.writeFileSync(outputPath, fixedOutput);
  return outputPath;
}

function scriptKindFor(filePath) {
  if (filePath.endsWith('.tsx')) {
    return ts.ScriptKind.TSX;
  }
  if (filePath.endsWith('.ts')) {
    return ts.ScriptKind.TS;
  }
  return ts.ScriptKind.JS;
}

function extractFunctionSource(filePath, functionName) {
  const sourceText = fs.readFileSync(filePath, 'utf8');
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, scriptKindFor(filePath));
  let result = null;

  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === functionName) {
      result = sourceText.slice(node.getStart(sourceFile), node.getEnd());
      return;
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  if (!result) {
    throw new Error(`Failed to extract ${functionName} from ${filePath}`);
  }

  return result;
}

const compileTargets = [
  'src/lib/siteSelection.ts',
  'src/lib/useSelectorRequestGate.ts',
  'src/lib/siteSelection.test.ts',
  'src/lib/useSelectorRequestGate.test.ts',
];

for (const inputPath of compileTargets) {
  transpileToTemp(inputPath, fs.readFileSync(inputPath, 'utf8'));
}

const appContentHelperPath = transpileToTemp(
  'tmp/app-content-crawl-start.ts',
  [
    extractFunctionSource('src/components/app/AppContent.tsx', 'getCrawlDefaultStartUrl'),
    'export { getCrawlDefaultStartUrl };',
  ].join('\n\n'),
);

const crawlInventoryHelperPath = transpileToTemp(
  'tmp/crawl-inventory-start-url.ts',
  [
    extractFunctionSource('components/dashboard/CrawlInventoryView.tsx', 'resolveStartUrl'),
    'export { resolveStartUrl };',
  ].join('\n\n'),
);

const crawlRouteHelperPath = transpileToTemp(
  'tmp/crawl-route-start-url.ts',
  [
    extractFunctionSource('server/routes/crawl.ts', 'isHttpUrl'),
    extractFunctionSource('server/routes/crawl.ts', 'normalizeCrawlSiteHost'),
    extractFunctionSource('server/routes/crawl.ts', 'resolveStartUrl'),
    extractFunctionSource('server/routes/crawl.ts', 'isStartUrlAllowedForSite'),
    'export { normalizeCrawlSiteHost, resolveStartUrl, isStartUrlAllowedForSite };',
  ].join('\n\n'),
);

const siteSelectionTests = await import(pathToFileURL(path.resolve(tempRoot, 'src/lib/siteSelection.test.mjs')).href);
const requestGateTests = await import(pathToFileURL(path.resolve(tempRoot, 'src/lib/useSelectorRequestGate.test.mjs')).href);
const { getCrawlDefaultStartUrl } = await import(pathToFileURL(appContentHelperPath).href);
const { resolveStartUrl: resolveViewStartUrl } = await import(pathToFileURL(crawlInventoryHelperPath).href);
const {
  isStartUrlAllowedForSite,
  normalizeCrawlSiteHost,
  resolveStartUrl: resolveRouteStartUrl,
} = await import(pathToFileURL(crawlRouteHelperPath).href);

await requestGateTests.runSelectorRequestGateTests();
siteSelectionTests.runSiteSelectionTests();

assert.equal(getCrawlDefaultStartUrl('https://beta.example/'), 'https://beta.example/');
assert.equal(getCrawlDefaultStartUrl('sc-domain:beta.example'), 'sc-domain:beta.example');
assert.equal(getCrawlDefaultStartUrl('properties/123'), null);

assert.equal(resolveViewStartUrl('https://beta.example/', 'https://alpha.example/'), 'https://beta.example/');
assert.equal(resolveViewStartUrl('sc-domain:beta.example', 'https://alpha.example/deep/page'), 'https://beta.example/');
assert.equal(resolveViewStartUrl('https://beta.example/', null), 'https://beta.example/');

assert.equal(normalizeCrawlSiteHost('sc-domain:WWW.Beta.Example/path'), 'beta.example');
assert.equal(resolveRouteStartUrl('https://beta.example/', 'https://beta.example/deep/page'), 'https://beta.example/deep/page');
assert.equal(resolveRouteStartUrl('sc-domain:beta.example', null), 'https://beta.example/');
assert.equal(isStartUrlAllowedForSite('https://beta.example/', 'https://www.beta.example/deep/page'), true);
assert.equal(isStartUrlAllowedForSite('https://beta.example/', 'https://alpha.example/'), false);

console.log('Selector stability check passed');
