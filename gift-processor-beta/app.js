import { processMediaItem, terminateFfmpeg } from "./ffmpeg-engine.js?v=20260825-pngseq";
import { mountSvgaPreview, parseSvgaFile } from "./svga-codec.js?v=20260825-pngseq";
import { extractVapConfig, vapDisplayMetadata } from "./vap-codec.js";
import { parseAnimatedImageMetadata } from "./image-codec.js";

const MAX_FILES = 20;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const HISTORY_LIMIT = 12;

const state = {
  items: [],
  processing: false,
  history: [],
  previewPlayers: new Map(),
  vapPlayers: new Map(),
  toastTimer: null,
};

const elements = {
  dropzone: document.querySelector("#dropzone"),
  fileInput: document.querySelector("#fileInput"),
  outputFormat: document.querySelector("#outputFormat"),
  targetWidth: document.querySelector("#targetWidth"),
  targetHeight: document.querySelector("#targetHeight"),
  scaleMode: document.querySelector("#scaleMode"),
  targetFps: document.querySelector("#targetFps"),
  targetDuration: document.querySelector("#targetDuration"),
  quality: document.querySelector("#quality"),
  qualityOutput: document.querySelector("#qualityOutput"),
  edgeBlur: document.querySelector("#edgeBlur"),
  blurOutput: document.querySelector("#blurOutput"),
  muteAudio: document.querySelector("#muteAudio"),
  formatNote: document.querySelector("#formatNote"),
  resetSettings: document.querySelector("#resetSettings"),
  processAll: document.querySelector("#processAll"),
  downloadAll: document.querySelector("#downloadAll"),
  clearQueue: document.querySelector("#clearQueue"),
  queueSummary: document.querySelector("#queueSummary"),
  engineStatus: document.querySelector("#engineStatus"),
  emptyState: document.querySelector("#emptyState"),
  queueList: document.querySelector("#queueList"),
  historyGrid: document.querySelector("#historyGrid"),
  clearHistory: document.querySelector("#clearHistory"),
  toast: document.querySelector("#toast"),
};

const FORMAT_NOTES = {
  webp: "保留透明与全彩色，体积通常小于 APNG；部分老端不支持动态 WebP。",
  apng: "无损透明动图，画质稳定，但文件体积通常较大。质量滑杆只影响压缩强度。",
  gif: "兼容性高，但只有 256 色，不适合半透明、渐变和高精度礼物。",
  mp4: "H.264 MP4 体积小、硬解快，但不保留透明；透明区域会转为黑底。",
  vap: "生成 H.264 RGB+Alpha 并在 MP4 写入腾讯 VAP v2 vapc 配置。测试版须在业务端播放器复验。",
  dual: "生成左侧 RGB、右侧 Alpha 的双通道 H.264 MP4，不写入 VAP 配置。",
  svga: "采用逐帧 SVGA 2.0 兼容结构，视觉稳定但可能较大；测试版最多 300 帧且不携带音频。",
  pngseq: "只支持 SVGA：按原始画布、原始帧率和全部帧渲染透明 RGBA PNG，以 000.png开始连续命名并打包 ZIP。",
};

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function showToast(message, type = "default") {
  clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.className = `toast visible${type === "error" ? " error" : ""}${type === "success" ? " success" : ""}`;
  state.toastTimer = setTimeout(() => {
    elements.toast.className = "toast";
  }, 3200);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
}

function formatDuration(seconds) {
  if (!Number(seconds)) return "时长待解析";
  return `${Number(seconds).toFixed(2)} s`;
}

function stem(name) {
  return String(name).replace(/\.[^.]+$/, "") || "gift-motion";
}

function detectKind(file) {
  const extension = file.name.toLowerCase().split(".").pop();
  if (extension === "svga") return "svga";
  if (extension === "gif") return "gif";
  if (extension === "webp") return "webp";
  if (extension === "apng") return "apng";
  if (extension === "png") return "png";
  if (["mp4", "mov", "webm", "vap"].includes(extension)) return "video";
  return null;
}

