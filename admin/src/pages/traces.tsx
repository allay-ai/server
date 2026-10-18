import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { CheckCircle2, XCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Empty, ErrorBox, Loading, PageHeader, ResultBadge, TableFrame } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { dateTime, duration, number, relative, usd } from "@/lib/format";
import type { Run, Span, TraceSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

const PAGE = 50;

const length = (start: string, end: string | null) => (end ? new Date(end).getTime() - new Date(start).getTime() : null);

export const TracesPage = () => {
  const { t } = useTranslation();
  const query = useInfiniteQuery({
    queryKey: ["traces"],
    initialPageParam: "",
    queryFn: ({ pageParam }) => api<{ traces: TraceSummary[] }>(`/traces?limit=${PAGE}${pageParam ? `&before=${encodeURIComponent(pageParam)}` : ""}`),
    getNextPageParam: (last) => (last.traces.length === PAGE ? last.traces.at(-1)!.started_at : undefined),
  });
  const traces = query.data?.pages.flatMap((p) => p.traces) ?? [];
  return (
    <>
      <PageHeader title={t("traces.title")} description={t("traces.description")} />
      {query.isPending && <Loading />}
      {query.error && <ErrorBox error={query.error} />}
      {query.data &&
        (traces.length === 0 ? (
          <Empty>{t("traces.none")}</Empty>
        ) : (
          <>
            <TableFrame>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("traces.columns.started")}</TableHead>
                    <TableHead>{t("traces.columns.run")}</TableHead>
                    <TableHead className="text-right">{t("traces.columns.duration")}</TableHead>
                    <TableHead>{t("traces.columns.result")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {traces.map((trace) => (
                    <TableRow key={trace.trace_id}>
                      <TableCell className="whitespace-nowrap">
                        <Link to="/traces/$id" params={{ id: trace.trace_id }} className="font-medium hover:underline" title={dateTime(trace.started_at)}>
                          {relative(trace.started_at)}
                        </Link>
                      </TableCell>
                      <TableCell className="max-w-40 truncate font-mono text-xs">{trace.run_id ?? "—"}</TableCell>
                      <TableCell className="tabular text-right">{duration(length(trace.started_at, trace.ended_at))}</TableCell>
                      <TableCell>{trace.ok ? <ResultBadge result="ok" /> : <ResultBadge result="error" />}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableFrame>
            {query.hasNextPage && (
              <div className="mt-4 flex justify-center">
                <Button variant="outline" onClick={() => query.fetchNextPage()} disabled={query.isFetchingNextPage}>
                  {t("common.more")}
                </Button>
              </div>
            )}
          </>
        ))}
    </>
  );
};

/** Spans in tree order, each with its depth, so the waterfall indents children under their step. */
const ordered = (spans: Span[]) => {
  const children = new Map<string | null, Span[]>();
  for (const span of spans) children.set(span.parent_id, [...(children.get(span.parent_id) ?? []), span]);
  const ids = new Set(spans.map((s) => s.span_id));
  const roots = spans.filter((s) => !s.parent_id || !ids.has(s.parent_id));
  const out: Array<{ span: Span; depth: number }> = [];
  const walk = (span: Span, depth: number) => {
    out.push({ span, depth });
    for (const child of children.get(span.span_id) ?? []) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);
  return out;
};

export const TracePage = () => {
  const { t } = useTranslation();
  const { id } = useParams({ from: "/app/traces/$id" });
  const query = useQuery({ queryKey: ["trace", id], queryFn: () => api<{ trace: TraceSummary; spans: Span[]; run: Run | null }>(`/traces/${encodeURIComponent(id)}`) });
  const data = query.data;
  const start = data ? new Date(data.trace.started_at).getTime() : 0;
  const total = data ? Math.max(1, ...data.spans.map((s) => (s.ended_at ? new Date(s.ended_at).getTime() : start) - start)) : 1;
  return (
    <>
      <PageHeader title={t("trace.title")} description={t("trace.description")} />
      {query.isPending && <Loading />}
      {query.error && <ErrorBox error={query.error} />}
      {data && (
        <div className="flex flex-col gap-6">
          {data.run && (
            <Card className="gap-2">
              <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
                <div>
                  <CardTitle className="text-base">
                    <Link to="/runs/$id" params={{ id: data.run.id }} className="hover:underline">
                      {t(`runs.kinds.${data.run.kind}`)} · {data.run.player ?? data.run.user_id}
                    </Link>
                  </CardTitle>
                  <CardDescription>
                    {dateTime(data.run.at)} · {duration(data.run.duration_ms)} · {usd(data.run.cost)}
                  </CardDescription>
                </div>
                <ResultBadge result={data.run.result} code={data.run.error_code} />
              </CardHeader>
            </Card>
          )}
          <Card className="gap-3">
            <CardHeader>
              <CardTitle className="text-base">{t("trace.steps", { count: data.spans.length })}</CardTitle>
              <CardDescription>{t("trace.privacy")}</CardDescription>
            </CardHeader>
            <CardContent>
              <ol className="flex flex-col gap-1">
                {ordered(data.spans).map(({ span, depth }) => {
                  const from = new Date(span.started_at).getTime() - start;
                  const to = (span.ended_at ? new Date(span.ended_at).getTime() : start + total) - start;
                  const tokens = span.input_tokens !== undefined ? t("trace.tokens", { input: number(span.input_tokens), output: number(span.output_tokens ?? 0) }) : null;
                  return (
                    <li key={span.span_id} className="grid grid-cols-1 gap-1 rounded-md px-2 py-1.5 hover:bg-muted/60 md:grid-cols-[minmax(0,18rem)_1fr] md:items-center md:gap-4">
                      <div className="flex min-w-0 items-center gap-2 text-sm" style={{ paddingLeft: `${depth * 14}px` }}>
                        {span.ok ? <CheckCircle2 className="size-3.5 shrink-0 text-success" aria-label={t("runs.results.ok")} /> : <XCircle className="size-3.5 shrink-0 text-destructive" aria-label={t("runs.results.error")} />}
                        <span className={cn("truncate", span.type === "tool_call" && "font-mono text-xs")}>{span.type === "model_step" ? t("trace.step", { n: span.label.replace("step ", "") }) : span.label}</span>
                      </div>
                      <div className="flex min-w-0 flex-col gap-1">
                        <div className="relative h-2 rounded-full bg-muted" aria-hidden>
                          <div
                            className={cn("absolute h-2 rounded-full", span.type === "tool_call" ? "bg-chart-3" : span.type === "model_step" ? "bg-chart-1" : "bg-muted-foreground/40")}
                            style={{ left: `${(from / total) * 100}%`, width: `${Math.max(0.6, ((to - from) / total) * 100)}%` }}
                          />
                        </div>
                        <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                          <span className="tabular">{duration(to - from)}</span>
                          {span.model && <span className="truncate font-mono">{span.model}</span>}
                          {tokens && <span className="tabular">{tokens}</span>}
                          {span.finish_reason && <span>{span.finish_reason}</span>}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ol>
            </CardContent>
          </Card>
        </div>
      )}
    </>
  );
};
