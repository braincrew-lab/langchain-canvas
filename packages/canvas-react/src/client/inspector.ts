/**
 * The iframe inspector — makes an `html` artifact directly editable.
 *
 * `withInspector(html)` injects a small, self-contained script + style into the
 * page rendered inside the sandboxed iframe. That script:
 *
 *   1. stamps every element with a deterministic `data-cid` (a tree path like
 *      `e-0-2`), so a selection survives re-renders and the agent can target it;
 *   2. outlines the element under the cursor on hover;
 *   3. on click, marks it selected and `postMessage`s a selection payload —
 *      including a snapshot of its key computed styles — to the parent window;
 *   4. on double-click, makes a text element `contenteditable`; on blur it posts
 *      the edited element back as `node_edit` (the host commits it as a
 *      `canvas.node_patch`);
 *   5. responds to parent commands: `set_style` (apply a style live), `commit`
 *      (post the element's current HTML back as `node_edit`), and `clear`.
 *
 * The script runs inside a `sandbox="allow-scripts"` iframe with a null origin,
 * so it cannot reach the parent DOM, cookies, or storage — only `postMessage`.
 */

export const INSPECTOR_MARK = "langchain-canvas";

/** Inject the inspector into an HTML string, before `</body>` when present. The
 *  injected nodes are tagged `data-lcx` so a full-document save can strip them.
 *  Also ensures a responsive viewport meta so device-width media queries behave
 *  the same in the preview, in export, and on a real device. */
export function withInspector(html: string): string {
  let out = withViewport(html);
  const injection = `<style data-lcx>${INSPECTOR_CSS}</style><script data-lcx>${INSPECTOR_SCRIPT}</script>`;
  const marker = "</body>";
  const at = out.lastIndexOf(marker);
  out = at === -1 ? out + injection : out.slice(0, at) + injection + out.slice(at);
  return out;
}

