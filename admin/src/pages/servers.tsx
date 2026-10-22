import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import {
  Definition,
  Empty,
  ErrorBox,
  LicenseButton,
  Loading,
  PageHeader,
  PlayerHead,
  PlayerLink,
  RunsTable,
  StatTile,
  TableFrame,
  rowLink,
  serverParams,
} from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { dateTime, number, relative, usd } from "@/lib/format";
import { useCan } from "@/lib/session";
import type { ServerDetail, ServerSummary } from "@/lib/types";

/** Where players join: the address the plugin's config names, with the game port when it isn't the default. */
export const joinAddress = (s: Pick<ServerSummary, "address" | "port">) => (s.address ? (s.port && s.port !== 25565 ? `${s.address}:${s.port}` : s.address) : null);

/** The address a server connects from, marked when it's a private network the backend shares. */
export const ServerIp = ({ server }: { server: ServerSummary }) => {
  const { t } = useTranslation();
  if (!server.ip) return <span className="text-muted-foreground">{t("servers.noIp")}</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span className="font-mono text-xs">{server.ip}</span>
      {server.internal && (
        <Badge variant="outline" title={t("servers.internalHint")}>
          {t("servers.internal")}
        </Badge>
      )}
    </span>
  );
};

/** What the server runs: the game's software and version, and the plugin's version under it. */
export const ServerRuntime = ({ server }: { server: ServerSummary }) => {
  const { t } = useTranslation();
  if (!server.software && !server.plugin_version) return <span className="text-muted-foreground">{t("servers.noRuntime")}</span>;
  return (
    <span className="flex flex-col">
      {server.software && <span>{[server.software, server.version].filter(Boolean).join(" ")}</span>}
      {server.plugin_version && <span className="text-xs text-muted-foreground">{t("servers.plugin", { version: server.plugin_version })}</span>}
    </span>
  );
};

/** Who pays for a server's questions: its license as a button, or a word for the backend's own key. */
export const ServerPayer = ({ server }: { server: ServerSummary }) => {
  const { t } = useTranslation();
  if (server.license) return <LicenseButton id={server.license.id} name={server.license.name} />;
  return <span className="text-muted-foreground">{server.server === "self" ? t("servers.self") : t("servers.byokShort")}</span>;
};

/** A server's name as its owner set it, or a word and its id when it never registered one. */
export const ServerName = ({ server }: { server: ServerSummary }) => {
  const { t } = useTranslation();
  return (
    <span className="flex min-w-0 flex-col">
      <span className="truncate font-medium">{server.name ?? t("servers.unnamed")}</span>
      {!server.name && <span className="truncate font-mono text-xs text-muted-foreground">{server.server_id ?? t("servers.noId")}</span>}
    </span>
  );
};

