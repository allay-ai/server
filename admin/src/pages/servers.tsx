import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Empty, ErrorBox, Loading, PageHeader, TableFrame } from "@/components/common";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { dateTime, number, relative, usd } from "@/lib/format";
import type { ServerSummary } from "@/lib/types";
import { ServerLabel } from "./runs";

export const ServersPage = () => {
  const { t } = useTranslation();
  const query = useQuery({ queryKey: ["servers"], queryFn: () => api<{ servers: ServerSummary[] }>("/servers?limit=500") });
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
                  <TableHead className="text-right">{t("servers.columns.questions")}</TableHead>
                  <TableHead className="text-right">{t("servers.columns.players")}</TableHead>
                  <TableHead className="hidden text-right sm:table-cell">{t("servers.columns.cost")}</TableHead>
                  <TableHead>{t("servers.columns.lastSeen")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {query.data.servers.map((s) => (
                  <TableRow key={`${s.server}/${s.server_id ?? ""}`}>
                    <TableCell className="max-w-56">
                      <ServerLabel server={s.server} serverId={s.server_id} />
                    </TableCell>
                    <TableCell className="tabular text-right">
                      <Link to="/runs" search={{ server: s.server }} className="hover:underline">
                        {number(s.questions)}
                      </Link>
                    </TableCell>
                    <TableCell className="tabular text-right">{number(s.players)}</TableCell>
                    <TableCell className="tabular hidden text-right sm:table-cell">{usd(s.cost)}</TableCell>
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
