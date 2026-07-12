import { useState, useEffect, useMemo } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Ga4ApiService } from "@/src/services/ga4Service"
import { useAuth } from "@/src/contexts/AuthContext"
import { Database, Loader2 } from "lucide-react"
import { format } from "date-fns"
import { DateRange } from "react-day-picker"
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip as RechartsTooltip, Legend } from 'recharts'

interface Ga4DemographicsProps {
  siteUrl: string;
  workspaceSiteUrl?: string;
  dateRange?: DateRange;
  refreshKey?: number;
}

const COLORS = ['#4285f4', '#fbbc04', '#34a853', '#ea4335', '#ff6d00', '#46bdc6'];

const DIMENSIONS = [
  { key: 'deviceCategory', label: 'Devices' },
  { key: 'browser', label: 'Browsers' },
  { key: 'operatingSystem', label: 'Operating Systems' },
  { key: 'country', label: 'Countries' },
] as const;

type DemographicDimensionKey = typeof DIMENSIONS[number]['key'];

type WarehouseCoverage = {
  activeDateCount?: number;
  activeJobCount?: number;
  coveredDateCount?: number;
  expectedDateCount?: number;
  missingDateCount?: number;
  queuedDateCount?: number;
};

type DimensionLoadState = {
  coverage: WarehouseCoverage | null;
  error: string | null;
  rows: Array<{ name: string; value: number }>;
};

const emptyDimensionState = (): Record<DemographicDimensionKey, DimensionLoadState> => Object.fromEntries(
  DIMENSIONS.map((dimension) => [dimension.key, { coverage: null, error: null, rows: [] }]),
) as Record<DemographicDimensionKey, DimensionLoadState>;

const toNumber = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const hasWarehouseWork = (coverage: WarehouseCoverage | null | undefined) => (
  Number(coverage?.activeJobCount || 0) > 0
  || Number(coverage?.activeDateCount || 0) > 0
  || Number(coverage?.queuedDateCount || 0) > 0
);

const hasCoverageGap = (coverage: WarehouseCoverage | null | undefined) => (
  Number(coverage?.expectedDateCount || 0) > 0
  && Number(coverage?.missingDateCount || 0) > 0
);

const isPreparationMessage = (message: string | null | undefined) => Boolean(
  message && /stored history|being prepared|not ready|not available in the stored warehouse|warehouse/i.test(message),
);

const aggregateCoverage = (states: Record<DemographicDimensionKey, DimensionLoadState>) => {
  const coverages = Object.values(states).map((state) => state.coverage).filter(Boolean) as WarehouseCoverage[];
  if (coverages.length === 0) return null;

  return coverages.reduce<WarehouseCoverage>((acc, coverage) => ({
    activeDateCount: Math.max(Number(acc.activeDateCount || 0), Number(coverage.activeDateCount || 0)),
    activeJobCount: Number(acc.activeJobCount || 0) + Number(coverage.activeJobCount || 0),
    coveredDateCount: Number(acc.coveredDateCount || 0) + Number(coverage.coveredDateCount || 0),
    expectedDateCount: Number(acc.expectedDateCount || 0) + Number(coverage.expectedDateCount || 0),
    missingDateCount: Number(acc.missingDateCount || 0) + Number(coverage.missingDateCount || 0),
    queuedDateCount: Number(acc.queuedDateCount || 0) + Number(coverage.queuedDateCount || 0),
  }), {});
};