function kindLabel(item) {
  if (item.kind === "video") return item.file.name.toLowerCase().endsWith(".webm") ? "WEBM" : "MP4";
  if (item.kind === "vap") return "VAP";
  if (item.kind === "dual") return "DUAL";
  return item.kind.toUpperCase();
}

function singleFrameMemory(metadata) {
  if (!metadata.width || !metadata.height) return "—";
  return formatBytes(metadata.width * metadata.height * 4);
}

function loadVideoMetadata(file, vapConfig = null) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.onloadedmetadata = () => {
      const vap = vapDisplayMetadata(vapConfig);
      resolve({
        width: vap?.width || video.videoWidth,
        height: vap?.height || video.videoHeight,
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
        fps: vap?.fps || 30,
        frames: vap?.frames || (video.duration ? Math.round(video.duration * 30) : null),
        duration: vap?.duration || video.duration || 0,
        hasAudio: true,
      });
      URL.revokeObjectURL(url);
    };
    video.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("视频无法解析或当前浏览器不支持该编码"));
    };
    video.src = url;
  });
}

async function parseFile(file) {
  let kind = detectKind(file);
  if (!kind) throw new Error("格式不支持");

  const item = {
    id: crypto.randomUUID(),
    file,
    kind,
    status: "parsing",
    progress: 0,
    message: "正在解析",
    result: null,
    error: null,
    previewUrl: URL.createObjectURL(file),
    metadata: {},
    video: null,
    vapConfig: null,
  };

  if (kind === "svga") {
    const parsed = await parseSvgaFile(file);
    item.video = parsed.video;
    item.metadata = parsed.metadata;
  } else if (["gif", "webp", "apng", "png"].includes(kind)) {
    item.metadata = await parseAnimatedImageMetadata(file, kind);
  } else {
    const arrayBuffer = await file.arrayBuffer();
    item.vapConfig = extractVapConfig(arrayBuffer);
    if (item.vapConfig || file.name.toLowerCase().endsWith(".vap")) {
      item.kind = "vap";
      item.metadata = await loadVideoMetadata(file, item.vapConfig);
    } else {
      const rawMetadata = await loadVideoMetadata(file, null);
      if (/(^|[-_.])(dual|alpha)([-_.]|$)/i.test(file.name)) {
        const displayWidth = Math.max(1, Math.floor(rawMetadata.width / 2));
        item.kind = "dual";
        item.vapConfig = {
          info: {
            v: 1,
            f: rawMetadata.frames,
            w: displayWidth,
            h: rawMetadata.height,
            fps: rawMetadata.fps,
            videoW: rawMetadata.width,
            videoH: rawMetadata.height,
            aFrame: [displayWidth, 0, displayWidth, rawMetadata.height],
            rgbFrame: [0, 0, displayWidth, rawMetadata.height],
            isVapx: 0,
            orien: 0,
          },
        };
        item.metadata = { ...rawMetadata, width: displayWidth };
      } else item.metadata = rawMetadata;
    }
  }

  item.status = "ready";
  item.message = "可处理";
  return item;
}

function disposePreviewPlayers() {
  for (const player of state.previewPlayers.values()) {
    try { player.destroy(); } catch {}
  }
  for (const player of state.vapPlayers.values()) {
    try { player.destroy(); } catch {}
  }
  state.previewPlayers.clear();
  state.vapPlayers.clear();
}

