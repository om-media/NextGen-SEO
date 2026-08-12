import type { GscSearchAnalyticsRow } from "@/src/services/gscService";

export type SortColumn = "key" | "intent" | "clicks" | "impressions" | "ctr" | "position" | "queryCount" | null;
export type GridDimension = "query" | "page" | "country";
export type QueryIntent = "Navigational" | "Commercial" | "Informational" | "Unclassified";

export type GridRow = GscSearchAnalyticsRow & {
  compareClicks?: number;
  compareImpressions?: number;
  compareCtr?: number;
  comparePosition?: number;
  queryCount?: number;
  compareQueryCount?: number;
};

export type GridFilters = {
  intentFilter: string;
  isQuestionOnly: boolean;
  maxPosition: number | "";
  minClicks: number | "";
  minImpressions: number | "";
  minWords: number | "";
  searchTerm: string;
};

function normalizeIntentText(value: string) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function getSiteHostname(siteUrl: string) {
  const rawValue = String(siteUrl || "").trim().replace(/^sc-domain:/i, "");
  if (!rawValue) return "";

  try {
    const parsed = new URL(rawValue.includes("://") ? rawValue : `https://${rawValue}`);
    return parsed.hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return rawValue.split(/[/?#]/, 1)[0].replace(/^www\./i, "").toLowerCase();
  }
}

function matchesIntentSignal(queryText: string, signal: string) {
  const normalizedSignal = normalizeIntentText(signal);
  if (!normalizedSignal) return false;
  if (normalizedSignal.includes(" ")) return ` ${queryText} `.includes(` ${normalizedSignal} `);
  return new Set(queryText.split(" ")).has(normalizedSignal);
}

function hasAnyIntentSignal(queryText: string, signals: string[]) {
  return signals.some((signal) => matchesIntentSignal(queryText, signal));
}

/**
 * Classifies a query with transparent, deterministic heuristics. This is not
 * an ML prediction: explicit query signals win, then site identity, and an
 * ambiguous query remains Unclassified instead of being mislabeled.
 */
export function classifyIntent(query: string, siteUrl: string): QueryIntent {
  const rawQuery = String(query || "");
  const normalizedQuery = normalizeIntentText(rawQuery);
  if (!normalizedQuery) return "Unclassified";

  const commercialWords = [
    "buy", "price", "cheap", "software", "tool", "review", "reviews", "vs", "compare", "best", "top",
    "discount", "coupon", "order", "purchase", "hire", "service", "services", "cost", "pricing",
    "deal", "app", "platform", "booking", "book", "reserve", "reservation", "ticket", "tickets", "free",
    "cijena", "ulaznica", "ulaznice", "karte", "karta", "biglietti", "biglietto", "entradas", "entrada",
    "billet", "billets", "precio", "prezzo", "rezervacija", "rezervacije", "karten", "eintritt",
  ];
  const localCommercialWords = [
    "visit", "open", "hours", "location", "directions", "near", "nearby", "accommodation", "hotel",
    "rental", "rent", "tour", "tours", "attractions", "activities", "camping",
    "adventure park", "adrenalinski park", "things to do", "water park", "theme park",
  ];
  const informationalWords = [
    "how", "what", "guide", "tutorial", "why", "when", "where", "who", "tips", "ideas", "examples",
    "learn", "meaning", "definition", "can", "is", "are", "does", "ways", "benefits", "history", "news",
    "kako", "zasto", "zašto", "kada", "gdje", "gde", "radno vrijeme", "radno vreme", "vrijeme", "vreme", "weather",
  ];
  const navWords = ["login", "signin", "sign in", "sign up", "contact", "support", "dashboard", "portal"];

  // A purchase/decision signal is more useful than the brand name alone:
  // “brand tickets” is commercial, while “where is brand?” is informational.
  if (hasAnyIntentSignal(normalizedQuery, commercialWords)) return "Commercial";
  if (rawQuery.includes("?") || hasAnyIntentSignal(normalizedQuery, informationalWords)) return "Informational";
  if (hasAnyIntentSignal(normalizedQuery, navWords)) return "Navigational";
  if (hasAnyIntentSignal(normalizedQuery, localCommercialWords)) return "Commercial";

  const hostname = getSiteHostname(siteUrl);
  const hostLabels = hostname.split(".").filter((label) => label && !["com", "net", "org", "io", "co", "uk", "de", "fr", "es", "it", "nl", "au", "ca", "us", "shop", "store", "online", "site"].includes(label));
  const compactQuery = normalizedQuery.replace(/\s+/g, "");
  const identityCandidates = hostLabels.flatMap((label) => [label, label.replace(/[-_]/g, " ")]);
  const isSiteQuery = identityCandidates.some((candidate) => {
    const compactCandidate = normalizeIntentText(candidate).replace(/\s+/g, "");
    if (compactCandidate.length < 5) return false;
    return compactQuery.includes(compactCandidate) || (
      compactCandidate.includes(compactQuery) && compactQuery.length >= Math.max(5, Math.ceil(compactCandidate.length * 0.55))
    );
  });

  if (isSiteQuery) return "Navigational";
  return "Unclassified";
}

export function filterGridData(data: GridRow[], dimension: GridDimension, filters: GridFilters, siteUrl: string) {
  return data.filter((row) => {
    const rowKey = typeof row.keys?.[0] === "string" ? row.keys[0] : "";
    if (!rowKey) {
      return false;
    }

    if (!rowKey.toLowerCase().includes(filters.searchTerm.toLowerCase())) {
      return false;
    }

    if (dimension === "query") {
      if (filters.intentFilter !== "all") {
        const intent = (row.intent || classifyIntent(rowKey, siteUrl)).toLowerCase();
        if (intent !== filters.intentFilter) {
          return false;
        }
      }

      if (filters.isQuestionOnly) {
        const normalizedQuery = rowKey.toLowerCase();
        const firstWord = normalizedQuery.trim().split(/\s+/)[0];
        const questionWords = ["who", "what", "where", "when", "why", "how", "is", "are", "do", "does", "can", "could", "should", "would"];
        if (!questionWords.includes(firstWord) && !normalizedQuery.includes("?")) {
          return false;
        }
      }

      if (filters.minWords !== "") {
        const wordCount = rowKey.trim().split(/\s+/).length;
        if (wordCount < filters.minWords) {
          return false;
        }
      }
    }

    if (filters.minClicks !== "" && row.clicks < filters.minClicks) return false;
    if (filters.minImpressions !== "" && row.impressions < filters.minImpressions) return false;
    if (filters.maxPosition !== "" && row.position > filters.maxPosition) return false;

    return true;
  });
}

export function sortGridData(data: GridRow[], sortColumn: SortColumn, sortDirection: "asc" | "desc", siteUrl: string) {
  return [...data].sort((a, b) => {
    if (!sortColumn) {
      return 0;
    }

    let valueA: string | number = a[sortColumn as keyof GridRow] as string | number;
    let valueB: string | number = b[sortColumn as keyof GridRow] as string | number;

    if (sortColumn === "key") {
      valueA = typeof a.keys?.[0] === "string" ? a.keys[0] : "";
      valueB = typeof b.keys?.[0] === "string" ? b.keys[0] : "";
    } else if (sortColumn === "intent") {
      valueA = a.intent || classifyIntent(typeof a.keys?.[0] === "string" ? a.keys[0] : "", siteUrl);
      valueB = b.intent || classifyIntent(typeof b.keys?.[0] === "string" ? b.keys[0] : "", siteUrl);
    } else if (sortColumn === "queryCount") {
      valueA = a.queryCount || 0;
      valueB = b.queryCount || 0;
    }

    if (valueA < valueB) return sortDirection === "asc" ? -1 : 1;
    if (valueA > valueB) return sortDirection === "asc" ? 1 : -1;
    return 0;
  });
}

export function getGridTitle(dimension: GridDimension) {
  if (dimension === "page") return "Top Pages";
  if (dimension === "country") return "Top Countries";
  return "Top Search Queries";
}

export function getGridTitleWithCount(dimension: GridDimension, count: number) {
  return `${getGridTitle(dimension)} (${count})`;
}

export function getGridSearchPlaceholder(dimension: GridDimension) {
  if (dimension === "page") return "Filter pages...";
  if (dimension === "country") return "Filter countries...";
  return "Filter queries...";
}

export function hasActiveGridFilters(dimension: GridDimension, filters: GridFilters) {
  return Boolean(
    filters.searchTerm ||
      (dimension === "query" && filters.intentFilter !== "all") ||
      filters.minClicks !== "" ||
      filters.minImpressions !== "" ||
      filters.maxPosition !== "" ||
      filters.isQuestionOnly ||
      filters.minWords !== "",
  );
}

export function getGridFilterSummary(dimension: GridDimension, filters: GridFilters) {
  const summary: string[] = [`Dimension: ${dimension}`];

  if (filters.searchTerm) summary.push(`Search: "${filters.searchTerm}"`);
  if (dimension === "query" && filters.intentFilter !== "all") summary.push(`Intent: ${filters.intentFilter}`);
  if (filters.minClicks !== "") summary.push(`Min Clicks: ${filters.minClicks}`);
  if (filters.minImpressions !== "") summary.push(`Min Impressions: ${filters.minImpressions}`);
  if (filters.maxPosition !== "") summary.push(`Max Position: ${filters.maxPosition}`);
  if (dimension === "query" && filters.isQuestionOnly) summary.push("Questions Only");
  if (dimension === "query" && filters.minWords !== "") summary.push(`Min Words: ${filters.minWords}`);

  if (summary.length === 1) {
    summary.push("No active filters");
  }

  return summary;
}
