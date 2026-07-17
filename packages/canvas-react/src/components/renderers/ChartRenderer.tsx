/**
 * Renders a `type: "chart"` artifact with Recharts, and lets the user edit it in
 * place — chart type, stacking, per-series colors & labels, per-slice colors
 * (pie), the y-axis label, and the underlying data (add / remove / edit rows).
 *
 * The renderer stays a thin adapter over the protocol's `ChartData` (tidy rows +
 * a series list, which maps almost 1:1 onto Recharts). Every edit goes through
 * `patch`, so it flows through the same reconciler path an agent's updates would.
 */

import { useState } from "react";

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { ChartData, ChartSeries } from "../../protocol/artifacts";
import { useArtifactPatch } from "../../hooks/useArtifactPatch";
import type { RendererProps } from "../../registry/registry";

// Accessible, brand-neutral categorical palette (swap for your design system).
const PALETTE = ["#6366f1", "#10b981", "#f59e0b", "#ef4444", "#0ea5e9", "#a855f7"];

const seriesColor = (series: ChartSeries, index: number) => series.color ?? PALETTE[index % PALETTE.length];
const sliceColor = (options: ChartData["options"], index: number) => options?.colors?.[index] ?? PALETTE[index % PALETTE.length];

const CHART_TYPES: ChartData["chart"][] = ["bar", "line", "area", "pie"];

export function ChartRenderer({ artifact }: RendererProps<ChartData>) {
  const { chart, rows, xKey, series, options } = artifact.data;
  const patch = useArtifactPatch(artifact.id);
  const [editing, setEditing] = useState(false);

  if (rows.length === 0) {
    return <div className="cv-chart cv-chart--empty">Waiting for data…</div>;
  }

  const isPie = chart === "pie";

  const setSeries = (i: number, partial: Partial<ChartSeries>) =>
    patch({ series: series.map((s, j) => (j === i ? { ...s, ...partial } : s)) });
  const setSliceColor = (i: number, color: string) => {
    const colors = rows.map((_, j) => options?.colors?.[j] ?? PALETTE[j % PALETTE.length]);
    colors[i] = color;
    patch({ options: { ...options, colors } });
  };
  const setCell = (rowIdx: number, key: string, value: string | number) =>
    patch({ rows: rows.map((r, j) => (j === rowIdx ? { ...r, [key]: value } : r)) });
  const addRow = () => {
    const blank: Record<string, string | number> = { [xKey]: `Item ${rows.length + 1}` };
    series.forEach((s) => (blank[s.key] = 0));
    patch({ rows: [...rows, blank] });
  };
  const removeRow = (i: number) => patch({ rows: rows.filter((_, j) => j !== i) });

  return (
    <div className="cv-chart">
      <div className="cv-chart__toolbar cv-chrome">
        <div className="cv-chart__types">
          {CHART_TYPES.map((t) => (
            <button key={t} className={`cv-edit-btn ${chart === t ? "is-primary" : ""}`} onClick={() => patch({ chart: t })}>
              {t}
            </button>
          ))}
        </div>
        {(chart === "bar" || chart === "area") && (
          <label className="cv-chart__stack">
            <input type="checkbox" checked={!!options?.stacked} onChange={(e) => patch({ options: { ...options, stacked: e.target.checked } })} />
            Stacked
          </label>
        )}
        <span className="cv-chart__spacer" />
        <button className={`cv-edit-btn ${editing ? "is-primary" : ""}`} onClick={() => setEditing((v) => !v)}>
          {editing ? "Done" : "Edit data"}
        </button>
      </div>

      {editing && (
        <div className="cv-chart__editor cv-chrome">
          <div className="cv-chart__legend">
            {isPie
              ? rows.map((r, i) => (
                  <span key={i} className="cv-chart__swatch">
                    <input type="color" value={sliceColor(options, i)} onChange={(e) => setSliceColor(i, e.target.value)} title={`Color: ${r[xKey]}`} />
                    <span className="cv-chart__swatch-label">{String(r[xKey])}</span>
                  </span>
                ))
              : series.map((s, i) => (
                  <span key={s.key} className="cv-chart__swatch">
                    <input type="color" value={seriesColor(s, i)} onChange={(e) => setSeries(i, { color: e.target.value })} title="Series color" />
                    <input
                      className="cv-chart__series-name"
                      value={s.label ?? s.key}
                      onChange={(e) => setSeries(i, { label: e.target.value })}
                      title="Series name"
                    />
                  </span>
                ))}
          </div>

          {!isPie && (
            <label className="cv-chart__ylabel">
              Y-axis
              <input value={options?.yLabel ?? ""} placeholder="label…" onChange={(e) => patch({ options: { ...options, yLabel: e.target.value } })} />
            </label>
          )}

          <DataGrid rows={rows} xKey={xKey} series={series} onCell={setCell} onAddRow={addRow} onRemoveRow={removeRow} />
        </div>
      )}

      <ResponsiveContainer width="100%" height={editing ? 260 : 340}>
        {renderChart(chart, rows, xKey, series, options)}
      </ResponsiveContainer>
    </div>
  );
}

