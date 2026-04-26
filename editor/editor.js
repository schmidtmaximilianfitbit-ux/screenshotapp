'use strict';

/* ── Constants ────────────────────────────────────────────── */

const BG_PRESETS = {
  ember:   ['#f97316', '#ef4444', '#ec4899'],
  ocean:   ['#06b6d4', '#3b82f6', '#8b5cf6'],
  aurora:  ['#10b981', '#06b6d4', '#6366f1'],
  sunset:  ['#f59e0b', '#ef4444', '#7c3aed'],
  mint:    ['#a7f3d0', '#67e8f9', '#c4b5fd'],
  slate:   ['#334155', '#1e293b', '#0f172a'],
  rose:    ['#fda4af', '#f472b6', '#c084fc'],
  night:   ['#1e1b4b', '#312e81', '#4c1d95'],
  peach:   ['#fed7aa', '#fecaca', '#e9d5ff'],
  none:    null,
};

const RATIOS = {
  'auto':     null,
  '4:3':      { r: 4 / 3 },
  '3:2':      { r: 3 / 2 },
  '16:9':     { r: 16 / 9 },
  '1:1':      { r: 1 },
  'twitter':  { w: 1200, h: 675 },
  'linkedin': { w: 1200, h: 627 },
  'insta':    { w: 1080, h: 1080 },
};

const BUILTIN_PRESETS = [
  { name: 'Clean',  padding: 32, radius:  8, shadow: 20, bg: 'slate', ratio: 'auto'    },
  { name: 'Social', padding: 64, radius: 16, shadow: 60, bg: 'ocean', ratio: 'twitter' },
  { name: 'Bold',   padding: 80, radius: 20, shadow: 80, bg: 'ember', ratio: 'auto'    },
];

/* ── State ────────────────────────────────────────────────── */

const S = {
  img:         null,
  padding:     48,
  radius:      12,
  shadow:      40,
  bg:          'ember',
  ratio:       'auto',
  tool:        'pointer',
  color:       '#f97316',
  lw:          3,
  annotations: [],
  undone:      [],
  current:     null,
};

// Set by render(); used by zoom lens to map canvas→image coordinates.
let lastDims = null;

