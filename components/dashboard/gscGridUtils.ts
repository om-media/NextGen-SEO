import type { GscSearchAnalyticsRow } from "@/src/services/gscService";

export type SortColumn = "key" | "intent" | "clicks" | "impressions" | "ctr" | "position" | "queryCount" | null;
export type GridDimension = "query" | "page" | "country";

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

export function classifyIntent(query: string, siteUrl: string) {
  const normalizedQuery = String(query || "").toLowerCase();
  let brand = "";

  try {
    const cleanUrl = siteUrl.replace("sc-domain:", "").replace("https://", "").replace("http://", "").replace("www.", "");
    brand = cleanUrl.split(".")[0].toLowerCase();
  } catch {
    // Ignore brand extraction issues and fall back to keyword signals.
  }

  const navWords = ["login", "signin", "sign up", "contact", "support", "dashboard", "portal"];
  if (navWords.some((word) => normalizedQuery.includes(word))) return "Navigational";

  const commercialWords = ["buy", "price", "cheap", "software", "tool", "review", "vs", "compare", "best", "top", "discount", "coupon", "order", "purchase", "hire", "services", "cost", "pricing", "deal", "app", "platform"];
  if (commercialWords.some((word) => normalizedQuery.includes(word))) return "Commercial";

  const informationalWords = ["how", "what", "guide", "tutorial", "why", "when", "where", "who", "tips", "ideas", "examples", "learn", "meaning", "definition", "can", "is", "does", "ways", "benefits", "history", "news", "free"];
  if (informationalWords.some((word) => normalizedQuery.includes(word))) return "Informational";

  if (brand && (normalizedQuery === brand || normalizedQuery.includes(brand) || normalizedQuery.includes(brand.replace(/-/g, " ")))) {
    return "Navigational";
  }

  return "Informational";
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
        const intent = classifyIntent(rowKey, siteUrl).toLowerCase();
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
      valueA = classifyIntent(typeof a.keys?.[0] === "string" ? a.keys[0] : "", siteUrl);
      valueB = classifyIntent(typeof b.keys?.[0] === "string" ? b.keys[0] : "", siteUrl);
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
