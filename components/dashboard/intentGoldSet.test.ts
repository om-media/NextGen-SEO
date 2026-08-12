import assert from "node:assert/strict";
import { classifyQueryIntentDeterministic } from "../../server/services/queryIntentClassifier";
import { filterGridData, type GridFilters, type GridRow } from "./gscGridUtils";

/**
 * Small, hand-reviewed contract set for intent classification.
 *
 * These are deliberately real-world shapes rather than keyword fixtures: brand
 * queries, local discovery, purchase research, questions, and multilingual
 * variants are the cases that are most often mislabeled in the query grid.
 * Keep this set small and review additions with product/SEO owners.
 */
const site = "https://www.avanterrapark.com/";

const goldSet: Array<{ query: string; expected: string; note: string }> = [
  { query: "avanterra park lopar", expected: "Navigational", note: "brand + destination" },
  { query: "avanterra", expected: "Navigational", note: "brand shorthand" },
  { query: "where is avanterra park", expected: "Informational", note: "explicit location question" },
  { query: "how to get to avanterra park", expected: "Informational", note: "explicit route question" },
  { query: "avanterra park tickets", expected: "Commercial", note: "ticket purchase" },
  { query: "avanterra park reviews", expected: "Commercial", note: "commercial investigation" },
  { query: "adventure park lopar", expected: "Commercial", note: "local attraction discovery" },
  { query: "things to do in lopar", expected: "Commercial", note: "local activity discovery" },
  { query: "cijena ulaznica avantura park", expected: "Commercial", note: "Croatian ticket price" },
  { query: "kako doći do avantura parka", expected: "Informational", note: "Croatian route question" },
  { query: "radno vrijeme avantura parka", expected: "Informational", note: "Croatian opening-hours lookup" },
  { query: "biglietti parco avventura lopar", expected: "Commercial", note: "Italian ticket query" },
  { query: "entradas parque de aventura", expected: "Commercial", note: "Spanish ticket query" },
  { query: "abenteuerpark tickets", expected: "Commercial", note: "German ticket query" },
  { query: "weather in lopar", expected: "Informational", note: "general factual lookup" },
  { query: "xylophone quantum widget", expected: "Unclassified", note: "no usable intent evidence" },
];

for (const testCase of goldSet) {
  assert.equal(
    classifyQueryIntentDeterministic(testCase.query, site).intent,
    testCase.expected,
    `${testCase.note}: ${testCase.query}`,
  );
}

const rows: GridRow[] = [
  { keys: ["avanterra park tickets"], clicks: 10, impressions: 20, ctr: 0.5, position: 1 },
  { keys: ["how to get to avanterra park"], clicks: 8, impressions: 10, ctr: 0.8, position: 2 },
  { keys: ["xylophone quantum widget"], clicks: 1, impressions: 3, ctr: 0.33, position: 30 },
];

const baseFilters: GridFilters = {
  intentFilter: "all",
  isQuestionOnly: false,
  maxPosition: "",
  minClicks: "",
  minImpressions: "",
  minWords: "",
  searchTerm: "",
};

assert.deepEqual(
  filterGridData(rows, "query", { ...baseFilters, intentFilter: "commercial" }, site)
    .map((row) => row.keys[0]),
  ["avanterra park tickets"],
  "commercial filter must use the same classifier as the table label",
);
assert.deepEqual(
  filterGridData(rows, "query", { ...baseFilters, intentFilter: "unclassified" }, site)
    .map((row) => row.keys[0]),
  ["xylophone quantum widget"],
  "unclassified filter must expose uncertain queries instead of hiding them as informational",
);

console.log(`intent gold-set checks passed (${goldSet.length} queries)`);
