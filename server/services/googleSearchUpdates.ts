const GOOGLE_SEARCH_INCIDENTS_URL = 'https://status.search.google.com/incidents.json';
const GOOGLE_RANKING_PRODUCT_ID = 'rGHU1u87FJnkP6W2GwMi';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const FAILURE_RETRY_MS = 15 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 4_000;

export type GoogleSearchUpdateAnnotation = {
  id: string;
  userId: 'system';
  siteUrl: null;
  date: string;
  title: string;
  description: string;
  type: 'system';
  createdAt: string;
};

type IncidentUpdate = {
  text?: unknown;
  when?: unknown;
};

type Incident = {
  id?: unknown;
  begin?: unknown;
  created?: unknown;
  external_desc?: unknown;
  service_name?: unknown;
  affected_products?: unknown;
  updates?: unknown;
};

const FALLBACK_UPDATES: GoogleSearchUpdateAnnotation[] = [
  { id: 'sys-2026-06-spam', userId: 'system', siteUrl: null, date: '2026-06-24', title: 'June 2026 Spam Update', description: 'Google June 2026 spam update rollout began. It applies globally and to all languages.', type: 'system', createdAt: '' },
  { id: 'sys-2026-05-core', userId: 'system', siteUrl: null, date: '2026-05-21', title: 'May 2026 Core Update', description: 'Google May 2026 core update rollout began.', type: 'system', createdAt: '' },
  { id: 'sys-2026-03-core', userId: 'system', siteUrl: null, date: '2026-03-27', title: 'March 2026 Core Update', description: 'Google March 2026 core update rollout began.', type: 'system', createdAt: '' },
  { id: 'sys-2026-03-spam', userId: 'system', siteUrl: null, date: '2026-03-24', title: 'March 2026 Spam Update', description: 'Google March 2026 spam update rollout began.', type: 'system', createdAt: '' },
  { id: 'sys-2026-02-discover', userId: 'system', siteUrl: null, date: '2026-02-05', title: 'February 2026 Discover Update', description: 'Google February 2026 Discover update rollout began.', type: 'system', createdAt: '' },
  { id: 'sys-2025-12-core', userId: 'system', siteUrl: null, date: '2025-12-11', title: 'December 2025 Core Update', description: 'Google December 2025 core update rollout began.', type: 'system', createdAt: '' },
  { id: 'sys-2025-08-spam', userId: 'system', siteUrl: null, date: '2025-08-26', title: 'August 2025 Spam Update', description: 'Google August 2025 spam update rollout began.', type: 'system', createdAt: '' },
  { id: 'sys-2025-06-core', userId: 'system', siteUrl: null, date: '2025-06-30', title: 'June 2025 Core Update', description: 'Google June 2025 core update rollout began.', type: 'system', createdAt: '' },
  { id: 'sys-2025-03-core', userId: 'system', siteUrl: null, date: '2025-03-13', title: 'March 2025 Core Update', description: 'Google March 2025 core update rollout began.', type: 'system', createdAt: '' },
  { id: 'sys-2024-12-spam', userId: 'system', siteUrl: null, date: '2024-12-19', title: 'December 2024 Spam Update', description: 'Google December 2024 spam update rollout began.', type: 'system', createdAt: '' },
  { id: 'sys-2024-12-core', userId: 'system', siteUrl: null, date: '2024-12-12', title: 'December 2024 Core Update', description: 'Google December 2024 core update rollout began.', type: 'system', createdAt: '' },
];

let cachedUpdates: { fetchedAt: number; annotations: GoogleSearchUpdateAnnotation[] } | null = null;
let refreshInFlight: Promise<GoogleSearchUpdateAnnotation[]> | null = null;

const asString = (value: unknown) => typeof value === 'string' ? value.trim() : '';

const isIsoDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);

const cleanText = (value: string) => value
  .replace(/<https?:\/\/[^>]+>/g, '')
  .replace(/<[^>]+>/g, '')
  .replace(/\s+/g, ' ')
  .trim();

const titleCase = (value: string) => value
  .split(/\s+/)
  .map((word) => word ? `${word.charAt(0).toUpperCase()}${word.slice(1)}` : word)
  .join(' ');

const isRankingIncident = (incident: Incident) => {
  if (asString(incident.service_name).toLowerCase() === 'ranking') return true;
  return Array.isArray(incident.affected_products)
    && incident.affected_products.some((product) => {
      if (!product || typeof product !== 'object') return false;
      const candidate = product as { id?: unknown; title?: unknown };
      return asString(candidate.id) === GOOGLE_RANKING_PRODUCT_ID || asString(candidate.title).toLowerCase() === 'ranking';
    });
};

export function parseGoogleSearchIncidents(payload: unknown): GoogleSearchUpdateAnnotation[] {
  if (!Array.isArray(payload)) return [];

  return payload
    .filter((incident): incident is Incident => Boolean(incident && typeof incident === 'object' && isRankingIncident(incident)))
    .map((incident) => {
      const id = asString(incident.id);
      const begin = asString(incident.begin);
      const date = begin.slice(0, 10);
      const title = titleCase(asString(incident.external_desc));
      const updates = Array.isArray(incident.updates) ? incident.updates as IncidentUpdate[] : [];
      const firstUpdate = updates
        .slice()
        .sort((left, right) => asString(left.when).localeCompare(asString(right.when)))[0];
      const description = cleanText(asString(firstUpdate?.text) || asString(incident.external_desc));

      if (!id || !isIsoDate(date) || !title || !description) return null;
      return {
        id: `sys-google-${id}`,
        userId: 'system' as const,
        siteUrl: null,
        date,
        title,
        description,
        type: 'system' as const,
        createdAt: asString(incident.created),
      };
    })
    .filter((annotation): annotation is GoogleSearchUpdateAnnotation => annotation !== null)
    .sort((left, right) => right.date.localeCompare(left.date));
}

const fallbackUpdates = () => FALLBACK_UPDATES.map((annotation) => ({ ...annotation }));

async function fetchGoogleSearchUpdates() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(GOOGLE_SEARCH_INCIDENTS_URL, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Google status feed returned HTTP ${response.status}`);
    const parsed = parseGoogleSearchIncidents(await response.json());
    if (!parsed.length) throw new Error('Google status feed did not contain ranking updates');
    return parsed;
  } finally {
    clearTimeout(timeout);
  }
}

export async function getGoogleSearchUpdateAnnotations() {
  if (cachedUpdates && Date.now() - cachedUpdates.fetchedAt < CACHE_TTL_MS) {
    return cachedUpdates.annotations;
  }
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = fetchGoogleSearchUpdates()
    .then((annotations) => {
      cachedUpdates = { fetchedAt: Date.now(), annotations };
      return annotations;
    })
    .catch((error) => {
      console.warn('[annotations] Google update feed unavailable; using cached updates:', error);
      const annotations = cachedUpdates?.annotations || fallbackUpdates();
      cachedUpdates = { fetchedAt: Date.now() - CACHE_TTL_MS + FAILURE_RETRY_MS, annotations };
      return annotations;
    })
    .finally(() => {
      refreshInFlight = null;
    });

  return refreshInFlight;
}
