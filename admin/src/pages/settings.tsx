import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Download, FlaskConical, Lock, RotateCcw, TriangleAlert, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Controller, type UseFormReturn, useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { z } from "zod";
import { Confirm, ErrorBox, Loading, PageHeader } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, post } from "@/lib/api";
import { dateTime, number } from "@/lib/format";
import { showErrors } from "@/lib/forms";
import { useCan } from "@/lib/session";
import type { SettingField, SettingsView } from "@/lib/types";
import { cn } from "@/lib/utils";

type FormValues = Record<string, string | boolean>;

const GROUP_ORDER = ["model", "search", "limits", "sessions", "tracing", "billing", "telegram", "address", "access"];
/** Which check each group offers, and the fields it reads from the form. */
const CHECKS: Record<string, { kind: string; keys: string[] }> = {
  model: { kind: "model", keys: ["OPENROUTER_API_KEY", "OPENROUTER_API_URL", "OPENROUTER_API_MODEL"] },
  search: { kind: "perplexity", keys: ["PERPLEXITY_API_KEY"] },
  telegram: { kind: "bot", keys: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_API_URL", "TELEGRAM_TEST_ENV"] },
};

/** What the form holds for a field: text for inputs, a flag for switches, empty for a secret until it's replaced. */
const initial = (field: SettingField): string | boolean => {
  if (field.type === "bool") return Boolean(field.value);
  if (field.type === "secret") return "";
  return field.stored === null || field.stored === undefined ? "" : String(field.stored);
};

const isUrl = (text: string) => {
  try {
    const url = new URL(text);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
};

/** The same checks the backend makes, so most mistakes show before saving. */
const schemaFor = (field: SettingField) => {
  switch (field.type) {
    case "bool":
      return z.boolean();
    case "int":
    case "number":
      return z.string().refine((v) => {
        if (v.trim() === "") return true;
        const n = Number(v);
        return Number.isFinite(n) && (field.type === "number" || Number.isInteger(n)) && n >= field.min! && n <= field.max!;
      }, `settings.errors.${field.type === "int" ? "int" : "number"}`);
    case "url":
      return z.string().refine((v) => v.trim() === "" || isUrl(v.trim()), "settings.errors.url");
    case "string":
      return z
        .string()
        .max(field.max_length ?? 500, "settings.errors.long")
        .refine((v) => !field.pattern || v.trim() === "" || new RegExp(field.pattern).test(v), "settings.errors.pattern");
    default:
      return z.string().max(2000);
  }
};

const SourceBadge = ({ field }: { field: SettingField }) => {
  const { t } = useTranslation();
  if (field.source === "env")
    return (
      <Badge variant="secondary" className="gap-1">
        <Lock className="size-3" aria-hidden />
        {t("settings.source.env")}
      </Badge>
    );
  if (field.source === "stored") return <Badge variant="outline">{t("settings.source.stored")}</Badge>;
  return <Badge variant="outline" className="text-muted-foreground">{t("settings.source.default")}</Badge>;
};

const SecretControl = ({ field, form, cleared, setCleared, disabled }: { field: SettingField; form: UseFormReturn<FormValues>; cleared: boolean; setCleared: (v: boolean) => void; disabled: boolean }) => {
  const { t } = useTranslation();
  const [replacing, setReplacing] = useState(false);
  const secret = field.secret!;
  if (replacing && !disabled)
    return (
      <div className="flex gap-2">
        <Input id={field.key} type="password" autoComplete="off" spellCheck={false} placeholder={t("settings.secret.placeholder")} {...form.register(field.key)} autoFocus />
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            form.setValue(field.key, "", { shouldDirty: true });
            setReplacing(false);
          }}
        >
          {t("common.cancel")}
        </Button>
      </div>
    );
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className={cn("rounded-md border px-3 py-1.5 font-mono text-sm", cleared && "line-through opacity-60")}>
        {secret.broken ? t("settings.secret.broken") : secret.set ? t("settings.secret.set", { last4: secret.last4 || "…" }) : t("settings.secret.unset")}
      </span>
      {!disabled && (
        <>
          <Button type="button" variant="outline" size="sm" onClick={() => setReplacing(true)}>
            {secret.set ? t("settings.secret.replace") : t("settings.secret.add")}
          </Button>
          {field.source === "stored" && (
            <Button type="button" variant="ghost" size="sm" onClick={() => setCleared(!cleared)} aria-pressed={cleared}>
              {cleared ? t("settings.secret.keep") : t("settings.secret.clear")}
            </Button>
          )}
        </>
      )}
    </div>
  );
};