// User-created presets synced from chrome.storage.sync.
let userPresets = [];

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
  const { radius, shadow, bg } = S;
  const stops = BG_PRESETS[bg];

  // Background
  if (stops) {
    const grad = c.createLinearGradient(0, 0, w, h);
    stops.forEach((col, i) => grad.addColorStop(i / (stops.length - 1), col));
    c.fillStyle = grad;
    c.fillRect(0, 0, w, h);
  } else {
    // Checkerboard
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

  if (!img) return;

  const iw = img.naturalWidth;
  const ih = img.naturalHeight;

  // Shadow — draw a filled rrect first so the shadow extends outside the clip.
  // The image drawn afterwards covers the opaque black fill exactly.
  if (shadow > 0) {
    c.save();
    c.shadowColor   = `rgba(0,0,0,${(shadow / 100) * 0.6})`;
    c.shadowBlur    = shadow * 1.5;
    c.shadowOffsetY = shadow * 0.4;
    rrectPath(c, imgX, imgY, iw, ih, radius);
    c.fillStyle = '#000';
    c.fill();
    c.restore();
  }

  // Screenshot clipped to rounded rect
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

    case 'highlight':
      c.globalAlpha = 0.32;
      c.fillRect(a.x, a.y, a.w, a.h);
      c.globalAlpha = 1;
      break;

    case 'text': {
      const fontSize = Math.max(16, a.lw * 8);
      c.font = `${fontSize}px Outfit, sans-serif`;
      c.fillText(a.text, a.x, a.y);
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

function drawZoomLens(c, a, canvasW, canvasH) {
  if (!S.img || !lastDims) return;

  const LENS_R  = Math.max(40, a.lw * 10);
  const ZOOM    = 2.5;
  const srcSize = (LENS_R * 2) / ZOOM;

  // Render just the base layer into an offscreen canvas to use as zoom source.
  const osc  = new OffscreenCanvas(canvasW, canvasH);
  const octx = osc.getContext('2d');
  drawBaseLayer(octx, canvasW, canvasH, S.img, lastDims.imgX, lastDims.imgY);

  // Clip to circle and draw magnified region.
  c.save();
  c.beginPath();
  c.arc(a.dx, a.dy, LENS_R, 0, Math.PI * 2);
  c.clip();
  c.drawImage(
    osc,
    a.sx - srcSize / 2, a.sy - srcSize / 2, srcSize, srcSize,
    a.dx - LENS_R,      a.dy - LENS_R,      LENS_R * 2, LENS_R * 2
  );
  c.restore();

  // Border ring
  c.save();
  c.strokeStyle = a.color;
  c.lineWidth   = 3;
  c.beginPath();
  c.arc(a.dx, a.dy, LENS_R, 0, Math.PI * 2);
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

/* ── Canvas mouse events ──────────────────────────────────── */

let mouseDown = false;

canvas.addEventListener('mousedown', (e) => {
  if (!S.img || e.button !== 0) return;
  mouseDown = true;
  const { x, y } = getCoords(e);

  if (S.tool === 'pointer') return;

  if (S.tool === 'text') {
    spawnTextInput(e.clientX, e.clientY, x, y);
    return;
  }

  const base = { color: S.color, lw: S.lw };

  switch (S.tool) {
    case 'draw':      S.current = { ...base, type: 'draw',      pts: [{ x, y }] };         break;
    case 'line':      S.current = { ...base, type: 'line',      x1: x, y1: y, x2: x, y2: y }; break;
    case 'arrow':     S.current = { ...base, type: 'arrow',     x1: x, y1: y, x2: x, y2: y }; break;
    case 'rect':      S.current = { ...base, type: 'rect',      x, y, w: 0, h: 0 };        break;
    case 'ellipse':   S.current = { ...base, type: 'ellipse',   x, y, w: 0, h: 0 };        break;
    case 'highlight': S.current = { ...base, type: 'highlight', x, y, w: 0, h: 0 };        break;
    case 'zoom':      S.current = { ...base, type: 'zoom',      sx: x, sy: y, dx: x, dy: y }; break;
  }
});

canvas.addEventListener('mousemove', (e) => {
  if (!mouseDown || !S.current) return;
  const { x, y } = getCoords(e);
  const a = S.current;

  switch (a.type) {
    case 'draw':                          a.pts.push({ x, y });   break;
    case 'line':    case 'arrow':         a.x2 = x; a.y2 = y;    break;
    case 'rect':    case 'ellipse':
    case 'highlight':                     a.w = x - a.x; a.h = y - a.y; break;
    case 'zoom':                          a.dx = x; a.dy = y;     break;
  }

  render();
});

canvas.addEventListener('mouseup',    commitCurrent);
canvas.addEventListener('mouseleave', commitCurrent);

function commitCurrent() {
  if (!mouseDown) return;
  mouseDown = false;
  if (S.current) {
    S.annotations.push(S.current);
    S.current = null;
    S.undone  = [];
    render();
  }
}

/* ── Floating text input ──────────────────────────────────── */

function spawnTextInput(clientX, clientY, canvasX, canvasY) {
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.placeholder = 'Type here…';
  Object.assign(inp.style, {
    position: 'fixed', left: `${clientX}px`, top: `${clientY}px`,
    zIndex: '9999', background: 'rgba(0,0,0,0.7)', border: '1px solid #f97316',
    color: '#fff', padding: '4px 8px', borderRadius: '6px',
    font: '14px Outfit, sans-serif', minWidth: '120px', outline: 'none',
  });
  document.body.appendChild(inp);
  inp.focus();

  let done = false;

  const commit = () => {
    if (done) return; done = true;
    const text = inp.value.trim();
    inp.remove();
    if (!text) return;
    S.annotations.push({ type: 'text', color: S.color, lw: S.lw, text, x: canvasX, y: canvasY });
    S.undone = [];
    render();
  };

  const cancel = () => { if (done) return; done = true; inp.remove(); };

  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  commit();
    if (e.key === 'Escape') cancel();
    e.stopPropagation(); // prevent undo/redo shortcuts while typing
  });

  inp.addEventListener('blur', () => { inp.value.trim() ? commit() : cancel(); });
}

/* ── Undo / Redo ──────────────────────────────────────────── */

function undo() {
  if (!S.annotations.length) return;
  S.undone.unshift(S.annotations.pop());
  render();
}

function redo() {
  if (!S.undone.length) return;
  S.annotations.push(S.undone.shift());
  render();
}

btnUndo.addEventListener('click', undo);
btnRedo.addEventListener('click', redo);

document.getElementById('btn-clear-ann').addEventListener('click', () => {
  S.annotations = [];
  S.undone = [];
  render();
});

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  const mod = e.metaKey || e.ctrlKey;
  if (!mod || e.key.toLowerCase() !== 'z') return;
  e.preventDefault();
  e.shiftKey ? redo() : undo();
});

