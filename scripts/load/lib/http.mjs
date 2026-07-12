import { performance } from 'node:perf_hooks';
import { buildAuthHeaders } from './auth.mjs';

async function readResponseBody(response) {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return response.json().catch(() => null);
  }
  return response.text().catch(() => null);
}

export function createHttpClient(config, collector) {
  async function request({
    acceptableStatuses = [],
    baseUrl = config.baseUrl,
    body,
    headers = {},
    method = 'GET',
    path,
    query,
    scenario,
    step,
    tags = {},
    timeoutMs = config.requestTimeoutMs,
    user = null,
  }) {
    const url = new URL(`${baseUrl}${path}`);
    for (const [key, value] of Object.entries(query || {})) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }

    const requestHeaders = {
      Accept: 'application/json',
      ...headers,
    };

    if (user) {
      Object.assign(requestHeaders, buildAuthHeaders(user));
    }
    if (body !== undefined && body !== null && !requestHeaders['Content-Type']) {
      requestHeaders['Content-Type'] = 'application/json';
    }

    const startedAt = performance.now();
    let response;
    let payload = null;

    try {
      response = await fetch(url, {
        method,
        headers: requestHeaders,
        body: body !== undefined && body !== null ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      payload = await readResponseBody(response);
      const ok = response.ok || acceptableStatuses.includes(response.status);
      collector.record({
        durationMs: Number((performance.now() - startedAt).toFixed(2)),
        method,
        ok,
        path,
        scenario,
        status: response.status,
        step,
        tags,
        userId: user?.id || null,
      });

      if (!ok) {
        throw new Error(payload?.error || `HTTP ${response.status} for ${method} ${url.pathname}`);
      }

      return {
        data: payload,
        headers: response.headers,
        status: response.status,
      };
    } catch (error) {
      if (!response) {
        collector.record({
          durationMs: Number((performance.now() - startedAt).toFixed(2)),
          method,
          ok: false,
          path,
          scenario,
          status: 0,
          step,
          tags: {
            ...tags,
            error: error?.message || String(error),
          },
          userId: user?.id || null,
        });
      }
      throw error;
    }
  }

  return { request };
}
