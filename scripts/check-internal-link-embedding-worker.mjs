const baseUrl = (process.env.INTERNAL_LINK_EMBEDDING_WORKER_URL || 'http://127.0.0.1:8091').replace(/\/+$/, '');

async function readJson(response) {
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = data?.detail || data?.error || data?.status || 'HTTP ' + response.status;
    throw new Error('Built-in embedding worker request failed: ' + detail);
  }
  return data;
}

async function main() {
  const health = await readJson(await fetch(baseUrl + '/health/ready', {
    signal: AbortSignal.timeout(10_000),
  }));

  const result = await readJson(await fetch(baseUrl + '/embed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      normalize: true,
      texts: [
        'Contextual internal links help readers discover relevant supporting information.',
        'A descriptive anchor should explain what the destination page provides.',
      ],
    }),
    signal: AbortSignal.timeout(120_000),
  }));

  const embeddings = Array.isArray(result?.embeddings) ? result.embeddings : [];
  const dimensions = embeddings[0]?.length || 0;
  const allFinite = embeddings.every((vector) => (
    Array.isArray(vector) &&
    vector.length === 1024 &&
    vector.every((value) => Number.isFinite(Number(value)))
  ));
  const norms = embeddings.map((vector) => Math.sqrt(vector.reduce((sum, value) => sum + Number(value) ** 2, 0)));

  if (health.status !== 'ready') throw new Error('Worker is not ready: ' + health.status);
  if (health.model !== 'BAAI/bge-m3') throw new Error('Unexpected model: ' + health.model);
  if (embeddings.length !== 2 || dimensions !== 1024 || !allFinite) {
    throw new Error('Built-in worker returned invalid BGE-M3 embeddings.');
  }
  if (norms.some((norm) => Math.abs(norm - 1) > 0.01)) {
    throw new Error('Built-in worker embeddings are not normalized.');
  }

  console.log(JSON.stringify({
    allFinite,
    baseUrl,
    dimensions,
    embeddings: embeddings.length,
    model: health.model,
    norms: norms.map((norm) => Number(norm.toFixed(6))),
    ollamaRequired: false,
    status: health.status,
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || error);
  process.exit(1);
});