/* ── UI state sync ────────────────────────────────────────── */

function updateUI() {
  const has = Boolean(S.img);

  canvas.style.display    = has ? 'block' : 'none';
  dropZone.style.display  = has ? 'none'  : 'flex';
  document.getElementById('btn-clear-image').hidden = !has;

  if (has) {
    canvas.style.cursor =
      S.tool === 'pointer' ? 'default'   :
      S.tool === 'text'    ? 'text'      : 'crosshair';
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
});

// Background swatches
document.querySelectorAll('.swatch').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.swatch').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    S.bg = btn.dataset.bg;
    render();
  });
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
    updateUI();
  });
});

// Color dots
document.querySelectorAll('.color-dot').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.color-dot').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    S.color = btn.dataset.color;
  });
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

function applySettings({ padding, radius, shadow, bg, ratio }) {
  S.padding = padding;
  S.radius  = radius;
  S.shadow  = shadow;
  S.bg      = bg;
  S.ratio   = ratio;

  // Sync slider positions and displayed values
  document.getElementById('sl-padding').value       = padding;
  document.getElementById('val-padding').textContent = padding + 'px';
  document.getElementById('sl-radius').value        = radius;
  document.getElementById('val-radius').textContent  = radius + 'px';
  document.getElementById('sl-shadow').value        = shadow;
  document.getElementById('val-shadow').textContent  = shadow + '%';

  // Sync active swatch
  document.querySelectorAll('.swatch').forEach(b =>
    b.classList.toggle('active', b.dataset.bg === bg)
  );

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
    padding: S.padding,
    radius:  S.radius,
    shadow:  S.shadow,
    bg:      S.bg,
    ratio:   S.ratio,
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
      setTimeout(() => {
        btnCopy.textContent = '⌘C  Copy to Clipboard';
        btnCopy.classList.remove('success');
      }, 1800);
    } catch (err) {
      console.error('Clipboard write failed:', err);
    }
  }, 'image/png');
});

btnExport.addEventListener('click', () => {
  if (!S.img) return;
  const link = document.createElement('a');
  link.download = `snapbeauty-${Date.now()}.png`;
  link.href = canvas.toDataURL('image/png');
  link.click();
});

/* ── Image loading ────────────────────────────────────────── */

function loadImage(src) {
  const img = new Image();
  img.onload = () => {
    S.img = img;
    S.annotations = [];
    S.undone  = [];
    S.current = null;
    render();
  };
  img.src = src;
}

// Load user presets + default settings from sync, then load any pending capture.
chrome.storage.sync.get(['presets', 'defaultSettings'], ({ presets, defaultSettings }) => {
  userPresets = presets || [];
  renderPresetChips();

  if (defaultSettings) applySettings(defaultSettings);

  chrome.storage.local.get('capturedImage', ({ capturedImage }) => {
    if (capturedImage) {
      chrome.storage.local.remove('capturedImage');
      loadImage(capturedImage);
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
  S.img = null;
  S.annotations = [];
  S.undone  = [];
  S.current = null;
  updateUI();
});
