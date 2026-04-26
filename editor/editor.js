const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");

let activeTool = "select";
let isDrawing = false;
let lastX = 0;
let lastY = 0;

// Load the captured screenshot then immediately clear it so stale data never
// appears if the editor is reopened manually.
chrome.storage.local.get("capturedImage", ({ capturedImage }) => {
  if (!capturedImage) return;
  chrome.storage.local.remove("capturedImage");
  const img = new Image();
  img.onload = () => {
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    ctx.drawImage(img, 0, 0);
  };
  img.src = capturedImage;
});

// Tool selection.
document.querySelectorAll(".tool-btn[id^='tool-']").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tool-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    activeTool = btn.id.replace("tool-", "");
  });
});

// Basic freehand drawing on the canvas.
canvas.addEventListener("mousedown", (e) => {
  if (activeTool !== "pen") return;
  isDrawing = true;
  [lastX, lastY] = [e.offsetX, e.offsetY];
  ctx.beginPath();
  ctx.moveTo(lastX, lastY);
});

canvas.addEventListener("mousemove", (e) => {
  if (!isDrawing || activeTool !== "pen") return;
  ctx.strokeStyle = "#6366f1";
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineTo(e.offsetX, e.offsetY);
  ctx.stroke();
  [lastX, lastY] = [e.offsetX, e.offsetY];
});

canvas.addEventListener("mouseup", () => { isDrawing = false; });
canvas.addEventListener("mouseleave", () => { isDrawing = false; });

// Save.
document.getElementById("btn-save").addEventListener("click", () => {
  const link = document.createElement("a");
  link.download = `snapbeauty-${Date.now()}.png`;
  link.href = canvas.toDataURL("image/png");
  link.click();
});

// Copy to clipboard.
document.getElementById("btn-copy").addEventListener("click", async () => {
  canvas.toBlob(async (blob) => {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob }),
      ]);
    } catch (err) {
      console.error("Clipboard write failed:", err);
    }
  }, "image/png");
});
