// Content script — injected into pages as needed.
// Currently a placeholder; region-selection UI will be implemented here.

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "ping") {
    sendResponse({ status: "ready" });
  }
  return true;
});
