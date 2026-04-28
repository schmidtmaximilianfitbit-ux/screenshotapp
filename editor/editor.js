'use strict';

/* ── Constants ────────────────────────────────────────────── */

const BG_PRESETS = {
  flink:    ['#E2186F', '#FF7EB3', '#CCC5E0'],
  neonnight:['#1A2B5C', '#E2186F', '#FF7EB3'],
  lavender: ['#CCC5E0', '#E8E3F0', '#FFFFFF'],
  midnight: ['#1A2B5C', '#2A3E7A', '#3D5299'],
  magenta:  ['#E2186F', '#C4145F', '#8B0E43'],
  dusk:     ['#CCC5E0', '#1A2B5C'],
  blush:    ['#FF7EB3', '#FF5A99', '#E2186F'],
  deepsea:  ['#0A0A2E', '#1A2B5C', '#CCC5E0'],
  slate:    ['#2D3436', '#636E72', '#B2BEC3'],
  none:     null,
};

const RATIOS = {
  'auto':  null,
  '4:3':   { r: 4 / 3 },
  '3:2':   { r: 3 / 2 },
  '16:9':  { r: 16 / 9 },
  '1:1':   { r: 1 },
};

const BUILTIN_PRESETS = [
  { name: 'Clean', padding: 32, radius: 8, shadow: 20, bg: 'slate', ratio: 'auto', inset: 0, insetColor: '#ffffff' },
];

const FONT_MAP = {
  sans:  'Outfit, system-ui, sans-serif',
  serif: 'Georgia, serif',
  comic: '"Comic Sans MS", cursive',
  code:  '"DM Mono", monospace',
};

/* ── State ────────────────────────────────────────────────── */

const S = {
  img:              null,
  padding:          90,
  radius:           12,
  shadow:           40,
  bg:               'deepsea',
  bgCustomColor:    '#ffffff',
  bgCustomImage:    null,
  ratio:            'auto',
  inset:            40,
  insetColor:       '#ffffff',
  tool:             'draw',
  color:            '#1A2B5C',
  lw:               3,
  // annotation-tool sub-options
  textFont:         'sans',
  textStyle:        'normal',
  highlightRounded: false,
  zoomShape:        'circle',
  zoomLevel:        2.5,
  annotations:      [],
  undone:           [],
  current:          null,
  footerEnabled:    false,
  captureUrl:       null,
  captureTimestamp: null,
  captureUser:      null,
};

// Set by render(); used by zoom lens to map canvas→image coordinates.
let lastDims = null;

// User-created presets synced from chrome.storage.sync.
let userPresets = [];

// Eyedropper mode flags.
let eyedropperActive         = false;
let bgEyedropperActive       = false;
let annColorEyedropperActive = false;

// Annotation selection state.
let selectedIndex = -1;
let selDrag       = null; // { mode:'move'|'nw'|'ne'|'sw'|'se'|'p1'|'p2', startX, startY, orig }

/* ── DOM refs ─────────────────────────────────────────────── */

const canvas     = document.getElementById('canvas');
const ctx        = canvas.getContext('2d');
const canvasArea = document.getElementById('canvas-area');
const dropZone   = document.getElementById('drop-zone');
const btnCopy    = document.getElementById('btn-copy');
const btnExport  = document.getElementById('btn-export');
const btnUndo    = document.getElementById('btn-undo');
const btnRedo    = document.getElementById('btn-redo');

/* ── Render pipeline ──────────────────────────────────────── */

function computeDimensions() {
  const { padding, ratio, img } = S;
  const iw   = img.naturalWidth;
  const ih   = img.naturalHeight;
  const spec = RATIOS[ratio];

  let w, h;

  if (!spec) {
    w = iw + padding * 2;
    h = ih + padding * 2;
  } else if (spec.w) {
    w = spec.w;
    h = spec.h;
  } else {
    w = iw + padding * 2;
    h = Math.round(w / spec.r);
    if (h < ih + padding * 2) {
      h = ih + padding * 2;
      w = Math.round(h * spec.r);
    }
  }

  return {
    w,
    h,
    imgX: Math.round((w - iw) / 2),
    imgY: Math.round((h - ih) / 2),
  };
}

function drawBaseLayer(c, w, h, img, imgX, imgY) {
  const { radius, shadow, bg, bgCustomColor, bgCustomImage, insetColor } = S;

  // Background
  if (bg === 'custom-color') {
    c.fillStyle = bgCustomColor;
    c.fillRect(0, 0, w, h);
  } else if (bg === 'custom-image' && bgCustomImage) {
    const scale = Math.max(w / bgCustomImage.naturalWidth, h / bgCustomImage.naturalHeight);
    const sw    = bgCustomImage.naturalWidth  * scale;
    const sh    = bgCustomImage.naturalHeight * scale;
    c.drawImage(bgCustomImage, (w - sw) / 2, (h - sh) / 2, sw, sh);
  } else {
    const stops = BG_PRESETS[bg];
    if (stops) {
      const grad = c.createLinearGradient(0, 0, w, h);
      stops.forEach((col, i) => grad.addColorStop(i / (stops.length - 1), col));
      c.fillStyle = grad;
      c.fillRect(0, 0, w, h);
    } else {
      // Checkerboard (bg === 'none')
      c.fillStyle = '#fff';
      c.fillRect(0, 0, w, h);
      c.fillStyle = '#e5e7eb';
      const sq = 16;
      for (let gy = 0; gy < h; gy += sq) {
        for (let gx = 0; gx < w; gx += sq) {
          if (((gx / sq) + (gy / sq)) % 2 === 0) c.fillRect(gx, gy, sq, sq);
        }
      }
    }
  }

  if (!img) return;

  const iw = img.naturalWidth;
  const ih = img.naturalHeight;

  // Inset frame: a solid-color border between the background and the screenshot.
  // Clamped so it never exceeds the available padding on any side.
  const safeInset = Math.max(0, Math.min(S.inset, Math.min(imgX, imgY) - 2));
  const frameX = imgX - safeInset;
  const frameY = imgY - safeInset;
  const frameW = iw + safeInset * 2;
  const frameH = ih + safeInset * 2;
  const frameR = radius + safeInset * 0.6;

  // Shadow — cast from the outer frame rect so it radiates outside the inset border.
  // When inset = 0 the frame equals the image rect; '#000' fill is covered by the image.
  if (shadow > 0) {
    c.save();
    c.shadowColor   = `rgba(0,0,0,${(shadow / 100) * 0.6})`;
    c.shadowBlur    = shadow * 1.5;
    c.shadowOffsetY = shadow * 0.4;
    rrectPath(c, frameX, frameY, frameW, frameH, frameR);
    c.fillStyle = safeInset > 0 ? insetColor : '#000';
    c.fill();
    c.restore();
  } else if (safeInset > 0) {
    c.save();
    rrectPath(c, frameX, frameY, frameW, frameH, frameR);
    c.fillStyle = insetColor;
    c.fill();
    c.restore();
  }

  // Screenshot clipped to image rounded rect (covers the center of the inset frame).
  c.save();
  rrectPath(c, imgX, imgY, iw, ih, radius);
  c.clip();
  c.drawImage(img, imgX, imgY);
  c.restore();
}

