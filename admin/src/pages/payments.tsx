import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Confirm, Empty, ErrorBox, LicenseButton, Loading, PageHeader, TableFrame } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, post } from "@/lib/api";
import { dateTime, number, relative } from "@/lib/format";
import { showErrors } from "@/lib/forms";
import { useCan } from "@/lib/session";
import type { Payment } from "@/lib/types";

const PAGE = 100;

export const PaymentsTable = ({ payments, showLicense = true }: { payments: Payment[]; showLicense?: boolean }) => {
  const { t } = useTranslation();
  const can = useCan();
  const client = useQueryClient();
  const refund = async (payment: Payment) => {
    try {
      await post(`/payments/${encodeURIComponent(payment.charge_id)}/refund`);
      toast.success(t("payments.refunded", { stars: number(payment.stars) }));
      await client.invalidateQueries();
    } catch (error) {
      showErrors(error);
    }
  };
  if (!payments.length) return <Empty>{t("payments.none")}</Empty>;
  return (
    <TableFrame>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("payments.columns.when")}</TableHead>
            {showLicense && <TableHead>{t("payments.columns.license")}</TableHead>}
            <TableHead>{t("payments.columns.plan")}</TableHead>
            <TableHead className="text-right">{t("payments.columns.stars")}</TableHead>
            <TableHead>{t("payments.columns.state")}</TableHead>
            {can("admin") && <TableHead className="text-right">{t("payments.columns.actions")}</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {payments.map((p) => (
            <TableRow key={p.charge_id}>
              <TableCell className="whitespace-nowrap" title={dateTime(p.at)}>
                {relative(p.at)}
              </TableCell>
              {showLicense && (
                <TableCell>
                  <LicenseButton id={p.license} />
                </TableCell>
              )}
              <TableCell>
                {t(`plans.${p.plan}`, { defaultValue: p.plan })}
                {p.recurring && <span className="ml-1 text-xs text-muted-foreground">{t("payments.recurring")}</span>}
              </TableCell>
              <TableCell className="tabular text-right">{number(p.stars)}</TableCell>
              <TableCell>{p.refunded_at ? <Badge variant="outline">{t("payments.refundedOn", { date: dateTime(p.refunded_at) })}</Badge> : <Badge variant="secondary">{t("payments.paid")}</Badge>}</TableCell>
              {can("admin") && (
                <TableCell className="text-right">
                  {!p.refunded_at && (
                    <Confirm
                      label={t("payments.refund")}
                      title={t("payments.refundTitle")}
                      text={t("payments.refundText", { stars: number(p.stars) })}
                      action={t("payments.refund")}
                      destructive
                      variant="outline"
                      onConfirm={() => refund(p)}
                    />
                  )}
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableFrame>
  );
};

export const PaymentsPage = () => {
  const { t } = useTranslation();
  const query = useInfiniteQuery({
    queryKey: ["payments"],
    initialPageParam: "",
    queryFn: ({ pageParam }) => api<{ payments: Payment[] }>(`/payments?limit=${PAGE}${pageParam ? `&before=${encodeURIComponent(pageParam)}` : ""}`),
    getNextPageParam: (last) => (last.payments.length === PAGE ? last.payments.at(-1)!.at : undefined),
  });
  return (
    <>
      <PageHeader title={t("payments.title")} description={t("payments.description")} />
      {query.isPending && <Loading />}
      {query.error && <ErrorBox error={query.error} />}
      {query.data && (
        <>
          <PaymentsTable payments={query.data.pages.flatMap((p) => p.payments)} />
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
