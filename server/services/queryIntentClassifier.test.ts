import assert from 'node:assert/strict';
import {
  classifyQueryIntent,
  classifyQueryIntentDeterministic,
  validateQueryIntentProviderResult,
} from './queryIntentClassifier.js';

const site = 'sc-domain:avanterrapark.com/';

assert.equal(classifyQueryIntentDeterministic('avanterra park lopar', site).intent, 'Navigational');
assert.equal(classifyQueryIntentDeterministic('avanterra', site).intent, 'Navigational');
assert.equal(classifyQueryIntentDeterministic('adventurepark tickets', site).intent, 'Commercial');
assert.equal(classifyQueryIntentDeterministic('cijena ulaznica', site).intent, 'Commercial');
assert.equal(classifyQueryIntentDeterministic('biglietti avventura', site).intent, 'Commercial');
assert.equal(classifyQueryIntentDeterministic('kako doći do parka', site).intent, 'Informational');
assert.equal(classifyQueryIntentDeterministic('radno vrijeme', site).intent, 'Informational');
assert.equal(classifyQueryIntentDeterministic('weather lopar', site).intent, 'Informational');
assert.equal(classifyQueryIntentDeterministic('qzv-unknown-term', site).intent, 'Unclassified');

assert.equal(validateQueryIntentProviderResult({ intent: 'Commercial', confidence: 0.91, reason: 'ticket signal' }, 'llm')?.source, 'llm');
assert.equal(validateQueryIntentProviderResult({ intent: 'Commercial', confidence: 1.2, reason: 'bad' }, 'llm'), null);
assert.equal(validateQueryIntentProviderResult({ intent: 'Commercial', confidence: 0.9, reason: 'ok', extra: true }, 'llm'), null);

const providerResult = await classifyQueryIntent('family park holiday', site, {
  providers: {
    embedding: async () => ({ intent: 'Commercial', confidence: 0.88, reason: 'semantic local purchase intent' }),
  },
});
assert.equal(providerResult.intent, 'Commercial');
assert.equal(providerResult.source, 'embedding');

const fallbackResult = await classifyQueryIntent('another unknown phrase', site, {
  providers: { llm: async () => { throw new Error('provider unavailable'); } },
});
assert.equal(fallbackResult.intent, 'Unclassified');

console.log('query intent classifier checks passed');

