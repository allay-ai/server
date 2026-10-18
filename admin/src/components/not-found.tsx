import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

export const NotFound = () => {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-[50dvh] flex-col items-center justify-center gap-3 p-6 text-center">
      <h1 className="text-xl font-semibold">{t("notFound.title")}</h1>
      <p className="text-muted-foreground">{t("notFound.text")}</p>
      <Button asChild variant="outline">
        <Link to="/">{t("notFound.home")}</Link>
      </Button>
    </div>
  );
};
