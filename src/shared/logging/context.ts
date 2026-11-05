import { trace } from "@opentelemetry/api";
import { Logger, ILogObj } from "tslog";

/** The trace a line belongs to, so Grafana goes from a log line in Loki to its trace in Tempo. */
const traced = (message: string) => {
  const span = trace.getActiveSpan()?.spanContext();
  return span && span.traceFlags & 1 ? `${message} trace_id=${span.traceId}` : message;
};

export class ContextLogger<T extends ILogObj = ILogObj> {
  private readonly baseLogger: Logger<T>;
  private readonly context: Record<string, any>;

  constructor(baseLogger: Logger<T>, context: Record<string, any> = {}) {
    this.baseLogger = baseLogger;
    this.context = context;
  }

  with(key: string, value: any): ContextLogger<T> {
    return new ContextLogger(this.baseLogger, { ...this.context, [key]: value });
  }

  info(message: string, ...args: any[]) {
    console.log("[INFO] " + traced(message), ...args)
  }

  warn(message: string, ...args: any[]) {
    console.log("[WARN] " + traced(message), ...args)
  }

  error(message: string, ...args: any[]) {
    console.log("[ERROR] " + traced(message), ...args)
  }

  debug(message: string, ...args: any[]) {
    console.log("[DEBUG] " + traced(message), ...args)
  }

  fatal(message: string, ...args: any[]) {
    console.log("[FATAL] " + traced(message), ...args)
  }

  trace(message: string, ...args: any[]) {
    console.log("[TRACE] " + traced(message), ...args)
  }
}
