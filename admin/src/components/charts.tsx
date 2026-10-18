import { Area, AreaChart, Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";

interface SeriesChartProps<T> {
  data: T[];
  /** The field on the x axis, and how a tick reads. */
  x: keyof T & string;
  tick: (value: string) => string;
  /** The one measure plotted; its name is the card's title, so there's no legend. */
  y: keyof T & string;
  label: string;
  format: (value: number) => string;
  /** chart-1 … chart-5, the validated categorical order. */
  color?: 1 | 2 | 3 | 4 | 5;
  /** Ticks for the y axis when they need a shorter form than the tooltip. */
  axisFormat?: (value: number) => string;
  /** Counts get whole ticks only. */
  integer?: boolean;
}

const axis = { tickLine: false, axisLine: false, tickMargin: 8, fontSize: 12 } as const;

/** Counts over time: columns from one baseline, thin, rounded only at the data end. */
export const ColumnChart = <T,>({ data, x, tick, y, label, format, color = 1, axisFormat }: SeriesChartProps<T>) => {
  const config = { [y]: { label, color: `var(--chart-${color})` } } satisfies ChartConfig;
  return (
    <ChartContainer config={config} className="aspect-auto h-56 w-full">
      <BarChart data={data} margin={{ left: 0, right: 4, top: 8 }} barCategoryGap={2}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey={x as never} {...axis} tickFormatter={tick} minTickGap={24} />
        <YAxis {...axis} width={48} tickFormatter={(v: number) => (axisFormat ?? format)(v)} allowDecimals={false} />
        <ChartTooltip cursor={{ fillOpacity: 0.4 }} content={<ChartTooltipContent labelFormatter={(_, payload) => tick(String(payload?.[0]?.payload?.[x] ?? ""))} formatter={(value) => <span className="tabular font-medium">{format(Number(value))}</span>} hideIndicator />} />
        <Bar dataKey={y as never} fill={`var(--color-${y})`} radius={[4, 4, 0, 0]} maxBarSize={24} animationDuration={400} />
      </BarChart>
    </ChartContainer>
  );
};

/** A measure that flows, like money: a 2px line over a faint wash. */
export const LineAreaChart = <T,>({ data, x, tick, y, label, format, color = 1, axisFormat, integer }: SeriesChartProps<T>) => {
  const config = { [y]: { label, color: `var(--chart-${color})` } } satisfies ChartConfig;
  const id = `fill-${y}-${color}`;
  return (
    <ChartContainer config={config} className="aspect-auto h-56 w-full">
      <AreaChart data={data} margin={{ left: 0, right: 4, top: 8 }}>
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={`var(--color-${y})`} stopOpacity={0.14} />
            <stop offset="100%" stopColor={`var(--color-${y})`} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} />
        <XAxis dataKey={x as never} {...axis} tickFormatter={tick} minTickGap={24} />
        <YAxis {...axis} width={72} tickFormatter={(v: number) => (axisFormat ?? format)(v)} allowDecimals={!integer} />
        <ChartTooltip content={<ChartTooltipContent labelFormatter={(_, payload) => tick(String(payload?.[0]?.payload?.[x] ?? ""))} formatter={(value) => <span className="tabular font-medium">{format(Number(value))}</span>} hideIndicator />} />
        <Area dataKey={y as never} type="monotone" animationDuration={400} stroke={`var(--color-${y})`} strokeWidth={2} fill={`url(#${id})`} activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--card)" }} />
      </AreaChart>
    </ChartContainer>
  );
};

/** A ranked list as bars in plain HTML: a name, a bar, and its value in text ink. */
export const RankBars = ({ rows, format, mono = true }: { rows: Array<{ name: string; value: number; note?: string }>; format: (value: number) => string; mono?: boolean }) => {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="flex flex-col gap-3">
      {rows.map((row) => (
        <li key={row.name} className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className={`min-w-0 truncate ${mono ? "font-mono text-xs" : ""}`} title={row.name}>
              {row.name}
            </span>
            <span className="tabular shrink-0 text-muted-foreground">
              {format(row.value)}
              {row.note && <span className="ml-2">{row.note}</span>}
            </span>
          </div>
          <div className="h-1.5 rounded-full bg-muted" aria-hidden>
            <div className="h-full rounded-full bg-chart-1" style={{ width: `${Math.max(2, (row.value / max) * 100)}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
};