function drawAnnotation(c, a, canvasW, canvasH) {
  c.save();
  c.strokeStyle = a.color;
  c.fillStyle   = a.color;
  c.lineWidth   = a.lw;
  c.lineCap     = 'round';
  c.lineJoin    = 'round';

  switch (a.type) {

    case 'draw':
      if (a.pts.length < 2) break;
      c.beginPath();
      c.moveTo(a.pts[0].x, a.pts[0].y);
      for (let i = 1; i < a.pts.length; i++) c.lineTo(a.pts[i].x, a.pts[i].y);
      c.stroke();
      break;

    case 'line':
      c.beginPath();
      c.moveTo(a.x1, a.y1);
      c.lineTo(a.x2, a.y2);
      c.stroke();
      break;

    case 'arrow':
      drawArrow(c, a.x1, a.y1, a.x2, a.y2, a.lw);
      break;

    case 'rect':
      c.strokeRect(a.x, a.y, a.w, a.h);
      break;

    case 'rect-r': {
      const rx = a.w >= 0 ? a.x : a.x + a.w;
      const ry = a.h >= 0 ? a.y : a.y + a.h;
      const rw = Math.abs(a.w);
      const rh = Math.abs(a.h);
      if (rw < 1 || rh < 1) break;
      rrectPath(c, rx, ry, rw, rh, Math.min(12, rw / 3, rh / 3));
      c.stroke();
      break;
    }

    case 'ellipse':
      if (a.w === 0 || a.h === 0) break;
      c.beginPath();
      c.ellipse(
        a.x + a.w / 2, a.y + a.h / 2,
        Math.abs(a.w / 2), Math.abs(a.h / 2),
        0, 0, Math.PI * 2
      );
      c.stroke();
      break;

    case 'highlight': {
      const hx = a.w >= 0 ? a.x : a.x + a.w;
      const hy = a.h >= 0 ? a.y : a.y + a.h;
      const hw = Math.abs(a.w);
      const hh = Math.abs(a.h);
      c.globalAlpha = 0.35;
      if (a.rounded && hw > 0 && hh > 0) {
        rrectPath(c, hx, hy, hw, hh, Math.min(10, hw / 3, hh / 3));
        c.fill();
      } else {
        c.fillRect(a.x, a.y, a.w, a.h);
      }
      c.globalAlpha = 1;
      break;
    }

    case 'text': {
      const fontSize  = Math.max(16, a.lw * 8);
      const tstyle    = a.textStyle || 'normal';
      const isBold    = tstyle === 'bold';
      const isItalic  = tstyle === 'italic';
      const parts     = [];
      if (isItalic) parts.push('italic');
      if (isBold)   parts.push('bold');
      parts.push(`${fontSize}px`, FONT_MAP[a.font] || FONT_MAP.sans);
      c.font         = parts.join(' ');
      c.textBaseline = 'top';
      c.fillText(a.text, a.x, a.y);
      if (tstyle === 'underline') {
        const tw = c.measureText(a.text).width;
        c.fillRect(a.x, a.y + fontSize + 2, tw, Math.max(1, Math.round(fontSize * 0.07)));
      }
      break;
    }

    case 'zoom':
      drawZoomLens(c, a, canvasW, canvasH);
      break;
  }

  c.restore();
}

function drawArrow(c, x1, y1, x2, y2, lw) {
  const angle   = Math.atan2(y2 - y1, x2 - x1);
  const headLen = Math.max(12, lw * 4);
  const headAng = 0.45;

  c.beginPath();
  c.moveTo(x1, y1);
  c.lineTo(x2, y2);
  c.stroke();

  c.beginPath();
  c.moveTo(x2, y2);
  c.lineTo(
    x2 - headLen * Math.cos(angle - headAng),
    y2 - headLen * Math.sin(angle - headAng)
  );
  c.lineTo(
    x2 - headLen * Math.cos(angle + headAng),
    y2 - headLen * Math.sin(angle + headAng)
  );
  c.closePath();
  c.fill();
}

/* ── Footer helpers ───────────────────────────────────────── */

function colorLuminance(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function isBackgroundLight() {
  const { bg, bgCustomColor } = S;
  if (bg === 'custom-color') return colorLuminance(bgCustomColor) > 0.35;
  if (bg === 'none') return true;
  if (bg === 'custom-image') return false;
  const stops = BG_PRESETS[bg];
  if (!stops) return false;
  const avg = stops.reduce((s, c) => s + colorLuminance(c), 0) / stops.length;
  return avg > 0.35;
}

function formatTimestamp(ts) {
  const d = new Date(ts);
  const date = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `${date}  ${time}`;
}

function extractUrlLabel(url) {
  if (!url) return '';
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    const parts = host.split('.');
    if (parts.length > 1) parts.pop();
    return parts.join('.');
  } catch { return ''; }
}

function emailToName(email) {
  if (!email) return '';
  const local = email.split('@')[0];
  return local.split(/[._\-+]/)
    .slice(0, 2)
    .map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join(' ');
}

function drawFooter(c, w, h, dims) {
  if (!S.footerEnabled) return;

  const light    = isBackgroundLight();
  const textColor = light ? '#1A2B5C' : 'rgba(255,255,255,0.82)';
  const fontSize = Math.max(11, Math.round(Math.min(dims.imgX, dims.imgY) * 0.28));
  const padX     = dims.imgX;
  const baseY    = h - Math.max(10, Math.round(dims.imgY * 0.28));

  c.save();
  c.font         = `500 ${fontSize}px Montserrat, system-ui, sans-serif`;
  c.fillStyle    = textColor;
  c.textBaseline = 'alphabetic';

  const name = S.captureUser || '';
  c.textAlign = 'left';
  c.fillText(name, padX, baseY);

  const ts = formatTimestamp(S.captureTimestamp || Date.now());
  c.textAlign = 'center';
  c.fillText(ts, w / 2, baseY);

  const label = extractUrlLabel(S.captureUrl || '');
  c.textAlign = 'right';
  c.fillText(label, w - padX, baseY);

  c.restore();
}

