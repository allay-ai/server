import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { CheckCircle2, XCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Definition, ErrorBox, Loading, PageHeader, PlayerLink, ResultBadge, RunsTable } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import { dateTime, duration, number, usd } from "@/lib/format";
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
  const query = useQuery({ queryKey: ["run", id], queryFn: () => api<{ run: Run; trace_id: string | null }>(`/runs/${encodeURIComponent(id)}`) });
  const run = query.data?.run;
  return (
    <>
      <PageHeader title={t("run.title")} description={<span className="font-mono text-xs break-all">{id}</span>} />
      {query.isPending && <Loading />}
      {query.error && <ErrorBox error={query.error} />}
      {run && (
        <div className="flex flex-col gap-6">
          <Card className="gap-4">
            <CardHeader className="flex flex-row items-start justify-between gap-3">
              <div>
                <CardTitle className="text-base">{t(`runs.kinds.${run.kind}`)}</CardTitle>
                <CardDescription>{dateTime(run.at)}</CardDescription>
              </div>
              <ResultBadge result={run.result} code={run.error_code} />
            </CardHeader>
            <CardContent>
              <Definition
                items={[
                  [t("run.player"), <PlayerLink key="p" id={run.user_id} />],
                  [t("run.server"), <ServerLabel key="s" server={run.server} serverId={run.server_id} />],
                  [t("run.model"), <span key="m" className="font-mono text-xs">{run.model}</span>],
                  [t("run.language"), run.language ?? "—"],
                  [t("run.duration"), duration(run.duration_ms)],
                  [t("run.cost"), usd(run.cost)],
                  [t("run.steps"), number(run.steps)],
                  [t("run.tokens"), t("run.tokenSplit", { input: number(run.input_tokens), output: number(run.output_tokens), reasoning: number(run.reasoning_tokens) })],
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
