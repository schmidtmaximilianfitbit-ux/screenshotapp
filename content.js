(function () {
  // Guard against double-injection.
  if (document.getElementById("sb-overlay")) return;

  const DPR = window.devicePixelRatio || 1;
  let startX = 0, startY = 0, curX = 0, curY = 0;
  let dragging = false;

  /* ── DOM ─────────────────────────────────────────────────── */

  const overlay = el("div", {
    id: "sb-overlay",
    style: css({
      position: "fixed",
      inset: "0",
      zIndex: "2147483647",
      cursor: "crosshair",
      userSelect: "none",
      background: "rgba(0,0,0,0.35)",
    }),
  });

  const hint = el("div", {
    style: css({
      position: "absolute",
      top: "50%",
      left: "50%",
      transform: "translate(-50%,-50%)",
      color: "#e2e8f0",
      fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
      fontSize: "14px",
      background: "rgba(12,16,24,0.85)",
      padding: "9px 18px",
      borderRadius: "8px",
      border: "1px solid rgba(255,255,255,0.12)",
      pointerEvents: "none",
      whiteSpace: "nowrap",
      letterSpacing: "0.2px",
    }),
  });
  hint.textContent = "Drag to select a region  •  Esc to cancel";

  const selection = el("div", {
    id: "sb-selection",
    style: css({
      position: "fixed",
      display: "none",
      // Large spread shadow darkens everything outside the selection; no visible border on the rect itself.
      boxShadow: "0 0 0 99999px rgba(0,0,0,0.48)",
      pointerEvents: "none",
      boxSizing: "border-box",
    }),
  });

  const dimsLabel = el("div", {
    style: css({
      position: "fixed",
      display: "none",
      color: "#e2e8f0",
      fontFamily: "ui-monospace,SFMono-Regular,monospace",
      fontSize: "11px",
      background: "rgba(17,24,39,0.92)",
      padding: "3px 8px",
      borderRadius: "4px",
      border: "1px solid rgba(255,255,255,0.1)",
      pointerEvents: "none",
      whiteSpace: "nowrap",
    }),
  });

  overlay.append(hint, selection, dimsLabel);
  document.documentElement.appendChild(overlay);

  /* ── Drag logic ──────────────────────────────────────────── */

  overlay.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragging = true;
    startX = curX = e.clientX;
    startY = curY = e.clientY;
    // Switch from uniform dark overlay to box-shadow cutout.
    overlay.style.background = "transparent";
    hint.style.display = "none";
    renderSelection();
  });

  overlay.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    curX = e.clientX;
    curY = e.clientY;
    renderSelection();
  });

  overlay.addEventListener("mouseup", (e) => {
    if (!dragging || e.button !== 0) return;
    dragging = false;

    const x = Math.min(startX, curX);
    const y = Math.min(startY, curY);
    const w = Math.abs(curX - startX);
    const h = Math.abs(curY - startY);

    cleanup();

    // Treat a sub-4px drag as an accidental click — cancel silently.
    if (w < 4 || h < 4) return;

    chrome.runtime.sendMessage({
      type: "region-selected",
      rect: {
        x: Math.round(x * DPR),
        y: Math.round(y * DPR),
        width: Math.round(w * DPR),
        height: Math.round(h * DPR),
      },
    });
  });

  document.addEventListener("keydown", onKey, true);

  function onKey(e) {
    if (e.key === "Escape") cleanup();
  }

  function renderSelection() {
    const x = Math.min(startX, curX);
    const y = Math.min(startY, curY);
    const w = Math.abs(curX - startX);
    const h = Math.abs(curY - startY);

    Object.assign(selection.style, {
      left: `${x}px`,
      top: `${y}px`,
      width: `${w}px`,
      height: `${h}px`,
      display: "block",
    });

    // Dimensions in physical pixels.
    dimsLabel.textContent = `${Math.round(w * DPR)} × ${Math.round(h * DPR)}`;

    // Position pill at bottom-right of selection; flip if near viewport edge.
    const PAD = 6;
    const PILL_W = 90, PILL_H = 22;
    let dx = x + w + PAD;
    let dy = y + h + PAD;
    if (dx + PILL_W > window.innerWidth)  dx = x - PILL_W - PAD;
    if (dy + PILL_H > window.innerHeight) dy = y - PILL_H - PAD;

    Object.assign(dimsLabel.style, {
      left: `${dx}px`,
      top: `${dy}px`,
      display: "block",
    });
  }

  function cleanup() {
    overlay.remove();
    document.removeEventListener("keydown", onKey, true);
    dragging = false;
  }

  /* ── Tiny helpers ────────────────────────────────────────── */

  function el(tag, props = {}) {
    const node = document.createElement(tag);
    Object.assign(node, props);
    return node;
  }

  function css(obj) {
    return Object.entries(obj).map(([k, v]) => `${kebab(k)}:${v}`).join(";");
  }

  function kebab(s) {
    return s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  }
})();