async function mountItemPreview(item) {
  const frame = elements.queueList.querySelector(`[data-preview-id="${item.id}"]`);
  if (!frame || item.status === "parsing") return;

  frame.innerHTML = "";
  try {
    if (item.kind === "svga" && item.video) {
      const canvas = document.createElement("canvas");
      canvas.setAttribute("aria-label", `${item.file.name} SVGA 预览`);
      frame.appendChild(canvas);
      state.previewPlayers.set(item.id, await mountSvgaPreview(item.video, canvas));
      return;
    }

    if (["vap", "dual"].includes(item.kind) && item.vapConfig && window.Vap?.default) {
      const host = document.createElement("div");
      host.style.width = "100%";
      host.style.height = "180px";
      frame.appendChild(host);
      try {
        const player = new window.Vap.default({
          container: host,
          src: item.previewUrl,
          config: item.vapConfig,
          width: item.metadata.width || 375,
          height: item.metadata.height || 375,
          fps: item.metadata.fps || 30,
          mute: true,
          loop: true,
          accurate: true,
          type: item.id,
        });
        state.vapPlayers.set(item.id, player);
        return;
      } catch (error) {
        console.warn("VAP 透明预览失败，回退原始视频", error);
        host.remove();
      }
    }

    if (["gif", "webp", "apng", "png"].includes(item.kind)) {
      const image = new Image();
      image.src = item.previewUrl;
      image.alt = `${item.file.name} 预览`;
      frame.appendChild(image);
    } else {
      const video = document.createElement("video");
      video.src = item.previewUrl;
      video.muted = true;
      video.loop = true;
      video.autoplay = true;
      video.playsInline = true;
      video.controls = true;
      frame.appendChild(video);
    }
  } catch (error) {
    frame.innerHTML = `<div class="preview-placeholder">预览失败<br>${escapeHtml(error.message)}</div>`;
  }
}

function cardHtml(item) {
  const meta = item.metadata || {};
  const statusClass = item.status === "done" ? "done" : item.status === "error" ? "error" : "";
  const result = item.result;
  const saving = result ? item.file.size - result.blob.size : 0;
  const savingPercent = result && item.file.size ? (saving / item.file.size) * 100 : 0;
  return `
    <article class="asset-card" data-item-id="${item.id}">
      <div class="preview-frame" data-preview-id="${item.id}">
        <div class="preview-placeholder"><span class="spinner"></span>${item.status === "parsing" ? "正在解析" : "正在准备预览"}</div>
      </div>
      <div class="card-content">
        <div class="card-top">
          <div class="file-name" title="${escapeHtml(item.file.name)}">${escapeHtml(item.file.name)}</div>
          <div><span class="format-badge">${kindLabel(item)}</span> <span class="status-badge ${statusClass}" data-status>${escapeHtml(item.message)}</span></div>
        </div>
        <div class="metadata">
          <span>${meta.width && meta.height ? `${meta.width} × ${meta.height}` : "尺寸待解析"}</span>
          <span>${meta.frames ? `${meta.frames} 帧` : "帧数待解析"}</span>
          <span>${meta.fps ? `${meta.fps} FPS` : "FPS 待解析"}</span>
          <span>${formatDuration(meta.duration)}</span>
          <span>文件 ${formatBytes(item.file.size)}</span>
          <span>单帧 RGBA ${singleFrameMemory(meta)}</span>
        </div>
        <div class="progress-wrap" ${["processing"].includes(item.status) ? "" : "hidden"} data-progress-wrap>
          <div class="progress-line"><span data-progress style="width:${Math.round(item.progress * 100)}%"></span></div>
          <div class="progress-copy"><span data-progress-text>${escapeHtml(item.message)}</span><span data-progress-value>${Math.round(item.progress * 100)}%</span></div>
        </div>
        ${result ? `<div class="result-box"><div><strong>${escapeHtml(result.filename)}</strong><span>${formatBytes(result.blob.size)} · ${saving >= 0 ? `减少 ${savingPercent.toFixed(1)}%` : `增加 ${Math.abs(savingPercent).toFixed(1)}%`} · ${result.width} × ${result.height}</span></div><button class="text-button" data-action="download" data-id="${item.id}">下载结果</button></div>` : ""}
        ${item.error ? `<p class="error-copy">${escapeHtml(item.error)}</p>` : ""}
        <div class="card-actions">
          <button class="text-button" data-action="process" data-id="${item.id}" ${state.processing ? "disabled" : ""}>${item.status === "error" ? "重试此项" : "处理此项"}</button>
          <button class="text-button remove" data-action="remove" data-id="${item.id}" ${state.processing ? "disabled" : ""}>移除</button>
        </div>
      </div>
    </article>`;
}