function drawZoomLens(c, a, canvasW, canvasH) {
  if (!S.img || !lastDims) return;

  // The drawn rect defines the SOURCE area on the screenshot to magnify.
  const sx    = Math.min(a.x, a.x + a.w);
  const sy    = Math.min(a.y, a.y + a.h);
  const sw    = Math.max(Math.abs(a.w), 10);
  const sh    = Math.max(Math.abs(a.h), 10);
  const zoom  = a.zoom || 2.5;
  const shape = a.shape || 'circle';
  const scx   = sx + sw / 2;
  const scy   = sy + sh / 2;

  // Output lens = source × zoom factor, centered on the source area.
  const lw = sw * zoom;
  const lh = sh * zoom;

  let lx = scx - lw / 2;
  let ly = scy - lh / 2;
  // Clamp to canvas bounds.
  lx = Math.max(0, Math.min(lx, canvasW - lw));
  ly = Math.max(0, Math.min(ly, canvasH - lh));
  const lcx = lx + lw / 2;
  const lcy = ly + lh / 2;

  const osc = new OffscreenCanvas(canvasW, canvasH);
  drawBaseLayer(osc.getContext('2d'), canvasW, canvasH, S.img, lastDims.imgX, lastDims.imgY);

  function lensPath(ctx) {
    ctx.beginPath();
    if (shape === 'circle') {
      ctx.arc(lcx, lcy, Math.min(lw, lh) / 2, 0, Math.PI * 2);
    } else if (shape === 'rect') {
      ctx.rect(lx, ly, lw, lh);
    } else {
      rrectPath(ctx, lx, ly, lw, lh, 12);
    }
  }

  // Clip to lens shape; draw full source rect into lens (= zoom× magnification of entire source).
  c.save();
  lensPath(c);
  c.clip();
  c.drawImage(osc, sx, sy, sw, sh, lx, ly, lw, lh);
  c.restore();

  // Lens border.
  c.save();
  c.strokeStyle = a.color;
  c.lineWidth   = 2.5;
  lensPath(c);
  c.stroke();
  c.restore();


}

function render() {
  if (!S.img) { updateUI(); return; }

  const dims = computeDimensions();
  lastDims = dims;

  canvas.width  = dims.w;
  canvas.height = dims.h;

  drawBaseLayer(ctx, dims.w, dims.h, S.img, dims.imgX, dims.imgY);

  const all = [...S.annotations, ...(S.current ? [S.current] : [])];
  all.forEach(a => drawAnnotation(ctx, a, dims.w, dims.h));

  drawFooter(ctx, dims.w, dims.h, dims);

  drawSelectionOverlay(ctx);
  positionSelectionToolbar();

  updateUI();
}

/* ── Helpers ──────────────────────────────────────────────── */

function rrectPath(c, x, y, w, h, r) {
  r = Math.min(r, Math.min(w, h) / 2);
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y,     x + w, y + h, r);
  c.arcTo(x + w, y + h, x,     y + h, r);
  c.arcTo(x,     y + h, x,     y,     r);
  c.arcTo(x,     y,     x + w, y,     r);
  c.closePath();
}

function getCoords(e) {
  const r = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) * (canvas.width  / r.width),
    y: (e.clientY - r.top)  * (canvas.height / r.height),
  };
}

/* ── Annotation selection helpers ────────────────────────── */

function getAnnotationBBox(a) {
  if (!a) return null;
  switch (a.type) {
    case 'rect': case 'rect-r': case 'ellipse': case 'highlight': case 'zoom':
      return { x: Math.min(a.x, a.x + a.w), y: Math.min(a.y, a.y + a.h),
               w: Math.max(Math.abs(a.w), 4), h: Math.max(Math.abs(a.h), 4) };
    case 'line': case 'arrow':
      return { x: Math.min(a.x1, a.x2), y: Math.min(a.y1, a.y2),
               w: Math.max(Math.abs(a.x2 - a.x1), 4), h: Math.max(Math.abs(a.y2 - a.y1), 4) };
    case 'draw': {
      if (!a.pts || !a.pts.length) return null;
      const xs = a.pts.map(p => p.x), ys = a.pts.map(p => p.y);
      return { x: Math.min(...xs), y: Math.min(...ys),
               w: Math.max(Math.max(...xs) - Math.min(...xs), 4),
               h: Math.max(Math.max(...ys) - Math.min(...ys), 4) };
    }
    case 'text': {
      const fs = Math.max(16, a.lw * 8);
      const approxW = a.text ? a.text.length * fs * 0.55 : 80;
      return { x: a.x, y: a.y, w: Math.max(approxW, 20), h: fs + 4 };
    }
    default: return null;
  }
}

function hitTestAnnotations(x, y) {
  const PAD = 8;
  for (let i = S.annotations.length - 1; i >= 0; i--) {
    const bb = getAnnotationBBox(S.annotations[i]);
    if (!bb) continue;
    if (x >= bb.x - PAD && x <= bb.x + bb.w + PAD &&
        y >= bb.y - PAD && y <= bb.y + bb.h + PAD) return i;
  }
  return -1;
}

function getHandleAt(x, y) {
  if (selectedIndex < 0 || selectedIndex >= S.annotations.length) return null;
  const a  = S.annotations[selectedIndex];
  const bb = getAnnotationBBox(a);
  if (!bb) return null;

  const PAD = 6, H = 9;
  const bx = bb.x - PAD, by = bb.y - PAD, bw = bb.w + PAD * 2, bh = bb.h + PAD * 2;

  // For line/arrow expose endpoint handles (p1, p2) instead of corners.
  if (a.type === 'line' || a.type === 'arrow') {
    if (Math.abs(x - a.x1) <= H && Math.abs(y - a.y1) <= H) return 'p1';
    if (Math.abs(x - a.x2) <= H && Math.abs(y - a.y2) <= H) return 'p2';
    return null;
  }

  const corners = { nw: [bx, by], ne: [bx + bw, by], sw: [bx, by + bh], se: [bx + bw, by + bh] };
  for (const [name, [hx, hy]] of Object.entries(corners)) {
    if (Math.abs(x - hx) <= H && Math.abs(y - hy) <= H) return name;
  }
  return null;
}

function moveAnnotation(a, orig, dx, dy) {
  switch (a.type) {
    case 'rect': case 'rect-r': case 'ellipse': case 'highlight': case 'zoom': case 'text':
      a.x = orig.x + dx; a.y = orig.y + dy; break;
    case 'line': case 'arrow':
      a.x1 = orig.x1 + dx; a.y1 = orig.y1 + dy;
      a.x2 = orig.x2 + dx; a.y2 = orig.y2 + dy; break;
    case 'draw':
      a.pts = orig.pts.map(p => ({ x: p.x + dx, y: p.y + dy })); break;
  }
}

function resizeAnnotation(a, orig, handle, dx, dy) {
  if (handle === 'p1') { a.x1 = orig.x1 + dx; a.y1 = orig.y1 + dy; return; }
  if (handle === 'p2') { a.x2 = orig.x2 + dx; a.y2 = orig.y2 + dy; return; }

  const bb = getAnnotationBBox(orig);
  if (!bb) return;
  let { x: nx, y: ny, w: nw, h: nh } = bb;
  if (handle === 'nw') { nx += dx; ny += dy; nw -= dx; nh -= dy; }
  else if (handle === 'ne') { ny += dy; nw += dx; nh -= dy; }
  else if (handle === 'sw') { nx += dx; nw -= dx; nh += dy; }
  else if (handle === 'se') { nw += dx; nh += dy; }

  a.x = nx; a.y = ny;
  a.w = Math.max(4, nw);
  a.h = Math.max(4, nh);
}

