document.getElementById("btn-capture-tab").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "capture-tab" });
  window.close();
});

document.getElementById("btn-capture-region").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "capture-region" });
  window.close();
});

document.getElementById("btn-settings").addEventListener("click", () => {
  chrome.runtime.openOptionsPage?.() ??
    chrome.tabs.create({ url: chrome.runtime.getURL("editor/editor.html") });
  window.close();
});

/* ── Recent captures ─────────────────────────────────────── */

function timeAgo(ts) {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60)   return sec + 's';
  if (sec < 3600) return Math.floor(sec / 60) + 'm';
  if (sec < 86400) return Math.floor(sec / 3600) + 'h';
  return Math.floor(sec / 86400) + 'd';
}

chrome.storage.local.get('captureHistory', ({ captureHistory }) => {
  if (!captureHistory?.length) return;

  const section   = document.getElementById('recent-section');
  const container = document.getElementById('recent-thumbs');
  section.style.display = 'block';

  captureHistory.forEach(item => {
    const btn = document.createElement('button');
    btn.className = 'thumb-btn';

    const img = document.createElement('img');
    img.src = item.thumb;
    img.alt = '';

    const age = document.createElement('span');
    age.className = 'thumb-age';
    age.textContent = timeAgo(item.ts);

    btn.appendChild(img);
    btn.appendChild(age);

    btn.addEventListener('click', () => {
      chrome.storage.local.set({ capturedImage: item.full }, () => {
        chrome.tabs.create({ url: chrome.runtime.getURL('editor/editor.html') });
        window.close();
      });
    });

    container.appendChild(btn);
  });
});
