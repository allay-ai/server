import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { CheckCircle2, XCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Definition, ErrorBox, Loading, PageHeader, PlayerHead, PlayerLink, ResultBadge, RunsTable, StatTile } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import { compact, dateTime, duration, number, percent, usd } from "@/lib/format";
import type { Run } from "@/lib/types";

const KINDS = ["ask", "askall", "askx", "task", "summary", "telegram"];
const PAGE = 50;

/** Where a run's money came from, without a key or a secret: a license, a server's own key, or this backend. */
export const ServerLabel = ({ server, serverId }: { server: string; serverId?: string }) => {
  const { t } = useTranslation();
  const [kind, id] = server.split(":");
  const label = kind === "license" ? t("servers.license", { id }) : kind === "byok" ? t("servers.byok", { id }) : t("servers.self");
  return (
    <span className="flex min-w-0 flex-col">
      {kind === "license" ? (
        <Link to="/licenses/$id" params={{ id }} className="truncate hover:underline">
          {label}
        </Link>
      ) : (
        <span className="truncate">{label}</span>
      )}
      {serverId && <span className="truncate font-mono text-xs text-muted-foreground">{serverId}</span>}
    </span>
  );
};

export const RunsPage = () => {
  const { t } = useTranslation();
  const search = useSearch({ from: "/app/runs" });
  const navigate = useNavigate({ from: "/runs" });
  const params = new URLSearchParams({ limit: String(PAGE) });
  for (const key of ["player", "server", "kind", "result"] as const) if (search[key]) params.set(key, search[key]!);
  const query = useInfiniteQuery({
    queryKey: ["runs", search],
    initialPageParam: "",
    queryFn: ({ pageParam }) => api<{ runs: Run[] }>(`/runs?${params}${pageParam ? `&before=${encodeURIComponent(pageParam)}` : ""}`),
    getNextPageParam: (last) => (last.runs.length === PAGE ? last.runs.at(-1)!.at : undefined),
  });
  const runs = query.data?.pages.flatMap((p) => p.runs) ?? [];
  const set = (key: "kind" | "result", value: string) => navigate({ search: (prev) => ({ ...prev, [key]: value === "all" ? undefined : value }) });
  return (
    <>
      <PageHeader
        title={t("runs.title")}
        description={search.player ? t("runs.ofPlayer", { player: search.player }) : search.server ? t("runs.ofServer", { server: search.server }) : t("runs.description")}
        actions={
          <>
            <Select value={search.kind ?? "all"} onValueChange={(v) => set("kind", v)}>
              <SelectTrigger className="w-40" aria-label={t("runs.columns.kind")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("runs.allKinds")}</SelectItem>
                {KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {t(`runs.kinds.${k}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={search.result ?? "all"} onValueChange={(v) => set("result", v)}>
              <SelectTrigger className="w-40" aria-label={t("runs.columns.result")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("runs.allResults")}</SelectItem>
                {(["ok", "error", "cancelled"] as const).map((r) => (
                  <SelectItem key={r} value={r}>
                    {t(`runs.results.${r}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {(search.player || search.server) && (
              <Button variant="ghost" onClick={() => navigate({ search: {} })}>
                {t("runs.clear")}
              </Button>
            )}
          </>
        }
      />
      {query.isPending && <Loading />}
      {query.error && <ErrorBox error={query.error} />}
      {query.data && (
        <>
          <RunsTable runs={runs} />
          {query.hasNextPage && (
            <div className="mt-4 flex justify-center">
              <Button variant="outline" onClick={() => query.fetchNextPage()} disabled={query.isFetchingNextPage}>
                {t("common.more")}
              </Button>
            </div>
          )}
        </>
      )}
    </>
  );
};

export const RunPage = () => {
  const { t } = useTranslation();
  const { id } = useParams({ from: "/app/runs/$id" });
  const query = useQuery({
    queryKey: ["run", id],
    queryFn: () => api<{ run: Run; trace_id: string | null; server_name: string | null; span_count: number | null }>(`/runs/${encodeURIComponent(id)}`),
  });
  const run = query.data?.run;
  const tokens = run ? run.input_tokens + run.output_tokens : 0;
  const failed = run?.tools.filter((tool) => !tool.ok).length ?? 0;
  return (
    <>
      <PageHeader title={t("run.title")} description={<span className="font-mono text-xs break-all">{id}</span>} />
      {query.isPending && <Loading />}
      {query.error && <ErrorBox error={query.error} />}
      {run && (
        <div className="flex flex-col gap-6">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatTile label={t("run.duration")} value={duration(run.duration_ms)} hint={t("run.perStep", { time: duration(run.steps ? Math.round(run.duration_ms / run.steps) : null) })} />
            <StatTile label={t("run.cost")} value={usd(run.cost)} hint={tokens ? t("run.perThousand", { cost: usd((run.cost / tokens) * 1000) }) : undefined} />
            <StatTile label={t("run.tokens")} value={compact(tokens)} hint={run.duration_ms ? t("run.speed", { rate: number(run.output_tokens / (run.duration_ms / 1000), 1) }) : undefined} />
            <StatTile label={t("run.toolCalls")} value={number(run.tools.length)} hint={run.tools.length ? t("run.toolFailures", { rate: percent(failed / run.tools.length) }) : undefined} />
          </div>
          <Card className="gap-4">
            <CardHeader className="flex flex-row items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <PlayerHead id={run.user_id} size={40} known={!!run.player} />
                <div>
                  <CardTitle className="text-base">{t(`runs.kinds.${run.kind}`)}</CardTitle>
                  <CardDescription>{dateTime(run.at)}</CardDescription>
                </div>
              </div>
              <ResultBadge result={run.result} code={run.error_code} />
            </CardHeader>
            <CardContent>
              <Definition
                items={[
                  [t("run.player"), <PlayerLink key="p" id={run.user_id} player={run.player} />],
                  [t("run.uuid"), run.player ? <span key="u" className="font-mono text-xs">{run.player.uuid}</span> : "—"],
                  [t("run.server"), <ServerLabel key="s" server={run.server} serverId={run.server_id} />],
                  [t("run.serverName"), query.data?.server_name ?? "—"],
                  [t("run.payer"), t(`run.payers.${run.payer}`)],
                  [t("run.model"), <span key="m" className="font-mono text-xs">{run.model}</span>],
                  [t("run.language"), run.language ?? "—"],
                  [t("run.steps"), number(run.steps)],
                  [t("run.searches"), number(run.searches)],
                  [t("run.tokens"), t("run.tokenSplit", { input: number(run.input_tokens), output: number(run.output_tokens), reasoning: number(run.reasoning_tokens) })],
                  [t("run.spans"), query.data?.span_count === null || query.data?.span_count === undefined ? "—" : number(query.data.span_count)],
                  [t("run.errorCode"), run.error_code ? <span key="e" className="font-mono text-xs">{run.error_code}</span> : "—"],
                ]}
              />
            </CardContent>
          </Card>
          <Card className="gap-3">
            <CardHeader>
              <CardTitle className="text-base">{t("run.tools", { count: run.tools.length })}</CardTitle>
              <CardDescription>{t("run.toolsHint")}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              {run.tools.length === 0 && <span className="text-sm text-muted-foreground">{t("run.noTools")}</span>}
              {run.tools.map((tool, i) => (
                <Badge key={i} variant="outline" className="gap-1 font-mono">
                  {tool.ok ? <CheckCircle2 className="size-3 text-success" aria-label={t("runs.results.ok")} /> : <XCircle className="size-3 text-destructive" aria-label={t("runs.results.error")} />}
                  {tool.name}
                </Badge>
              ))}
            </CardContent>
          </Card>
          {query.data?.trace_id ? (
            <Button asChild variant="outline" className="self-start">
              <Link to="/traces/$id" params={{ id: query.data!.trace_id! }}>
                {t("run.openTrace")}
              </Link>
            </Button>
          ) : (
            <p className="text-sm text-muted-foreground">{t("run.noTrace")}</p>
          )}
        </div>
      )}
    </>
  );
};