function drawSelectionOverlay(c) {
  if (selectedIndex < 0 || selectedIndex >= S.annotations.length) return;
  const a  = S.annotations[selectedIndex];
  const bb = getAnnotationBBox(a);
  if (!bb) return;

  const PAD = 6, H = 7;
  const bx = bb.x - PAD, by = bb.y - PAD, bw = bb.w + PAD * 2, bh = bb.h + PAD * 2;

  c.save();
  c.strokeStyle = '#3D5299';
  c.lineWidth   = 1.5;
  c.setLineDash([4, 3]);
  c.strokeRect(bx, by, bw, bh);
  c.setLineDash([]);

  let handles;
  if (a.type === 'line' || a.type === 'arrow') {
    handles = [[a.x1, a.y1], [a.x2, a.y2]];
  } else if (a.type === 'draw' || a.type === 'text') {
    handles = [];
  } else {
    handles = [[bx, by], [bx + bw, by], [bx, by + bh], [bx + bw, by + bh]];
  }

  c.fillStyle   = '#FFFFFF';
  c.strokeStyle = '#3D5299';
  c.lineWidth   = 1.5;
  handles.forEach(([hx, hy]) => {
    c.fillRect(hx - H / 2, hy - H / 2, H, H);
    c.strokeRect(hx - H / 2, hy - H / 2, H, H);
  });
  c.restore();
}

function canvasToScreen(cx, cy) {
  const r = canvas.getBoundingClientRect();
  return {
    x: r.left + cx * (r.width  / canvas.width),
    y: r.top  + cy * (r.height / canvas.height),
  };
}

function positionSelectionToolbar() {
  const tb = document.getElementById('ann-toolbar');
  if (!tb) return;

  if (selectedIndex < 0 || selectedIndex >= S.annotations.length || S.current) {
    tb.style.display = 'none';
    return;
  }

  const a  = S.annotations[selectedIndex];
  const bb = getAnnotationBBox(a);
  if (!bb) { tb.style.display = 'none'; return; }

  const PAD = 6;
  // Position the ✕ button at the top-right corner of the dashed selection box.
  const pt  = canvasToScreen(bb.x + bb.w + PAD, bb.y - PAD);

  tb.style.display = 'flex';
  tb.style.left    = `${Math.round(pt.x) + 2}px`;
  tb.style.top     = `${Math.round(pt.y) - 2}px`;
}

function syncSidebarToSelection() {
  if (selectedIndex < 0 || selectedIndex >= S.annotations.length) return;
  const a = S.annotations[selectedIndex];

  // Auto-switch to Annotate tab.
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === 'annotate'));
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.getElementById('panel-annotate').classList.add('active');

  // Highlight the matching tool button.
  document.querySelectorAll('.tool-cell').forEach(b => b.classList.toggle('active', b.dataset.tool === a.type));

  // Color.
  S.color = a.color;
  document.getElementById('ann-color-picker').value = a.color;
  const presetMatch = [...document.querySelectorAll('.color-dot[data-color]')].some(b => {
    const m = b.dataset.color.toLowerCase() === a.color.toLowerCase();
    b.classList.toggle('active', m);
    return m;
  });
  const customBtn = document.getElementById('btn-ann-custom-color');
  if (!presetMatch) {
    customBtn.style.background = a.color;
    customBtn.classList.add('active');
  } else {
    customBtn.classList.remove('active');
  }

  // Line width.
  S.lw = a.lw;
  document.getElementById('sl-lw').value = a.lw;
  document.getElementById('val-lw').textContent = a.lw + 'px';

  // Show tool-specific option panel.
  S.tool = a.type;
  updateToolOptions();

  if (a.type === 'highlight') {
    const style = a.rounded ? 'rounded' : 'normal';
    document.querySelectorAll('[data-hstyle]').forEach(b => b.classList.toggle('active', b.dataset.hstyle === style));
    S.highlightRounded = a.rounded;
  }

  if (a.type === 'text') {
    const font = a.font || 'sans';
    document.querySelectorAll('[data-font]').forEach(b => b.classList.toggle('active', b.dataset.font === font));
    S.textFont = font;
    const tstyle = a.textStyle || 'normal';
    document.querySelectorAll('[data-tstyle]').forEach(b => b.classList.toggle('active', b.dataset.tstyle === tstyle));
    S.textStyle = tstyle;
  }

  if (a.type === 'zoom') {
    const shape = a.shape || 'circle';
    document.querySelectorAll('[data-zshape]').forEach(b => b.classList.toggle('active', b.dataset.zshape === shape));
    S.zoomShape = shape;
    const zl = a.zoom || 2.5;
    S.zoomLevel = zl;
    document.getElementById('sl-zoom-level').value = Math.round(zl * 10);
    document.getElementById('val-zoom-level').textContent = zl.toFixed(1) + '×';
  }
}

/* ── Canvas mouse events ──────────────────────────────────── */

let mouseDown = false;

