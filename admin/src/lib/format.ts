import i18n from "i18next";

/** Numbers, money, and dates in the reader's language, through Intl. */
const locale = () => i18n.language || "en";

export const number = (n: number, digits = 0) => new Intl.NumberFormat(locale(), { maximumFractionDigits: digits }).format(n);

export const compact = (n: number) => new Intl.NumberFormat(locale(), { notation: "compact", maximumFractionDigits: 1 }).format(n);

/** Small amounts keep their cents' fractions: a question costs a tenth of a cent. */
export const usd = (n: number) => {
  const digits = n === 0 ? 2 : Math.abs(n) < 0.01 ? 5 : Math.abs(n) < 1 ? 4 : 2;
  return new Intl.NumberFormat(locale(), { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: digits }).format(n);
};

/** Axis ticks: two significant digits, so a tenth of a cent stays short. */
export const usdTick = (n: number) =>
  new Intl.NumberFormat(locale(), { style: "currency", currency: "USD", maximumSignificantDigits: 2 }).format(n);

export const percent = (n: number, digits = 1) => new Intl.NumberFormat(locale(), { style: "percent", maximumFractionDigits: digits }).format(n);

export const dateTime = (iso: string | null | undefined) =>
  iso ? new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso)) : "—";

export const date = (iso: string | null | undefined) => (iso ? new Intl.DateTimeFormat(locale(), { dateStyle: "medium" }).format(new Date(iso)) : "—");

export const shortDate = (iso: string) => new Intl.DateTimeFormat(locale(), { month: "short", day: "numeric" }).format(new Date(iso));

export const hour = (iso: string) => new Intl.DateTimeFormat(locale(), { hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

export const duration = (ms: number | null | undefined) => {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${number(ms)} ms`;
  if (ms < 60_000) return `${number(ms / 1000, 1)} s`;
  return `${number(Math.floor(ms / 60_000))} min ${number(Math.round((ms % 60_000) / 1000))} s`;
};

export const relative = (iso: string | null | undefined) => {
  if (!iso) return "—";
  const seconds = (new Date(iso).getTime() - Date.now()) / 1000;
  const format = new Intl.RelativeTimeFormat(locale(), { numeric: "auto" });
  const steps: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  for (const [unit, size] of steps) if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  return format.format(Math.round(seconds), "second");
};
