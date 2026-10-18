import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ColumnChart, LineAreaChart, RankBars } from "@/components/charts";
import { Empty, ErrorBox, Loading, PageHeader, StatTile, TableFrame } from "@/components/common";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import { compact, duration, hour, number, percent, shortDate, usd, usdTick } from "@/lib/format";
import type { Stats } from "@/lib/types";

const RANGES = ["24h", "7d", "30d", "1y"] as const;

const ChartCard = ({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) => (
  <Card className="min-w-0 gap-3">
    <CardHeader>
      <CardTitle className="text-base">{title}</CardTitle>
      {description && <CardDescription>{description}</CardDescription>}
    </CardHeader>
    <CardContent className="px-2 sm:px-4">{children}</CardContent>
  </Card>
);

export const DashboardPage = () => {
  const { t } = useTranslation();
  const { range = "7d" } = useSearch({ from: "/app/" });
  const navigate = useNavigate({ from: "/" });
  const query = useQuery({ queryKey: ["stats", range], queryFn: () => api<Stats>(`/stats?range=${range}`), refetchInterval: 60_000 });
  const stats = query.data;
  const tick = stats?.step === "hour" ? hour : shortDate;
  const approx = stats?.approximate ? "≈ " : "";
  return (
    <>
      <PageHeader
        title={t("dashboard.title")}
        description={t("dashboard.description")}
        actions={
          <Tabs value={range} onValueChange={(value) => navigate({ search: { range: value as (typeof RANGES)[number] } })}>
            <TabsList>
              {RANGES.map((r) => (
                <TabsTrigger key={r} value={r}>
                  {t(`ranges.${r}`)}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        }
      />
      {query.isPending && <Loading rows={6} />}
      {query.error && <ErrorBox error={query.error} />}
      {stats && (
        <div className="flex flex-col gap-6">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatTile label={t("dashboard.questions")} value={number(stats.totals.questions)} hint={t("dashboard.searches", { count: stats.totals.searches })} />
            <StatTile label={t("dashboard.cost")} value={usd(stats.totals.cost)} hint={t("dashboard.perQuestion", { cost: usd(stats.totals.cost_per_question) })} />
            <StatTile label={t("dashboard.players")} value={number(stats.totals.players)} hint={t("dashboard.servers", { count: stats.totals.servers })} />
            <StatTile label={t("dashboard.errors")} value={percent(stats.totals.error_rate)} hint={t("dashboard.errorCount", { count: stats.totals.errors })} />
            <StatTile label={t("dashboard.p50")} value={`${approx}${duration(stats.totals.p50_ms)}`} />
            <StatTile label={t("dashboard.p95")} value={`${approx}${duration(stats.totals.p95_ms)}`} />
            <StatTile label={t("dashboard.tokensIn")} value={compact(stats.totals.input_tokens)} />
            <StatTile label={t("dashboard.tokensOut")} value={compact(stats.totals.output_tokens)} />
          </div>
          {stats.totals.questions === 0 && stats.totals.cost === 0 ? (
            <Empty>{t("dashboard.empty")}</Empty>
          ) : (
            <>
              <div className="grid gap-4 lg:grid-cols-2">
                <ChartCard title={t("dashboard.charts.questions")}>
                  <ColumnChart data={stats.series} x="t" tick={tick} y="questions" label={t("dashboard.questions")} format={(v) => compact(v)} />
                </ChartCard>
                <ChartCard title={t("dashboard.charts.cost")}>
                  <LineAreaChart data={stats.series} x="t" tick={tick} y="cost" label={t("dashboard.cost")} format={usd} axisFormat={usdTick} />
                </ChartCard>
                <ChartCard title={t("dashboard.charts.players")}>
                  <LineAreaChart data={stats.series} x="t" tick={tick} y="players" label={t("dashboard.players")} format={(v) => compact(v)} color={3} integer />
                </ChartCard>
                <ChartCard title={t("dashboard.charts.errors")}>
                  <ColumnChart data={stats.series} x="t" tick={tick} y="errors" label={t("dashboard.errors")} format={(v) => compact(v)} color={2} />
                </ChartCard>
              </div>
              <div className="grid gap-4 lg:grid-cols-2">
                <ChartCard title={t("dashboard.models")} description={t("dashboard.modelsHint")}>
                  <div className="px-2">
                    <RankBars rows={stats.models.map((m) => ({ name: m.name, value: m.runs, note: usd(m.cost) }))} format={(v) => t("dashboard.runCount", { count: v })} />
                  </div>
                </ChartCard>
                <ChartCard title={t("dashboard.kinds")}>
                  <div className="px-2">
                    <RankBars rows={Object.entries(stats.kinds).map(([kind, n]) => ({ name: t(`runs.kinds.${kind}`), value: n }))} format={(v) => number(v)} mono={false} />
                  </div>
                </ChartCard>
              </div>
              <Card className="gap-3">
                <CardHeader>
                  <CardTitle className="text-base">{t("dashboard.tools")}</CardTitle>
                  <CardDescription>{t("dashboard.toolsHint")}</CardDescription>
                </CardHeader>
                <CardContent>
                  {stats.tools.length === 0 ? (
                    <Empty>{t("dashboard.noTools")}</Empty>
                  ) : (
                  <TableFrame>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{t("dashboard.tool")}</TableHead>
                          <TableHead className="text-right">{t("dashboard.calls")}</TableHead>
                          <TableHead className="text-right">{t("dashboard.failed")}</TableHead>
                          <TableHead className="text-right">{t("dashboard.failureRate")}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {stats.tools.map((tool) => (
                          <TableRow key={tool.name}>
                            <TableCell className="font-mono text-xs">{tool.name}</TableCell>
                            <TableCell className="tabular text-right">{number(tool.calls)}</TableCell>
                            <TableCell className="tabular text-right">{number(tool.failed)}</TableCell>
                            <TableCell className="tabular text-right">{percent(tool.calls ? tool.failed / tool.calls : 0)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </TableFrame>
                  )}
                </CardContent>
              </Card>
            </>
          )}
        </div>
      )}
    </>
  );
};