function renderQueue() {
  disposePreviewPlayers();
  elements.emptyState.hidden = state.items.length > 0;
  elements.queueList.innerHTML = state.items.map(cardHtml).join("");
  elements.queueSummary.textContent = `${state.items.length} 个文件 · ${formatBytes(state.items.reduce((sum, item) => sum + item.file.size, 0))}`;
  elements.processAll.disabled = state.items.length === 0 || state.processing;
  elements.clearQueue.disabled = state.items.length === 0 || state.processing;
  elements.downloadAll.disabled = !state.items.some((item) => item.result) || state.processing;

  for (const item of state.items) mountItemPreview(item);
}

function updateCard(item) {
  const card = elements.queueList.querySelector(`[data-item-id="${item.id}"]`);
  if (!card) return;
  const badge = card.querySelector("[data-status]");
  badge.textContent = item.message;
  badge.className = `status-badge ${item.status === "done" ? "done" : item.status === "error" ? "error" : ""}`;
  const wrap = card.querySelector("[data-progress-wrap]");
  wrap.hidden = item.status !== "processing";
  card.querySelector("[data-progress]").style.width = `${Math.round(item.progress * 100)}%`;
  card.querySelector("[data-progress-text]").textContent = item.message;
  card.querySelector("[data-progress-value]").textContent = `${Math.round(item.progress * 100)}%`;
}

async function addFiles(files) {
  const existingBytes = state.items.reduce((sum, item) => sum + item.file.size, 0);
  const available = MAX_FILES - state.items.length;
  let total = existingBytes;
  const accepted = [];
  const rejected = [];

  for (const file of files.slice(0, available)) {
    if (!detectKind(file)) rejected.push(`${file.name}：格式不支持`);
    else if (file.size > MAX_FILE_BYTES) rejected.push(`${file.name}：超过 50 MB`);
    else if (total + file.size > MAX_TOTAL_BYTES) rejected.push(`${file.name}：总体积超过 200 MB`);
    else { accepted.push(file); total += file.size; }
  }
  if (files.length > available) rejected.push(`${files.length - available} 个文件超出数量上限`);
  if (rejected.length) showToast(rejected.slice(0, 3).join("；"), "error");

  for (const file of accepted) {
    const shell = {
      id: crypto.randomUUID(), file, kind: detectKind(file), status: "parsing", progress: 0,
      message: "正在解析", metadata: {}, previewUrl: URL.createObjectURL(file), result: null, error: null,
    };
    state.items.push(shell);
    renderQueue();
    try {
      const parsed = await parseFile(file);
      URL.revokeObjectURL(shell.previewUrl);
      Object.assign(shell, parsed, { id: shell.id });
    } catch (error) {
      shell.status = "error";
      shell.message = "解析失败";
      shell.error = error.message || "文件无法识别";
    }
    renderQueue();
  }
}

function currentSettings() {
  const outputFormat = elements.outputFormat.value;
  if (outputFormat === "pngseq") {
    return {
      outputFormat,
      width: 0,
      height: 0,
      scaleMode: "contain",
      fps: 0,
      duration: 0,
      quality: 100,
      edgeBlur: 0,
      mute: true,
    };
  }
  const width = Number(elements.targetWidth.value) || 0;
  const height = Number(elements.targetHeight.value) || 0;
  if ((width && !height) || (!width && height)) throw new Error("目标宽度和高度必须同时填写");
  return {
    outputFormat,
    width,
    height,
    scaleMode: elements.scaleMode.value,
    fps: Number(elements.targetFps.value),
    duration: Number(elements.targetDuration.value) || 0,
    quality: Number(elements.quality.value),
    edgeBlur: Number(elements.edgeBlur.value),
    mute: elements.muteAudio.checked,
  };
}