canvas.addEventListener('mousedown', (e) => {
  if (!S.img || e.button !== 0) return;

  // ── Eyedropper modes ──────────────────────────────────────────
  const sampleHex = (x, y) => {
    const px = ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data;
    return '#' + [px[0], px[1], px[2]].map(v => v.toString(16).padStart(2, '0')).join('');
  };

  if (bgEyedropperActive) {
    const { x, y } = getCoords(e);
    S.bgCustomColor = sampleHex(x, y);
    S.bg = 'custom-color';
    bgEyedropperActive = false;
    document.getElementById('btn-bg-eyedropper').classList.remove('active');
    updateUI(); updateBgSwatch(); render();
    return;
  }

  if (annColorEyedropperActive) {
    const { x, y } = getCoords(e);
    S.color = sampleHex(x, y);
    const customBtn = document.getElementById('btn-ann-custom-color');
    customBtn.style.background = S.color;
    document.getElementById('ann-color-picker').value = S.color;
    document.querySelectorAll('.color-dot').forEach(b => b.classList.remove('active'));
    customBtn.classList.add('active');
    annColorEyedropperActive = false;
    document.getElementById('btn-ann-color-eyedropper').classList.remove('active');
    updateUI();
    return;
  }

  if (eyedropperActive) {
    const { x, y } = getCoords(e);
    S.insetColor = sampleHex(x, y);
    document.getElementById('inset-color-picker').value = S.insetColor;
    eyedropperActive = false;
    document.getElementById('btn-eyedropper').classList.remove('active');
    updateUI(); render();
    return;
  }

  // ── Normal tool handling ───────────────────────────────────────
  const { x, y } = getCoords(e);

  // Check resize handle on already-selected annotation first.
  const handle = getHandleAt(x, y);
  if (handle) {
    mouseDown = true;
    selDrag = { mode: handle, startX: x, startY: y,
                orig: JSON.parse(JSON.stringify(S.annotations[selectedIndex])) };
    return;
  }

  // Check if clicking on an existing annotation to select/move it.
  const hitIdx = hitTestAnnotations(x, y);

  // Clicking on an already-selected text annotation → re-edit the text.
  if (hitIdx >= 0 && hitIdx === selectedIndex && S.annotations[hitIdx].type === 'text') {
    const a = S.annotations.splice(hitIdx, 1)[0];
    selectedIndex = -1;
    positionSelectionToolbar();
    spawnTextInput(e.clientX, e.clientY, a.x, a.y, a);
    return;
  }

  if (hitIdx >= 0) {
    mouseDown = true;
    selectedIndex = hitIdx;
    selDrag = { mode: 'move', startX: x, startY: y,
                orig: JSON.parse(JSON.stringify(S.annotations[hitIdx])) };
    syncSidebarToSelection();
    render();
    return;
  }

  // Clicked empty canvas: deselect and start drawing.
  selectedIndex = -1;
  positionSelectionToolbar();
  mouseDown = true;

  if (S.tool === 'text') {
    spawnTextInput(e.clientX, e.clientY, x, y);
    return;
  }

  const base = { color: S.color, lw: S.lw };

  switch (S.tool) {
    case 'draw':      S.current = { ...base, type: 'draw',      pts: [{ x, y }] };              break;
    case 'line':      S.current = { ...base, type: 'line',      x1: x, y1: y, x2: x, y2: y };  break;
    case 'arrow':     S.current = { ...base, type: 'arrow',     x1: x, y1: y, x2: x, y2: y };  break;
    case 'rect':      S.current = { ...base, type: 'rect',      x, y, w: 0, h: 0 };             break;
    case 'rect-r':    S.current = { ...base, type: 'rect-r',    x, y, w: 0, h: 0 };             break;
    case 'ellipse':   S.current = { ...base, type: 'ellipse',   x, y, w: 0, h: 0 };             break;
    case 'highlight': S.current = { ...base, type: 'highlight', x, y, w: 0, h: 0, rounded: S.highlightRounded }; break;
    case 'zoom':      S.current = { ...base, type: 'zoom',      x, y, w: 0, h: 0, zoom: S.zoomLevel, shape: S.zoomShape }; break;
  }
});

canvas.addEventListener('mousemove', (e) => {
  const { x, y } = getCoords(e);

  // Hover cursor when not drawing/dragging.
  if (!mouseDown && S.img) {
    if (bgEyedropperActive || annColorEyedropperActive || eyedropperActive) {
      canvas.style.cursor = 'crosshair';
    } else {
      const handle = getHandleAt(x, y);
      if (handle) {
        const RES = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', p1: 'move', p2: 'move' };
        canvas.style.cursor = RES[handle] || 'pointer';
      } else if (hitTestAnnotations(x, y) >= 0) {
        canvas.style.cursor = 'grab';
      } else {
        canvas.style.cursor = S.tool === 'text' ? 'text' : 'crosshair';
      }
    }
  }

  if (!mouseDown) return;

  // Grabbing cursor while dragging a selection.
  if (selDrag) canvas.style.cursor = 'grabbing';

  // Selection drag (move or resize).
  if (selDrag && selectedIndex >= 0 && selectedIndex < S.annotations.length) {
    const dx = x - selDrag.startX;
    const dy = y - selDrag.startY;
    const a  = S.annotations[selectedIndex];
    if (selDrag.mode === 'move') moveAnnotation(a, selDrag.orig, dx, dy);
    else resizeAnnotation(a, selDrag.orig, selDrag.mode, dx, dy);
    render();
    return;
  }

  if (!S.current) return;
  const a = S.current;

  switch (a.type) {
    case 'draw':
      a.pts.push({ x, y });
      break;
    case 'line': case 'arrow':
      a.x2 = x; a.y2 = y;
      break;
    case 'rect': case 'rect-r': case 'highlight': case 'zoom':
      a.w = x - a.x; a.h = y - a.y;
      break;
    case 'ellipse':
      a.w = x - a.x; a.h = y - a.y;
      if (e.shiftKey) {
        const s = Math.min(Math.abs(a.w), Math.abs(a.h));
        a.w = Math.sign(a.w) * s || s;
        a.h = Math.sign(a.h) * s || s;
      }
      break;
  }

  render();
});

canvas.addEventListener('mouseup',    commitCurrent);
canvas.addEventListener('mouseleave', commitCurrent);

function commitCurrent() {
  if (!mouseDown) return;
  mouseDown = false;

  if (selDrag) {
    selDrag = null;
    render();
    return;
  }

  if (S.current) {
    S.annotations.push(S.current);
    S.current = null;
    S.undone  = [];
    render();
  }
}

/* ── Floating text input ──────────────────────────────────── */

function spawnTextInput(clientX, clientY, canvasX, canvasY, existingAnn = null) {
  // Use the existing annotation's properties when re-editing, otherwise current sidebar state.
  const annColor  = existingAnn ? existingAnn.color    : S.color;
  const annFont   = existingAnn ? existingAnn.font      : S.textFont;
  const annStyle  = existingAnn ? (existingAnn.textStyle || 'normal') : S.textStyle;
  const annLw     = existingAnn ? existingAnn.lw        : S.lw;

  const canvasFontSize = Math.max(16, annLw * 8);
  // Scale canvas pixel font size to CSS pixels so the input matches what renders on canvas.
  const r = canvas.getBoundingClientRect();
  const cssScale = canvas.width > 0 ? r.width / canvas.width : 1;
  const displayFontSize = Math.round(canvasFontSize * cssScale);

  const isBold   = annStyle === 'bold';
  const isItalic = annStyle === 'italic';

  const inp = document.createElement('input');
  inp.type = 'text';
  inp.placeholder = 'Type here…';
  if (existingAnn) inp.value = existingAnn.text;

  // Position at the canvas annotation coordinates converted to screen coords.
  const screenPos = existingAnn ? canvasToScreen(canvasX, canvasY) : { x: clientX, y: clientY };

  Object.assign(inp.style, {
    position:       'fixed',
    left:           `${Math.min(screenPos.x, window.innerWidth - 180)}px`,
    top:            `${Math.min(screenPos.y, window.innerHeight - 48)}px`,
    zIndex:         '99999',
    background:     'transparent',
    border:         'none',
    borderBottom:   `2px solid ${annColor}`,
    color:          annColor,
    padding:        '3px 2px',
    borderRadius:   '0',
    fontFamily:     FONT_MAP[annFont] || FONT_MAP.sans,
    fontSize:       `${displayFontSize}px`,
    fontWeight:     isBold ? 'bold' : 'normal',
    fontStyle:      isItalic ? 'italic' : 'normal',
    textDecoration: annStyle === 'underline' ? 'underline' : 'none',
    minWidth:       '120px',
    outline:        'none',
    boxShadow:      'none',
    caretColor:     annColor,
  });
  document.body.appendChild(inp);

  // Select all text when re-editing an existing annotation.
  requestAnimationFrame(() => { inp.focus(); if (existingAnn) inp.select(); });

  let committed = false;

  const commit = () => {
    if (committed) return;
    committed = true;
    const text = inp.value.trim();
    inp.remove();
    if (!text) return;
    S.annotations.push({
      type: 'text', color: annColor, lw: annLw, font: annFont,
      textStyle: annStyle, text, x: canvasX, y: canvasY,
    });
    S.undone = [];
    render();
  };

  const cancel = () => { if (committed) return; committed = true; inp.remove(); };

  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    e.stopPropagation();
  });

  // Small delay prevents the initial mousedown from triggering blur+commit immediately.
  setTimeout(() => {
    inp.addEventListener('blur', () => setTimeout(() => { inp.value.trim() ? commit() : cancel(); }, 80));
  }, 200);
}

