import { auth } from '../firebase';

export async function getAuthHeaders(headers: HeadersInit = {}) {
  const nextHeaders = new Headers(headers);
  const user = auth.currentUser;

  if (user) {
    const idToken = await user.getIdToken();
    nextHeaders.set('Authorization', `Bearer ${idToken}`);
  }

  return nextHeaders;
}

export async function authFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const headers = await getAuthHeaders(init.headers);
  return fetch(input, {
    ...init,
    headers,
  });
}