function outputFilename(item, extension) {
  const format = currentSettings().outputFormat;
  const suffix = format === "vap" ? "-vap" : format === "dual" ? "-dual" : format === "pngseq" ? "-png-sequence" : "-processed";
  return `${stem(item.file.name)}${suffix}.${extension}`;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1200);
}

async function processItems(items) {
  if (state.processing) return;
  let settings;
  try { settings = currentSettings(); }
  catch (error) { showToast(error.message, "error"); return; }

  const candidates = items.filter((item) => item.status !== "parsing");
  if (!candidates.length) { showToast("没有可处理的文件", "error"); return; }
  state.processing = true;
  renderQueue();

  for (const item of candidates) {
    item.status = "processing";
    item.progress = 0;
    item.message = "排队准备";
    item.error = null;
    item.result = null;
    updateCard(item);
    try {
      const result = await processMediaItem(item, settings, {
        onStatus(message) {
          item.message = message;
          elements.engineStatus.hidden = false;
          elements.engineStatus.textContent = message;
          updateCard(item);
        },
        onProgress(progress) {
          item.progress = progress;
          updateCard(item);
        },
        onLog(message) {
          if (/error|invalid|failed/i.test(message)) console.debug("FFmpeg:", message);
        },
      });
      item.result = { ...result, filename: outputFilename(item, result.extension) };
      item.status = "done";
      item.progress = 1;
      item.message = "已完成";
      await saveHistory(item);
    } catch (error) {
      console.error(error);
      item.status = "error";
      item.message = "处理失败";
      item.error = error.message || "编解码失败";
    }
    renderQueue();
  }

  state.processing = false;
  elements.engineStatus.hidden = true;
  renderQueue();
  showToast("批量处理已结束", state.items.some((item) => item.status === "error") ? "error" : "success");
}

function removeItem(id) {
  const item = state.items.find((candidate) => candidate.id === id);
  if (!item || state.processing) return;
  if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
  state.items = state.items.filter((candidate) => candidate.id !== id);
  renderQueue();
}

function clearQueue() {
  if (state.processing) return;
  for (const item of state.items) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
  state.items = [];
  renderQueue();
}

function resetSettings() {
  elements.outputFormat.value = "webp";
  elements.targetWidth.value = "";
  elements.targetHeight.value = "";
  elements.scaleMode.value = "contain";
  elements.targetFps.value = "30";
  elements.targetDuration.value = "0";
  elements.quality.value = "80";
  elements.edgeBlur.value = "0";
  elements.muteAudio.checked = false;
  updateSettingsUI();
}

function updateSettingsUI() {
  const pngSequenceMode = elements.outputFormat.value === "pngseq";
  elements.qualityOutput.textContent = elements.quality.value;
  elements.blurOutput.textContent = elements.edgeBlur.value;
  elements.formatNote.textContent = FORMAT_NOTES[elements.outputFormat.value];
  [
    elements.targetWidth,
    elements.targetHeight,
    elements.scaleMode,
    elements.targetFps,
    elements.targetDuration,
    elements.quality,
    elements.edgeBlur,
    elements.muteAudio,
  ].forEach((control) => {
    control.disabled = pngSequenceMode;
  });
}

function openHistoryDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("team-gift-processor-beta", 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore("results", { keyPath: "id" });
      store.createIndex("createdAt", "createdAt");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(mode, action) {
  const db = await openHistoryDb();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction("results", mode);
      const store = transaction.objectStore("results");
      const request = action(store);
      if (request) {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      } else {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      }
    });
  } finally { db.close(); }
}

async function saveHistory(item) {
  const record = {
    id: crypto.randomUUID(),
    sourceName: item.file.name,
    filename: item.result.filename,
    format: item.result.extension,
    size: item.result.blob.size,
    width: item.result.displayWidth || item.result.width,
    height: item.result.displayHeight || item.result.height,
    duration: item.result.duration,
    createdAt: Date.now(),
    blob: item.result.blob,
  };
  await withStore("readwrite", (store) => store.put(record));
  await loadHistory();
  if (state.history.length > HISTORY_LIMIT) {
    const stale = state.history.slice(HISTORY_LIMIT);
    for (const entry of stale) await withStore("readwrite", (store) => store.delete(entry.id));
    await loadHistory();
  }
}