/** Editable long-form data table: the x-axis category plus one column per series. */
function DataGrid({
  rows,
  xKey,
  series,
  onCell,
  onAddRow,
  onRemoveRow,
}: {
  rows: ChartData["rows"];
  xKey: string;
  series: ChartSeries[];
  onCell: (rowIdx: number, key: string, value: string | number) => void;
  onAddRow: () => void;
  onRemoveRow: (i: number) => void;
}) {
  return (
    <div className="cv-chart__grid">
      <table>
        <thead>
          <tr>
            <th>{xKey}</th>
            {series.map((s) => (
              <th key={s.key}>{s.label ?? s.key}</th>
            ))}
            <th aria-label="Remove" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              <td>
                <input value={String(row[xKey] ?? "")} onChange={(e) => onCell(i, xKey, e.target.value)} />
              </td>
              {series.map((s) => (
                <td key={s.key}>
                  <input
                    type="number"
                    value={Number(row[s.key] ?? 0)}
                    onChange={(e) => onCell(i, s.key, e.target.value === "" ? 0 : Number(e.target.value))}
                  />
                </td>
              ))}
              <td>
                <button className="cv-chart__row-del" onClick={() => onRemoveRow(i)} disabled={rows.length <= 1} title="Remove row">
                  ×
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button className="cv-chart__addrow" onClick={onAddRow}>
        + Add row
      </button>
    </div>
  );
}

function renderChart(
  chart: ChartData["chart"],
  rows: ChartData["rows"],
  xKey: string,
  series: ChartSeries[],
  options: ChartData["options"],
) {
  const grid = <CartesianGrid strokeDasharray="3 3" stroke="var(--cv-border)" />;
  const axes = (
    <>
      <XAxis dataKey={xKey} stroke="var(--cv-muted)" fontSize={12} />
      <YAxis stroke="var(--cv-muted)" fontSize={12} label={yLabel(options)} />
    </>
  );
  const common = (
    <>
      <Tooltip />
      <Legend />
    </>
  );

  switch (chart) {
    case "line":
      return (
        <LineChart data={rows}>
          {grid}
          {axes}
          {common}
          {series.map((s, i) => (
            <Line key={s.key} dataKey={s.key} name={s.label ?? s.key} stroke={seriesColor(s, i)} dot={false} strokeWidth={2} />
          ))}
        </LineChart>
      );

    case "area":
      return (
        <AreaChart data={rows}>
          {grid}
          {axes}
          {common}
          {series.map((s, i) => (
            <Area
              key={s.key}
              dataKey={s.key}
              name={s.label ?? s.key}
              stroke={seriesColor(s, i)}
              fill={seriesColor(s, i)}
              fillOpacity={0.2}
              stackId={options?.stacked ? "stack" : undefined}
            />
          ))}
        </AreaChart>
      );

    case "bar":
      return (
        <BarChart data={rows}>
          {grid}
          {axes}
          {common}
          {series.map((s, i) => (
            <Bar key={s.key} dataKey={s.key} name={s.label ?? s.key} fill={seriesColor(s, i)} stackId={options?.stacked ? "stack" : undefined} />
          ))}
        </BarChart>
      );

    case "pie": {
      const valueKey = series[0]?.key ?? "value";
      return (
        <PieChart>
          <Tooltip />
          <Legend />
          <Pie data={rows} dataKey={valueKey} nameKey={xKey} innerRadius={60} outerRadius={120} paddingAngle={2}>
            {rows.map((_, i) => (
              <Cell key={i} fill={sliceColor(options, i)} />
            ))}
          </Pie>
        </PieChart>
      );
    }
  }
}

function yLabel(options: ChartData["options"]) {
  if (!options?.yLabel) return undefined;
  return { value: options.yLabel, angle: -90, position: "insideLeft", fill: "var(--cv-muted)", fontSize: 12 } as const;
}
