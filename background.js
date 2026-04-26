chrome.commands.onCommand.addListener((command) => {
  if (command === "capture-tab") {
    captureTab();
  }
});

async function captureTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: "png" });
  openEditor(dataUrl);
}

function openEditor(dataUrl) {
  chrome.storage.session.set({ pendingCapture: dataUrl }, () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("editor/editor.html") });
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "capture-tab") {
    captureTab();
    sendResponse({ ok: true });
  }
  return true;
});
