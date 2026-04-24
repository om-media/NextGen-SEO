import { Button } from "@/components/ui/button";
import { ArrowUpRight, BarChart3, TrendingUp } from "lucide-react";
import type { GridRow } from "./gscGridUtils";

type InsightTone = "green" | "purple" | "orange";

type Insight = {
  badge: string;
  icon: typeof TrendingUp;
  text: string;
  title: string;
  tone: InsightTone;
};

type InsightsPanelProps = {
  rows: GridRow[];
};

const toneClasses = {
  green: {
    icon: "bg-[#EAF4EC] text-[#15803D]",
    badge: "bg-[#EAF4EC] text-[#15803D]",
  },
  purple: {
    icon: "bg-[#F4ECFF] text-[#7C3AED]",
    badge: "bg-[#F4ECFF] text-[#7C3AED]",
  },
  orange: {
    icon: "bg-[#FFF2E8] text-[#F97316]",
    badge: "bg-[#FFF2E8] text-[#C2410C]",
  },
};

const formatCompact = (value: number) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 1, notation: "compact" }).format(value);

const formatPercent = (value: number) => `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;

function buildInsights(rows: GridRow[]): Insight[] {
  if (rows.length === 0) {
    return [];
  }

  const totals = rows.reduce(
    (acc, row) => {
      acc.clicks += row.clicks;
      acc.impressions += row.impressions;
      acc.weightedPosition += row.position * row.impressions;
      acc.compareClicks += row.compareClicks ?? 0;
      acc.compareImpressions += row.compareImpressions ?? 0;
      acc.compareWeightedPosition += (row.comparePosition ?? 0) * (row.compareImpressions ?? 0);
      return acc;
    },
    {
      clicks: 0,
      compareClicks: 0,
      compareImpressions: 0,
      compareWeightedPosition: 0,
      impressions: 0,
      weightedPosition: 0,
    },
  );

  const hasCompare = rows.some((row) => row.compareClicks !== undefined || row.compareImpressions !== undefined || row.comparePosition !== undefined);
  const insights: Insight[] = [];

  if (hasCompare && totals.compareClicks > 0) {
    const clickChange = ((totals.clicks - totals.compareClicks) / totals.compareClicks) * 100;
    insights.push({
      badge: formatPercent(clickChange),
      icon: TrendingUp,
      text: `Clicks changed from ${formatCompact(totals.compareClicks)} to ${formatCompact(totals.clicks)} compared with the previous range.`,
      title: clickChange >= 0 ? "Clicks are trending up" : "Clicks are trending down",
      tone: clickChange >= 0 ? "green" : "orange",
    });
  } else {
    const topClickRow = [...rows].sort((a, b) => b.clicks - a.clicks)[0];
    insights.push({
      badge: formatCompact(topClickRow.clicks),
      icon: TrendingUp,
      text: `"${topClickRow.keys[0]}" is currently the strongest click driver in this filtered view.`,
      title: "Top click driver",
      tone: "green",
    });
  }

  const opportunity = [...rows]
    .filter((row) => row.impressions > 0 && row.position > 3)
    .sort((a, b) => b.impressions - a.impressions)[0];

  if (opportunity) {
    insights.push({
      badge: `+${formatCompact(opportunity.impressions)}`,
      icon: ArrowUpRight,
      text: `"${opportunity.keys[0]}" has ${formatCompact(opportunity.impressions)} impressions at average position ${opportunity.position.toFixed(1)}.`,
      title: "Impressions opportunity",
      tone: "purple",
    });
  }

  if (hasCompare && totals.impressions > 0 && totals.compareImpressions > 0) {
    const currentPosition = totals.weightedPosition / totals.impressions;
    const comparePosition = totals.compareWeightedPosition / totals.compareImpressions;
    const positionDelta = comparePosition - currentPosition;

    insights.push({
      badge: `${positionDelta >= 0 ? "↑" : "↓"} ${Math.abs(positionDelta).toFixed(1)}`,
      icon: BarChart3,
      text: `Average position moved from ${comparePosition.toFixed(1)} to ${currentPosition.toFixed(1)} across this filtered view.`,
      title: positionDelta >= 0 ? "Position improved" : "Position slipped",
      tone: positionDelta >= 0 ? "green" : "orange",
    });
  } else {
    const bestPosition = [...rows].filter((row) => row.impressions > 0).sort((a, b) => a.position - b.position)[0];
    if (bestPosition) {
      insights.push({
        badge: bestPosition.position.toFixed(1),
        icon: BarChart3,
        text: `"${bestPosition.keys[0]}" has the strongest average position in this filtered view.`,
        title: "Best ranking query",
        tone: "orange",
      });
    }
  }

  return insights.slice(0, 3);
}

export function InsightsPanel({ rows }: InsightsPanelProps) {
  const insights = buildInsights(rows);

  return (
    <aside className="rounded-xl border border-[#E6ECE8] bg-white p-5 shadow-sm">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-[#0F172A]">Insights</h3>
          <p className="text-sm text-[#647067]">Based on your data</p>
        </div>
        <Button variant="ghost" size="sm" className="text-[#7C3AED] hover:text-[#6D28D9]" disabled={insights.length <= 3}>
          View all insights
          <span className="ml-2">-&gt;</span>
        </Button>
      </div>

      {insights.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[#E6ECE8] p-5 text-sm text-[#647067]">
          Insights will appear once this view has query data.
        </div>
      ) : (
        <div className="space-y-3">
          {insights.map((insight) => {
            const Icon = insight.icon;
            const classes = toneClasses[insight.tone];

            return (
              <div key={`${insight.title}-${insight.badge}`} className="flex items-center gap-3 rounded-xl border border-[#E6ECE8] bg-white p-4 shadow-sm">
                <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full ${classes.icon}`}>
                  <Icon className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-[#0F172A]">{insight.title}</div>
                  <p className="mt-1 text-xs leading-5 text-[#647067]">{insight.text}</p>
                </div>
                <span className={`shrink-0 rounded-xl px-3 py-2 text-xs font-semibold ${classes.badge}`}>
                  {insight.badge}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </aside>
  );
}
