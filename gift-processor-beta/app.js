(function () {
  "use strict";

  var MAX_FILES = 20;
  var MAX_FILE_BYTES = 50 * 1024 * 1024;
  var MAX_FRAMES = 300;

  var state = {
    items: [],
    players: new Map(),
    processing: false,
    toastTimer: null,
  };

  var elements = {
    dropzone: document.getElementById("dropzone"),
    fileInput: document.getElementById("fileInput"),
    queueSection: document.getElementById("queueSection"),
    queueCount: document.getElementById("queueCount"),
    queueList: document.getElementById("queueList"),
    clearButton: document.getElementById("clearButton"),
    exportAllButton: document.getElementById("exportAllButton"),
    guide: document.getElementById("guide"),
    toast: document.getElementById("toast"),
  };

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function showToast(message, type) {
    window.clearTimeout(state.toastTimer);
    elements.toast.textContent = message;
    elements.toast.className = "toast visible" + (type === "error" ? " error" : type === "success" ? " success" : "");
    state.toastTimer = window.setTimeout(function () {
      elements.toast.className = "toast";
    }, 3000);
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return "—";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / 1024 / 1024).toFixed(2) + " MB";
  }

  function formatDuration(seconds) {
    return Number(seconds || 0).toFixed(2) + " 秒";
  }

  function fileStem(name) {
    return String(name || "svga-animation")
      .replace(/\.[^.]+$/, "")
      .replace(/[^\p{L}\p{N}._-]+/gu, "-")
      .replace(/^-+|-+$/g, "") || "svga-animation";
  }

  function decodedImageMemory(video) {
    var values = Object.values(video.images || {});
    var total = values.reduce(function (sum, image) {
      var width = Number(image && image.width) || 0;
      var height = Number(image && image.height) || 0;
      return sum + width * height * 4;
    }, 0);
    return total || video.size.width * video.size.height * 4;
  }

  function canvasToPng(canvas) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (!blob) {
          reject(new Error("当前帧无法编码为 PNG"));
          return;
        }
        blob.arrayBuffer().then(function (buffer) {
          resolve(new Uint8Array(buffer));
        }, reject);
      }, "image/png");
    });
  }

  async function parseSvga(file) {
    var url = URL.createObjectURL(file);
    var parser = new window.SVGA.Parser({
      isDisableWebWorker: true,
      isDisableImageBitmapShim: false,
    });
    try {
      var video = await parser.load(url);
      if (!video.frames || video.frames > MAX_FRAMES) {
        throw new Error("SVGA 帧数为 " + video.frames + "，测试版最多支持 " + MAX_FRAMES + " 帧");
      }
      return {
        video: video,
        width: video.size.width,
        height: video.size.height,
        frames: video.frames,
        fps: video.fps,
        duration: video.fps ? video.frames / video.fps : 0,
        decodedMemory: decodedImageMemory(video),
      };
    } finally {
      parser.destroy();
      URL.revokeObjectURL(url);
    }
  }

  async function mountPreview(item) {
    var stage = elements.queueList.querySelector('[data-preview-id="' + item.id + '"]');
    if (!stage || (item.status !== "ready" && item.status !== "done")) return;
    stage.innerHTML = "";
    var canvas = document.createElement("canvas");
    canvas.setAttribute("aria-label", item.file.name + " 动画预览");
    stage.appendChild(canvas);
    var player = new window.SVGA.Player({
      container: canvas,
      loop: 0,
      fillMode: "forwards",
      isUseIntersectionObserver: false,
    });
    await player.mount(item.video);
    player.start();
    state.players.set(item.id, player);
  }

  function destroyPlayers() {
    state.players.forEach(function (player) {
      try { player.destroy(); } catch (error) { console.warn(error); }
    });
    state.players.clear();
  }

  function cardHtml(item) {
    var statusClass = item.status === "done" ? "done" : item.status === "error" ? "error" : "";
    var result = item.result;
    return '' +
      '<article class="asset-card" data-item-id="' + item.id + '">' +
        '<div class="preview-stage" data-preview-id="' + item.id + '">' +
          '<div class="preview-loading"><span class="spinner"></span>' + (item.status === "parsing" ? '正在解析 SVGA' : '正在准备预览') + '</div>' +
        '</div>' +
        '<div class="file-panel">' +
          '<div class="file-state ' + statusClass + '" data-status>' + escapeHtml(item.message) + '</div>' +
          '<h3 class="file-name" title="' + escapeHtml(item.file.name) + '">' + escapeHtml(item.file.name) + '</h3>' +
          '<div class="metadata-grid">' +
            '<div class="meta-item"><span>画布尺寸</span><strong>' + (item.width ? item.width + ' × ' + item.height : '—') + '</strong></div>' +
            '<div class="meta-item"><span>原始帧数</span><strong>' + (item.frames || '—') + ' 帧</strong></div>' +
            '<div class="meta-item"><span>原始帧率</span><strong>' + (item.fps || '—') + ' FPS</strong></div>' +
            '<div class="meta-item"><span>原始时长</span><strong>' + (item.duration ? formatDuration(item.duration) : '—') + '</strong></div>' +
            '<div class="meta-item"><span>SVGA 文件</span><strong>' + formatBytes(item.file.size) + '</strong></div>' +
            '<div class="meta-item"><span>图片解码内存</span><strong>' + (item.decodedMemory ? formatBytes(item.decodedMemory) : '—') + '</strong></div>' +
          '</div>' +
          '<div class="progress-box" data-progress-box ' + (item.status === "processing" ? '' : 'hidden') + '>' +
            '<div class="progress-track"><span data-progress style="width:' + Math.round(item.progress * 100) + '%"></span></div>' +
            '<div class="progress-copy"><span data-progress-copy>' + escapeHtml(item.message) + '</span><strong data-progress-value>' + Math.round(item.progress * 100) + '%</strong></div>' +
          '</div>' +
          (result ? '<div class="result-box"><strong>' + escapeHtml(result.filename) + '</strong><span>' + result.frames + ' 张 PNG · ' + result.width + ' × ' + result.height + ' · ' + formatBytes(result.blob.size) + '</span></div>' : '') +
          (item.error ? '<p class="error-copy">' + escapeHtml(item.error) + '</p>' : '') +
          '<div class="card-actions">' +
            '<button class="button button-primary" type="button" data-action="export" data-id="' + item.id + '" ' + (state.processing || item.status === "parsing" ? 'disabled' : '') + '>' + (result ? '重新下载 ZIP' : '生成并下载 PNG 序列') + '</button>' +
            '<button class="button button-danger" type="button" data-action="remove" data-id="' + item.id + '" ' + (state.processing ? 'disabled' : '') + '>移除这个文件</button>' +
          '</div>' +
        '</div>' +
      '</article>';
  }

  function renderQueue() {
    destroyPlayers();
    elements.queueSection.hidden = state.items.length === 0;
    elements.guide.hidden = state.items.length > 0;
    elements.queueCount.textContent = state.items.length + " 个文件";
    elements.queueList.innerHTML = state.items.map(cardHtml).join("");
    elements.exportAllButton.disabled = state.processing || !state.items.some(function (item) { return item.status === "ready" || item.status === "done"; });
    elements.clearButton.disabled = state.processing;
    state.items.forEach(function (item) {
      if (item.status === "ready" || item.status === "done") mountPreview(item);
    });
  }

  function updateCard(item) {
    var card = elements.queueList.querySelector('[data-item-id="' + item.id + '"]');
    if (!card) return;
    var status = card.querySelector("[data-status]");
    status.textContent = item.message;
    status.className = "file-state " + (item.status === "done" ? "done" : item.status === "error" ? "error" : "");
    var progressBox = card.querySelector("[data-progress-box]");
    progressBox.hidden = item.status !== "processing";
    card.querySelector("[data-progress]").style.width = Math.round(item.progress * 100) + "%";
    card.querySelector("[data-progress-copy]").textContent = item.message;
    card.querySelector("[data-progress-value]").textContent = Math.round(item.progress * 100) + "%";
  }

  async function addFiles(files) {
    var remaining = MAX_FILES - state.items.length;
    var selected = files.slice(0, remaining);
    var rejected = [];
    if (files.length > remaining) rejected.push((files.length - remaining) + " 个文件超出20个上限");

    for (var index = 0; index < selected.length; index += 1) {
      var file = selected[index];
      if (!/\.svga$/i.test(file.name)) {
        rejected.push(file.name + "：只支持 .svga");
        continue;
      }
      if (file.size > MAX_FILE_BYTES) {
        rejected.push(file.name + "：超过50 MB");
        continue;
      }
      var item = {
        id: crypto.randomUUID(),
        file: file,
        status: "parsing",
        message: "正在解析",
        progress: 0,
        result: null,
        error: null,
      };
      state.items.push(item);
      renderQueue();
      try {
        Object.assign(item, await parseSvga(file));
        item.status = "ready";
        item.message = "可导出";
      } catch (error) {
        item.status = "error";
        item.message = "解析失败";
        item.error = error.message || "SVGA 文件无法解析";
      }
      renderQueue();
    }

    if (rejected.length) showToast(rejected.slice(0, 3).join("；"), "error");
  }

  async function renderFrames(item, onProgress) {
    var canvas = document.createElement("canvas");
    var player = new window.SVGA.Player({ container: canvas, loop: false });
    await player.mount(item.video);
    var frames = [];
    try {
      for (var index = 0; index < item.frames; index += 1) {
        player.currentFrame = index;
        player.drawFrame(index);
        frames.push(await canvasToPng(canvas));
        onProgress((index + 1) / item.frames);
        if (index % 4 === 3) await new Promise(function (resolve) { window.setTimeout(resolve, 0); });
      }
    } finally {
      player.destroy();
    }
    return frames;
  }

  async function makeZip(item, frames, onProgress) {
    var zip = new window.JSZip();
    var folder = zip.folder(fileStem(item.file.name) + "-png-sequence");
    var digits = Math.max(3, String(frames.length - 1).length);
    frames.forEach(function (frame, index) {
      folder.file(String(index).padStart(digits, "0") + ".png", frame, {
        binary: true,
        compression: "STORE",
      });
    });
    return zip.generateAsync(
      { type: "blob", mimeType: "application/zip", compression: "STORE" },
      function (metadata) { onProgress(metadata.percent / 100); },
    );
  }

  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }

  async function exportItem(item, autoDownload) {
    if (item.result) {
      if (autoDownload !== false) downloadBlob(item.result.blob, item.result.filename);
      return item.result;
    }
    item.status = "processing";
    item.message = "正在逐帧渲染 PNG";
    item.progress = 0;
    item.error = null;
    updateCard(item);
    try {
      var frames = await renderFrames(item, function (progress) {
        item.progress = progress * 0.8;
        updateCard(item);
      });
      item.message = "正在打包 ZIP";
      updateCard(item);
      var zipBlob = await makeZip(item, frames, function (progress) {
        item.progress = 0.8 + progress * 0.2;
        updateCard(item);
      });
      item.result = {
        blob: zipBlob,
        filename: fileStem(item.file.name) + "-png-sequence.zip",
        frames: frames.length,
        width: item.width,
        height: item.height,
      };
      item.status = "done";
      item.message = "已生成 " + frames.length + " 张 PNG";
      item.progress = 1;
      renderQueue();
      if (autoDownload !== false) downloadBlob(zipBlob, item.result.filename);
      return item.result;
    } catch (error) {
      item.status = "error";
      item.message = "导出失败";
      item.error = error.message || "PNG 序列生成失败";
      renderQueue();
      throw error;
    }
  }

  async function exportAll() {
    if (state.processing) return;
    var candidates = state.items.filter(function (item) { return item.status === "ready" || item.status === "done"; });
    if (!candidates.length) return;
    state.processing = true;
    renderQueue();
    try {
      for (var index = 0; index < candidates.length; index += 1) {
        await exportItem(candidates[index], true);
        if (index < candidates.length - 1) await new Promise(function (resolve) { window.setTimeout(resolve, 350); });
      }
      showToast("已导出 " + candidates.length + " 个 PNG 序列 ZIP", "success");
    } catch (error) {
      showToast(error.message || "批量导出中断", "error");
    } finally {
      state.processing = false;
      renderQueue();
    }
  }

  function removeItem(id) {
    if (state.processing) return;
    var player = state.players.get(id);
    if (player) {
      try { player.destroy(); } catch (error) { console.warn(error); }
      state.players.delete(id);
    }
    state.items = state.items.filter(function (item) { return item.id !== id; });
    renderQueue();
  }

  function clearAll() {
    if (state.processing) return;
    state.items = [];
    renderQueue();
  }

  elements.dropzone.addEventListener("click", function () { elements.fileInput.click(); });
  elements.dropzone.addEventListener("keydown", function (event) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      elements.fileInput.click();
    }
  });
  elements.fileInput.addEventListener("change", function () {
    addFiles(Array.from(elements.fileInput.files || []));
    elements.fileInput.value = "";
  });
  ["dragenter", "dragover"].forEach(function (name) {
    elements.dropzone.addEventListener(name, function (event) {
      event.preventDefault();
      elements.dropzone.classList.add("is-dragging");
    });
  });
  ["dragleave", "drop"].forEach(function (name) {
    elements.dropzone.addEventListener(name, function (event) {
      event.preventDefault();
      elements.dropzone.classList.remove("is-dragging");
    });
  });
  elements.dropzone.addEventListener("drop", function (event) {
    addFiles(Array.from(event.dataTransfer.files || []));
  });
  elements.queueList.addEventListener("click", function (event) {
    var button = event.target.closest("[data-action]");
    if (!button) return;
    var item = state.items.find(function (candidate) { return candidate.id === button.dataset.id; });
    if (!item) return;
    if (button.dataset.action === "remove") removeItem(item.id);
    if (button.dataset.action === "export") {
      state.processing = true;
      renderQueue();
      exportItem(item, true)
        .then(function () { showToast("已下载 " + item.result.filename, "success"); })
        .catch(function (error) { showToast(error.message || "导出失败", "error"); })
        .finally(function () { state.processing = false; renderQueue(); });
    }
  });
  elements.clearButton.addEventListener("click", clearAll);
  elements.exportAllButton.addEventListener("click", exportAll);
  window.addEventListener("beforeunload", destroyPlayers);

  if (!window.SVGA || !window.JSZip) {
    showToast("页面运行库未加载，请刷新页面", "error");
    elements.dropzone.setAttribute("aria-disabled", "true");
  }
  renderQueue();
})();