async function loadHistory() {
  try {
    const records = await withStore("readonly", (store) => store.getAll());
    state.history = records.sort((a, b) => b.createdAt - a.createdAt);
  } catch (error) {
    console.warn("本机处理记录不可用", error);
    state.history = [];
  }
  renderHistory();
}

function renderHistory() {
  if (!state.history.length) {
    elements.historyGrid.innerHTML = '<div class="history-empty">还没有本机处理记录</div>';
    return;
  }
  elements.historyGrid.innerHTML = state.history.map((entry) => `
    <article class="history-card">
      <strong title="${escapeHtml(entry.filename)}">${escapeHtml(entry.filename)}</strong>
      <p>${entry.format.toUpperCase()} · ${entry.width} × ${entry.height} · ${formatBytes(entry.size)}<br>${new Date(entry.createdAt).toLocaleString("zh-CN")}</p>
      <div class="history-actions">
        <button class="text-button" data-history-action="download" data-id="${entry.id}">下载</button>
        <button class="text-button remove" data-history-action="delete" data-id="${entry.id}">删除</button>
      </div>
    </article>`).join("");
}

async function deleteHistory(id) {
  await withStore("readwrite", (store) => store.delete(id));
  await loadHistory();
}

async function clearHistory() {
  await withStore("readwrite", (store) => store.clear());
  await loadHistory();
  showToast("已清空本机处理记录");
}

elements.dropzone.addEventListener("click", () => elements.fileInput.click());
elements.dropzone.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") { event.preventDefault(); elements.fileInput.click(); }
});
elements.fileInput.addEventListener("change", () => {
  addFiles([...elements.fileInput.files]);
  elements.fileInput.value = "";
});
["dragenter", "dragover"].forEach((name) => elements.dropzone.addEventListener(name, (event) => {
  event.preventDefault(); elements.dropzone.classList.add("is-dragging");
}));
["dragleave", "drop"].forEach((name) => elements.dropzone.addEventListener(name, (event) => {
  event.preventDefault(); elements.dropzone.classList.remove("is-dragging");
}));
elements.dropzone.addEventListener("drop", (event) => addFiles([...event.dataTransfer.files]));

elements.queueList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const item = state.items.find((candidate) => candidate.id === button.dataset.id);
  if (!item) return;
  if (button.dataset.action === "remove") removeItem(item.id);
  if (button.dataset.action === "process") processItems([item]);
  if (button.dataset.action === "download" && item.result) downloadBlob(item.result.blob, item.result.filename);
});

elements.historyGrid.addEventListener("click", (event) => {
  const button = event.target.closest("[data-history-action]");
  if (!button) return;
  const entry = state.history.find((record) => record.id === button.dataset.id);
  if (!entry) return;
  if (button.dataset.historyAction === "download") downloadBlob(entry.blob, entry.filename);
  else deleteHistory(entry.id);
});

elements.processAll.addEventListener("click", () => processItems(state.items));
elements.downloadAll.addEventListener("click", async () => {
  for (const item of state.items.filter((candidate) => candidate.result)) {
    downloadBlob(item.result.blob, item.result.filename);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
});
elements.clearQueue.addEventListener("click", clearQueue);
elements.resetSettings.addEventListener("click", resetSettings);
elements.clearHistory.addEventListener("click", clearHistory);
elements.quality.addEventListener("input", updateSettingsUI);
elements.edgeBlur.addEventListener("input", updateSettingsUI);
elements.outputFormat.addEventListener("change", updateSettingsUI);

window.addEventListener("beforeunload", () => {
  disposePreviewPlayers();
  terminateFfmpeg();
  for (const item of state.items) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
});

updateSettingsUI();
renderQueue();
loadHistory();
