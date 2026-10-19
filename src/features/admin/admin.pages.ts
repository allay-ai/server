import { existsSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import { prefixOf } from "./admin.http";

/** The built panel: next to the bundle in the image, admin/dist when run from source. */
const pagesDir = () =>
  [join(import.meta.dir, "../admin"), join(import.meta.dir, "../../../admin/dist")].find((dir) => existsSync(join(dir, "index.html")));

const HEADERS = {
  // The setup and recovery links carry their codes in the query; no page they link to may see them.
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

/**
 * Serves the panel at /admin under whatever prefix a proxy adds: files as they are, and index.html for every
 * page with a <base> that points at the panel's real address, so its relative paths work from any route.
 */
export const adminPages = () => {
  const dir = pagesDir();
  let index: string | undefined;
  return async (req: Request): Promise<Response> => {
    if (!dir) return new Response("The admin panel isn't built into this backend", { status: 404 });
    const path = new URL(req.url).pathname;
    // Relative paths need the trailing slash; a relative Location keeps any prefix.
    if (path === "/admin") return new Response(null, { status: 308, headers: { Location: "admin/" } });
    const rest = normalize(decodeURIComponent(path.replace(/^\/admin\/?/, "")));
    if (rest && !rest.startsWith("..") && !rest.includes(`${sep}..`) && rest !== "index.html") {
      const file = Bun.file(join(dir, rest));
      if (await file.exists()) {
        // Vite names built assets by their hash, so they never change under the same name.
        const cache = rest.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache";
        return new Response(file, { headers: { ...HEADERS, "Cache-Control": cache } });
      }
      if (/\.[a-z0-9]+$/i.test(rest)) return new Response("Not found", { status: 404 });
    }
    index ??= await Bun.file(join(dir, "index.html")).text();
    const html = index.replace("<head>", `<head><base href="${prefixOf(req)}/admin/">`);
    return new Response(html, { headers: { ...HEADERS, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
  };
};