/* ── Undo / Redo ──────────────────────────────────────────── */

function undo() {
  if (!S.annotations.length) return;
  S.undone.unshift(S.annotations.pop());
  selectedIndex = -1;
  render();
}

function redo() {
  if (!S.undone.length) return;
  S.annotations.push(S.undone.shift());
  selectedIndex = -1;
  render();
}

btnUndo.addEventListener('click', undo);
btnRedo.addEventListener('click', redo);

document.getElementById('btn-clear-ann').addEventListener('click', () => {
  S.annotations = [];
  S.undone = [];
  selectedIndex = -1;
  render();
});

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;

  if (e.key === 'Escape') {
    selectedIndex = -1;
    positionSelectionToolbar();
    render();
    return;
  }

  if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIndex >= 0) {
    e.preventDefault();
    S.annotations.splice(selectedIndex, 1);
    selectedIndex = -1;
    positionSelectionToolbar();
    render();
    return;
  }

  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return;

  const key = e.key.toLowerCase();

  if (key === 'z') {
    e.preventDefault();
    e.shiftKey ? redo() : undo();
    return;
  }

  if (key === 'c') {
    e.preventDefault();
    btnCopy.click();
    return;
  }

  if (key === 's') {
    e.preventDefault();
    btnExport.click();
  }
});

/* ── UI state sync ────────────────────────────────────────── */

function updateUI() {
  const has = Boolean(S.img);

  canvas.style.display    = has ? 'block' : 'none';
  dropZone.style.display  = has ? 'none'  : 'flex';
  document.getElementById('btn-clear-image').hidden = !has;

  if (has) {
    if (bgEyedropperActive || annColorEyedropperActive || eyedropperActive) {
      canvas.style.cursor = 'crosshair';
    }
  }

  btnCopy.disabled   = !has;
  btnExport.disabled = !has;
  btnUndo.disabled   = S.annotations.length === 0;
  btnRedo.disabled   = S.undone.length === 0;
}

/* ── Sidebar control events ───────────────────────────────── */

// Sliders
[
  ['sl-padding', 'val-padding', 'padding', v => v + 'px'],
  ['sl-radius',  'val-radius',  'radius',  v => v + 'px'],
  ['sl-shadow',  'val-shadow',  'shadow',  v => v + '%'],
].forEach(([id, valId, key, fmt]) => {
  document.getElementById(id).addEventListener('input', function () {
    S[key] = +this.value;
    document.getElementById(valId).textContent = fmt(S[key]);
    render();
  });
});

document.getElementById('sl-lw').addEventListener('input', function () {
  S.lw = +this.value;
  document.getElementById('val-lw').textContent = S.lw + 'px';
  if (selectedIndex >= 0 && selectedIndex < S.annotations.length) {
    S.annotations[selectedIndex].lw = S.lw;
    render();
  }
});

document.getElementById('sl-inset').addEventListener('input', function () {
  S.inset = +this.value;
  document.getElementById('val-inset').textContent = S.inset + 'px';
  render();
});

document.getElementById('inset-color-picker').addEventListener('input', function () {
  S.insetColor = this.value;
  render();
});

/* ── Inset color helpers ──────────────────────────────────── */

function sampleEdgeColor() {
  if (!S.img) return;
  const w = S.img.naturalWidth;
  const h = S.img.naturalHeight;
  const tmp = document.createElement('canvas');
  tmp.width = w;
  tmp.height = h;
  const tctx = tmp.getContext('2d');
  tctx.drawImage(S.img, 0, 0);

  let r = 0, g = 0, b = 0, n = 0;
  const N = 24;
  const add = (x, y) => {
    const d = tctx.getImageData(
      Math.max(0, Math.min(Math.round(x), w - 1)),
      Math.max(0, Math.min(Math.round(y), h - 1)), 1, 1).data;
    r += d[0]; g += d[1]; b += d[2]; n++;
  };
  // Sample a ring of pixels evenly along all four edges.
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    add(t * (w - 1), 0);
    add(t * (w - 1), h - 1);
    add(0, t * (h - 1));
    add(w - 1, t * (h - 1));
  }

  r = Math.round(r / n); g = Math.round(g / n); b = Math.round(b / n);
  S.insetColor = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
  document.getElementById('inset-color-picker').value = S.insetColor;
  render();
}

document.getElementById('btn-auto-sample').addEventListener('click', sampleEdgeColor);

document.getElementById('btn-eyedropper').addEventListener('click', () => {
  eyedropperActive = !eyedropperActive;
  document.getElementById('btn-eyedropper').classList.toggle('active', eyedropperActive);
  updateUI();
});

/* ── Background helpers ───────────────────────────────────── */

function updateBgSwatch() {
  const isCustom = S.bg === 'custom-color' || S.bg === 'custom-image';

  document.querySelectorAll('.swatch').forEach(b =>
    b.classList.toggle('active', !isCustom && b.dataset.bg === S.bg)
  );

  const colorRow = document.getElementById('custom-color-row');
  if (S.bg === 'custom-color' && S.bgCustomColor) {
    colorRow.style.display = 'flex';
    document.getElementById('custom-color-circle').style.background = S.bgCustomColor;
    document.getElementById('custom-color-hex').textContent = S.bgCustomColor;
  } else {
    colorRow.style.display = 'none';
  }

  document.getElementById('bg-image-preview').style.display =
    (S.bg === 'custom-image' && S.bgCustomImage) ? 'block' : 'none';
}

// Background swatches
document.querySelectorAll('.swatch').forEach(btn => {
  btn.addEventListener('click', () => {
    S.bg = btn.dataset.bg;
    updateBgSwatch();
    render();
  });
});

// Pick bg color from canvas (eyedropper)
document.getElementById('btn-bg-eyedropper').addEventListener('click', () => {
  bgEyedropperActive = !bgEyedropperActive;
  document.getElementById('btn-bg-eyedropper').classList.toggle('active', bgEyedropperActive);
  if (bgEyedropperActive) {
    eyedropperActive = false;
    document.getElementById('btn-eyedropper').classList.remove('active');
  }
  updateUI();
});

