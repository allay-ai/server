import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CreditCard, Eye, KeyRound, LogIn, Settings, UserCog, Users } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Empty, ErrorBox, Loading, PageHeader } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import { dateTime, relative } from "@/lib/format";
import type { AuditEntry } from "@/lib/types";
import { cn } from "@/lib/utils";

const PAGE = 100;

/** The parts of the panel an action belongs to, by the start of its name; sign-ins and setup have no dot. */
const AREAS = ["account", "settings", "player", "license", "payment", "run"] as const;

const ICONS: Record<string, typeof Users> = { account: UserCog, settings: Settings, player: Users, license: KeyRound, payment: CreditCard, run: Eye };

const areaOf = (action: string) => (action.includes(".") ? action.slice(0, action.indexOf(".")) : "sign");

/** What an entry was done to, as a link where the panel has a page for it. */
const Target = ({ entry }: { entry: AuditEntry }) => {
  if (!entry.target) return null;
  const area = areaOf(entry.action);
  const parts = entry.target.split(" ");
  const mono = "font-mono text-xs break-all";
  if (area === "license") {
    return (
      <Link to="/licenses/$id" params={{ id: entry.target }} className={cn(mono, "hover:underline")}>
        {entry.target}
      </Link>
    );
  }
  // Players are “<tenant> <pseudonym>”, a look at a run adds its id.
  if ((area === "player" || area === "run") && parts.length >= 2) {
    return (
      <span className="inline-flex flex-wrap items-baseline gap-x-1.5">
        <Link to="/players/$id" params={{ id: parts[1] }} className={cn(mono, "hover:underline")}>
          {parts[1]}
        </Link>
        {parts[2] && (
          <Link to="/runs/$id" params={{ id: parts[2] }} className={cn(mono, "text-muted-foreground hover:underline")}>
            {parts[2].slice(0, 8)}
          </Link>
        )}
      </span>
    );
  }
  return <span className={mono}>{entry.target}</span>;
};

/** One changed field: its name, what it was, struck out, and what it is now. */
const Change = ({ change }: { change: NonNullable<AuditEntry["changes"]>[number] }) => {
  const { t } = useTranslation();
  return (
    <li className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-md bg-muted/40 px-2 py-1 text-xs">
      <span className="font-mono font-medium">{change.field}</span>
      {change.old ? <span className="text-destructive/80 line-through break-all">{change.old}</span> : <span className="text-muted-foreground">{t("audit.nothing")}</span>}
      <span aria-hidden className="text-muted-foreground">
        →
      </span>
      {change.new ? <span className="break-all text-success">{change.new}</span> : <span className="text-muted-foreground">{t("audit.nothing")}</span>}
    </li>
  );
};

export const AuditPage = () => {
  const { t } = useTranslation();
  const [area, setArea] = useState("all");
  const [actor, setActor] = useState("all");
  const filters = new URLSearchParams({ ...(area !== "all" ? { area } : {}), ...(actor !== "all" ? { actor } : {}) });
  const query = useInfiniteQuery({
    queryKey: ["audit", area, actor],
    initialPageParam: "",
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams(filters);
      if (pageParam) params.set("before", pageParam);
      return api<{ entries: AuditEntry[] }>(`/audit${params.size ? `?${params}` : ""}`);
    },
    getNextPageParam: (last) => (last.entries.length === PAGE ? last.entries.at(-1)!.at : undefined),
  });
  const entries = query.data?.pages.flatMap((p) => p.entries) ?? [];
  // Who acted, from what's loaded; the picked one stays even when the filter leaves only them.
  const actors = [...new Set([...entries.map((e) => e.actor), ...(actor !== "all" ? [actor] : [])])].sort();
  return (
    <>
      <PageHeader
        title={t("audit.title")}
        description={t("audit.description")}
        actions={
          <>
            <Select value={area} onValueChange={setArea}>
              <SelectTrigger className="w-40" aria-label={t("audit.area")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("audit.allAreas")}</SelectItem>
                {AREAS.map((a) => (
                  <SelectItem key={a} value={a}>
                    {t(`audit.areas.${a}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={actor} onValueChange={setActor}>
              <SelectTrigger className="w-40" aria-label={t("audit.actor")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("audit.allActors")}</SelectItem>
                {actors.map((a) => (
                  <SelectItem key={a} value={a}>
                    {a}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        }
      />
      {query.isPending && <Loading />}
      {query.error && <ErrorBox error={query.error} />}
      {query.data &&
        (entries.length === 0 ? (
          <Empty>{t("audit.none")}</Empty>
        ) : (
          <Card className="py-2">
            <CardContent className="flex flex-col divide-y px-4">
              {entries.map((entry, i) => {
                const Icon = ICONS[areaOf(entry.action)] ?? LogIn;
                return (
                  <div key={`${entry.at}-${i}`} className="flex gap-3 py-3">
                    <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary" aria-hidden>
                      <Icon className="size-4" />
                    </span>
                    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                      <div className="flex flex-wrap items-baseline gap-x-1.5 text-sm">
                        <span className="font-semibold">{entry.actor}</span>
                        <span>{t(`audit.actions.${entry.action}`, { defaultValue: entry.action })}</span>
                        <Target entry={entry} />
                        <span className="ml-auto text-xs whitespace-nowrap text-muted-foreground" title={dateTime(entry.at)}>
                          {relative(entry.at)}
                          {entry.ip && <span className="ml-1.5 font-mono">{entry.ip}</span>}
                        </span>
                      </div>
                      {entry.changes && entry.changes.length > 0 && (
                        <ul className="flex flex-col gap-1">
                          {entry.changes.map((change) => (
                            <Change key={change.field} change={change} />
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                );
              })}
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