const FieldRow = ({
  field,
  form,
  editable,
  cleared,
  setCleared,
}: {
  field: SettingField;
  form: UseFormReturn<FormValues>;
  editable: boolean;
  cleared: boolean;
  setCleared: (v: boolean) => void;
}) => {
  const { t } = useTranslation();
  const locked = field.source === "env";
  const disabled = !editable || locked;
  const error = form.formState.errors[field.key]?.message as string | undefined;
  const placeholder = field.default === null || field.default === undefined ? t("settings.empty") : String(field.default);
  const label = t(`settings.fields.${field.key}`, { defaultValue: field.description });
  let control: React.ReactNode;
  if (field.type === "secret") {
    control = <SecretControl field={field} form={form} cleared={cleared} setCleared={setCleared} disabled={disabled} />;
  } else if (field.type === "bool") {
    control = (
      <Controller
        control={form.control}
        name={field.key}
        render={({ field: f }) => <Switch id={field.key} checked={Boolean(f.value)} onCheckedChange={f.onChange} disabled={disabled} />}
      />
    );
  } else if (field.type === "enum") {
    control = (
      <Controller
        control={form.control}
        name={field.key}
        render={({ field: f }) => (
          <Select value={String(f.value) || "__default"} onValueChange={(v) => f.onChange(v === "__default" ? "" : v)} disabled={disabled}>
            <SelectTrigger id={field.key} className="w-full sm:w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__default">{field.default ? t("settings.defaultOption", { value: field.default }) : t("settings.unsetOption")}</SelectItem>
              {field.options!.map((option) => (
                <SelectItem key={option} value={option}>
                  {option}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      />
    );
  } else {
    control = (
      <Input
        id={field.key}
        inputMode={field.type === "int" ? "numeric" : field.type === "number" ? "decimal" : undefined}
        spellCheck={false}
        placeholder={placeholder}
        disabled={disabled}
        aria-invalid={!!error}
        className={cn(field.type === "int" || field.type === "number" ? "w-full sm:w-48" : "w-full", locked && "font-mono")}
        {...(locked ? { value: String(field.value ?? "") , readOnly: true } : form.register(field.key))}
      />
    );
  }
  return (
    <div className="flex flex-col gap-2 border-b py-4 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={field.key} className="font-mono text-xs font-medium break-all">
          {field.key}
        </label>
        <SourceBadge field={field} />
        {field.restart && (
          <Badge variant="outline" className="gap-1 border-warning/50">
            <TriangleAlert className="size-3 text-warning" aria-hidden />
            {t("settings.restart")}
          </Badge>
        )}
      </div>
      <p className="text-sm text-muted-foreground">{label}</p>
      {control}
      {(field.type === "int" || field.type === "number") && !locked && (
        <p className="text-xs text-muted-foreground">{t("settings.range", { min: number(field.min!, 3), max: number(field.max!, 3), value: field.default })}</p>
      )}
      {locked && <p className="text-xs text-muted-foreground">{t("settings.lockedHint")}</p>}
      {error && <p className="text-xs text-destructive">{t(error, { defaultValue: error })}</p>}
      {editable && field.source === "stored" && field.type !== "secret" && field.type !== "bool" && (
        <div>
          <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => form.setValue(field.key, "", { shouldDirty: true })}>
            <RotateCcw className="size-3" aria-hidden />
            {t("settings.reset")}
          </Button>
        </div>
      )}
    </div>
  );
};

type CheckResult = { ok: true; detail: string; ms: number } | { ok: false; error: string; ms: number };

const CheckButton = ({ group, form }: { group: string; form: UseFormReturn<FormValues> }) => {
  const { t } = useTranslation();
  const check = CHECKS[group];
  const [result, setResult] = useState<CheckResult | null>(null);
  const run = useMutation({
    mutationFn: () => post<CheckResult>(`/settings/test/${check.kind}`, { values: Object.fromEntries(check.keys.map((k) => [k, form.getValues(k)])) }),
    onSuccess: setResult,
    onError: (error) => showErrors(error),
  });
  if (!check) return null;
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <Button type="button" variant="outline" size="sm" onClick={() => run.mutate()} disabled={run.isPending}>
        <FlaskConical className="size-4" aria-hidden />
        {run.isPending ? t("settings.checks.running") : t(`settings.checks.${check.kind}`)}
      </Button>
      {result && (
        <span className="flex items-start gap-1.5 text-sm" role="status">
          {result.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden /> : <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />}
          <span className="break-words">{result.ok ? t("settings.checks.ok", { detail: result.detail, ms: result.ms }) : result.error}</span>
        </span>
      )}
    </div>
  );
};

const EnvironmentCard = ({ view }: { view: SettingsView }) => {
  const { t } = useTranslation();
  const env = view.environment;
  const items: Array<[string, string]> = [
    [t("settings.environment.version"), env.version],
    [t("settings.environment.mode"), env.selfhosted ? t("settings.environment.selfhosted") : t("settings.environment.hosted")],
    [t("settings.environment.database"), env.mongodb_database ?? "—"],
    [t("settings.environment.secretsKey"), env.secrets_key === "env" ? "SECRETS_KEY" : "/data/secrets.key"],
    [t("settings.environment.envAdmin"), env.env_admin ? t("common.yes") : t("common.no")],
    [t("settings.environment.port"), String(env.port)],
  ];
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle className="text-base">{t("settings.environment.title")}</CardTitle>
        <CardDescription>{t("settings.environment.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
          {items.map(([label, value]) => (
            <div key={label} className="min-w-0">
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="font-medium break-words">{value}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
};

const SettingsForm = ({ view }: { view: SettingsView }) => {
  const { t } = useTranslation();
  const can = useCan();
  const editable = can("admin");
  const client = useQueryClient();
  const groups = useMemo(() => GROUP_ORDER.filter((g) => view.fields.some((f) => f.group === g)), [view]);
  const [group, setGroup] = useState(groups[0]);
  const [cleared, setCleared] = useState<Record<string, boolean>>({});
  const schema = useMemo(() => z.object(Object.fromEntries(view.fields.map((f) => [f.key, schemaFor(f)]))), [view]);
  const defaults = useMemo(() => Object.fromEntries(view.fields.map((f) => [f.key, initial(f)])), [view]);
  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: defaults });
  useEffect(() => {
    form.reset(defaults);
    setCleared({});
  }, [defaults, form]);

  const dirty = Object.keys(form.formState.dirtyFields).filter((key) => {
    const field = view.fields.find((f) => f.key === key);
    return field && field.source !== "env" && !(field.type === "secret" && !form.getValues(key));
  });
  const changes = [...dirty, ...Object.keys(cleared).filter((k) => cleared[k] && !dirty.includes(k))];

  const save = form.handleSubmit(async (values) => {
    const body: Record<string, unknown> = {};
    for (const key of changes) {
      const field = view.fields.find((f) => f.key === key)!;
      if (field.type === "secret") body[key] = cleared[key] ? null : String(values[key]);
      else if (field.type === "bool") body[key] = values[key];
      else if (values[key] === "") body[key] = null;
      else body[key] = field.type === "int" || field.type === "number" ? Number(values[key]) : String(values[key]).trim();
    }
    try {
      const result = await api<{ version: number; changed: string[] }>("/settings", { method: "PUT", body: { version: view.version, values: body } });
      toast.success(result.changed.length ? t("settings.saved", { count: result.changed.length }) : t("settings.nothing"));
      await client.invalidateQueries({ queryKey: ["settings"] });
    } catch (error) {
      showErrors(error, form.setError);
      const bad = view.fields.find((f) => Object.keys(form.formState.errors).includes(f.key));
      if (bad) setGroup(bad.group);
    }
  });

  const fields = view.fields.filter((f) => f.group === group);
  return (
    <form onSubmit={save} className="flex flex-col gap-4 pb-24" noValidate>
      <Tabs value={group} onValueChange={setGroup}>
        <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <TabsList className="w-max">
            {groups.map((g) => (
              <TabsTrigger key={g} value={g}>
                {t(`settings.groups.${g}.title`)}
                {view.fields.some((f) => f.group === g && dirty.includes(f.key)) && <span className="ml-1 size-1.5 rounded-full bg-primary" aria-label={t("settings.changed")} />}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
      </Tabs>
      <Card className="gap-2">
        <CardHeader>
          <CardTitle className="text-base">{t(`settings.groups.${group}.title`)}</CardTitle>
          <CardDescription>{t(`settings.groups.${group}.description`)}</CardDescription>
          {group === "billing" && (
            <p className="mt-2 flex items-start gap-2 rounded-md bg-warning/10 p-3 text-sm">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
              {t("settings.plansWarning")}
            </p>
          )}
        </CardHeader>
        <CardContent>
          {fields.map((field) => (
            <FieldRow key={field.key} field={field} form={form} editable={editable} cleared={!!cleared[field.key]} setCleared={(v) => setCleared((c) => ({ ...c, [field.key]: v }))} />
          ))}
          {editable && CHECKS[group] && (
            <div className="pt-4">
              <CheckButton group={group} form={form} />
            </div>
          )}
        </CardContent>
      </Card>
      {editable && (
        <div className={cn("fixed inset-x-0 bottom-0 z-20 border-t bg-background/95 backdrop-blur transition-transform lg:left-60", changes.length ? "translate-y-0" : "invisible translate-y-full")}>
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
            <span className="text-sm">{t("settings.unsaved", { count: changes.length })}</span>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  form.reset(defaults);
                  setCleared({});
                }}
              >
                {t("settings.discard")}
              </Button>
              <Button type="submit" disabled={form.formState.isSubmitting || !changes.length}>
                {t("settings.save")}
              </Button>
            </div>
          </div>
        </div>
      )}
    </form>
  );
};

export const SettingsPage = () => {
  const { t } = useTranslation();
  const can = useCan();
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["settings"], queryFn: () => api<SettingsView>("/settings") });
  const fromEnv = query.data?.fields.filter((f) => f.source === "env").length ?? 0;
  const importEnv = async () => {
    try {
      const result = await post<{ imported: string[] }>("/settings/import");
      toast.success(t("settings.import.done", { count: result.imported.length }));
      await client.invalidateQueries({ queryKey: ["settings"] });
    } catch (error) {
      showErrors(error);
    }
  };
  return (
    <>
      <PageHeader
        title={t("settings.title")}
        description={query.data?.updated_by ? t("settings.updated", { who: query.data.updated_by, when: dateTime(query.data.updated_at) }) : t("settings.description")}
        actions={
          can("admin") &&
          fromEnv > 0 && (
            <Confirm
              label={
                <>
                  <Download className="size-4" aria-hidden />
                  {t("settings.import.button")}
                </>
              }
              title={t("settings.import.title")}
              text={t("settings.import.text", { count: fromEnv })}
              action={t("settings.import.action")}
              onConfirm={importEnv}
            />
          )
        }
      />
      {query.isPending && <Loading rows={6} />}
      {query.error && <ErrorBox error={query.error} />}
      {query.data && (
        <div className="flex flex-col gap-6">
          <EnvironmentCard view={query.data} />
          {/* A saved version remounts the form, so replaced secrets fold back. */}
          <SettingsForm key={query.data.version} view={query.data} />
        </div>
      )}
    </>
  );
};