// Image background upload
document.getElementById('btn-bg-image').addEventListener('click', () => {
  document.getElementById('bg-image-input').click();
});

document.getElementById('bg-image-input').addEventListener('change', function () {
  const file = this.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    const img = new Image();
    img.onload = () => {
      S.bgCustomImage = img;
      S.bg = 'custom-image';
      document.getElementById('bg-image-thumb').src = ev.target.result;
      updateBgSwatch();
      render();
    };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
  this.value = '';
});

document.getElementById('btn-remove-bg-image').addEventListener('click', () => {
  S.bgCustomImage = null;
  S.bg = 'flink';
  updateBgSwatch();
  render();
});

// Ratio pills (both rows share data-ratio)
document.querySelectorAll('.pill').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.pill').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    S.ratio = btn.dataset.ratio;
    render();
  });
});

// Annotation tools
document.querySelectorAll('.tool-cell').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tool-cell').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    S.tool = btn.dataset.tool;
    updateToolOptions();
    updateUI();
  });
});

function updateToolOptions() {
  ['highlight', 'text', 'zoom'].forEach(t => {
    const el = document.getElementById(`opt-${t}`);
    if (el) el.style.display = S.tool === t ? 'flex' : 'none';
  });
  const textStyleEl = document.getElementById('opt-text-style');
  if (textStyleEl) textStyleEl.style.display = S.tool === 'text' ? 'flex' : 'none';
}

// ── Highlight style toggle ────────────────────────────────────
document.querySelectorAll('[data-hstyle]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-hstyle]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    S.highlightRounded = btn.dataset.hstyle === 'rounded';
    if (selectedIndex >= 0 && selectedIndex < S.annotations.length &&
        S.annotations[selectedIndex].type === 'highlight') {
      S.annotations[selectedIndex].rounded = S.highlightRounded;
      render();
    }
  });
});

// ── Text font selector ────────────────────────────────────────
document.querySelectorAll('[data-font]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-font]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    S.textFont = btn.dataset.font;
    if (selectedIndex >= 0 && selectedIndex < S.annotations.length &&
        S.annotations[selectedIndex].type === 'text') {
      S.annotations[selectedIndex].font = S.textFont;
      render();
    }
  });
});

// ── Text style selector (Normal / Bold / Italic / Underline) ──
document.querySelectorAll('[data-tstyle]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-tstyle]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    S.textStyle = btn.dataset.tstyle;
    if (selectedIndex >= 0 && selectedIndex < S.annotations.length &&
        S.annotations[selectedIndex].type === 'text') {
      S.annotations[selectedIndex].textStyle = S.textStyle;
      render();
    }
  });
});

// ── Zoom shape + label ────────────────────────────────────────
document.querySelectorAll('[data-zshape]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-zshape]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    S.zoomShape = btn.dataset.zshape;
    if (selectedIndex >= 0 && selectedIndex < S.annotations.length &&
        S.annotations[selectedIndex].type === 'zoom') {
      S.annotations[selectedIndex].shape = S.zoomShape;
      render();
    }
  });
});

document.getElementById('sl-zoom-level').addEventListener('input', function () {
  S.zoomLevel = +this.value / 10;
  document.getElementById('val-zoom-level').textContent = S.zoomLevel.toFixed(1) + '×';
  if (selectedIndex >= 0 && selectedIndex < S.annotations.length &&
      S.annotations[selectedIndex].type === 'zoom') {
    S.annotations[selectedIndex].zoom = S.zoomLevel;
    render();
  }
});

// ── Annotation color dots (preset) ───────────────────────────
document.querySelectorAll('.color-dot[data-color]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.color-dot').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    S.color = btn.dataset.color;
    if (selectedIndex >= 0 && selectedIndex < S.annotations.length) {
      S.annotations[selectedIndex].color = S.color;
      render();
    }
  });
});

// ── Custom color picker ───────────────────────────────────────
document.getElementById('btn-ann-custom-color').addEventListener('click', () => {
  document.getElementById('ann-color-picker').click();
});

document.getElementById('ann-color-picker').addEventListener('input', function () {
  S.color = this.value;
  const customBtn = document.getElementById('btn-ann-custom-color');
  customBtn.style.background = this.value;
  document.querySelectorAll('.color-dot').forEach(b => b.classList.remove('active'));
  customBtn.classList.add('active');
  if (selectedIndex >= 0 && selectedIndex < S.annotations.length) {
    S.annotations[selectedIndex].color = S.color;
    render();
  }
});

// ── Annotation color eyedropper ───────────────────────────────
document.getElementById('btn-ann-color-eyedropper').addEventListener('click', () => {
  annColorEyedropperActive = !annColorEyedropperActive;
  document.getElementById('btn-ann-color-eyedropper').classList.toggle('active', annColorEyedropperActive);
  if (annColorEyedropperActive) {
    bgEyedropperActive = false;
    document.getElementById('btn-bg-eyedropper')?.classList.remove('active');
    eyedropperActive = false;
    document.getElementById('btn-eyedropper').classList.remove('active');
  }
  updateUI();
});

// ── Floating selection toolbar ────────────────────────────────
document.getElementById('ann-tb-delete').addEventListener('click', () => {
  if (selectedIndex >= 0 && selectedIndex < S.annotations.length) {
    S.annotations.splice(selectedIndex, 1);
    selectedIndex = -1;
    positionSelectionToolbar();
    render();
  }
});

// Tab switching
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    document.getElementById(`panel-${btn.dataset.tab}`).classList.add('active');
  });
});

/* ── Preset management ────────────────────────────────────── */

function applySettings({ padding, radius, shadow, bg, bgCustomColor = '#ffffff', ratio, inset = 0, insetColor = '#ffffff' }) {
  S.padding       = padding;
  S.radius        = radius;
  S.shadow        = shadow;
  S.bg            = bg;
  S.bgCustomColor = bgCustomColor;
  S.ratio         = ratio;
  S.inset         = inset;
  S.insetColor    = insetColor;

  // Sync slider positions and displayed values
  document.getElementById('sl-padding').value         = padding;
  document.getElementById('val-padding').textContent  = padding + 'px';
  document.getElementById('sl-radius').value         = radius;
  document.getElementById('val-radius').textContent   = radius + 'px';
  document.getElementById('sl-shadow').value         = shadow;
  document.getElementById('val-shadow').textContent   = shadow + '%';
  document.getElementById('sl-inset').value          = inset;
  document.getElementById('val-inset').textContent    = inset + 'px';
  document.getElementById('inset-color-picker').value = insetColor;

  // Sync active swatch and custom bg indicator
  updateBgSwatch();

  // Sync active ratio pill
  document.querySelectorAll('.pill').forEach(b =>
    b.classList.toggle('active', b.dataset.ratio === ratio)
  );

  render();
}

