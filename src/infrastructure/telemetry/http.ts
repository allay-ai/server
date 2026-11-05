import { SpanKind, SpanStatusCode, context, trace } from "@opentelemetry/api";
import { signals } from "./signals";

type Handler<A extends unknown[]> = (req: Request, ...rest: A) => Promise<Response>;

/**
 * A server span and `http.server.request.duration` for each request, named by the route's template, never its path:
 * a path holds a player's id. A run streams long after its handler answered, so its span sits under this one and
 * outlasts it. Each request starts its own trace: a plugin is someone else's code, so its `traceparent` decides nothing.
 */
export const observed = <A extends unknown[]>(route: string, handler: Handler<A>): Handler<A> => {
  // A tool's answer already shows in its run's trace, and health checks come every few seconds: numbers only.
  if (UNTRACED.has(route)) return timed(route, handler);
  return async (req, ...rest) => {
    const started = performance.now();
    const parent = context.active();
    const span = signals().tracer.startSpan(
      `${req.method} ${route}`,
      { kind: SpanKind.SERVER, attributes: { "http.request.method": req.method, "http.route": route, "url.scheme": "http" } },
      parent,
    );
    let status = 500;
    try {
      const response = await context.with(trace.setSpan(parent, span), () => handler(req, ...rest));
      status = response.status;
      return response;
    } finally {
      span.setAttribute("http.response.status_code", status);
      if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
      record(route, req, status, started);
    }
  };
};

const UNTRACED = new Set(["/api/health", "/api/v2/chat/:runId/tools/:callId"]);

const record = (route: string, req: Request, status: number, started: number) =>
  signals().instruments.http.record((performance.now() - started) / 1000, {
    "http.request.method": req.method,
    "http.route": route,
    "http.response.status_code": status,
  });

const timed =
  <A extends unknown[]>(route: string, handler: Handler<A>): Handler<A> =>
  async (req, ...rest) => {
    const started = performance.now();
    let status = 500;
    try {
      const response = await handler(req, ...rest);
      status = response.status;
      return response;
    } finally {
      record(route, req, status, started);
    }
  };
