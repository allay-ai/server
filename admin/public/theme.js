// Sets the theme before the first paint, so a dark page never flashes white. A file, not inline: the CSP allows only 'self'.
try {
  var stored = localStorage.getItem("allay-admin-theme");
  var dark = stored === "dark" || ((!stored || stored === "system") && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
} catch (e) {}
