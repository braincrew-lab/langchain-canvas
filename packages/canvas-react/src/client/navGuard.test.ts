/** The navigation guard keeps every link inside the frame: in-page anchors
 *  scroll, everything else is dropped. Exercised in jsdom by running the
 *  injected script against a real document. */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { NAV_GUARD_SCRIPT, withInspector } from "./inspector";

function mount(html: string, readOnly: boolean) {
  document.body.innerHTML = html;
  (window as unknown as { __LCX_READONLY?: boolean }).__LCX_READONLY = readOnly || undefined;
  new Function(NAV_GUARD_SCRIPT)();
}

function click(el: Element): MouseEvent {
  const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
  return ev;
}

describe("navigation guard", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("an in-page anchor scrolls to its target instead of navigating (read-only)", () => {
    mount('<nav><a id="l" href="#cover">목차</a></nav><section id="cover"></section>', true);
    const ev = click(document.getElementById("l")!);
    expect(ev.defaultPrevented).toBe(true);
    expect(document.getElementById("cover")!.scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("a click inside the anchor (nested element) is handled too", () => {
    mount('<a href="#top"><span id="s">↑</span></a><div id="top"></div>', true);
    const ev = click(document.getElementById("s")!);
    expect(ev.defaultPrevented).toBe(true);
    expect(document.getElementById("top")!.scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("a bare '#' or a missing target scrolls to the top of the document", () => {
    mount('<a id="a" href="#"></a><a id="b" href="#nowhere"></a>', true);
    click(document.getElementById("a")!);
    click(document.getElementById("b")!);
    expect(document.documentElement.scrollIntoView).toHaveBeenCalledTimes(2);
  });

  it("an external link never navigates", () => {
    mount('<a id="x" href="https://example.com" target="_blank">out</a>', true);
    const ev = click(document.getElementById("x")!);
    expect(ev.defaultPrevented).toBe(true);
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  it("a form never submits", () => {
    mount('<form id="f" action="/x"><button>go</button></form>', true);
    const ev = new Event("submit", { bubbles: true, cancelable: true });
    document.getElementById("f")!.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("in edit mode links are blocked but do not scroll (click = select)", () => {
    mount('<a id="l" href="#cover">목차</a><section id="cover"></section>', false);
    const ev = click(document.getElementById("l")!);
    expect(ev.defaultPrevented).toBe(true);
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  it("a click that is not on a link is left alone", () => {
    mount('<p id="p">text</p>', true);
    const ev = click(document.getElementById("p")!);
    expect(ev.defaultPrevented).toBe(false);
  });

  it("is part of the injected inspector script in both modes", () => {
    const page = "<!doctype html><html><body></body></html>";
    expect(withInspector(page)).toContain(NAV_GUARD_SCRIPT);
    expect(withInspector(page, undefined, { readOnly: true })).toContain(NAV_GUARD_SCRIPT);
  });
});
