import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type Theme = "light" | "dark" | "system";

const KEY = "allay-admin-theme";

const read = (): Theme => {
  try {
    const stored = localStorage.getItem(KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
};

const ThemeContext = createContext<{ theme: Theme; resolved: "light" | "dark"; setTheme: (theme: Theme) => void }>({
  theme: "system",
  resolved: "light",
  setTheme: () => {},
});

/** Light, dark, or the system's; the choice stays in this browser only. */
export const ThemeProvider = ({ children }: { children: ReactNode }) => {
  const [theme, setTheme] = useState<Theme>(read);
  const [systemDark, setSystemDark] = useState(() => matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => {
    const query = matchMedia("(prefers-color-scheme: dark)");
    const listen = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    query.addEventListener("change", listen);
    return () => query.removeEventListener("change", listen);
  }, []);
  const resolved = theme === "system" ? (systemDark ? "dark" : "light") : theme;
  useEffect(() => {
    document.documentElement.classList.toggle("dark", resolved === "dark");
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      // Private windows may refuse storage; the theme then lasts for this visit.
    }
  }, [theme, resolved]);
  return <ThemeContext.Provider value={{ theme, resolved, setTheme }}>{children}</ThemeContext.Provider>;
};

export const useTheme = () => useContext(ThemeContext);
