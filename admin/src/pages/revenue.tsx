import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ColumnChart } from "@/components/charts";
import { Empty, ErrorBox, Loading, PageHeader, StatTile, TableFrame } from "@/components/common";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import { number, shortDate, usd } from "@/lib/format";
import type { Revenue } from "@/lib/types";

const periodLabel = (period: string, by: "week" | "month") =>
  by === "month" ? new Intl.DateTimeFormat(undefined, { month: "short", year: "numeric" }).format(new Date(`${period}-01T00:00:00Z`)) : shortDate(`${period}T00:00:00Z`);

export const RevenuePage = () => {
  const { t } = useTranslation();
  const { range = "90d", by = "week" } = useSearch({ from: "/app/billing" });
  const navigate = useNavigate({ from: "/billing" });
  const query = useQuery({ queryKey: ["revenue", range, by], queryFn: () => api<Revenue>(`/billing/revenue?range=${range}&by=${by}`) });
  const data = query.data;
  const series = data?.series.map((p) => ({ ...p, net: p.stars - p.refunded })) ?? [];
  return (
    <>
      <PageHeader
        title={t("revenue.title")}
        description={data ? t("revenue.description", { rate: usd(data.star_usd) }) : undefined}
        actions={
          <>
            <Tabs value={range} onValueChange={(v) => navigate({ search: (s) => ({ ...s, range: v as typeof range }) })}>
              <TabsList>
                {(["30d", "90d", "1y"] as const).map((r) => (
                  <TabsTrigger key={r} value={r}>
                    {t(`ranges.${r}`)}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            <Tabs value={by} onValueChange={(v) => navigate({ search: (s) => ({ ...s, by: v as typeof by }) })}>
              <TabsList>
                <TabsTrigger value="week">{t("revenue.byWeek")}</TabsTrigger>
                <TabsTrigger value="month">{t("revenue.byMonth")}</TabsTrigger>
              </TabsList>
            </Tabs>
          </>
        }
      />
      {query.isPending && <Loading rows={6} />}
      {query.error && <ErrorBox error={query.error} />}
      {data && (
        <div className="flex flex-col gap-6">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatTile label={t("revenue.net")} value={`${number(data.totals.net_stars)} ⭐`} hint={t("revenue.usd", { usd: usd(data.totals.usd) })} />
            <StatTile label={t("revenue.payments")} value={number(data.totals.payments)} hint={t("revenue.renewals", { count: data.totals.renewals })} />
            <StatTile label={t("revenue.refunds")} value={number(data.totals.refunds)} hint={t("revenue.refundedStars", { stars: number(data.totals.refunded) })} />
            <StatTile label={t("revenue.cancellations")} value={number(data.totals.cancellations)} hint={t("revenue.licenseCost", { usd: usd(data.totals.license_cost) })} />
          </div>
          {series.length === 0 ? (
            <Empty>{t("revenue.none")}</Empty>
          ) : (
            <>
              <Card className="gap-3">
                <CardHeader>
                  <CardTitle className="text-base">{t("revenue.chart")}</CardTitle>
                </CardHeader>
                <CardContent className="px-2 sm:px-4">
                  <ColumnChart data={series} x="period" tick={(p) => periodLabel(p, by)} y="net" label={t("revenue.net")} format={(v) => `${number(v)} ⭐`} axisFormat={(v) => number(v)} />
                </CardContent>
              </Card>
              <TableFrame>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("revenue.columns.period")}</TableHead>
                      <TableHead className="text-right">{t("revenue.columns.payments")}</TableHead>
                      <TableHead className="text-right">{t("revenue.columns.stars")}</TableHead>
                      <TableHead className="hidden text-right sm:table-cell">{t("revenue.columns.refunded")}</TableHead>
                      <TableHead className="text-right">{t("revenue.columns.usd")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {[...series].reverse().map((p) => (
                      <TableRow key={p.period}>
                        <TableCell>{periodLabel(p.period, by)}</TableCell>
                        <TableCell className="tabular text-right">{number(p.payments)}</TableCell>
                        <TableCell className="tabular text-right">{number(p.stars)}</TableCell>
                        <TableCell className="tabular hidden text-right sm:table-cell">{number(p.refunded)}</TableCell>
                        <TableCell className="tabular text-right">{usd(p.usd)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableFrame>
            </>
          )}
        </div>
      )}
    </>
  );
};