/** Add a responsive viewport meta to `<head>` if the document doesn't have one. */
function withViewport(html: string): string {
  if (/name=["']?viewport/i.test(html)) return html;
  const meta = '<meta name="viewport" content="width=device-width, initial-scale=1">';
  const head = html.match(/<head[^>]*>/i);
  if (head) return html.replace(head[0], head[0] + meta);
  const htmlTag = html.match(/<html[^>]*>/i);
  if (htmlTag) return html.replace(htmlTag[0], htmlTag[0] + "<head>" + meta + "</head>");
  return meta + html;
}

const INSPECTOR_CSS = `
[data-cid].lcx-hover { outline: 2px solid #6366f1 !important; outline-offset: 1px; cursor: pointer; }
[data-cid].lcx-selected { outline: 2px solid #10b981 !important; outline-offset: 1px; cursor: move; }
[data-group-id] { outline: 1px dashed rgba(99,102,241,0.45); outline-offset: 2px; }
.lcx-marquee { position: fixed; border: 1.5px solid #6366f1; background: rgba(99,102,241,0.12); z-index: 999999; pointer-events: none; }
.lcx-fmt { position: fixed; z-index: 1000000; display: flex; gap: 2px; padding: 4px; border-radius: 8px;
  background: #1f2328; box-shadow: 0 6px 20px rgba(0,0,0,0.25); font-family: -apple-system, system-ui, sans-serif; }
.lcx-fmt button { min-width: 28px; height: 28px; padding: 0 6px; border: 0; border-radius: 6px; background: transparent;
  color: #fff; font-size: 14px; cursor: pointer; }
.lcx-fmt button:hover { background: rgba(255,255,255,0.15); }
.lcx-fmt button b { font-weight: 800; } .lcx-fmt button i { font-style: italic; } .lcx-fmt button u { text-decoration: underline; }
.lcx-resize { position: fixed; width: 14px; height: 14px; z-index: 1000001; background: #10b981;
  border: 2px solid #fff; border-radius: 3px; box-shadow: 0 1px 4px rgba(0,0,0,0.3); cursor: nwse-resize; touch-action: none; }
`.trim();

/** Computed-style properties surfaced to the style panel (camelCase). */
export const STYLE_PROPS = [
  "color",
  "backgroundColor",
  "fontSize",
  "fontWeight",
  "textAlign",
  "lineHeight",
  "letterSpacing",
  "padding",
  "borderRadius",
  "width",
] as const;

// Kept as ES5-ish source since it is serialized verbatim into the iframe.
const INSPECTOR_SCRIPT = `
(function () {
  var MARK = ${JSON.stringify(INSPECTOR_MARK)};
  var STYLE_PROPS = ${JSON.stringify(STYLE_PROPS)};
  function assign(el, path) {
    if (el.hasAttribute && el.hasAttribute("data-lcx")) return; // skip injected style/script
    el.setAttribute("data-cid", path);
    for (var i = 0; i < el.children.length; i++) assign(el.children[i], path + "-" + i);
  }
  function byCid(cid) { return document.querySelector('[data-cid="' + cid + '"]'); }
  function isEditable(el) { return el && el.hasAttribute && !el.hasAttribute("data-lcx") && !el.closest("[data-lcx]"); }
  function selectorFor(el) {
    var tag = el.tagName.toLowerCase();
    var classes = typeof el.className === "string" ? el.className.trim().split(/\\s+/) : [];
    var real = classes.filter(function (c) { return c && c.indexOf("lcx-") !== 0; }); // skip inspector classes
    return tag + (real.length ? "." + real[0] : "");
  }
  function stylesOf(el) {
    var cs = getComputedStyle(el), out = {};
    for (var i = 0; i < STYLE_PROPS.length; i++) out[STYLE_PROPS[i]] = cs[STYLE_PROPS[i]];
    return out;
  }
  function scrub(el) {
    el.removeAttribute("data-cid");
    el.removeAttribute("contenteditable");
    if (el.classList) { el.classList.remove("lcx-hover"); el.classList.remove("lcx-selected"); }
    if (el.getAttribute && el.getAttribute("class") === "") el.removeAttribute("class");
  }
  function emitEdit(el) {
    // Serialize the *canonical* HTML — strip the inspector's own injected
    // attributes/classes so they never persist into the stored source or exports.
    var cid = el.getAttribute("data-cid");
    var clone = el.cloneNode(true);
    scrub(clone);
    var inner = clone.querySelectorAll ? clone.querySelectorAll("[data-cid],[contenteditable],.lcx-hover,.lcx-selected") : [];
    for (var i = 0; i < inner.length; i++) scrub(inner[i]);
    parent.postMessage({ source: MARK, type: "node_edit", cid: cid, html: clone.outerHTML }, "*");
  }
  // A structural change (insert/delete/move) shifts every cid, so we save the
  // whole document: clone <html>, drop the injected inspector nodes, scrub the
  // inspector's attributes, and post it for the host to store wholesale.
  // selfApplied = the iframe already reflects this change and every element kept
  // its data-cid (a pure reorder/move), so the host can persist without reloading
  // the iframe (no flicker). Edits that mint new nodes (insert) leave it false so a
  // reload re-tags fresh cids.
  function emitDoc(selfApplied) {
    var clone = document.documentElement.cloneNode(true);
    var injected = clone.querySelectorAll("[data-lcx]");
    for (var i = 0; i < injected.length; i++) injected[i].parentNode && injected[i].parentNode.removeChild(injected[i]);
    var marked = clone.querySelectorAll("[data-cid],[contenteditable],.lcx-hover,.lcx-selected");
    for (var j = 0; j < marked.length; j++) scrub(marked[j]);
    parent.postMessage({ source: MARK, type: "doc_edit", self: !!selfApplied, html: "<!doctype html>\\n" + clone.outerHTML }, "*");
  }
  function newBlock(tag) {
    var el = document.createElement(tag);
    if (tag === "img") {
      el.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='480' height='270'%3E%3Crect width='100%25' height='100%25' fill='%23e5e7eb'/%3E%3Cpath d='M190 155l40-45 35 40 25-25 40 45z' fill='%23c3c8d0'/%3E%3Ccircle cx='300' cy='105' r='16' fill='%23c3c8d0'/%3E%3C/svg%3E";
      el.alt = "image"; el.style.maxWidth = "100%";
    }
    else if (tag === "button") el.textContent = "Button";
    else if (tag === "hr") { /* no content */ }
    else if (tag === "section") { var p = document.createElement("p"); p.textContent = "New section"; el.appendChild(p); }
    else el.textContent = tag === "h1" || tag === "h2" ? "New heading" : "New text";
    return el;
  }
  // Floating rich-text toolbar shown while a text element is being edited.
  var fmtBar = null;
  function removeFmtBar() { if (fmtBar && fmtBar.parentNode) fmtBar.parentNode.removeChild(fmtBar); fmtBar = null; }
  function showFmtBar(el) {
    removeFmtBar();
    var r = el.getBoundingClientRect();
    fmtBar = document.createElement("div");
    fmtBar.setAttribute("data-lcx", "");
    fmtBar.className = "lcx-fmt";
    fmtBar.style.left = Math.max(4, r.left) + "px";
    fmtBar.style.top = Math.max(4, r.top - 40) + "px";
    var specs = [["<b>B</b>", "bold"], ["<i>I</i>", "italic"], ["<u>U</u>", "underline"], ["\\uD83D\\uDD17", "createLink"]];
    for (var i = 0; i < specs.length; i++) {
      (function (spec) {
        var btn = document.createElement("button");
        btn.innerHTML = spec[0];
        btn.title = spec[1];
        // mousedown+preventDefault keeps the contenteditable focused and its selection intact.
        btn.addEventListener("mousedown", function (ev) {
          ev.preventDefault();
          if (spec[1] === "createLink") {
            var url = prompt("Link URL", "https://");
            if (url) document.execCommand("createLink", false, url);
          } else {
            document.execCommand(spec[1], false, null);
          }
        });
        fmtBar.appendChild(btn);
      })(specs[i]);
    }
    document.body.appendChild(fmtBar);
  }
  // Drag-to-resize handle for the selected element (images keep their aspect).
  var resizeEl = null, resizeHandle = null, resizing = null;
  function positionResize() {
    if (!resizeEl || !resizeHandle) return;
    var r = resizeEl.getBoundingClientRect();
    // Anchor to the element's bottom-right, but keep the whole handle on-screen so
    // a section taller/wider than the viewport still exposes a reachable grip
    // (otherwise it sits below the fold and "there's no way to adjust it").
    var M = 8;
    var left = Math.max(r.left - 7, Math.min(r.right - 7, window.innerWidth - M - 14));
    var top = Math.max(r.top - 7, Math.min(r.bottom - 7, window.innerHeight - M - 14));
    resizeHandle.style.left = left + "px";
    resizeHandle.style.top = top + "px";
  }
  function hideResize() { resizeEl = null; if (resizeHandle) resizeHandle.style.display = "none"; }
  function showResize(el) {
    resizeEl = el;
    if (!resizeHandle) {
      resizeHandle = document.createElement("div");
      resizeHandle.setAttribute("data-lcx", "");
      resizeHandle.className = "lcx-resize";
      resizeHandle.addEventListener("pointerdown", function (e) {
        if (!resizeEl) return;
        e.preventDefault(); e.stopPropagation();
        var r = resizeEl.getBoundingClientRect();
        resizing = { sx: e.clientX, sy: e.clientY, w: r.width, h: r.height, img: resizeEl.tagName === "IMG" };
        resizeHandle.setPointerCapture(e.pointerId);
      });
      resizeHandle.addEventListener("pointermove", function (e) {
        if (!resizing || !resizeEl) return;
        var w = Math.max(20, Math.round(resizing.w + (e.clientX - resizing.sx)));
        if (resizing.img) {
          // Store image width as a % of its container so it scales with the layout
          // (responsive): shrinks on mobile, grows on desktop. Aspect ratio kept.
          var parentW = resizeEl.parentElement ? resizeEl.parentElement.getBoundingClientRect().width : window.innerWidth;
          resizeEl.style.width = Math.max(5, Math.min(100, Math.round((w / parentW) * 100))) + "%";
          resizeEl.style.height = "auto";
        } else {
          resizeEl.style.width = w + "px";
          resizeEl.style.height = Math.max(20, Math.round(resizing.h + (e.clientY - resizing.sy))) + "px";
        }
        positionResize();
      });
      resizeHandle.addEventListener("pointerup", function () {
        if (!resizing) return;
        resizing = null;
        emitEdit(resizeEl); // commit the new size as a node edit
      });
      document.body.appendChild(resizeHandle);
    }
    resizeHandle.style.display = "block";
    positionResize();
  }
  function start() {
    assign(document.body, "e");
    var hovered = null;
    var selected = [];               // currently highlighted elements
    var marquee = null, sx = 0, sy = 0, dragging = false, moved = false, suppressClick = false;
    // Free positioning: dragging places an element anywhere. The element is pulled
    // into absolute positioning inside its own parent, and its final spot + size are
    // stored as percentages of that parent — so it stays put proportionally across
    // responsive breakpoints, instead of a fixed pixel offset that drifts off.
    var dragEls = null, dragStart = null, dragBases = null, groupSeq = 0;

    function ensurePositioned(parent) {
      if (!parent || parent === document.body || parent === document.documentElement) return;
      if (window.getComputedStyle(parent).position === "static") parent.style.position = "relative";
    }
    // Pull each element out into absolute positioning at its current spot (no visual
    // jump), so it can then be moved freely.
    function beginFreeDrag(els) {
      dragBases = [];
      for (var i = 0; i < els.length; i++) {
        var el = els[i], parent = el.parentElement || document.body;
        ensurePositioned(parent);
        var pr = parent.getBoundingClientRect(), r = el.getBoundingClientRect();
        var base = { el: el, parent: parent, left: r.left - pr.left, top: r.top - pr.top, w: el.offsetWidth, h: el.offsetHeight };
        el.style.position = "absolute";
        el.style.margin = "0";
        el.style.width = base.w + "px";        // freeze size while dragging (absolute can't inherit flow width)
        el.style.left = base.left + "px";
        el.style.top = base.top + "px";
        dragBases.push(base);
      }
    }
    function moveFree(dx, dy) {
      for (var i = 0; i < dragBases.length; i++) {
        var b = dragBases[i];
        b.el.style.left = (b.left + dx) + "px";
        b.el.style.top = (b.top + dy) + "px";
      }
    }
    // Commit the current position (in px, as set live by moveFree) as % of the
    // parent — position and width — so it scales with the layout. Falls back to px
    // only if the parent has collapsed to zero on that axis.
    function commitFree() {
      for (var i = 0; i < dragBases.length; i++) {
        var b = dragBases[i], pr = b.parent.getBoundingClientRect();
        var curLeft = parseFloat(b.el.style.left) || 0, curTop = parseFloat(b.el.style.top) || 0;
        b.el.style.left = pr.width ? ((curLeft / pr.width) * 100).toFixed(3) + "%" : curLeft + "px";
        b.el.style.top = pr.height ? ((curTop / pr.height) * 100).toFixed(3) + "%" : curTop + "px";
        if (pr.width) b.el.style.width = ((b.w / pr.width) * 100).toFixed(3) + "%";
      }
    }

    function clearSelected() {
      for (var i = 0; i < selected.length; i++) selected[i].classList.remove("lcx-selected");
      selected = [];
      hideResize();
    }
    window.addEventListener("scroll", positionResize, true);
    function overlapRatio(r, box) {
      var ix = Math.max(0, Math.min(r.right, box.right) - Math.max(r.left, box.left));
      var iy = Math.max(0, Math.min(r.bottom, box.bottom) - Math.max(r.top, box.top));
      var area = r.width * r.height;
      return area > 0 ? (ix * iy) / area : 0;
    }
    function hasAncestorIn(el, list) {
      var p = el.parentElement;
      while (p) { if (list.indexOf(p) !== -1) return true; p = p.parentElement; }
      return false;
    }
    function selectSummary(el) {
      return { cid: el.getAttribute("data-cid"), selector: selectorFor(el), tag: el.tagName.toLowerCase(),
               text: (el.textContent || "").trim().slice(0, 60) };
    }

    document.addEventListener("mouseover", function (e) {
      var t = e.target;
      if (!(t instanceof Element) || !isEditable(t)) return;
      if (hovered) hovered.classList.remove("lcx-hover");
      hovered = t; t.classList.add("lcx-hover");
    }, true);
    document.addEventListener("mouseout", function () {
      if (hovered) { hovered.classList.remove("lcx-hover"); hovered = null; }
    }, true);

    // --- click = single select --------------------------------------------------
    document.addEventListener("click", function (e) {
      if (suppressClick) { suppressClick = false; return; }
      var t = e.target;
      if (!(t instanceof Element) || t.isContentEditable || !isEditable(t)) return;
      e.preventDefault(); e.stopPropagation();
      // Clicking the page background (body / near-full-page element) deselects.
      var rr = t.getBoundingClientRect();
      if (t === document.body || t === document.documentElement ||
          rr.width * rr.height > window.innerWidth * window.innerHeight * 0.9) {
        clearSelected();
        parent.postMessage({ source: MARK, type: "multi_select", items: [] }, "*");
        return;
      }
      if (e.shiftKey) {
        // Shift-click toggles an element in a multi-selection.
        var i = selected.indexOf(t);
        if (i !== -1) { t.classList.remove("lcx-selected"); selected.splice(i, 1); }
        else {
          // Keep the selection flat — a nested pair can't be grouped, so drop any
          // already-selected ancestor/descendant of the newly-clicked element.
          for (var j = selected.length - 1; j >= 0; j--) {
            if (selected[j].contains(t) || t.contains(selected[j])) {
              selected[j].classList.remove("lcx-selected"); selected.splice(j, 1);
            }
          }
          t.classList.add("lcx-selected"); selected.push(t);
        }
        parent.postMessage({ source: MARK, type: "multi_select", items: selected.map(selectSummary) }, "*");
        return;
      }
      clearSelected();
      var gid = t.getAttribute("data-group-id");
      if (gid) {
        // Clicking a grouped element highlights the whole group; it moves together
        // and offers Ungroup. (Double-click still edits the deep text element.)
        var mates = document.querySelectorAll('[data-group-id="' + gid + '"]');
        for (var mi = 0; mi < mates.length; mi++) { mates[mi].classList.add("lcx-selected"); selected.push(mates[mi]); }
      } else {
        t.classList.add("lcx-selected"); selected = [t];
      }
      showResize(t);
      parent.postMessage({
        source: MARK, type: "select",
        cid: t.getAttribute("data-cid"),
        selector: selectorFor(t),
        tag: t.tagName.toLowerCase(),
        text: (t.textContent || "").trim().slice(0, 80),
        outerHtml: t.outerHTML.slice(0, 4000),
        styles: stylesOf(t),
        isGroup: !!gid
      }, "*");
    }, true);

    // Block the browser's native drag (images and links start an HTML5 drag on
    // mousemove by default, which hijacks our free-drag — the image "ghost" gets
    // dragged instead of the element moving). Suppress it for any editable node.
    document.addEventListener("dragstart", function (e) {
      var t = e.target;
      if (t instanceof Element && t.closest("[data-cid]") && !t.hasAttribute("data-lcx")) e.preventDefault();
    }, true);

    // --- drag: freely move an element anywhere, or marquee-select empty space ----
    document.addEventListener("mousedown", function (e) {
      suppressClick = false;             // a fresh press: never carry a stale suppress
      if (e.button !== 0) return;
      var t = e.target;
      if (t instanceof Element && t.isContentEditable) return;
      if (t === resizeHandle) return;    // the resize handle drives its own drag
      // Pressing on a selected element drags the whole selection; pressing on any
      // other element drags just that one (a single gesture both selects and moves,
      // so you never have to click first). Empty space starts a marquee.
      var onSel = false;
      for (var si = 0; si < selected.length; si++) { if (selected[si] === t || selected[si].contains(t)) { onSel = true; break; } }
      if (onSel && selected.length >= 1) {
        dragEls = selected.slice();
      } else {
        var el = t instanceof Element ? t.closest("[data-cid]") : null;
        if (el && el !== document.body && el.parentElement) dragEls = [el];
      }
      if (dragEls) {
        dragStart = { x: e.clientX, y: e.clientY }; moved = false;
        document.body.style.userSelect = "none";
        return;
      }
      dragging = true; moved = false; sx = e.clientX; sy = e.clientY;
      document.body.style.userSelect = "none";
      marquee = document.createElement("div");
      marquee.className = "lcx-marquee";
      document.body.appendChild(marquee);
    }, true);
    document.addEventListener("mousemove", function (e) {
      if (dragEls) {
        if (!moved && (Math.abs(e.clientX - dragStart.x) > 3 || Math.abs(e.clientY - dragStart.y) > 3)) {
          moved = true;
          beginFreeDrag(dragEls);       // pull into absolute positioning at the current spot
        }
        if (!moved) return;
        moveFree(e.clientX - dragStart.x, e.clientY - dragStart.y);
        positionResize();
        return;
      }
      if (!dragging || !marquee) return;
      if (Math.abs(e.clientX - sx) > 4 || Math.abs(e.clientY - sy) > 4) moved = true;
      var l = Math.min(sx, e.clientX), tp = Math.min(sy, e.clientY);
      marquee.style.left = l + "px"; marquee.style.top = tp + "px";
      marquee.style.width = Math.abs(e.clientX - sx) + "px";
      marquee.style.height = Math.abs(e.clientY - sy) + "px";
    }, true);
    document.addEventListener("mouseup", function (e) {
      if (dragEls) {
        var els = dragEls; dragEls = null;
        document.body.style.userSelect = "";
        if (moved && dragBases) {
          suppressClick = true;
          moveFree(e.clientX - dragStart.x, e.clientY - dragStart.y);    // final px position
          commitFree();                                                  // px → % of parent
          positionResize();
          // The new position is already shown in the iframe with every cid intact,
          // so persist without a reload (no flicker): one element → node_edit,
          // several → a self-applied doc_edit.
          if (els.length === 1) emitEdit(els[0]); else emitDoc(true);
        }
        dragBases = null;
        return;
      }
      if (!dragging) return;
      dragging = false;
      document.body.style.userSelect = "";
      var box = marquee ? marquee.getBoundingClientRect() : null;
      if (marquee && marquee.parentNode) marquee.parentNode.removeChild(marquee);
      marquee = null;
      if (!moved || !box) return;              // a click, not a drag
      suppressClick = true;
      // Predictable rubber-band: select the outermost elements *fully enclosed*
      // by the box (standard marquee behavior — no partial-overlap guessing).
      var vpArea = window.innerWidth * window.innerHeight;
      var all = document.body.querySelectorAll("[data-cid]");
      var hits = [];
      all.forEach(function (el) {
        if (el.hasAttribute("data-lcx")) return;
        var r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return;
        if (r.width * r.height > vpArea * 0.9) return;   // never select the page/body wrapper
        if (r.left >= box.left - 1 && r.top >= box.top - 1 && r.right <= box.right + 1 && r.bottom <= box.bottom + 1) hits.push(el);
      });
      var top = hits.filter(function (el) { return !hasAncestorIn(el, hits); }); // outermost only
      // If the enclosure is a single wrapper of several items, select the items
      // (so dragging a box around 3 cards selects the cards, not their container).
      var guard = 0;
      while (top.length === 1 && guard++ < 4) {
        var kids = [];
        for (var k = 0; k < top[0].children.length; k++) {
          if (hits.indexOf(top[0].children[k]) !== -1) kids.push(top[0].children[k]);
        }
        if (kids.length >= 2) top = kids; else break;
      }
      if (!e.shiftKey) clearSelected();
      top.forEach(function (el) {
        if (selected.indexOf(el) === -1) { el.classList.add("lcx-selected"); selected.push(el); }
      });
      parent.postMessage({ source: MARK, type: "multi_select", items: selected.map(selectSummary) }, "*");
    }, true);

    // Safety net: if the pointer leaves the frame mid-drag the mouseup can be lost,
    // which would leave move/marquee state stuck. Finalize cleanly on exit.
    function endDrag() {
      document.body.style.userSelect = "";
      if (dragEls) {
        // Pointer left the frame mid-drag: commit the move at its last position so
        // it isn't lost (the element is already placed absolutely in the iframe).
        var els = dragEls; dragEls = null;
        if (moved && dragBases) { commitFree(); if (els.length === 1) emitEdit(els[0]); else emitDoc(true); }
        dragBases = null;
      }
      if (dragging) {
        dragging = false;
        if (marquee && marquee.parentNode) marquee.parentNode.removeChild(marquee);
        marquee = null;
      }
    }
    document.addEventListener("mouseleave", endDrag);
    window.addEventListener("blur", endDrag);

    // --- double-click = edit text inline; commit on blur ------------------------
    document.addEventListener("dblclick", function (e) {
      var t = e.target;
      if (!(t instanceof Element) || !isEditable(t)) return;
      e.preventDefault();
      t.setAttribute("contenteditable", "true");
      t.focus();
      showFmtBar(t);
    }, true);
    document.addEventListener("blur", function (e) {
      var t = e.target;
      if (!(t instanceof Element) || !t.hasAttribute("contenteditable")) return;
      removeFmtBar();
      t.removeAttribute("contenteditable");
      emitEdit(t);
    }, true);
    // While editing text, Enter inserts a real line break. The browser's default
    // for Enter is to split the block (which nests <div>s, or does nothing at all
    // on inline/button-like elements), so line breaks appear not to work — force a
    // clean <br> instead. Escape commits by blurring.
    document.addEventListener("keydown", function (e) {
      var t = e.target;
      var editing = t instanceof Element && t.hasAttribute("contenteditable");
      if (editing) {
        if (e.key === "Enter") {
          e.preventDefault();
          if (!document.execCommand("insertLineBreak")) document.execCommand("insertHTML", false, "<br>");
        } else if (e.key === "Escape") {
          e.preventDefault();
          t.blur();
        }
        return;
      }
      // Escape with a live selection clears it here and tells the host to close its
      // selection UI (an empty multi-select).
      if (e.key === "Escape" && selected.length) {
        clearSelected();
        parent.postMessage({ source: MARK, type: "multi_select", items: [] }, "*");
      }
    }, true);

    // --- parent commands --------------------------------------------------------
    window.addEventListener("message", function (e) {
      var d = e.data;
      if (!d || d.source !== MARK) return;
      if (d.type === "clear") { clearSelected(); return; }
      if (d.type === "set_style") { var el = byCid(d.cid); if (el) el.style[d.prop] = d.value; return; }
      if (d.type === "set_src") { var ei = byCid(d.cid); if (ei) { ei.setAttribute("src", d.value); emitEdit(ei); } return; }
      if (d.type === "commit") { var el2 = byCid(d.cid); if (el2) emitEdit(el2); return; }

      // Structural edits — mutate the tree, then persist the whole document.
      if (d.type === "insert") {
        var block = newBlock(d.block || "p");
        var anchor = d.cid ? byCid(d.cid) : null;
        if (anchor && anchor.parentNode && anchor.parentNode !== document.documentElement) {
          anchor.parentNode.insertBefore(block, anchor.nextSibling);
        } else {
          document.body.appendChild(block);
        }
        emitDoc();
        return;
      }
      if (d.type === "insert_html") {
        // A built-in section template (trusted markup from the toolbar).
        var anc = d.cid ? byCid(d.cid) : null;
        var container = (anc && anc.parentNode && anc.parentNode !== document.documentElement) ? anc.parentNode : document.body;
        var ref = (anc && anc.parentNode === container) ? anc.nextSibling : null;
        var frag = document.createElement("div");
        frag.innerHTML = d.html || "";
        while (frag.firstChild) container.insertBefore(frag.firstChild, ref);
        emitDoc();
        return;
      }
      if (d.type === "group") {
        // Tag members with a shared id — no wrapper, so the page layout (grid /
        // flex flow) is untouched; the members simply move together.
        var members = [];
        var cids = d.cids || [];
        for (var g = 0; g < cids.length; g++) { var m = byCid(cids[g]); if (m) members.push(m); }
        if (members.length < 2) return;
        var gid = "g" + (groupSeq++);
        for (var w = 0; w < members.length; w++) members[w].setAttribute("data-group-id", gid);
        clearSelected();
        emitDoc();
        return;
      }
      if (d.type === "ungroup") {
        var el0 = d.cid ? byCid(d.cid) : null;
        if (!el0) return;
        var gid2 = el0.getAttribute("data-group-id");
        if (gid2) {
          var mates = document.querySelectorAll('[data-group-id="' + gid2 + '"]');
          for (var u = 0; u < mates.length; u++) mates[u].removeAttribute("data-group-id");
          clearSelected();
          emitDoc();
        }
        return;
      }
      var target = d.cid ? byCid(d.cid) : null;
      if (!target || !target.parentNode) return;
      if (d.type === "duplicate") {
        var copy = target.cloneNode(true);
        scrub(copy);
        target.parentNode.insertBefore(copy, target.nextSibling);
        emitDoc();
      } else if (d.type === "delete") {
        target.parentNode.removeChild(target);
        clearSelected();
        emitDoc();
      } else if (d.type === "move_up") {
        var prev = target.previousElementSibling;
        while (prev && prev.hasAttribute("data-lcx")) prev = prev.previousElementSibling;
        if (prev) { target.parentNode.insertBefore(target, prev); emitDoc(); }
      } else if (d.type === "move_down") {
        var next = target.nextElementSibling;
        while (next && next.hasAttribute("data-lcx")) next = next.nextElementSibling;
        if (next) { target.parentNode.insertBefore(next, target); emitDoc(); }
      }
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
`.trim();
