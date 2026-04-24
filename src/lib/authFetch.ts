export function getAuthHeaders(headers: HeadersInit = {}) {
  return new Headers(headers);
}

export async function authFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const headers = getAuthHeaders(init.headers);
  return fetch(input, {
    ...init,
    credentials: 'same-origin',
    headers,
  });
}
