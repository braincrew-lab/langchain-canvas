/**
 * Renders a `type: "chart"` artifact with ECharts, and lets the user edit it in
 * place — chart type, stacking, per-series colors & labels, per-slice colors
 * (pie), the y-axis label, and the underlying data (add / remove / edit rows).
 *
 * The renderer stays a thin adapter over the protocol's `ChartData` (tidy rows +
 * a series list), mapping it to an ECharts `option`. Every edit goes through
 * `patch`, so it flows through the same reconciler path an agent's updates would.
 * An artifact may instead carry a raw `echartsOption`, which is rendered verbatim.
 *
 * ECharts is imported through this module only, which the registry loads lazily —
 * so it never enters a bundle that doesn't render a chart.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import * as echarts from "echarts/core";
import { BarChart, LineChart, PieChart } from "echarts/charts";
import { GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";

import type { ChartData, ChartSeries } from "../../protocol/artifacts";
import { useArtifactPatch } from "../../hooks/useArtifactPatch";
import type { RendererProps } from "../../registry/registry";

echarts.use([BarChart, LineChart, PieChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer]);

// Accessible, brand-neutral categorical palette (swap for your design system).
const PALETTE = ["#6366f1", "#10b981", "#f59e0b", "#ef4444", "#0ea5e9", "#a855f7"];

const seriesColor = (series: ChartSeries, index: number) => series.color ?? PALETTE[index % PALETTE.length];
const sliceColor = (options: ChartData["options"], index: number) => options?.colors?.[index] ?? PALETTE[index % PALETTE.length];

const CHART_TYPES: ChartData["chart"][] = ["bar", "line", "area", "pie"];

/** Mount an ECharts instance and drive it from an `option`; resizes with its box. */
function EChart({ option, height }: { option: Record<string, unknown>; height: number }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const instRef = useRef<echarts.ECharts | null>(null);
  useEffect(() => {
    if (!boxRef.current) return;
    const inst = echarts.init(boxRef.current, undefined, { renderer: "canvas" });
    instRef.current = inst;
    const ro = new ResizeObserver(() => inst.resize());
    ro.observe(boxRef.current);
    return () => { ro.disconnect(); inst.dispose(); instRef.current = null; };
  }, []);
  useEffect(() => {
    // `notMerge: true` so removing a series / switching type doesn't leave ghosts.
    instRef.current?.setOption(option, true);
  }, [option]);
  return <div ref={boxRef} className="cv-chart__canvas" style={{ width: "100%", height }} />;
}

export function ChartRenderer({ artifact }: RendererProps<ChartData>) {
  const { chart, rows, xKey, series, options, echartsOption } = artifact.data;
  const patch = useArtifactPatch(artifact.id);
  const [editing, setEditing] = useState(false);

  const option = useMemo(
    () => echartsOption ?? toEChartsOption(chart, rows, xKey, series, options),
    [echartsOption, chart, rows, xKey, series, options],
  );

  // A raw ECharts option is authored elsewhere — render it verbatim, no editor.
  if (echartsOption) {
    return (
      <div className="cv-chart">
        <EChart option={option} height={340} />
      </div>
    );
  }

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

      <EChart option={option} height={editing ? 260 : 340} />
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

/** Map the tidy `ChartData` model onto an ECharts `option`. */
function toEChartsOption(
  chart: ChartData["chart"],
  rows: ChartData["rows"],
  xKey: string,
  series: ChartSeries[],
  options: ChartData["options"],
): Record<string, unknown> {
  const AXIS = "#9aa4b2"; // muted axis/label ink that reads on light or dark
  if (chart === "pie") {
    const valueKey = series[0]?.key ?? "value";
    return {
      tooltip: { trigger: "item" },
      legend: { bottom: 0, textStyle: { color: AXIS } },
      series: [
        {
          type: "pie",
          radius: ["45%", "72%"],
          padAngle: 2,
          itemStyle: { borderRadius: 4 },
          label: { color: AXIS },
          data: rows.map((r, i) => ({
            name: String(r[xKey] ?? ""),
            value: Number(r[valueKey] ?? 0),
            itemStyle: { color: sliceColor(options, i) },
          })),
        },
      ],
    };
  }

  const stacked = (chart === "bar" || chart === "area") && !!options?.stacked;
  return {
    tooltip: { trigger: "axis" },
    legend: { bottom: 0, textStyle: { color: AXIS } },
    grid: { left: 8, right: 16, top: 24, bottom: 40, containLabel: true },
    xAxis: {
      type: "category",
      data: rows.map((r) => String(r[xKey] ?? "")),
      axisLabel: { color: AXIS, fontSize: 12 },
      axisLine: { lineStyle: { color: "#d4d7dd" } },
    },
    yAxis: {
      type: "value",
      name: options?.yLabel,
      nameTextStyle: { color: AXIS },
      axisLabel: { color: AXIS, fontSize: 12 },
      splitLine: { lineStyle: { color: "#e5e7eb", type: "dashed" } },
    },
    series: series.map((s, i) => ({
      name: s.label ?? s.key,
      type: chart === "area" ? "line" : chart,
      ...(chart === "area" ? { areaStyle: { opacity: 0.2 }, smooth: false } : {}),
      ...(chart !== "bar" ? { showSymbol: false, lineStyle: { width: 2 } } : {}),
      stack: stacked ? "total" : undefined,
      itemStyle: { color: seriesColor(s, i) },
      data: rows.map((r) => Number(r[s.key] ?? 0)),
    })),
  };
}
