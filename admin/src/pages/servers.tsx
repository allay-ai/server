import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Empty, ErrorBox, Loading, Marquee, PageHeader, TableFrame } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { dateTime, number, relative, usd } from "@/lib/format";
import { useCan } from "@/lib/session";
import type { ServerSummary } from "@/lib/types";
import { ServerLabel } from "./runs";

/** Where players join: the address the plugin's config names, with the game port when it isn't the default. */
export const joinAddress = (s: ServerSummary) => (s.address ? (s.port && s.port !== 25565 ? `${s.address}:${s.port}` : s.address) : null);

/** The address a server connects from, marked when it's a private network the backend shares. */
export const ServerIp = ({ server }: { server: ServerSummary }) => {
  const { t } = useTranslation();
  if (!server.ip) return <span className="text-muted-foreground">—</span>;
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

/** What the server runs: the game's software and version, and the plugin's version. */
export const ServerRuns = ({ server }: { server: ServerSummary }) => {
  const { t } = useTranslation();
  if (!server.software && !server.plugin_version) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="flex flex-col">
      {server.software && <span>{[server.software, server.version].filter(Boolean).join(" ")}</span>}
      {server.plugin_version && <span className="text-xs text-muted-foreground">{t("servers.plugin", { version: server.plugin_version })}</span>}
    </span>
  );
};

/**
 * A server as the panel heads it: the name its owner gave it, or its random id, then where players join (or where it
 * connects from) past a middle dot, and its MOTD a line below in smaller type.
 */
export const ServerTitle = ({ server }: { server: ServerSummary }) => {
  const where = joinAddress(server) ?? (server.internal ? null : server.ip);
  return (
    <span className="flex min-w-0 flex-col">
      <span className="flex min-w-0 items-baseline gap-1.5">
        {server.name ? (
          <Marquee title={server.name} className="min-w-0 font-medium">
            {server.name}
          </Marquee>
        ) : (
          <span className="truncate font-mono text-xs">{server.server_id ?? "—"}</span>
        )}
        {where && <span className="shrink-0 text-xs text-muted-foreground">· {where}</span>}
      </span>
      {server.motd && (
        <Marquee title={server.motd} className="text-xs text-muted-foreground">
          {server.motd}
        </Marquee>
      )}
    </span>
  );
};

export const ServersPage = () => {
  const { t } = useTranslation();
  const can = useCan();
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
                  <TableHead>{t("servers.columns.server")}</TableHead>
                  {admin && <TableHead className="hidden lg:table-cell">{t("servers.columns.ip")}</TableHead>}
                  <TableHead className="hidden lg:table-cell">{t("servers.columns.runs")}</TableHead>
                  <TableHead className="text-right">{t("servers.columns.questions")}</TableHead>
                  <TableHead className="hidden text-right sm:table-cell">{t("servers.columns.players")}</TableHead>
                  <TableHead className="hidden text-right sm:table-cell">{t("servers.columns.cost")}</TableHead>
                  <TableHead>{t("servers.columns.lastSeen")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {query.data.servers.map((s) => (
                  <TableRow key={`${s.server}/${s.server_id ?? ""}`}>
                    <TableCell className="max-w-64">
                      <ServerTitle server={s} />
                      <span className="text-xs text-muted-foreground">
                        <ServerLabel server={s.server} />
                      </span>
                    </TableCell>
                    {admin && (
                      <TableCell className="hidden lg:table-cell">
                        <ServerIp server={s} />
                      </TableCell>
                    )}
                    <TableCell className="hidden lg:table-cell">
                      <ServerRuns server={s} />
                    </TableCell>
                    <TableCell className="tabular text-right">
                      <Link to="/runs" search={{ server: s.server }} className="hover:underline">
                        {number(s.questions)}
                      </Link>
                    </TableCell>
                    <TableCell className="tabular hidden text-right sm:table-cell">{number(s.players)}</TableCell>
                    <TableCell className="tabular hidden text-right sm:table-cell">{usd(s.cost)}</TableCell>
                    <TableCell className="whitespace-nowrap" title={s.first_seen ? t("servers.firstSeen", { date: dateTime(s.first_seen) }) : dateTime(s.last_seen)}>
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
