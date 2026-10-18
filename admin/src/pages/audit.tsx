import { useInfiniteQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Empty, ErrorBox, Loading, PageHeader } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { api } from "@/lib/api";
import { dateTime } from "@/lib/format";
import type { AuditEntry } from "@/lib/types";

const PAGE = 100;

export const AuditPage = () => {
  const { t } = useTranslation();
  const query = useInfiniteQuery({
    queryKey: ["audit"],
    initialPageParam: "",
    queryFn: ({ pageParam }) => api<{ entries: AuditEntry[] }>(`/audit${pageParam ? `?before=${encodeURIComponent(pageParam)}` : ""}`),
    getNextPageParam: (last) => (last.entries.length === PAGE ? last.entries.at(-1)!.at : undefined),
  });
  const entries = query.data?.pages.flatMap((p) => p.entries) ?? [];
  return (
    <>
      <PageHeader title={t("audit.title")} description={t("audit.description")} />
      {query.isPending && <Loading />}
      {query.error && <ErrorBox error={query.error} />}
      {query.data &&
        (entries.length === 0 ? (
          <Empty>{t("audit.none")}</Empty>
        ) : (
          <Card className="py-2">
            <CardContent className="flex flex-col divide-y px-4">
              {entries.map((entry, i) => (
                <div key={`${entry.at}-${i}`} className="flex flex-col gap-1.5 py-3">
                  <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
                    <span className="font-medium">{entry.actor}</span>
                    <span>{t(`audit.actions.${entry.action}`, { defaultValue: entry.action })}</span>
                    {entry.target && <span className="font-mono text-xs break-all">{entry.target}</span>}
                    <span className="ml-auto text-xs text-muted-foreground">
                      {dateTime(entry.at)}
                      {entry.ip && ` · ${entry.ip}`}
                    </span>
                  </div>
                  {entry.changes && entry.changes.length > 0 && (
                    <ul className="flex flex-col gap-0.5 text-xs">
                      {entry.changes.map((change) => (
                        <li key={change.field} className="flex flex-wrap gap-x-2">
                          <span className="font-mono">{change.field}</span>
                          <span className="text-muted-foreground line-through">{change.old || "—"}</span>
                          <span aria-hidden>→</span>
                          <span className="break-all">{change.new}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>
        ))}
      {query.hasNextPage && (
        <div className="mt-4 flex justify-center">
          <Button variant="outline" onClick={() => query.fetchNextPage()} disabled={query.isFetchingNextPage}>
            {t("common.more")}
          </Button>
        </div>
      )}
    </>
  );
};