export const ServersPage = () => {
  const { t } = useTranslation();
  const can = useCan();
  const navigate = useNavigate();
  const query = useQuery({ queryKey: ["servers"], queryFn: () => api<{ servers: ServerSummary[] }>("/servers?limit=500") });
  const admin = can("admin");
  return (
    <>
      <PageHeader title={t("servers.title")} description={t("servers.description")} />
      {query.isPending && <Loading />}
      {query.error && <ErrorBox error={query.error} />}
      {query.data &&
        (query.data.servers.length === 0 ? (
          <Empty>{t("servers.none")}</Empty>
        ) : (
          <TableFrame>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("servers.columns.name")}</TableHead>
                  <TableHead className="hidden sm:table-cell">{t("servers.columns.domain")}</TableHead>
                  <TableHead className="hidden md:table-cell">{t("servers.columns.license")}</TableHead>
                  {admin && <TableHead className="hidden xl:table-cell">{t("servers.columns.ip")}</TableHead>}
                  <TableHead className="hidden lg:table-cell">{t("servers.columns.runtime")}</TableHead>
                  <TableHead className="text-right">{t("servers.columns.questions")}</TableHead>
                  <TableHead>{t("servers.columns.lastUsed")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {query.data.servers.map((s) => (
                  <TableRow key={`${s.server}/${s.server_id ?? ""}`} {...rowLink(() => navigate({ to: "/servers/$tenant/$id", params: serverParams(s) }))}>
                    <TableCell className="max-w-56">
                      <Link to="/servers/$tenant/$id" params={serverParams(s)} className="block min-w-0 hover:underline">
                        <ServerName server={s} />
                      </Link>
                    </TableCell>
                    <TableCell className="hidden max-w-48 truncate sm:table-cell">{joinAddress(s) ?? <span className="text-muted-foreground">{t("servers.noDomain")}</span>}</TableCell>
                    <TableCell className="hidden max-w-48 md:table-cell">
                      <ServerPayer server={s} />
                    </TableCell>
                    {admin && (
                      <TableCell className="hidden xl:table-cell">
                        <ServerIp server={s} />
                      </TableCell>
                    )}
                    <TableCell className="hidden lg:table-cell">
                      <ServerRuntime server={s} />
                    </TableCell>
                    <TableCell className="tabular text-right">{number(s.questions)}</TableCell>
                    <TableCell className="whitespace-nowrap" title={dateTime(s.last_seen)}>
                      {relative(s.last_seen)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableFrame>
        ))}
    </>
  );
};

export const ServerPage = () => {
  const { t } = useTranslation();
  const can = useCan();
  const { tenant, id } = useParams({ from: "/app/servers/$tenant/$id" });
  const query = useQuery({
    queryKey: ["server", tenant, id],
    queryFn: () => api<ServerDetail>(`/servers/${encodeURIComponent(tenant)}/${encodeURIComponent(id)}`),
  });
  const data = query.data;
  const server = data?.server;
  return (
    <>
      <PageHeader
        title={server ? (server.name ?? t("servers.unnamed")) : t("servers.server")}
        after={server ? joinAddress(server) : undefined}
        description={server && !server.name ? <span className="font-mono text-xs break-all">{server.server_id ?? t("servers.noId")}</span> : undefined}
        actions={
          server && (
            <Button asChild variant="outline" size="sm">
              <Link to="/runs" search={{ server: server.server }}>
                {t("servers.allRuns")}
              </Link>
            </Button>
          )
        }
      />
      {query.isPending && <Loading />}
      {query.error && <ErrorBox error={query.error} />}
      {data && server && (
        <div className="flex flex-col gap-6">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatTile label={t("servers.columns.questions")} value={number(server.questions)} />
            <StatTile label={t("servers.columns.players")} value={number(server.players)} />
            <StatTile label={t("servers.columns.cost")} value={usd(server.cost)} hint={server.questions ? t("dashboard.perQuestion", { cost: usd(server.cost / server.questions) }) : undefined} />
            <StatTile label={t("servers.columns.lastUsed")} value={relative(server.last_seen)} hint={dateTime(server.last_seen)} />
          </div>
          <Card className="gap-4">
            <CardHeader>
              <CardTitle className="text-base">{t("servers.details")}</CardTitle>
            </CardHeader>
            <CardContent>
              <Definition
                columns={3}
                items={[
                  [t("servers.columns.domain"), joinAddress(server) ?? t("servers.noDomain")],
                  [t("servers.columns.license"), <ServerPayer key="l" server={server} />],
                  [t("servers.columns.runtime"), <ServerRuntime key="r" server={server} />],
                  can("admin") && [t("servers.columns.ip"), <ServerIp key="ip" server={server} />],
                  [t("servers.registered"), server.first_seen ? dateTime(server.first_seen) : t("servers.neverRegistered")],
                  [t("servers.firstQuestion"), server.first_asked ? dateTime(server.first_asked) : t("servers.noQuestions")],
                  [t("servers.motd"), server.motd],
                  [t("servers.id"), server.server_id && <span className="font-mono text-xs">{server.server_id}</span>],
                ]}
              />
            </CardContent>
          </Card>
          <Card className="gap-3">
            <CardHeader>
              <CardTitle className="text-base">{t("servers.players", { count: data.players.length })}</CardTitle>
              <CardDescription>{t("servers.playersHint")}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col divide-y">
              {data.players.length === 0 && <span className="text-sm text-muted-foreground">{t("servers.noPlayers")}</span>}
              {data.players.map((p) => (
                <div key={p.user_id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                  <span className="flex min-w-0 items-center gap-2">
                    <PlayerHead id={p.user_id} size={24} known={!!p.player} />
                    <PlayerLink id={p.user_id} player={p.player} />
                  </span>
                  <span className="tabular text-muted-foreground">{t("servers.playerLine", { questions: number(p.questions), cost: usd(p.cost), seen: relative(p.last_seen) })}</span>
                </div>
              ))}
            </CardContent>
          </Card>
          <section className="flex flex-col gap-3">
            <h2 className="text-lg font-semibold">{t("servers.runs")}</h2>
            <RunsTable runs={data.runs} showServer={false} />
          </section>
        </div>
      )}
    </>
  );
};
