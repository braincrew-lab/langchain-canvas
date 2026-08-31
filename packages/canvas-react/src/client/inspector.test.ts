import { afterEach, expect, test } from "vitest";
import { withInspector } from "./inspector";

afterEach(() => { document.body.innerHTML = ""; });

test("rich inline text selects and edits its semantic paragraph", () => {
  const parsed = new DOMParser().parseFromString(withInspector('<html><body><p data-node-id="message" data-text-block="true">Hello <strong>world</strong>.</p></body></html>'), "text/html");
  document.body.innerHTML = parsed.body.innerHTML;
  document.querySelectorAll("script[data-lcx]").forEach((script) => window.eval(script.textContent || ""));
  const paragraph = document.querySelector("p")!;
  const strong = document.querySelector("strong")!;
  strong.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  expect(paragraph.classList.contains("lcx-selected")).toBe(true);
  expect(strong.classList.contains("lcx-selected")).toBe(false);
  strong.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  expect(paragraph.getAttribute("contenteditable")).toBe("true");
  expect(strong.hasAttribute("contenteditable")).toBe(false);
  expect(paragraph.textContent).toBe("Hello world.");
});

test("chart labels select the structured chart and cannot overwrite its data inline", () => {
  const parsed = new DOMParser().parseFromString(withInspector('<html><body><div data-node-id="chart" data-chart-data="{}"><p data-node-id="label" data-text-block="true">Q1</p></div></body></html>'), "text/html");
  document.body.innerHTML = parsed.body.innerHTML;
  document.querySelectorAll("script[data-lcx]").forEach((script) => window.eval(script.textContent || ""));
  const chart = document.querySelector('[data-node-id="chart"]')!;
  const label = document.querySelector("p")!;
  label.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  expect(chart.classList.contains("lcx-selected")).toBe(true);
  expect(label.classList.contains("lcx-selected")).toBe(false);
  label.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  expect(chart.hasAttribute("contenteditable")).toBe(false);
  expect(label.hasAttribute("contenteditable")).toBe(false);
  expect(chart.getAttribute("data-chart-data")).toBe("{}");
});
