document.getElementById("btn-capture-tab").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "capture-tab" });
  window.close();
});

document.getElementById("btn-capture-region").addEventListener("click", () => {
  // TODO: inject content script to let the user draw a selection region.
  window.close();
});

document.getElementById("btn-settings").addEventListener("click", () => {
  chrome.runtime.openOptionsPage?.() ??
    chrome.tabs.create({ url: chrome.runtime.getURL("editor/editor.html") });
  window.close();
});
