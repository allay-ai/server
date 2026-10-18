/**
 * The panel's address and its API's: the backend puts a <base> at <prefix>/admin/, so the page never
 * hard-codes /admin and works behind any proxy prefix. Without one (the Vite dev server) it sits at the root.
 */
const basePath = new URL(document.baseURI).pathname.replace(/\/+$/, "");

export const ROUTER_BASE = basePath || "/";
export const API_BASE = `${basePath.replace(/\/admin$/, "")}/api/admin`;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields: Record<string, string> = {},
    readonly retryAfter?: number,
  ) {
    super(message);
  }
}

export const api = async <T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> => {
  const response = await fetch(`${API_BASE}${path}`, {
    method: init.method ?? "GET",
    credentials: "same-origin",
    headers: init.body === undefined ? {} : { "Content-Type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const data = (await response.json().catch(() => null)) as { error?: { code: string; message: string }; fields?: Record<string, string>; retry_after?: number } | null;
  if (!response.ok) {
    throw new ApiError(response.status, data?.error?.code ?? "HTTP_ERROR", data?.error?.message ?? response.statusText, data?.fields ?? {}, data?.retry_after);
  }
  return data as T;
};

export const post = <T = unknown>(path: string, body?: unknown) => api<T>(path, { method: "POST", body: body ?? {} });