export function Ga4Demographics({ siteUrl, workspaceSiteUrl, dateRange, refreshKey = 0 }: Ga4DemographicsProps) {
  const { userProfile } = useAuth()
  const [dimensionStates, setDimensionStates] = useState<Record<DemographicDimensionKey, DimensionLoadState>>(() => emptyDimensionState())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pollKey, setPollKey] = useState(0)

  const data = useMemo(() => Object.fromEntries(
    DIMENSIONS.map((dimension) => [dimension.key, dimensionStates[dimension.key]?.rows || []]),
  ) as Record<DemographicDimensionKey, DimensionLoadState['rows']>, [dimensionStates]);
  const coverage = useMemo(() => aggregateCoverage(dimensionStates), [dimensionStates]);
  const hasAnyRows = useMemo(() => Object.values(data).some((rows) => rows.length > 0), [data]);
  const hasAnyPreparationError = useMemo(() => (
    Object.values(dimensionStates).some((state) => isPreparationMessage(state.error))
  ), [dimensionStates]);
  const pendingDimensionCount = useMemo(() => (
    Object.values(dimensionStates).filter((state) => hasWarehouseWork(state.coverage) || hasCoverageGap(state.coverage) || isPreparationMessage(state.error)).length
  ), [dimensionStates]);

  useEffect(() => {
    if (!userProfile?.googleConnected || !siteUrl || !dateRange?.from || !dateRange?.to) return;
    const controller = new AbortController()
    let isCurrent = true

    const fetchData = async () => {
      setLoading(true)
      setError(null)
      try {
        const ga4Service = new Ga4ApiService()
        const startDate = format(dateRange.from!, 'yyyy-MM-dd')
        const endDate = format(dateRange.to!, 'yyyy-MM-dd')

        const results = await Promise.allSettled(DIMENSIONS.map(async (dimension) => {
          const result = await ga4Service.runReport(
            siteUrl,
            startDate,
            endDate,
            [dimension.key],
            ['sessions'],
            undefined,
            { signal: controller.signal, siteUrl: workspaceSiteUrl },
          );
          return { dimension, result };
        }));
        if (!isCurrent) return

        const nextState = emptyDimensionState();
        const hardErrors: string[] = [];

        results.forEach((result, index) => {
          const dimension = DIMENSIONS[index];
          if (result.status === 'rejected') {
            const message = result.reason?.message || `Failed to load ${dimension.label.toLowerCase()}`;
            nextState[dimension.key] = { coverage: null, error: message, rows: [] };
            if (!isPreparationMessage(message)) hardErrors.push(`${dimension.label}: ${message}`);
            return;
          }

          const rows = Array.isArray(result.value.result.rows) ? result.value.result.rows : [];
          const sorted = [...rows]
            .filter((row: any) => row?.dimensionValues?.[0]?.value)
            .sort((a: any, b: any) => toNumber(b.metricValues?.[0]?.value) - toNumber(a.metricValues?.[0]?.value));

          nextState[dimension.key] = {
            coverage: result.value.result?.metadata?.coverage || null,
            error: null,
            rows: sorted.slice(0, 5).map((item: any) => ({
              name: item.dimensionValues[0].value === '(not set)' ? 'Unknown' : item.dimensionValues[0].value,
              value: toNumber(item.metricValues?.[0]?.value),
            })),
          };
        });

        setDimensionStates(nextState);
        setError(hardErrors.length > 0 ? hardErrors.join(' | ') : null);
      } catch (err: any) {
        if (!isCurrent || err?.name === "AbortError") return
        if (err.message === "UNAUTHORIZED") {
          setError("Your session expired. Sign in again to load stored Analytics data.")
        } else if (err.message === "Failed to fetch") {
          setError("Network error: Unable to load the stored Analytics user breakdowns right now.")
        } else if (/not warehoused|being prepared|not ready|history import|stored warehouse/i.test(err.message)) {
          setError("Analytics data is still updating for these user breakdowns. Existing stored rows stay available while the background import catches up.")
        } else {
          setError(err.message || 'Failed to fetch breakdown data')
        }
        console.error(err)
      } finally {
        if (isCurrent) setLoading(false)
      }
    }

    fetchData()
    return () => {
      isCurrent = false
      controller.abort()
    }
  }, [siteUrl, workspaceSiteUrl, dateRange, userProfile?.googleConnected, pollKey, refreshKey])

  useEffect(() => {
    if (loading) return;
    const shouldPoll = Object.values(dimensionStates).some((state) => (
      hasWarehouseWork(state.coverage) || hasCoverageGap(state.coverage) || isPreparationMessage(state.error)
    ));
    if (!shouldPoll) return;

    const timeout = window.setTimeout(() => setPollKey((value) => value + 1), 10000);
    return () => window.clearTimeout(timeout);
  }, [dimensionStates, loading])

  if (loading && !hasAnyRows) {
    return (
      <Card className="mb-4 rounded-2xl border border-border bg-card shadow-[0_12px_32px_rgba(15,61,46,0.045)]">
        <CardContent className="flex h-64 flex-col items-center justify-center gap-3 px-6 text-center">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
          <div>
            <h3 className="text-sm font-semibold text-foreground">Loading stored user breakdowns</h3>
            <p className="mt-1 max-w-md text-sm text-muted-foreground">
              Reading device, browser, OS, and geography data for this property and site.
            </p>
          </div>
        </CardContent>
      </Card>
    )
  }

  const shouldShowCoverage =
    coverage &&
    Number(coverage.expectedDateCount || 0) > 0 &&
    (
      Number(coverage.activeJobCount || 0) > 0 ||
      Number(coverage.activeDateCount || 0) > 0 ||
      Number(coverage.queuedDateCount || 0) > 0 ||
      Number(coverage.missingDateCount || 0) > 0
    );
  const hasActiveWarehouseWork = hasWarehouseWork(coverage);
  const nonPreparationError = error && !isPreparationMessage(error) ? error : null;

  if (nonPreparationError && !hasAnyRows) {
    return (
      <Card className="mb-4 rounded-2xl border border-destructive/30 bg-card shadow-[0_12px_32px_rgba(15,61,46,0.045)]">
        <CardContent className="flex h-48 flex-col items-center justify-center space-y-4 px-6 text-center text-destructive">
          <div>{nonPreparationError}</div>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="mb-4 space-y-4">
      {(shouldShowCoverage || hasAnyPreparationError) && (
        <div className="flex flex-col gap-2 rounded-2xl border border-border bg-card px-4 py-3 text-sm text-muted-foreground shadow-[0_12px_32px_rgba(15,61,46,0.035)] sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            {hasActiveWarehouseWork || hasAnyPreparationError ? (
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
            ) : (
              <Database className="h-4 w-4 text-primary" />
            )}
            <span className="font-medium text-foreground">
              {hasActiveWarehouseWork || hasAnyPreparationError ? "Updating Analytics breakdowns" : "Analytics data update available"}
            </span>
            {coverage && (
              <span>
                {Number(coverage.coveredDateCount || 0).toLocaleString()} / {Number(coverage.expectedDateCount || 0).toLocaleString()} dimension-days ready
              </span>
            )}
            {pendingDimensionCount > 0 && <span>{pendingDimensionCount} breakdowns pending</span>}
          </div>
          <span>{hasAnyRows ? "Available rows stay visible while stored data catches up." : "Stored rows will appear here automatically when they are ready."}</span>
        </div>
      )}
      {nonPreparationError && hasAnyRows && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50/70 px-4 py-3 text-sm text-amber-900">
          Some breakdowns could not be refreshed. Showing the stored rows that are available.
        </div>
      )}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        {DIMENSIONS.map((dim) => {
          const rows = data[dim.key] || [];
          const state = dimensionStates[dim.key];
          const isPending = hasWarehouseWork(state?.coverage) || hasCoverageGap(state?.coverage) || isPreparationMessage(state?.error);

          return (
            <Card key={dim.key} className="flex flex-col rounded-2xl border border-[#E9F0EB] bg-white shadow-[0_12px_32px_rgba(15,61,46,0.045)]">
              <CardHeader className="border-b border-[#E6ECE8] bg-white pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Sessions by {dim.label}</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-1 flex-col">
                <div className="h-[200px] w-full">
                  {rows.length > 0 ? (
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart margin={{ top: 0, right: 0, bottom: 20, left: 0 }}>
                        <Pie
                          data={rows}
                          cx="50%"
                          cy="45%"
                          innerRadius={40}
                          outerRadius={65}
                          paddingAngle={3}
                          stroke="none"
                          dataKey="value"
                        >
                          {rows.map((entry, index) => (
                            <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                          ))}
                        </Pie>
                        <RechartsTooltip
                          formatter={(value: number) => value.toLocaleString()}
                          contentStyle={{ borderRadius: '8px', zIndex: 1000, fontSize: '12px' }}
                        />
                        <Legend layout="horizontal" verticalAlign="bottom" align="center" wrapperStyle={{ fontSize: '10px', paddingTop: '5px' }} />
                      </PieChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
                      {loading || isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Database className="h-4 w-4" />}
                      <span>{loading || isPending ? "Preparing stored data" : "No data"}</span>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  )
}
