const baseUrl = (process.env.INTERNAL_LINK_EMBEDDING_WORKER_URL || 'http://127.0.0.1:8091').replace(/\/+$/, '');
const requestCount = Math.max(4, Number(process.env.EMBEDDING_LOAD_REQUESTS || 12));
const textsPerRequest = 2;

async function readJson(response) {
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Embedding worker returned ${response.status}: ${data?.detail || 'unknown error'}`);
  return data;
}

async function health() {
  return readJson(await fetch(baseUrl + '/health/ready', { signal: AbortSignal.timeout(10_000) }));
}

const before = await health();
const startedAt = performance.now();
const responses = await Promise.all(Array.from({ length: requestCount }, async (_, requestIndex) => {
  const texts = Array.from({ length: textsPerRequest }, (_, textIndex) =>
    `Agency ${requestIndex} page ${textIndex}: contextual internal linking connects a reader to a relevant supporting topic.`,
  );
  return readJson(await fetch(baseUrl + '/embed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ normalize: true, texts }),
    signal: AbortSignal.timeout(180_000),
  }));
}));
const wallMs = Math.round(performance.now() - startedAt);
const after = await health();

for (const response of responses) {
  if (!Array.isArray(response.embeddings) || response.embeddings.length !== textsPerRequest) {
    throw new Error('A concurrent request returned the wrong embedding count.');
  }
  if (response.embeddings.some((vector) => !Array.isArray(vector) || vector.length !== 1024)) {
    throw new Error('A concurrent request returned a non-BGE-M3 vector.');
  }
}

const batchesBefore = Number(before?.inference?.totalBatches || 0);
const batchesAfter = Number(after?.inference?.totalBatches || 0);
const batchDelta = batchesAfter - batchesBefore;
if (batchDelta <= 0 || batchDelta >= requestCount) {
  throw new Error(`Dynamic batching did not coalesce requests: ${batchDelta} batches for ${requestCount} requests.`);
}
if (Number(after?.queue?.pendingRequests || 0) !== 0 || Number(after?.queue?.pendingTexts || 0) !== 0) {
  throw new Error('Embedding queue did not drain after concurrent load.');
}
if (Number(after?.queue?.rejectedRequests || 0) > Number(before?.queue?.rejectedRequests || 0)) {
  throw new Error('Embedding worker rejected requests below its configured queue limit.');
}

console.log(JSON.stringify({
  batchDelta,
  completedTexts: Number(after?.inference?.completedTexts || 0) - Number(before?.inference?.completedTexts || 0),
  lastBatchSize: after?.inference?.lastBatchSize,
  pendingRequests: after?.queue?.pendingRequests,
  requestCount,
  textsPerRequest,
  wallMs,
}, null, 2));
