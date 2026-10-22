import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { ColumnChart, RankBars } from "@/components/charts";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { toast } from "sonner";
import { Confirm, Definition, Empty, ErrorBox, Loading, PageHeader, Pager, PlayerHead, PlayerLink, RunsTable, StatTile, TableFrame, rowLink, serverParams } from "@/components/common";
import { FormField } from "@/components/form-field";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, post } from "@/lib/api";
import { compact, dateTime, duration, number, percent, relative, shortDate, usd } from "@/lib/format";
import { showErrors } from "@/lib/forms";
import { useAppState, useCan } from "@/lib/session";
import type { FoundPlayer, PlayerDetail, PlayerSummary, ServerSummary } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ServerLabel } from "./runs";
import { ServerName, joinAddress } from "./servers";

const LIMIT = 50;

/** A tenant in words, where nothing better names it: a license by its id, or this backend's own key. */
export const tenantLabel = (t: TFunction, tenant: string) => {
  const [kind, id] = tenant.split(":");
  return kind === "license" ? t("servers.license", { id }) : kind === "byok" ? t("servers.byok", { id }) : t("servers.self");
};

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

/** The players page's search: a dropdown of matching players that opens the one picked; Enter filters the table instead. */
const PlayerSearch = ({ value, onSearch }: { value: string; onSearch: (text: string) => void }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <div className="relative w-full sm:w-80">
      <Search className="pointer-events-none absolute top-1/2 left-3 z-10 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
      <div className="[&_input]:pl-9">
        <PlayerPicker
          id="players-search"
          text={text}
          picked={null}
          onText={(next) => {
            setText(next);
            if (!next) onSearch("");
          }}
          onPick={(player) => player && navigate({ to: "/players/$id", params: { id: player.user_id } })}
          onEnter={onSearch}
          placeholder={t("players.search")}
          label={t("players.search")}
        />
      </div>
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
        actions={<PlayerSearch value={search} onSearch={(value) => navigate({ search: { search: value || undefined, page: 0 } })} />}
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
                    <TableHead className="w-12">{t("players.columns.skin")}</TableHead>
                    <TableHead>{t("players.columns.player")}</TableHead>
                    <TableHead className="hidden text-right md:table-cell">{t("players.columns.servers")}</TableHead>
                    <TableHead className="text-right">{t("players.columns.questions")}</TableHead>
                    <TableHead className="hidden text-right lg:table-cell">{t("players.columns.errors")}</TableHead>
                    <TableHead className="hidden text-right lg:table-cell">{t("players.columns.tokens")}</TableHead>
                    <TableHead className="hidden text-right xl:table-cell">{t("players.columns.avgTime")}</TableHead>
                    <TableHead className="hidden text-right sm:table-cell">{t("players.columns.cost")}</TableHead>
                    <TableHead className="hidden md:table-cell">{t("players.columns.language")}</TableHead>
                    <TableHead className="hidden xl:table-cell">{t("players.columns.firstSeen")}</TableHead>
                    <TableHead>{t("players.columns.lastSeen")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {query.data.players.map((p) => (
                    <TableRow key={p.user_id} {...(p.user_id === "erased" ? {} : rowLink(() => navigate({ to: "/players/$id", params: { id: p.user_id } })))}>
                      <TableCell>
                        <PlayerHead id={p.user_id} size={32} known={!!p.player} />
                      </TableCell>
                      <TableCell className="max-w-56">
                        <span className="flex items-center gap-2">
                          <span className="flex min-w-0 flex-col">
                            <PlayerLink id={p.user_id} player={p.player} />
                            {p.player && <span className="truncate font-mono text-xs text-muted-foreground">{p.user_id}</span>}
                          </span>
                          {p.blocked && <Badge variant="destructive">{t("player.blocked")}</Badge>}
                        </span>
                      </TableCell>
                      <TableCell className="tabular hidden text-right md:table-cell">{number(p.servers)}</TableCell>
                      <TableCell className="tabular text-right">{number(p.questions)}</TableCell>
                      <TableCell className={cn("tabular hidden text-right lg:table-cell", p.errors > 0 && "text-destructive")}>{number(p.errors)}</TableCell>
                      <TableCell className="tabular hidden text-right whitespace-nowrap lg:table-cell">{compact(p.input_tokens + p.output_tokens)}</TableCell>
                      <TableCell className="tabular hidden text-right whitespace-nowrap xl:table-cell">{duration(p.avg_ms)}</TableCell>
                      <TableCell className="tabular hidden text-right sm:table-cell">{usd(p.cost)}</TableCell>
                      <TableCell className="hidden md:table-cell">{p.language ?? "—"}</TableCell>
                      <TableCell className="hidden whitespace-nowrap xl:table-cell" title={dateTime(p.first_seen)}>
                        {relative(p.first_seen)}
                      </TableCell>
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
  const query = useQuery({
    queryKey: ["players", "blocked"],
    queryFn: () => api<{ bans: Array<{ user_id: string; player: PlayerSummary["player"]; server: string; blocked_at: string }> }>("/players/blocked"),
  });
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
            <PlayerLink id={ban.user_id} player={ban.player} head />
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

/**
 * A combobox over the players the backend knows on one server: type the start of a name, pick the right face. What's
 * typed and not picked goes as it is, so a UUID or a pseudonym still works.
 */
export const PlayerPicker = ({
  id,
  server,
  text,
  picked,
  onText,
  onPick,
  onEnter,
  placeholder,
  label,
}: {
  id: string;
  /** Only this server's players; every server's without one. */
  server?: string;
  text: string;
  picked: FoundPlayer | null;
  onText: (text: string) => void;
  onPick: (player: FoundPlayer | null) => void;
  /** Enter with nothing highlighted, as a search box would take it. */
  onEnter?: (text: string) => void;
  placeholder: string;
  label?: string;
}) => {
  const { t } = useTranslation();
  const list = useId();
  const [open, setOpen] = useState(false);
  // A search box starts with nothing highlighted, so Enter searches; arrows pick a player.
  const first = onEnter ? -1 : 0;
  const [active, setActive] = useState(first);
  const [query, setQuery] = useState(text);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(text.trim()), 200);
    return () => clearTimeout(timer);
  }, [text]);
  const found = useQuery({
    queryKey: ["players", "lookup", server, query],
    queryFn: () => api<{ players: FoundPlayer[] }>(`/players/lookup?${server ? `server=${encodeURIComponent(server)}&` : ""}q=${encodeURIComponent(query)}`),
    enabled: open,
    placeholderData: (previous) => previous,
  });
  const options = found.data?.players ?? [];
  const pick = (player: FoundPlayer) => {
    onPick(player);
    onText(player.name);
    setOpen(false);
  };
  return (
    <div className="relative">
      <div className="relative">
        {picked && <PlayerHead id={picked.user_id} size={20} className="absolute top-1/2 left-2.5 -translate-y-1/2" />}
        <Input
          id={id}
          role="combobox"
          aria-expanded={open && options.length > 0}
          aria-controls={list}
          aria-autocomplete="list"
          aria-activedescendant={open && options[active] ? `${list}-${active}` : undefined}
          value={text}
          onChange={(e) => {
            onText(e.target.value);
            onPick(null);
            setActive(first);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setOpen(true);
              setActive((i) => Math.min(options.length - 1, i + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((i) => Math.max(0, i - 1));
            } else if (e.key === "Enter" && open && options[active]) {
              e.preventDefault();
              pick(options[active]);
            } else if (e.key === "Enter" && onEnter) {
              e.preventDefault();
              setOpen(false);
              onEnter(text.trim());
            } else if (e.key === "Escape") setOpen(false);
          }}
          placeholder={placeholder}
          aria-label={label}
          autoComplete="off"
          spellCheck={false}
          className={cn(picked && "pl-9")}
        />
      </div>
      {open && (options.length > 0 || (found.isFetched && query)) && (
        <ul id={list} role="listbox" className="absolute z-50 mt-1 max-h-72 w-full overflow-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
          {options.length === 0 && <li className="px-2 py-1.5 text-sm text-muted-foreground">{t(server ? "players.erase.noMatch" : "players.erase.noMatchAnywhere")}</li>}
          {options.map((player, i) => (
            <li
              key={`${player.server} ${player.user_id}`}
              id={`${list}-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(player)}
              className={cn("flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm", i === active && "bg-accent text-accent-foreground")}
            >
              <PlayerHead id={player.user_id} size={24} />
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-medium">{player.name}</span>
                <span className="truncate font-mono text-xs text-muted-foreground">{player.uuid}</span>
              </span>
              <span className="ml-auto flex shrink-0 flex-col items-end text-xs text-muted-foreground">
                {!server && <span className="max-w-32 truncate">{player.server_name ?? tenantLabel(t, player.server)}</span>}
                <span>{relative(player.last_seen)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

/** A player asked to be forgotten: picked by name from the server's players, or by the UUID or pseudonym they sent. */
const EraseCard = () => {
  const { t } = useTranslation();
  const can = useCan();
  const state = useAppState();
  const client = useQueryClient();
  const known = useQuery({ queryKey: ["servers"], queryFn: () => api<{ servers: ServerSummary[] }>("/servers?limit=500"), enabled: can("admin") });
  // The tenants that ever asked; a hosted backend's own key answers nobody, so `self` only counts where it asked or runs alone.
  const asked = [...new Set(known.data?.servers.map((s) => s.server).filter((s) => s === "self" || s.startsWith("license:")) ?? [])];
  const servers = asked.length ? asked : state?.billing ? [] : ["self"];
  const [chosen, setChosen] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<FoundPlayer | null>(null);
  // A picked player brings their server; a typed id needs one chosen, the only one when there's one.
  const server = picked?.server ?? chosen ?? servers[0] ?? "";
  const erase = useMutation({
    mutationFn: () => post<{ memories: number; runs: number }>("/players/erase", { server, user_id: picked?.user_id ?? text.trim() }),
    onSuccess: async (result) => {
      toast.success(t("players.erase.done", { memories: result.memories, runs: result.runs }));
      setText("");
      setPicked(null);
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
      <CardContent className={cn("grid gap-4 sm:items-end", !picked && text.trim() && servers.length > 1 ? "sm:grid-cols-[minmax(0,1fr)_minmax(0,14rem)_auto]" : "sm:grid-cols-[minmax(0,1fr)_auto]")}>
        <FormField id="erase-player" label={t("players.erase.player")} hint={picked ? t("players.erase.on", { server: picked.server_name ?? tenantLabel(t, picked.server) }) : undefined}>
          <PlayerPicker id="erase-player" text={text} picked={picked} onText={setText} onPick={setPicked} placeholder={t("players.erase.placeholder")} />
        </FormField>
        {!picked && text.trim() && servers.length > 1 && (
          <FormField id="erase-server" label={t("players.erase.server")}>
            <ServerSelect id="erase-server" value={server} onChange={setChosen} servers={servers} />
          </FormField>
        )}
        <Confirm
          label={t("players.erase.action")}
          title={picked ? t("players.erase.confirmNamed", { name: picked.name }) : t("players.erase.confirmTitle")}
          text={t("players.erase.confirmText")}
          action={t("players.erase.action")}
          destructive
          disabled={!server || !text.trim()}
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

const HOURS = Array.from({ length: 24 }, (_, i) => i);

export const PlayerPage = () => {
  const { t } = useTranslation();
  const can = useCan();
  const { id } = useParams({ from: "/app/players/$id" });
  const query = useQuery({ queryKey: ["player", id], queryFn: () => api<PlayerDetail>(`/players/${encodeURIComponent(id)}`) });
  const player = query.data;
  const blocked = player?.servers.some((s) => s.blocked_at);
  const profile = player?.profile;
  return (
    <>
      <PageHeader
        title={player?.player?.name ?? id}
        description={player?.player ? <span className="font-mono text-xs break-all">{id}</span> : t("player.description")}
        actions={blocked && <Badge variant="destructive">{t("player.blocked")}</Badge>}
      />
      {query.isPending && <Loading />}
      {query.error && <ErrorBox error={query.error} />}
      {player && profile && (
        <div className="flex flex-col gap-6">
          <Card className="gap-4">
            <CardContent className="flex flex-col gap-5 sm:flex-row sm:items-start">
              <PlayerHead id={id} size={96} className="rounded-md" known={!!player.player} />
              <div className="min-w-0 flex-1">
                <Definition
                  items={[
                    [t("player.name"), player.player?.name ?? t("player.noName")],
                    !!player.player && [t("player.uuid"), <span key="u" className="font-mono text-xs">{player.player.uuid}</span>],
                    [t("player.pseudonym"), <span key="p" className="font-mono text-xs">{id}</span>],
                    player.op !== null && [t("player.op"), player.op ? t("common.yes") : t("common.no")],
                    !!player.language && [t("player.language"), player.language],
                    !!player.first_seen && [t("player.firstSeen"), dateTime(player.first_seen)],
                    !!player.last_seen && [t("player.lastSeen"), dateTime(player.last_seen)],
                    [t("player.serverCount"), number(player.seen_on.length || player.servers.length)],
                  ]}
                />
                {!player.player && <p className="mt-4 text-sm text-muted-foreground">{t("player.nameLater")}</p>}
              </div>
            </CardContent>
          </Card>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatTile label={t("player.questions")} value={number(player.questions)} hint={t("player.searches", { count: profile.searches })} />
            <StatTile label={t("player.cost")} value={usd(player.cost)} hint={t("dashboard.perQuestion", { cost: usd(player.questions ? player.cost / player.questions : 0) })} />
            <StatTile label={t("player.errors")} value={percent(player.questions ? profile.errors / player.questions : 0)} hint={t("dashboard.errorCount", { count: profile.errors })} />
            <StatTile label={t("dashboard.p50")} value={duration(profile.p50_ms)} hint={t("player.p95", { time: duration(profile.p95_ms) })} />
            <StatTile label={t("dashboard.tokensIn")} value={compact(profile.input_tokens)} />
            <StatTile label={t("dashboard.tokensOut")} value={compact(profile.output_tokens)} hint={t("player.reasoning", { count: compact(profile.reasoning_tokens) })} />
            <StatTile label={t("player.toolCalls")} value={number(profile.tool_calls)} hint={t("player.toolFailures", { count: profile.tool_failures })} />
            <StatTile label={t("player.cancelled")} value={number(profile.cancelled)} />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="min-w-0 gap-3">
              <CardHeader>
                <CardTitle className="text-base">{t("player.activity")}</CardTitle>
                <CardDescription>{t("player.activityHint")}</CardDescription>
              </CardHeader>
              <CardContent className="px-2 sm:px-4">
                <ColumnChart data={profile.activity} x="t" tick={shortDate} y="questions" label={t("player.questions")} format={(v) => compact(v)} />
              </CardContent>
            </Card>
            <Card className="min-w-0 gap-3">
              <CardHeader>
                <CardTitle className="text-base">{t("player.hours")}</CardTitle>
                <CardDescription>{t("player.hoursHint")}</CardDescription>
              </CardHeader>
              <CardContent className="px-2 sm:px-4">
                <ColumnChart
                  data={HOURS.map((h) => ({ t: String(h), questions: profile.hours[h] ?? 0 }))}
                  x="t"
                  tick={(h) => `${h.padStart(2, "0")}:00`}
                  y="questions"
                  label={t("player.questions")}
                  format={(v) => compact(v)}
                  color={3}
                />
              </CardContent>
            </Card>
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="min-w-0 gap-3">
              <CardHeader>
                <CardTitle className="text-base">{t("dashboard.kinds")}</CardTitle>
              </CardHeader>
              <CardContent>
                {Object.keys(profile.kinds).length ? (
                  <RankBars rows={Object.entries(profile.kinds).map(([kind, n]) => ({ name: t(`runs.kinds.${kind}`), value: n }))} format={(v) => number(v)} mono={false} />
                ) : (
                  <span className="text-sm text-muted-foreground">—</span>
                )}
              </CardContent>
            </Card>
            <Card className="min-w-0 gap-3">
              <CardHeader>
                <CardTitle className="text-base">{t("dashboard.models")}</CardTitle>
              </CardHeader>
              <CardContent>
                {profile.models.length ? (
                  <RankBars rows={profile.models.map((m) => ({ name: m.name, value: m.runs, note: usd(m.cost) }))} format={(v) => t("dashboard.runCount", { count: v })} />
                ) : (
                  <span className="text-sm text-muted-foreground">—</span>
                )}
              </CardContent>
            </Card>
            <Card className="min-w-0 gap-3">
              <CardHeader>
                <CardTitle className="text-base">{t("dashboard.tools")}</CardTitle>
              </CardHeader>
              <CardContent>
                {profile.tools.length ? (
                  <RankBars rows={profile.tools.map((tool) => ({ name: tool.name, value: tool.calls, note: tool.failed ? t("player.failedNote", { count: tool.failed }) : undefined }))} format={(v) => number(v)} />
                ) : (
                  <span className="text-sm text-muted-foreground">{t("dashboard.noTools")}</span>
                )}
              </CardContent>
            </Card>
          </div>
          <Card className="gap-3">
            <CardHeader>
              <CardTitle className="text-base">{t("player.servers")}</CardTitle>
              <CardDescription>{t("player.privacy")}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2">
              {player.seen_on.length === 0 && <span className="text-sm text-muted-foreground">{t("player.noServers")}</span>}
              {player.seen_on.map((s) => {
                const tenant = player.servers.find((entry) => entry.server === s.server);
                return (
                  <Link
                    key={`${s.server}/${s.server_id ?? ""}`}
                    to="/servers/$tenant/$id"
                    params={serverParams(s)}
                    className="flex min-w-0 flex-col gap-1.5 rounded-lg border p-3 text-sm transition-colors hover:border-primary/40 hover:bg-accent/40"
                  >
                    <span className="flex min-w-0 items-center justify-between gap-2">
                      <ServerName server={s} />
                      <span className="flex shrink-0 gap-1">
                        {tenant?.op && <Badge variant="outline">{t("player.opBadge")}</Badge>}
                        {tenant?.blocked_at && <Badge variant="destructive">{t("player.blocked")}</Badge>}
                      </span>
                    </span>
                    {joinAddress(s) && <span className="truncate font-medium text-primary">{joinAddress(s)}</span>}
                    <span className="text-xs text-muted-foreground">
                      {[
                        tenant?.name && t("player.as", { name: tenant.name }),
                        s.license?.name,
                        t("player.serverLine", { questions: number(s.questions), cost: usd(s.cost), seen: relative(s.last_seen) }),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </Link>
                );
              })}
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
