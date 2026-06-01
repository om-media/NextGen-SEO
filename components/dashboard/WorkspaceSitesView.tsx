import { useEffect, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { AlertCircle, CheckCircle2, Database, Globe2, Loader2, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fetchWorkspaceSiteStatuses, type WorkspaceSiteStatus } from "@/src/services/workspaceSitesService";

type WorkspaceSitesViewProps = {
  onActivateSite: (siteUrl: string) => Promise<void>;
  onOpenSite: (siteUrl: string, menu: "Dashboard" | "Crawl Inventory" | "Raw Data" | "Reconciliation") => void;
};

function formatNumber(value: number | null | undefined) {
  return new Intl.NumberFormat("en-US").format(Number(value || 0));
}

function formatDate(value: string | null | undefined) {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function formatRelative(value: string | null | undefined) {
  if (!value) return "never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return formatDistanceToNow(date, { addSuffix: true });
}

function SiteStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4 shadow-[0_12px_28px_rgba(15,61,46,0.04)]">
      <div className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">{label}</div>
      <div className="mt-3 text-3xl font-semibold tracking-[-0.03em] text-foreground">{value}</div>
    </div>
  );
}

function getCoverageTone(site: WorkspaceSiteStatus) {
  if (!site.isUnlocked) return "outline";
  if (site.warehouse.rowCount > 0 && site.crawl?.summary.totalPages) return "secondary";
  return "destructive";
}

export function WorkspaceSitesView({ onActivateSite, onOpenSite }: WorkspaceSitesViewProps) {
  const [sites, setSites] = useState<WorkspaceSiteStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activatingSite, setActivatingSite] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchWorkspaceSiteStatuses();
      setSites(result.sites);
    } catch (err: any) {
      setError(err.message || "Failed to load workspace sites");
    } finally {
      setLoading(false);
    }
  };

  const activate = async (siteUrl: string) => {
    setActivatingSite(siteUrl);
    setError(null);
    try {
      await onActivateSite(siteUrl);
      await load();
    } catch (err: any) {
      setError(err.message || "Failed to activate site");
    } finally {
      setActivatingSite(null);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const unlockedCount = sites.filter((site) => site.isUnlocked).length;
  const warehouseReadyCount = sites.filter((site) => site.warehouse.rowCount > 0).length;
  const crawledCount = sites.filter((site) => site.crawl?.summary.totalPages).length;
  const issueCount = sites.filter((site) => site.isUnlocked && (!site.warehouse.rowCount || !site.crawl?.summary.totalPages || (site.crawl?.summary.errorPages || 0) > 0)).length;

  return (
    <Card className="rounded-2xl border border-border bg-card shadow-[0_12px_32px_rgba(15,61,46,0.045)]">
      <CardHeader className="border-b border-border">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <CardTitle>Workspace sites</CardTitle>
            <CardDescription className="mt-2 max-w-3xl">
              Activated properties and the latest automated analysis status for each workspace site.
            </CardDescription>
          </div>
          <Button variant="outline" className="rounded-xl" disabled={loading} onClick={load}>
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            Refresh status
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-5 pt-5">
        <div className="grid gap-3 md:grid-cols-4">
          <SiteStat label="Known sites" value={formatNumber(sites.length)} />
          <SiteStat label="Activated" value={formatNumber(unlockedCount)} />
          <SiteStat label="Warehouse ready" value={formatNumber(warehouseReadyCount)} />
          <SiteStat label="Needs attention" value={formatNumber(issueCount)} />
        </div>

        {error && (
          <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            <AlertCircle className="mr-2 inline h-4 w-4" />
            {error}
          </div>
        )}

        <div className="overflow-hidden rounded-2xl border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Site</TableHead>
                <TableHead>Analysis</TableHead>
                <TableHead>Search data</TableHead>
                <TableHead>Technical scan</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={5} className="h-24 text-center">
                    <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
                    Loading workspace sites...
                  </TableCell>
                </TableRow>
              ) : sites.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">No workspace sites found.</TableCell>
                </TableRow>
              ) : sites.map((site) => (
                <TableRow key={site.siteUrl}>
                  <TableCell className="max-w-[360px]">
                    <div className="truncate font-medium text-foreground" title={site.siteUrl}>{site.siteUrl}</div>
                    <div className="mt-1 flex gap-1.5">
                      {site.isDefault && <Badge variant="secondary">Default</Badge>}
                      {site.isUnlocked ? <Badge variant="outline">Activated</Badge> : <Badge variant="outline">Known</Badge>}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={getCoverageTone(site)}>
                      {site.warehouse.rowCount > 0 && site.crawl?.summary.totalPages ? "Ready" : site.isUnlocked ? "Needs data" : "Not activated"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-start gap-2">
                      <Database className="mt-0.5 h-4 w-4 text-muted-foreground" />
                      <div>
                        <div className="font-medium">{formatNumber(site.warehouse.metricDayCount)} days</div>
                        <div className="text-xs text-muted-foreground">
                          {formatDate(site.warehouse.earliestMetricDate)} to {formatDate(site.warehouse.lastMetricDate)}
                        </div>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-start gap-2">
                      {site.crawl?.status === "completed" ? <CheckCircle2 className="mt-0.5 h-4 w-4 text-emerald-600" /> : <Globe2 className="mt-0.5 h-4 w-4 text-muted-foreground" />}
                      <div>
                        <div className="font-medium">
                          {site.crawl ? `${formatNumber(site.crawl.summary.totalPages)} pages` : "No crawl"}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {site.crawl ? `${site.crawl.status}, updated ${formatRelative(site.crawl.updatedAt)}` : "Not started yet"}
                        </div>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex flex-wrap justify-end gap-2">
                      {site.isUnlocked ? (
                        <>
                          <Button variant="outline" size="sm" onClick={() => onOpenSite(site.siteUrl, "Dashboard")}>Dashboard</Button>
                          <Button variant="outline" size="sm" onClick={() => onOpenSite(site.siteUrl, "Crawl Inventory")}>Technical</Button>
                          <Button variant="ghost" size="sm" onClick={() => onOpenSite(site.siteUrl, "Reconciliation")}>Match</Button>
                        </>
                      ) : (
                        <Button variant="outline" size="sm" disabled={activatingSite === site.siteUrl} onClick={() => activate(site.siteUrl)}>
                          {activatingSite === site.siteUrl ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
                          Activate
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
