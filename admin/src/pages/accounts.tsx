import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff, Plus, Wand2 } from "lucide-react";
import { useState } from "react";
import { Controller, type UseFormRegisterReturn, useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { z } from "zod";
import { Confirm, ErrorBox, Loading, PageHeader, TableFrame } from "@/components/common";
import { FormField } from "@/components/form-field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, post } from "@/lib/api";
import { dateTime, relative } from "@/lib/format";
import { showErrors } from "@/lib/forms";
import { useAppState } from "@/lib/session";
import type { Account, Role } from "@/lib/types";
import { cn } from "@/lib/utils";

const ROLES: Role[] = ["owner", "admin", "viewer"];

// No look-alikes (0 O 1 l I), so a password read out or copied by hand comes through.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_";

/** 20 characters from the browser's cryptographic random source, about 117 bits; rejection keeps every character equally likely. */
const generatePassword = () => {
  const out: string[] = [];
  const limit = 256 - (256 % ALPHABET.length);
  while (out.length < 20) {
    for (const byte of crypto.getRandomValues(new Uint8Array(32))) if (byte < limit && out.length < 20) out.push(ALPHABET[byte % ALPHABET.length]);
  }
  return out.join("");
};

/** A new password's field: type one, or generate one, which shows it and copies it to give to the person. */
const PasswordInput = ({ id, field, onGenerate }: { id: string; field: UseFormRegisterReturn; onGenerate: (password: string) => void }) => {
  const { t } = useTranslation();
  const [shown, setShown] = useState(false);
  const generate = async () => {
    const password = generatePassword();
    onGenerate(password);
    setShown(true);
    try {
      await navigator.clipboard.writeText(password);
      toast.success(t("accounts.generatedCopied"));
    } catch {
      toast.success(t("accounts.generated"));
    }
  };
  return (
    <div className="flex gap-2">
      <div className="relative min-w-0 flex-1">
        <Input id={id} type={shown ? "text" : "password"} autoComplete="new-password" spellCheck={false} className={cn("pr-9", shown && "font-mono")} {...field} />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="absolute top-1/2 right-0.5 size-8 -translate-y-1/2"
          onClick={() => setShown(!shown)}
          aria-label={shown ? t("accounts.hide") : t("accounts.show")}
          aria-pressed={shown}
        >
          {shown ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
        </Button>
      </div>
      <Button type="button" variant="outline" onClick={generate}>
        <Wand2 className="size-4" aria-hidden />
        {t("accounts.generate")}
      </Button>
    </div>
  );
};

const RoleSelect = ({ value, onChange, id }: { value: Role; onChange: (role: Role) => void; id?: string }) => {
  const { t } = useTranslation();
  return (
    <Select value={value} onValueChange={(v) => onChange(v as Role)}>
      <SelectTrigger id={id} className="w-full sm:w-40">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {ROLES.map((role) => (
          <SelectItem key={role} value={role}>
            {t(`roles.${role}`)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};

const createSchema = z.object({
  username: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9_.-]{1,31}$/, "setup.errors.username"),
  password: z.string().min(10, "setup.errors.password").max(200),
  role: z.enum(["owner", "admin", "viewer"]),
});

const CreateDialog = ({ onDone }: { onDone: () => Promise<void> }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const form = useForm<z.infer<typeof createSchema>>({ resolver: zodResolver(createSchema), defaultValues: { username: "", password: "", role: "viewer" } });
  const { errors, isSubmitting } = form.formState;
  const submit = form.handleSubmit(async (values) => {
    try {
      await post("/accounts", values);
      toast.success(t("accounts.created", { name: values.username }));
      setOpen(false);
      form.reset();
      await onDone();
    } catch (error) {
      showErrors(error, form.setError);
    }
  });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="size-4" aria-hidden />
          {t("accounts.add")}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>{t("accounts.addTitle")}</DialogTitle>
            <DialogDescription>{t("accounts.addText")}</DialogDescription>
          </DialogHeader>
          <FormField id="new-username" label={t("setup.username")} error={errors.username && t(errors.username.message!)} hint={t("setup.usernameHint")}>
            <Input id="new-username" autoComplete="off" autoCapitalize="none" spellCheck={false} {...form.register("username")} />
          </FormField>
          <FormField id="new-password" label={t("accounts.password")} error={errors.password && t(errors.password.message!)} hint={t("accounts.passwordHint")}>
            <PasswordInput id="new-password" field={form.register("password")} onGenerate={(password) => form.setValue("password", password, { shouldValidate: true, shouldDirty: true })} />
          </FormField>
          <FormField id="new-role" label={t("accounts.role")} hint={t("accounts.rolesHint")}>
            <Controller control={form.control} name="role" render={({ field }) => <RoleSelect id="new-role" value={field.value} onChange={field.onChange} />} />
          </FormField>
          <DialogFooter>
            <Button type="submit" disabled={isSubmitting}>
              {t("accounts.add")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

const PasswordDialog = ({ account, onDone }: { account: Account; onDone: () => Promise<void> }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const form = useForm<{ password: string }>({ resolver: zodResolver(z.object({ password: z.string().min(10, "setup.errors.password").max(200) })), defaultValues: { password: "" } });
  const { errors, isSubmitting } = form.formState;
  const submit = form.handleSubmit(async ({ password }) => {
    try {
      await api(`/accounts/${encodeURIComponent(account.username)}`, { method: "PATCH", body: { password } });
      toast.success(t("accounts.passwordReset", { name: account.username }));
      setOpen(false);
      form.reset();
      await onDone();
    } catch (error) {
      showErrors(error, form.setError);
    }
  });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          {t("accounts.resetPassword")}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>{t("accounts.resetTitle", { name: account.username })}</DialogTitle>
            <DialogDescription>{t("accounts.resetText")}</DialogDescription>
          </DialogHeader>
          <FormField id="reset-password" label={t("accounts.password")} error={errors.password && t(errors.password.message!)}>
            <PasswordInput id="reset-password" field={form.register("password")} onGenerate={(password) => form.setValue("password", password, { shouldValidate: true, shouldDirty: true })} />
          </FormField>
          <DialogFooter>
            <Button type="submit" disabled={isSubmitting}>
              {t("accounts.resetPassword")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export const AccountsPage = () => {
  const { t } = useTranslation();
  const state = useAppState();
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["accounts"], queryFn: () => api<{ accounts: Account[] }>("/accounts") });
  const refresh = () => client.invalidateQueries({ queryKey: ["accounts"] });
  const setRole = async (account: Account, role: Role) => {
    try {
      await api(`/accounts/${encodeURIComponent(account.username)}`, { method: "PATCH", body: { role } });
      toast.success(t("accounts.roleChanged", { name: account.username, role: t(`roles.${role}`) }));
      await refresh();
      if (account.username === state?.me?.username) await client.invalidateQueries({ queryKey: ["state"] });
    } catch (error) {
      showErrors(error);
    }
  };
  const remove = async (account: Account) => {
    try {
      await api(`/accounts/${encodeURIComponent(account.username)}`, { method: "DELETE" });
      toast.success(t("accounts.deleted", { name: account.username }));
      await refresh();
    } catch (error) {
      showErrors(error);
    }
  };
  return (
    <>
      <PageHeader title={t("accounts.title")} description={t("accounts.description")} actions={<CreateDialog onDone={refresh} />} />
      {query.isPending && <Loading />}
      {query.error && <ErrorBox error={query.error} />}
      {query.data && (
        <TableFrame>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("accounts.columns.name")}</TableHead>
                <TableHead>{t("accounts.columns.role")}</TableHead>
                <TableHead className="hidden md:table-cell">{t("accounts.columns.lastLogin")}</TableHead>
                <TableHead className="text-right">{t("accounts.columns.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {query.data.accounts.map((account) => (
                <TableRow key={account.username}>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{account.username}</span>
                      {account.env && <Badge variant="secondary">{t("accounts.fromEnv")}</Badge>}
                      {account.username === state?.me?.username && <Badge variant="outline">{t("accounts.you")}</Badge>}
                    </div>
                    {account.created_by && <span className="text-xs text-muted-foreground">{t("accounts.createdBy", { name: account.created_by, date: dateTime(account.created_at) })}</span>}
                  </TableCell>
                  <TableCell>{account.env ? t(`roles.${account.role}`) : <RoleSelect value={account.role} onChange={(role) => setRole(account, role)} />}</TableCell>
                  <TableCell className="hidden md:table-cell">{account.last_login_at ? relative(account.last_login_at) : "—"}</TableCell>
                  <TableCell className="text-right">
                    {!account.env && (
                      <div className="flex justify-end gap-2">
                        <PasswordDialog account={account} onDone={refresh} />
                        <Confirm
                          label={t("accounts.delete")}
                          title={t("accounts.deleteTitle", { name: account.username })}
                          text={t("accounts.deleteText")}
                          action={t("accounts.delete")}
                          destructive
                          variant="outline"
                          onConfirm={() => remove(account)}
                        />
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableFrame>
      )}
    </>
  );
};
