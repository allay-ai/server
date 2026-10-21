import { Link } from "@tanstack/react-router";
import { AlertTriangle, CheckCircle2, CircleSlash, XCircle } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { API_BASE, ApiError } from "@/lib/api";
import { compact, dateTime, duration, relative, usd } from "@/lib/format";
import type { Run, Who } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * One line that doesn't fit glides to its end and back, like a news ticker, with a pause at each end; a line that fits
 * stands still. Readers who asked for less motion get it cut, with the whole text on hover.
 */
export const Marquee = ({ children, title, className }: { children: ReactNode; title?: string; className?: string }) => {
  const box = useRef<HTMLSpanElement>(null);
  const line = useRef<HTMLSpanElement>(null);
  const [shift, setShift] = useState(0);
  useLayoutEffect(() => {
    const measure = () => setShift(box.current && line.current ? Math.max(0, line.current.scrollWidth - box.current.clientWidth) : 0);
    measure();
    const observer = new ResizeObserver(measure);
    if (box.current) observer.observe(box.current);
    if (line.current) observer.observe(line.current);
    return () => observer.disconnect();
  }, []);
  // About 40 px a second, so a long name reads at the same pace as a short one.
  const style = { "--marquee-shift": `-${shift}px`, "--marquee-duration": `${Math.max(4, shift / 40) * 2 + 3}s` } as CSSProperties;
  return (
    <span ref={box} title={shift > 0 ? title : undefined} className={cn("block overflow-hidden whitespace-nowrap", shift > 0 && "marquee-fade", className)}>
      <span ref={line} className={cn("inline-block", shift > 0 && "marquee pr-3")} style={style}>
        {children}
      </span>
    </span>
  );
};

