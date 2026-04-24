import type { GridDimension, GridRow } from "./gscGridUtils";

function escapeCsv(value: string | number | null | undefined) {
  const normalized = value === null || value === undefined ? "" : String(value);
  if (/[",\n]/.test(normalized)) {
    return `"${normalized.replace(/"/g, '""')}"`;
  }
  return normalized;
}

function getDimensionLabel(dimension: GridDimension) {
  if (dimension === "page") return "Page";
  if (dimension === "country") return "Country";
  return "Query";
}

export function downloadGscCsv({
  dimension,
  includeCompare,
  includeIntent,
  rows,
}: {
  dimension: GridDimension;
  includeCompare: boolean;
  includeIntent: boolean;
  rows: Array<GridRow & { intentLabel?: string }>;
}) {
  const headers = [
    getDimensionLabel(dimension),
    ...(includeIntent ? ["Intent"] : []),
    "Clicks",
    "Impressions",
    "CTR",
    "Position",
    ...(includeCompare ? ["Compare Clicks", "Compare Impressions", "Compare CTR", "Compare Position"] : []),
  ];

  const body = rows.map((row) => [
    row.keys[0],
    ...(includeIntent ? [row.intentLabel || ""] : []),
    row.clicks,
    row.impressions,
    `${(row.ctr * 100).toFixed(2)}%`,
    row.position.toFixed(1),
    ...(includeCompare
      ? [
          row.compareClicks ?? "",
          row.compareImpressions ?? "",
          row.compareCtr !== undefined ? `${(row.compareCtr * 100).toFixed(2)}%` : "",
          row.comparePosition !== undefined ? row.comparePosition.toFixed(1) : "",
        ]
      : []),
  ]);

  const csv = [headers, ...body]
    .map((line) => line.map(escapeCsv).join(","))
    .join("\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `nextgen-seo-${dimension}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.URL.revokeObjectURL(url);
}
