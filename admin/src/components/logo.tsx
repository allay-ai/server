import { useTranslation } from "react-i18next";

export const Logo = () => {
  const { t } = useTranslation();
  return (
    <span className="flex items-center gap-2 font-semibold tracking-tight">
      <svg viewBox="0 0 32 32" className="size-7" aria-hidden>
        <rect width="32" height="32" rx="8" className="fill-primary" />
        <path d="M9 21c2-7 4-11 7-11s5 4 7 11" fill="none" className="stroke-primary-foreground" strokeWidth="2.5" strokeLinecap="round" />
        <circle cx="13" cy="15" r="1.6" className="fill-primary-foreground" />
        <circle cx="19" cy="15" r="1.6" className="fill-primary-foreground" />
      </svg>
      {t("app.name")}
    </span>
  );
};