export const PageHeader = ({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) => (
  <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
    <div className="min-w-0 flex-1">
      <h1 className="text-2xl font-semibold tracking-tight">
        <Marquee title={title}>{title}</Marquee>
      </h1>
      {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
    </div>
    {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
  </div>
);

export const StatTile = ({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) => (
  <Card className="gap-0 py-4">
    <CardContent className="flex flex-col gap-1 px-4">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <span className="tabular text-2xl font-semibold tracking-tight">{value}</span>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </CardContent>
  </Card>
);

export const Loading = ({ rows = 4 }: { rows?: number }) => (
  <div className="flex flex-col gap-2" aria-busy>
    {Array.from({ length: rows }, (_, i) => (
      <Skeleton key={i} className="h-10 w-full" />
    ))}
  </div>
);

export const ErrorBox = ({ error }: { error: unknown }) => {
  const { t } = useTranslation();
  const message = error instanceof ApiError ? error.message : t("errors.network");
  return (
    <div role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
      <span>{message}</span>
    </div>
  );
};

export const Empty = ({ children }: { children: ReactNode }) => <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">{children}</div>;

export const Pager = ({ page, total, limit, onPage }: { page: number; total: number; limit: number; onPage: (page: number) => void }) => {
  const { t } = useTranslation();
  const pages = Math.max(1, Math.ceil(total / limit));
  if (pages <= 1) return null;
  return (
    <div className="mt-4 flex items-center justify-between gap-2 text-sm">
      <span className="text-muted-foreground">{t("common.page", { page: page + 1, pages })}</span>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" disabled={page === 0} onClick={() => onPage(page - 1)}>
          {t("common.previous")}
        </Button>
        <Button variant="outline" size="sm" disabled={page + 1 >= pages} onClick={() => onPage(page + 1)}>
          {t("common.next")}
        </Button>
      </div>
    </div>
  );
};

/** A button that asks first; for anything that deletes, refunds, or blocks. */
/**
 * A player's face from their skin, which the backend fetches and caches; Steve's when the panel doesn't know who they
 * are: players from before 6.4, those with full privacy on, and faces the skin service didn't give.
 */
export const PlayerHead = ({ id, size = 24, className, known = true }: { id: string; size?: number; className?: string; known?: boolean }) => {
  const [failed, setFailed] = useState(false);
  const style = { width: size, height: size };
  // Without a name the backend has no skin to look up, so Steve saves a request that would fail.
  const own = !failed && known && id.startsWith("p_");
  return (
    <img
      src={own ? `${API_BASE}/players/${encodeURIComponent(id)}/head` : "./steve.png"}
      alt=""
      loading="lazy"
      className={cn("shrink-0 rounded-sm bg-muted [image-rendering:pixelated]", className)}
      style={style}
      onError={() => setFailed(true)}
    />
  );
};

/** A player as the panel knows them: their name when the directory has it, their pseudonym otherwise, or nobody once erased. */
export const PlayerLink = ({ id, player, head = false }: { id: string; player?: Who; head?: boolean }) => {
  const { t } = useTranslation();
  if (id === "erased") return <span className="text-muted-foreground">{t("player.erased")}</span>;
  return (
    <Link to="/players/$id" params={{ id }} className="inline-flex max-w-full min-w-0 items-center gap-2 hover:underline" title={player ? `${player.name} · ${id}` : id}>
      {head && <PlayerHead id={id} size={20} known={!!player} />}
      {player ? <span className="truncate font-medium">{player.name}</span> : <span className="truncate font-mono text-xs">{id}</span>}
    </Link>
  );
};

export const Confirm = ({
  label,
  title,
  text,
  action,
  onConfirm,
  destructive,
  disabled,
  size = "sm",
  variant,
}: {
  label: ReactNode;
  title: string;
  text: ReactNode;
  action: string;
  onConfirm: () => Promise<unknown>;
  destructive?: boolean;
  disabled?: boolean;
  size?: "sm" | "default";
  variant?: "outline" | "destructive" | "secondary";
}) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button size={size} variant={variant ?? (destructive ? "destructive" : "outline")} disabled={disabled}>
          {label}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{text}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            className={cn(destructive && "bg-destructive text-white hover:bg-destructive/90")}
            onClick={async (event) => {
              event.preventDefault();
              setBusy(true);
              try {
                await onConfirm();
                setOpen(false);
              } finally {
                setBusy(false);
              }
            }}
          >
            {action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

/** How a run ended: an icon and a word, never color alone. */
export const ResultBadge = ({ result, code }: { result: Run["result"]; code?: string }) => {
  const { t } = useTranslation();
  if (result === "ok")
    return (
      <Badge variant="outline" className="gap-1 border-success/40 text-foreground">
        <CheckCircle2 className="size-3 text-success" aria-hidden />
        {t("runs.results.ok")}
      </Badge>
    );
  if (result === "cancelled")
    return (
      <Badge variant="outline" className="gap-1">
        <CircleSlash className="size-3 text-muted-foreground" aria-hidden />
        {t("runs.results.cancelled")}
      </Badge>
    );
  return (
    <Badge variant="outline" className="gap-1 border-destructive/40 text-foreground" title={code}>
      <XCircle className="size-3 text-destructive" aria-hidden />
      {code ?? t("runs.results.error")}
    </Badge>
  );
};

/** Tables scroll sideways inside their card on a phone, never the page. */
export const TableFrame = ({ children }: { children: ReactNode }) => <div className="overflow-hidden rounded-lg border bg-card">{children}</div>;

export const RunsTable = ({ runs, showPlayer = true }: { runs: Run[]; showPlayer?: boolean }) => {
  const { t } = useTranslation();
  if (!runs.length) return <Empty>{t("runs.none")}</Empty>;
  return (
    <TableFrame>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("runs.columns.when")}</TableHead>
            <TableHead>{t("runs.columns.kind")}</TableHead>
            {showPlayer && <TableHead>{t("runs.columns.player")}</TableHead>}
            <TableHead className="hidden md:table-cell">{t("runs.columns.model")}</TableHead>
            <TableHead className="hidden text-right lg:table-cell">{t("runs.columns.tokens")}</TableHead>
            <TableHead className="hidden text-right lg:table-cell">{t("runs.columns.tools")}</TableHead>
            <TableHead className="text-right">{t("runs.columns.duration")}</TableHead>
            <TableHead className="hidden text-right sm:table-cell">{t("runs.columns.cost")}</TableHead>
            <TableHead>{t("runs.columns.result")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {runs.map((run) => (
            <TableRow key={run.id}>
              <TableCell className="whitespace-nowrap">
                <Link to="/runs/$id" params={{ id: run.id }} className="font-medium hover:underline" title={dateTime(run.at)}>
                  {relative(run.at)}
                </Link>
              </TableCell>
              <TableCell>{t(`runs.kinds.${run.kind}`)}</TableCell>
              {showPlayer && (
                <TableCell className="max-w-48">
                  <PlayerLink id={run.user_id} player={run.player} head />
                </TableCell>
              )}
              <TableCell className="hidden max-w-56 truncate font-mono text-xs md:table-cell">{run.model}</TableCell>
              <TableCell className="tabular hidden text-right whitespace-nowrap lg:table-cell" title={`${run.input_tokens} / ${run.output_tokens}`}>
                {compact(run.input_tokens)} / {compact(run.output_tokens)}
              </TableCell>
              <TableCell className="tabular hidden text-right lg:table-cell">
                {run.tools.length}
                {run.tools.some((tool) => !tool.ok) && <span className="ml-1 text-destructive">({run.tools.filter((tool) => !tool.ok).length})</span>}
              </TableCell>
              <TableCell className="tabular text-right whitespace-nowrap">{duration(run.duration_ms)}</TableCell>
              <TableCell className="tabular hidden text-right sm:table-cell">{usd(run.cost)}</TableCell>
              <TableCell>
                <ResultBadge result={run.result} code={run.error_code} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableFrame>
  );
};

export const Definition = ({ items }: { items: Array<[string, ReactNode]> }) => (
  <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
    {items.map(([label, value]) => (
      <div key={label} className="flex min-w-0 flex-col gap-0.5">
        <dt className="text-xs text-muted-foreground">{label}</dt>
        <dd className="tabular truncate font-medium">{value}</dd>
      </div>
    ))}
  </dl>
);

