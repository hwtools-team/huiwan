(() => {
  const fileInput = document.getElementById("fileInput");
  const dropzone = document.getElementById("dropzone");
  const previewSection = document.getElementById("previewSection");
  const previewGrid = document.getElementById("previewGrid");
  const previewCount = document.getElementById("previewCount");

  if (!fileInput || !dropzone || !previewSection || !previewGrid || !previewCount) {
    return;
  }

  const queue = [];
  const players = [];
  const objectUrls = new Set();
  const maxConcurrentPreviews = 2;
  let activePreviews = 0;
  let totalFiles = 0;

  function updateCount() {
    previewCount.textContent = `${totalFiles} 个文件`;
    previewSection.classList.toggle("hidden", totalFiles === 0);
  }

  function createPreviewCard(file) {
    const card = document.createElement("article");
    card.className = "preview-card";

    const stage = document.createElement("div");
    stage.className = "preview-stage";

    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-label", `${file.name} 动画预览`);

    const loading = document.createElement("span");
    loading.className = "preview-loading";
    loading.textContent = "正在加载预览…";

    const body = document.createElement("div");
    body.className = "preview-card-body";

    const name = document.createElement("p");
    name.className = "preview-name";
    name.title = file.name;
    name.textContent = file.name;

    const status = document.createElement("p");
    status.className = "preview-status";
    status.textContent = "等待预览";

    stage.append(canvas, loading);
    body.append(name, status);
    card.append(stage, body);
    previewGrid.append(card);

    return { card, canvas, loading, status };
  }

  function addFiles(fileList) {
    const files = Array.from(fileList || []).filter((file) =>
      file.name.toLowerCase().endsWith(".svga")
    );

    if (files.length === 0) {
      return;
    }

    files.forEach((file) => {
      queue.push({ file, elements: createPreviewCard(file) });
    });
    totalFiles += files.length;
    updateCount();
    runQueue();
  }

  async function renderPreview(job) {
    const { file, elements } = job;
    const { card, canvas, loading, status } = elements;
    let objectUrl;

    try {
      status.textContent = "正在解析动画";
      objectUrl = URL.createObjectURL(file);
      objectUrls.add(objectUrl);

      const parser = new window.SVGA.Parser({ isDisableWebWorker: true });
      const video = await parser.load(objectUrl);

      URL.revokeObjectURL(objectUrl);
      objectUrls.delete(objectUrl);
      objectUrl = null;

      canvas.width = video.size.width;
      canvas.height = video.size.height;

      const player = new window.SVGA.Player(canvas);
      await player.mount(video);
      player.setConfig({
        loop: 0,
        playMode: "forwards",
        startFrame: 0,
        endFrame: Math.max(video.frames - 1, 0),
        isCacheFrames: false,
        isUseIntersectionObserver: true,
        isOpenNoExecutionDelay: true,
      });
      player.start();
      players.push(player);

      const width = Math.round(video.size.width);
      const height = Math.round(video.size.height);
      status.textContent = `预览中 · ${width}×${height} · ${video.frames} 帧`;
      card.classList.add("is-ready");
    } catch (error) {
      console.warn(`无法预览 ${file.name}`, error);
      loading.textContent = "预览失败";
      status.textContent = "文件无法解析，但不影响原转换任务";
      card.classList.add("is-error");
    } finally {
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
        objectUrls.delete(objectUrl);
      }
    }
  }

  function runQueue() {
    while (activePreviews < maxConcurrentPreviews && queue.length > 0) {
      const job = queue.shift();
      activePreviews += 1;
      renderPreview(job).finally(() => {
        activePreviews -= 1;
        runQueue();
      });
    }
  }

  fileInput.addEventListener(
    "change",
    (event) => {
      addFiles(event.target.files);
    },
    { capture: true }
  );

  dropzone.addEventListener(
    "drop",
    (event) => {
      addFiles(event.dataTransfer && event.dataTransfer.files);
    },
    { capture: true }
  );

  window.addEventListener("pagehide", () => {
    players.forEach((player) => {
      try {
        if (typeof player.stop === "function") {
          player.stop();
        }
        if (typeof player.destroy === "function") {
          player.destroy();
        }
      } catch (error) {
        console.warn("清理 SVGA 预览资源失败", error);
      }
    });
    objectUrls.forEach((url) => URL.revokeObjectURL(url));
    objectUrls.clear();
  });
})();
