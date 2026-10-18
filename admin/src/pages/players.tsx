import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Confirm, Definition, Empty, ErrorBox, Loading, PageHeader, Pager, RunsTable, StatTile, TableFrame } from "@/components/common";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { dateTime, number, relative, usd } from "@/lib/format";
import { showErrors } from "@/lib/forms";
import { useCan } from "@/lib/session";
import type { PlayerDetail, PlayerSummary } from "@/lib/types";

const LIMIT = 50;

/** A search box that waits for a pause in typing before it asks the backend. */
export const SearchBox = ({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) => {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  useEffect(() => {
    if (text === value) return;
    const timer = setTimeout(() => onChange(text), 300);
    return () => clearTimeout(timer);
  }, [text, value, onChange]);
  return (
    <div className="relative w-full sm:w-72">
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
      <Input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} aria-label={placeholder} className="pl-9" />
    </div>
  );
};

export const PlayersPage = () => {
  const { t } = useTranslation();
  const { search = "", page = 0 } = useSearch({ from: "/app/players" });
  const navigate = useNavigate({ from: "/players" });
  const query = useQuery({
    queryKey: ["players", search, page],
    queryFn: () => api<{ total: number; players: PlayerSummary[] }>(`/players?limit=${LIMIT}&page=${page}${search ? `&search=${encodeURIComponent(search)}` : ""}`),
    placeholderData: (previous) => previous,
  });
  return (
    <>
      <PageHeader
        title={t("players.title")}
        description={t("players.description")}
        actions={<SearchBox value={search} onChange={(value) => navigate({ search: { search: value || undefined, page: 0 } })} placeholder={t("players.search")} />}
      />
      {query.isPending && <Loading />}
      {query.error && <ErrorBox error={query.error} />}
      {query.data &&
        (query.data.players.length === 0 ? (
          <Empty>{search ? t("players.noMatch") : t("players.none")}</Empty>
        ) : (
          <>
            <TableFrame>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("players.columns.player")}</TableHead>
                    <TableHead className="text-right">{t("players.columns.questions")}</TableHead>
                    <TableHead className="text-right">{t("players.columns.cost")}</TableHead>
                    <TableHead className="hidden sm:table-cell">{t("players.columns.language")}</TableHead>
                    <TableHead>{t("players.columns.lastSeen")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {query.data.players.map((p) => (
                    <TableRow key={p.user_id}>
                      <TableCell className="max-w-48">
                        <Link to="/players/$id" params={{ id: p.user_id }} className="block truncate font-medium hover:underline">
                          {p.player ?? p.user_id}
                        </Link>
                      </TableCell>
                      <TableCell className="tabular text-right">{number(p.questions)}</TableCell>
                      <TableCell className="tabular text-right">{usd(p.cost)}</TableCell>
                      <TableCell className="hidden sm:table-cell">{p.language ?? "—"}</TableCell>
                      <TableCell className="whitespace-nowrap" title={dateTime(p.last_seen)}>
                        {relative(p.last_seen)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableFrame>
            <Pager page={page} total={query.data.total} limit={LIMIT} onPage={(next) => navigate({ search: { search: search || undefined, page: next } })} />
          </>
        ))}
    </>
  );
};

export const PlayerPage = () => {
  const { t } = useTranslation();
  const { id } = useParams({ from: "/app/players/$id" });
  const can = useCan();
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["player", id], queryFn: () => api<PlayerDetail>(`/players/${encodeURIComponent(id)}`) });
  const act = useMutation({
    mutationFn: (what: "memories" | "session") => api(`/players/${encodeURIComponent(id)}/${what}`, { method: "DELETE" }),
    onSuccess: async (_, what) => {
      toast.success(t(what === "memories" ? "player.memoriesDeleted" : "player.sessionReset"));
      await client.invalidateQueries({ queryKey: ["player", id] });
    },
    onError: (error) => showErrors(error),
  });
  const player = query.data;
  return (
    <>
      <PageHeader title={player?.player ?? id} description={t("player.description", { id })} />
      {query.isPending && <Loading />}
      {query.error && <ErrorBox error={query.error} />}
      {player && (
        <div className="flex flex-col gap-6">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatTile label={t("player.questions")} value={number(player.questions)} />
            <StatTile label={t("player.cost")} value={usd(player.cost)} />
            <StatTile label={t("player.memories")} value={player.memories === null ? "—" : number(player.memories)} />
            <StatTile label={t("player.session")} value={t("player.sessionSize", { count: player.session.messages })} hint={t("player.tokens", { count: player.session.tokens })} />
          </div>
          <Card className="gap-4">
            <CardHeader>
              <CardTitle className="text-base">{t("player.details")}</CardTitle>
              <CardDescription>{t("player.privacy")}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-5">
              <Definition
                items={[
                  [t("player.language"), player.language ?? "—"],
                  [t("player.firstSeen"), dateTime(player.first_seen)],
                  [t("player.lastSeen"), dateTime(player.last_seen)],
                  [t("player.summary"), player.session.summary ? t("common.yes") : t("common.no")],
                ]}
              />
              {can("admin") && (
                <div className="flex flex-wrap gap-2">
                  <Confirm
                    label={t("player.deleteMemories")}
                    title={t("player.deleteMemoriesTitle")}
                    text={t("player.deleteMemoriesText", { count: player.memories ?? 0 })}
                    action={t("player.deleteMemories")}
                    destructive
                    disabled={!player.memories}
                    onConfirm={() => act.mutateAsync("memories")}
                  />
                  <Confirm
                    label={t("player.resetSession")}
                    title={t("player.resetSessionTitle")}
                    text={t("player.resetSessionText")}
                    action={t("player.resetSession")}
                    disabled={!player.session.messages && !player.session.summary}
                    onConfirm={() => act.mutateAsync("session")}
                  />
                </div>
              )}
            </CardContent>
          </Card>
          <section className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">{t("player.runs")}</h2>
              <Link to="/runs" search={{ player: id }} className="text-sm text-primary hover:underline">
                {t("common.all")}
              </Link>
            </div>
            <RunsTable runs={player.runs} showPlayer={false} />
          </section>
        </div>
      )}
    </>
  );
};