function renderPresetChips() {
  const container = document.getElementById('preset-chips');
  container.innerHTML = '';

  [...BUILTIN_PRESETS, ...userPresets].forEach(preset => {
    const isBuiltin = BUILTIN_PRESETS.some(p => p.name === preset.name);
    const chip = document.createElement('button');
    chip.className = 'preset-chip' + (isBuiltin ? ' preset-chip--builtin' : '');
    chip.dataset.name = preset.name;
    chip.title = `${preset.bg} · ${preset.ratio} · padding ${preset.padding}px`;

    const label = document.createElement('span');
    label.textContent = preset.name;
    chip.appendChild(label);

    if (!isBuiltin) {
      const del = document.createElement('button');
      del.className = 'preset-chip__delete';
      del.textContent = '×';
      del.title = 'Delete preset';
      chip.appendChild(del);
    }

    container.appendChild(chip);
  });
}

// Event delegation: apply on chip click, delete on × click.
document.getElementById('preset-chips').addEventListener('click', (e) => {
  const chip = e.target.closest('.preset-chip');
  if (!chip) return;

  if (e.target.closest('.preset-chip__delete')) {
    const name = chip.dataset.name;
    userPresets = userPresets.filter(p => p.name !== name);
    chrome.storage.sync.set({ presets: userPresets });
    renderPresetChips();
    return;
  }

  const name = chip.dataset.name;
  const preset =
    BUILTIN_PRESETS.find(p => p.name === name) ||
    userPresets.find(p => p.name === name);
  if (preset) applySettings(preset);
});

document.getElementById('btn-save-preset').addEventListener('click', () => {
  const input = document.getElementById('preset-name-input');
  const name  = input.value.trim();
  if (!name) { input.focus(); return; }

  const settings = {
    name,
    padding:       S.padding,
    radius:        S.radius,
    shadow:        S.shadow,
    bg:            S.bg === 'custom-image' ? 'flink' : S.bg,
    bgCustomColor: S.bgCustomColor,
    ratio:         S.ratio,
    inset:         S.inset,
    insetColor:    S.insetColor,
  };

  // Overwrite if name already exists, otherwise append.
  const idx = userPresets.findIndex(p => p.name === name);
  if (idx >= 0) userPresets[idx] = settings;
  else          userPresets.push(settings);

  chrome.storage.sync.set({ presets: userPresets });
  renderPresetChips();
  input.value = '';
});

// Also save on Enter inside the name input.
document.getElementById('preset-name-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('btn-save-preset').click();
  e.stopPropagation();
});

document.getElementById('btn-set-default').addEventListener('click', () => {
  const settings = {
    padding: S.padding, radius: S.radius, shadow: S.shadow,
    bg: S.bg, ratio: S.ratio,
  };
  chrome.storage.sync.set({ defaultSettings: settings }, () => {
    const btn = document.getElementById('btn-set-default');
    const prev = btn.textContent;
    btn.textContent = '✓ Saved';
    btn.classList.add('saved');
    setTimeout(() => { btn.textContent = prev; btn.classList.remove('saved'); }, 1800);
  });
});

/* ── Export ───────────────────────────────────────────────── */

btnCopy.addEventListener('click', () => {
  if (!S.img) return;
  canvas.toBlob(async (blob) => {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      btnCopy.textContent = '✓ Copied!';
      btnCopy.classList.add('success');
      chrome.action.setBadgeText({ text: '✓' });
      chrome.action.setBadgeBackgroundColor({ color: '#22c55e' });
      setTimeout(() => {
        btnCopy.textContent = '⌘C  Copy to Clipboard';
        btnCopy.classList.remove('success');
        chrome.action.setBadgeText({ text: '' });
      }, 2000);
    } catch (err) {
      console.error('Clipboard write failed:', err);
    }
  }, 'image/png');
});

window.addEventListener('resize', positionSelectionToolbar);
canvasArea.addEventListener('scroll', positionSelectionToolbar);

btnExport.addEventListener('click', () => {
  if (!S.img) return;
  const link = document.createElement('a');
  link.download = `snapz-${Date.now()}.png`;
  link.href = canvas.toDataURL('image/png');
  link.click();
});

/* ── Image loading ────────────────────────────────────────── */

function loadImage(src) {
  const img = new Image();
  img.onload = () => {
    S.img         = img;
    S.annotations = [];
    S.undone      = [];
    S.current     = null;
    selectedIndex = -1;
    // Auto-sample inset color from image edges if inset is active.
    if (S.inset > 0) sampleEdgeColor();
    render();
    canvas.classList.remove('canvas-fadein');
    void canvas.offsetHeight;
    canvas.classList.add('canvas-fadein');
  };
  img.src = src;
}

// Load user presets + default settings from sync, then load any pending capture.
chrome.storage.sync.get(['presets', 'defaultSettings'], ({ presets, defaultSettings }) => {
  userPresets = presets || [];
  renderPresetChips();

  if (defaultSettings) applySettings(defaultSettings);

  chrome.storage.local.get(['capturedImage', 'captureUrl', 'captureTimestamp'], (res) => {
    if (res.captureUrl)       S.captureUrl       = res.captureUrl;
    if (res.captureTimestamp) S.captureTimestamp  = res.captureTimestamp;

    if (res.capturedImage) {
      chrome.storage.local.remove('capturedImage');
      loadImage(res.capturedImage);
    } else {
      updateUI();
    }
  });
});

// File browser
document.getElementById('file-input').addEventListener('change', function () {
  const file = this.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => loadImage(e.target.result);
  reader.readAsDataURL(file);
  this.value = '';
});

// Drag and drop onto the whole canvas area
canvasArea.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});

canvasArea.addEventListener('dragleave', (e) => {
  if (!canvasArea.contains(e.relatedTarget)) dropZone.classList.remove('drag-over');
});

canvasArea.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (!file || !file.type.startsWith('image/')) return;
  const reader = new FileReader();
  reader.onload = ev => loadImage(ev.target.result);
  reader.readAsDataURL(file);
});

// Paste from clipboard
window.addEventListener('paste', (e) => {
  const item = [...e.clipboardData.items].find(i => i.type.startsWith('image/'));
  if (!item) return;
  const reader = new FileReader();
  reader.onload = ev => loadImage(ev.target.result);
  reader.readAsDataURL(item.getAsFile());
});

// Clear image
document.getElementById('btn-clear-image').addEventListener('click', () => {
  S.img         = null;
  S.annotations = [];
  S.undone      = [];
  S.current     = null;
  selectedIndex = -1;
  positionSelectionToolbar();
  updateUI();
});

// Footer toggle
document.getElementById('chk-footer').addEventListener('change', function () {
  S.footerEnabled = this.checked;
  render();
});

// Load user identity for footer name
if (chrome.identity?.getProfileUserInfo) {
  try {
    chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' }, (info) => {
      if (info?.email) S.captureUser = emailToName(info.email);
    });
  } catch (_) {}
}
