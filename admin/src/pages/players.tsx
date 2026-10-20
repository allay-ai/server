import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Confirm, Definition, Empty, ErrorBox, Loading, PageHeader, Pager, PlayerLink, RunsTable, StatTile, TableFrame } from "@/components/common";
import { FormField } from "@/components/form-field";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, post } from "@/lib/api";
import { dateTime, number, relative, usd } from "@/lib/format";
import { showErrors } from "@/lib/forms";
import { useCan } from "@/lib/session";
import type { PlayerDetail, PlayerSummary, ServerSummary } from "@/lib/types";
import { ServerLabel } from "./runs";

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
                      <TableCell className="max-w-56">
                        <span className="flex items-center gap-2">
                          <span className="truncate">
                            <PlayerLink id={p.user_id} />
                          </span>
                          {p.blocked && <Badge variant="destructive">{t("player.blocked")}</Badge>}
                        </span>
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
      <BlockedCard />
      <EraseCard />
    </>
  );
};

/** Everyone blocked on some server, erased players too, so a block can always be lifted from their page. */
const BlockedCard = () => {
  const { t } = useTranslation();
  const query = useQuery({ queryKey: ["players", "blocked"], queryFn: () => api<{ bans: Array<{ user_id: string; server: string; blocked_at: string }> }>("/players/blocked") });
  if (!query.data?.bans.length) return null;
  return (
    <Card className="mt-6 gap-4">
      <CardHeader>
        <CardTitle className="text-base">{t("players.blocked.title")}</CardTitle>
        <CardDescription>{t("players.blocked.description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col divide-y">
        {query.data.bans.map((ban) => (
          <div key={`${ban.server} ${ban.user_id}`} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
            <PlayerLink id={ban.user_id} />
            <span className="flex flex-wrap gap-x-2 text-muted-foreground">
              <ServerLabel server={ban.server} />
              <span>{t("players.blocked.since", { date: dateTime(ban.blocked_at) })}</span>
            </span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
};

/** A server picker over the tenants that ever asked, as runs name them; self first when it's there. */
const ServerSelect = ({ id, value, onChange, servers }: { id: string; value: string; onChange: (value: string) => void; servers: string[] }) => (
  <Select value={value} onValueChange={onChange}>
    <SelectTrigger id={id} className="w-full">
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      {servers.map((server) => (
        <SelectItem key={server} value={server}>
          <ServerLabel server={server} />
        </SelectItem>
      ))}
    </SelectContent>
  </Select>
);

/** A player asked to be forgotten: by the pseudonym from the list, or by the id they sent, which the panel itself never shows. */
const EraseCard = () => {
  const { t } = useTranslation();
  const can = useCan();
  const client = useQueryClient();
  const known = useQuery({ queryKey: ["servers"], queryFn: () => api<{ servers: ServerSummary[] }>("/servers"), enabled: can("admin") });
  const servers = [...new Set(["self", ...(known.data?.servers.map((s) => s.server).filter((s) => s === "self" || s.startsWith("license:")) ?? [])])];
  const [server, setServer] = useState("self");
  const [userId, setUserId] = useState("");
  const erase = useMutation({
    mutationFn: () => post<{ memories: number; runs: number }>("/players/erase", { server: server.trim(), user_id: userId.trim() }),
    onSuccess: async (result) => {
      toast.success(t("players.erase.done", { memories: result.memories, runs: result.runs }));
      setUserId("");
      await client.invalidateQueries({ queryKey: ["players"] });
    },
    onError: (error) => showErrors(error),
  });
  if (!can("admin")) return null;
  return (
    <Card className="mt-6 gap-4">
      <CardHeader>
        <CardTitle className="text-base">{t("players.erase.title")}</CardTitle>
        <CardDescription>{t("players.erase.description")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto] sm:items-end">
        <FormField id="erase-server" label={t("players.erase.server")}>
          <ServerSelect id="erase-server" value={server} onChange={setServer} servers={servers} />
        </FormField>
        <FormField id="erase-player" label={t("players.erase.player")}>
          <Input id="erase-player" value={userId} onChange={(e) => setUserId(e.target.value)} placeholder={t("players.erase.placeholder")} autoComplete="off" spellCheck={false} />
        </FormField>
        <Confirm
          label={t("players.erase.action")}
          title={t("players.erase.confirmTitle")}
          text={t("players.erase.confirmText")}
          action={t("players.erase.action")}
          destructive
          disabled={!server.trim() || !userId.trim()}
          onConfirm={() => erase.mutateAsync()}
        />
      </CardContent>
    </Card>
  );
};

/** What an admin does to a player from their page, on one server they asked on: the backend finds who they are. */
const PlayerActions = ({ id, servers }: { id: string; servers: PlayerDetail["servers"] }) => {
  const { t } = useTranslation();
  const client = useQueryClient();
  const navigate = useNavigate();
  const [server, setServer] = useState(servers[0]?.server ?? "self");
  const chosen = servers.find((s) => s.server === server) ?? servers[0];
  if (!chosen) return null;
  const act = async (action: "reset" | "erase" | "block" | "unblock") => {
    try {
      const result = await post<{ memories?: number; runs?: number }>(`/players/${encodeURIComponent(id)}/${action}`, { server: chosen.server });
      toast.success(action === "erase" ? t("players.erase.done", { memories: result.memories, runs: result.runs }) : t(`player.actions.${action}Done`));
      await client.invalidateQueries({ queryKey: ["players"] });
      if (action === "erase") await navigate({ to: "/players", search: {} });
      else await client.invalidateQueries({ queryKey: ["player", id] });
    } catch (error) {
      showErrors(error);
    }
  };
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="text-base">{t("player.actions.title")}</CardTitle>
        <CardDescription>{t("player.actions.description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {servers.length > 1 && (
          <div className="sm:w-72">
            <FormField id="player-server" label={t("players.erase.server")}>
              <ServerSelect id="player-server" value={chosen.server} onChange={setServer} servers={servers.map((s) => s.server)} />
            </FormField>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Confirm
            label={t("player.actions.reset")}
            title={t("player.actions.resetTitle")}
            text={t("player.actions.resetText")}
            action={t("player.actions.reset")}
            disabled={!chosen.known}
            onConfirm={() => act("reset")}
          />
          {chosen.blocked_at ? (
            <Confirm label={t("player.actions.unblock")} title={t("player.actions.unblockTitle")} text={t("player.actions.unblockText")} action={t("player.actions.unblock")} onConfirm={() => act("unblock")} />
          ) : (
            <Confirm
              label={t("player.actions.block")}
              title={t("player.actions.blockTitle")}
              text={t("player.actions.blockText")}
              action={t("player.actions.block")}
              destructive
              variant="outline"
              onConfirm={() => act("block")}
            />
          )}
          <Confirm
            label={t("players.erase.action")}
            title={t("players.erase.confirmTitle")}
            text={t("players.erase.confirmText")}
            action={t("players.erase.action")}
            destructive
            onConfirm={() => act("erase")}
          />
        </div>
        {chosen.blocked_at && <p className="text-sm text-muted-foreground">{t("player.actions.blockedSince", { date: dateTime(chosen.blocked_at) })}</p>}
        {!chosen.known && <p className="text-sm text-muted-foreground">{t("player.actions.unknown")}</p>}
      </CardContent>
    </Card>
  );
};

export const PlayerPage = () => {
  const { t } = useTranslation();
  const can = useCan();
  const { id } = useParams({ from: "/app/players/$id" });
  const query = useQuery({ queryKey: ["player", id], queryFn: () => api<PlayerDetail>(`/players/${encodeURIComponent(id)}`) });
  const player = query.data;
  const blocked = player?.servers.some((s) => s.blocked_at);
  return (
    <>
      <PageHeader title={id} description={t("player.description")} actions={blocked && <Badge variant="destructive">{t("player.blocked")}</Badge>} />
      {query.isPending && <Loading />}
      {query.error && <ErrorBox error={query.error} />}
      {player && (
        <div className="flex flex-col gap-6">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatTile label={t("player.questions")} value={number(player.questions)} />
            <StatTile label={t("player.cost")} value={usd(player.cost)} />
          </div>
          <Card className="gap-4">
            <CardHeader>
              <CardTitle className="text-base">{t("player.details")}</CardTitle>
              <CardDescription>{t("player.privacy")}</CardDescription>
            </CardHeader>
            <CardContent>
              <Definition
                items={[
                  [t("player.language"), player.language ?? "—"],
                  [t("player.firstSeen"), dateTime(player.first_seen)],
                  [t("player.lastSeen"), dateTime(player.last_seen)],
                ]}
              />
            </CardContent>
          </Card>
          {can("admin") && <PlayerActions key={id} id={id} servers={player.servers} />}
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
