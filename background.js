const EDITOR_URL = chrome.runtime.getURL("editor/editor.html");

// Protocols where captureVisibleTab always fails — check before attempting.
const RESTRICTED_PROTOCOLS = ["chrome:", "chrome-extension:", "about:", "edge:", "brave:"];

chrome.commands.onCommand.addListener((command) => {
  if (command === "capture-tab") {
    captureTab();
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "capture-tab") {
    captureTab()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // keep the message channel open for the async response
  }
});

async function captureTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab) {
    throw new Error("No active tab found.");
  }

  // Proactively reject restricted pages before calling captureVisibleTab.
  const url = tab.url ?? "";
  if (!url || RESTRICTED_PROTOCOLS.some((p) => url.startsWith(p))) {
    notify(
      "Cannot capture this page",
      "Screenshots are not available on browser-internal pages (e.g. chrome://)."
    );
    return;
  }

  let dataUrl;
  try {
    // quality is ignored for PNG (lossless) but kept for spec compliance.
    dataUrl = await chrome.tabs.captureVisibleTab(null, { format: "png", quality: 100 });
  } catch (err) {
    notify("Capture failed", err.message ?? "An unexpected error occurred.");
    throw err;
  }

  await chrome.storage.local.set({ capturedImage: dataUrl });
  await chrome.tabs.create({ url: EDITOR_URL });
}

function notify(title, message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon48.png"),
    title,
    message,
  });
}
