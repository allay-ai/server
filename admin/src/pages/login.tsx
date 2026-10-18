import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { AuthFrame } from "@/components/auth-frame";
import { FormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ApiError, ROUTER_BASE, post } from "@/lib/api";
import { showErrors } from "@/lib/forms";
import { resetSession } from "@/lib/session";

const schema = z.object({ username: z.string().trim().min(1, "login.errors.username"), password: z.string().min(1, "login.errors.password") });
type Values = z.infer<typeof schema>;

export const LoginPage = () => {
  const { t } = useTranslation();
  const { next } = useSearch({ from: "/login" });
  const navigate = useNavigate();
  const client = useQueryClient();
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { username: "", password: "" } });
  const { errors, isSubmitting } = form.formState;
  const submit = form.handleSubmit(async (values) => {
    try {
      await post("/login", values);
      await resetSession(client);
      // Only a path inside the panel; anything else goes to the dashboard.
      const target = next?.startsWith("/") && !next.startsWith("//") ? next.replace(ROUTER_BASE === "/" ? "" : ROUTER_BASE, "") || "/" : "/";
      await navigate({ to: target });
    } catch (error) {
      if (error instanceof ApiError && error.code === "BAD_CREDENTIALS") form.setError("password", { message: "login.errors.wrong" });
      else if (error instanceof ApiError && error.code === "RATE_LIMITED") form.setError("password", { message: "login.errors.limited" });
      else showErrors(error);
    }
  });
  return (
    <AuthFrame title={t("login.title")} description={t("login.description")}>
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <FormField id="username" label={t("login.username")} error={errors.username && t(errors.username.message!)}>
          <Input id="username" autoComplete="username" autoCapitalize="none" spellCheck={false} autoFocus aria-invalid={!!errors.username} {...form.register("username")} />
        </FormField>
        <FormField id="password" label={t("login.password")} error={errors.password && t(errors.password.message!)}>
          <Input id="password" type="password" autoComplete="current-password" aria-invalid={!!errors.password} {...form.register("password")} />
        </FormField>
        <Button type="submit" disabled={isSubmitting}>
          {t("login.submit")}
        </Button>
      </form>
    </AuthFrame>
  );
};
