const EDITOR_URL = chrome.runtime.getURL("editor/editor.html");

// Protocols where captureVisibleTab always fails — check before attempting.
const RESTRICTED_PROTOCOLS = ["chrome:", "chrome-extension:", "about:", "edge:", "brave:"];

/* ── Context menu ────────────────────────────────────────────── */

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id:       "beautify-page",
      title:    "Beautify this page",
      contexts: ["page"],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "beautify-page") captureTab();
});

/* ── Command shortcut ────────────────────────────────────────── */

chrome.commands.onCommand.addListener((command) => {
  if (command === "capture-tab") captureTab();
});

/* ── Message bus ─────────────────────────────────────────────── */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "capture-tab") {
    captureTab()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === "capture-region") {
    captureRegion()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === "region-selected") {
    cropAndOpen(message.rect)
      .catch((err) => notify("Crop failed", err.message ?? "An unexpected error occurred."));
    sendResponse({ ok: true });
  }
});

/* ── Full-tab capture ────────────────────────────────────────── */

async function captureTab() {
  const tab = await getActiveTab();
  if (!tab) return;

  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(null, { format: "png", quality: 100 });
  } catch (err) {
    notify("Capture failed", err.message ?? "An unexpected error occurred.");
    throw err;
  }

  await storeCapture(dataUrl);
  await chrome.tabs.create({ url: EDITOR_URL });
}

/* ── Region capture: step 1 — inject selection overlay ──────── */

async function captureRegion() {
  const tab = await getActiveTab();
  if (!tab) return;

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"],
    });
  } catch (err) {
    notify(
      "Cannot inject selection tool",
      err.message ?? "An unexpected error occurred."
    );
    throw err;
  }
}

/* ── Region capture: step 2 — receive coords, crop, open ────── */

async function cropAndOpen(rect) {
  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(null, { format: "png", quality: 100 });
  } catch (err) {
    notify("Capture failed", err.message ?? "An unexpected error occurred.");
    throw err;
  }

  const cropped = await cropImage(dataUrl, rect);
  await storeCapture(cropped);
  await chrome.tabs.create({ url: EDITOR_URL });
}

/* ── Capture history ─────────────────────────────────────────── */

// Store the full capture (as smaller JPEG) plus a 120×75 thumbnail in
// captureHistory[], keeping the 3 most recent.  The original dataUrl is always
// written to capturedImage so the editor gets full-res PNG on first open.
async function storeCapture(dataUrl) {
  const resp   = await fetch(dataUrl);
  const blob   = await resp.blob();
  const bitmap = await createImageBitmap(blob);

  // Compressed full image (JPEG 0.85) — much smaller than the raw PNG capture.
  const fsc  = new OffscreenCanvas(bitmap.width, bitmap.height);
  fsc.getContext("2d").drawImage(bitmap, 0, 0);
  const fullBlob = await fsc.convertToBlob({ type: "image/jpeg", quality: 0.85 });
  const fullJpeg = await blobToDataUrl(fullBlob);

  // Thumbnail 120×75
  const TW = 120, TH = 75;
  const scale = Math.min(TW / bitmap.width, TH / bitmap.height);
  const sw = Math.round(bitmap.width  * scale);
  const sh = Math.round(bitmap.height * scale);
  const tsc  = new OffscreenCanvas(TW, TH);
  const tctx = tsc.getContext("2d");
  tctx.fillStyle = "#0c1018";
  tctx.fillRect(0, 0, TW, TH);
  tctx.drawImage(bitmap, Math.round((TW - sw) / 2), Math.round((TH - sh) / 2), sw, sh);
  const thumbBlob = await tsc.convertToBlob({ type: "image/jpeg", quality: 0.7 });
  const thumb     = await blobToDataUrl(thumbBlob);

  // Prepend to history, keep last 3.
  const { captureHistory = [] } = await chrome.storage.local.get("captureHistory");
  captureHistory.unshift({ thumb, full: fullJpeg, ts: Date.now() });
  if (captureHistory.length > 3) captureHistory.length = 3;

  await chrome.storage.local.set({ capturedImage: dataUrl, captureHistory })
    .catch(() => chrome.storage.local.set({ capturedImage: dataUrl }));
}

/* ── Helpers ─────────────────────────────────────────────────── */

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return null;

  const url = tab.url ?? "";
  if (!url || RESTRICTED_PROTOCOLS.some((p) => url.startsWith(p))) {
    notify(
      "Cannot capture this page",
      "Screenshots are not available on browser-internal pages (e.g. chrome://)."
    );
    return null;
  }

  return tab;
}

async function cropImage(dataUrl, rect) {
  const resp = await fetch(dataUrl);
  const blob = await resp.blob();
  // createImageBitmap accepts a source rect, performing the crop in one step.
  const bitmap = await createImageBitmap(
    blob,
    rect.x,
    rect.y,
    rect.width,
    rect.height
  );
  const osc = new OffscreenCanvas(rect.width, rect.height);
  osc.getContext("2d").drawImage(bitmap, 0, 0);
  const croppedBlob = await osc.convertToBlob({ type: "image/png" });
  return blobToDataUrl(croppedBlob);
}

// FileReader is unavailable in service workers; convert via ArrayBuffer instead.
async function blobToDataUrl(blob) {
  const buf   = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary  = "";
  // Process in 8 KB chunks to stay well within the call-stack argument limit.
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return `data:${blob.type};base64,${btoa(binary)}`;
}

function notify(title, message) {
  chrome.notifications.create({
    type:     "basic",
    iconUrl:  chrome.runtime.getURL("icons/icon48.png"),
    title,
    message,
  });
}
