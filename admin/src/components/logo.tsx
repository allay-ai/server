import { useTranslation } from "react-i18next";

/** The allay from the organization's icon, and the panel's name. */
export const Logo = () => {
  const { t } = useTranslation();
  return (
    <span className="flex items-center gap-2 font-semibold tracking-tight">
      <img src="./logo.png" alt="" className="size-7 rounded-lg" width={28} height={28} />
      {t("app.name")}
    </span>
  );
};
