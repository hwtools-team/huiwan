(() => {
  "use strict";

  const DIMENSIONS = [
    {
      label: "3 字",
      width: 308,
      height: 104,
      bgKey: "img_10413",
      textKey: "img_10414",
      templates: {
        1: "./templates/level-2-3char.svga",
        2: "./templates/level-2-3char.svga",
        3: "./templates/level-3-3char.svga",
      },
    },
    {
      label: "4 字",
      width: 376,
      height: 104,
      bgKey: "img_10416",
      textKey: "img_10417",
      templates: {
        1: "./templates/level-2-4char.svga",
        2: "./templates/level-2-4char.svga",
        3: "./templates/level-3-4char.svga",
      },
    },
    {
      label: "5 字",
      width: 416,
      height: 104,
      bgKey: "img_10419",
      textKey: "img_10420",
      templates: {
        1: "./templates/level-2-5char.svga",
        2: "./templates/level-2-5char.svga",
        3: "./templates/level-3-5char.svga",
      },
    },
  ];

  const state = {
    level: 1,
    sizeIndex: 0,
    background: null,
    text: null,
    previewPlayer: null,
    previewParser: null,
    previewObjectUrl: null,
    renderToken: 0,
    busy: false,
  };

  const templateCache = new Map();
  let toastTimer = null;
  let MovieEntity = null;

  const elements = {
    levelOptions: [...document.querySelectorAll(".level-option")],
    sizeOptions: [...document.querySelectorAll(".size-option")],
    backgroundDropzone: document.querySelector("#backgroundDropzone"),
    textDropzone: document.querySelector("#textDropzone"),
    backgroundInput: document.querySelector("#backgroundInput"),
    textInput: document.querySelector("#textInput"),
    clearButton: document.querySelector("#clearButton"),
    previewButton: document.querySelector("#previewButton"),
    exportButton: document.querySelector("#exportButton"),
    previewCanvas: document.querySelector("#previewCanvas"),
    previewStatus: document.querySelector("#previewStatus"),
    stageLoading: document.querySelector("#stageLoading"),
    stageError: document.querySelector("#stageError"),
    summaryLevel: document.querySelector("#summaryLevel"),
    summarySize: document.querySelector("#summarySize"),
    summaryOutput: document.querySelector("#summaryOutput"),
    toast: document.querySelector("#toast"),
  };

  class UserFacingError extends Error {}

  function createMovieEntityType() {
    const schema = {
      nested: {
        com: {
          nested: {
            opensource: {
              nested: {
                svga: {
                  options: {
                    objc_class_prefix: "SVGAProto",
                    java_package: "com.opensource.svgaplayer",
                  },
                  nested: {
                    MovieParams: {
                      fields: {
                        viewBoxWidth: { type: "float", id: 1 },
                        viewBoxHeight: { type: "float", id: 2 },
                        fps: { type: "int32", id: 3 },
                        frames: { type: "int32", id: 4 },
                      },
                    },
                    SpriteEntity: {
                      fields: {
                        imageKey: { type: "string", id: 1 },
                        frames: { rule: "repeated", type: "FrameEntity", id: 2 },
                      },
                    },
                    Layout: {
                      fields: {
                        x: { type: "float", id: 1 },
                        y: { type: "float", id: 2 },
                        width: { type: "float", id: 3 },
                        height: { type: "float", id: 4 },
                      },
                    },
                    Transform: {
                      fields: {
                        a: { type: "float", id: 1 },
                        b: { type: "float", id: 2 },
                        c: { type: "float", id: 3 },
                        d: { type: "float", id: 4 },
                        tx: { type: "float", id: 5 },
                        ty: { type: "float", id: 6 },
                      },
                    },
                    ShapeEntity: {
                      oneofs: {
                        args: { oneof: ["shape", "rect", "ellipse"] },
                      },
                      fields: {
                        type: { type: "ShapeType", id: 1 },
                        shape: { type: "ShapeArgs", id: 2 },
                        rect: { type: "RectArgs", id: 3 },
                        ellipse: { type: "EllipseArgs", id: 4 },
                        styles: { type: "ShapeStyle", id: 10 },
                        transform: { type: "Transform", id: 11 },
                      },
                      nested: {
                        ShapeType: {
                          values: {
                            SHAPE: 0,
                            RECT: 1,
                            ELLIPSE: 2,
                            KEEP: 3,
                          },
                        },
                        ShapeArgs: {
                          fields: {
                            d: { type: "string", id: 1 },
                          },
                        },
                        RectArgs: {
                          fields: {
                            x: { type: "float", id: 1 },
                            y: { type: "float", id: 2 },
                            width: { type: "float", id: 3 },
                            height: { type: "float", id: 4 },
                            cornerRadius: { type: "float", id: 5 },
                          },
                        },
                        EllipseArgs: {
                          fields: {
                            x: { type: "float", id: 1 },
                            y: { type: "float", id: 2 },
                            radiusX: { type: "float", id: 3 },
                            radiusY: { type: "float", id: 4 },
                          },
                        },
                        ShapeStyle: {
                          fields: {
                            fill: { type: "RGBAColor", id: 1 },
                            stroke: { type: "RGBAColor", id: 2 },
                            strokeWidth: { type: "float", id: 3 },
                            lineCap: { type: "LineCap", id: 4 },
                            lineJoin: { type: "LineJoin", id: 5 },
                            miterLimit: { type: "float", id: 6 },
                            lineDashI: { type: "float", id: 7 },
                            lineDashII: { type: "float", id: 8 },
                            lineDashIII: { type: "float", id: 9 },
                          },
                          nested: {
                            RGBAColor: {
                              fields: {
                                r: { type: "float", id: 1 },
                                g: { type: "float", id: 2 },
                                b: { type: "float", id: 3 },
                                a: { type: "float", id: 4 },
                              },
                            },
                            LineCap: {
                              values: {
                                LineCap_BUTT: 0,
                                LineCap_ROUND: 1,
                                LineCap_SQUARE: 2,
                              },
                            },
                            LineJoin: {
                              values: {
                                LineJoin_MITER: 0,
                                LineJoin_ROUND: 1,
                                LineJoin_BEVEL: 2,
                              },
                            },
                          },
                        },
                      },
                    },
                    FrameEntity: {
                      fields: {
                        alpha: { type: "float", id: 1 },
                        layout: { type: "Layout", id: 2 },
                        transform: { type: "Transform", id: 3 },
                        clipPath: { type: "string", id: 4 },
                        shapes: { rule: "repeated", type: "ShapeEntity", id: 5 },
                      },
                    },
                    MovieEntity: {
                      fields: {
                        version: { type: "string", id: 1 },
                        params: { type: "MovieParams", id: 2 },
                        images: { keyType: "string", type: "bytes", id: 3 },
                        sprites: { rule: "repeated", type: "SpriteEntity", id: 4 },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    return protobuf.Root.fromJSON(schema).lookupType("com.opensource.svga.MovieEntity");
  }

  function currentDimension() {
    return DIMENSIONS[state.sizeIndex];
  }

  function currentTemplateUrl() {
    return currentDimension().templates[state.level];
  }

  function fileStem(filename) {
    const stem = String(filename || "").split(".")[0].trim();
    return stem || String(Date.now());
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function showToast(message, type = "default") {
    window.clearTimeout(toastTimer);
    elements.toast.textContent = message;
    elements.toast.className = `toast is-visible${type === "error" ? " is-error" : ""}${type === "success" ? " is-success" : ""}`;
    toastTimer = window.setTimeout(() => {
      elements.toast.className = "toast";
    }, 2800);
  }

  function setBusy(isBusy) {
    state.busy = isBusy;
    elements.previewButton.disabled = isBusy;
    elements.exportButton.disabled = isBusy;
  }

  function updateSelectionUI() {
    elements.levelOptions.forEach((option) => {
      const isActive = Number(option.dataset.level) === state.level;
      option.classList.toggle("is-active", isActive);
      option.setAttribute("aria-checked", String(isActive));
    });

    elements.sizeOptions.forEach((option) => {
      const isActive = Number(option.dataset.sizeIndex) === state.sizeIndex;
      option.classList.toggle("is-active", isActive);
      if (isActive) option.setAttribute("aria-current", "true");
      else option.removeAttribute("aria-current");
    });

    const dimension = currentDimension();
    elements.summaryLevel.textContent = `${state.level} 级称号`;
    elements.summarySize.textContent = `${dimension.label} · ${dimension.width} × ${dimension.height}`;
    elements.summaryOutput.textContent = state.text
      ? `${fileStem(state.text.file.name)}.svga`
      : "上传文字图后生成";
  }

  function updateUploadCard(kind) {
    const data = state[kind];
    const prefix = kind === "background" ? "background" : "text";
    const dropzone = elements[`${prefix}Dropzone`];
    const empty = dropzone.querySelector(".upload-empty");
    const filled = dropzone.querySelector(".upload-filled");

    dropzone.classList.toggle("is-filled", Boolean(data));
    empty.hidden = Boolean(data);
    filled.hidden = !data;

    if (!data) return;

    document.querySelector(`#${prefix}Thumb`).src = data.dataUrl;
    document.querySelector(`#${prefix}Name`).textContent = data.file.name;
    document.querySelector(`#${prefix}Meta`).textContent = `${data.width} × ${data.height} · ${formatBytes(data.file.size)}`;
  }

  function updateAllUI() {
    updateSelectionUI();
    updateUploadCard("background");
    updateUploadCard("text");
  }

  function readFileAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new UserFacingError("图片文件读取失败"));
      reader.readAsArrayBuffer(file);
    });
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new UserFacingError("图片预览读取失败"));
      reader.readAsDataURL(file);
    });
  }

  function getImageDimensions(dataUrl) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = () => reject(new UserFacingError("无法解析这张图片"));
      image.src = dataUrl;
    });
  }

  async function parseImageFile(file) {
    if (!file || !file.type || !file.type.startsWith("image/")) {
      throw new UserFacingError("请选择有效的图片文件");
    }

    const [arrayBuffer, dataUrl] = await Promise.all([
      readFileAsArrayBuffer(file),
      readFileAsDataUrl(file),
    ]);
    const { width, height } = await getImageDimensions(dataUrl);
    const sizeIndex = DIMENSIONS.findIndex(
      (item) => item.width === width && item.height === height,
    );

    if (sizeIndex < 0) {
      throw new UserFacingError(
        `素材尺寸不符合要求：${width} × ${height}，请使用 308/376/416 × 104`,
      );
    }

    return {
      file,
      bytes: new Uint8Array(arrayBuffer),
      dataUrl,
      width,
      height,
      sizeIndex,
    };
  }

  async function acceptFile(kind, file) {
    if (state.busy) return;

    try {
      setBusy(true);
      const parsed = await parseImageFile(file);
      const counterpart = kind === "background" ? state.text : state.background;

      if (
        counterpart &&
        (counterpart.width !== parsed.width || counterpart.height !== parsed.height)
      ) {
        throw new UserFacingError("背景图和文字图的尺寸必须完全一致");
      }

      state[kind] = parsed;
      state.sizeIndex = parsed.sizeIndex;
      updateAllUI();
      await renderPreview({ composed: false, quiet: true });
      showToast(
        `${kind === "background" ? "背景图" : "文字图"}已就绪，已自动匹配${currentDimension().label}模板`,
        "success",
      );
    } catch (error) {
      if (!(error instanceof UserFacingError)) console.error(error);
      showToast(
        error instanceof UserFacingError ? error.message : "素材处理失败，请更换文件后重试",
        "error",
      );
    } finally {
      setBusy(false);
      elements.backgroundInput.value = "";
      elements.textInput.value = "";
    }
  }

  async function getTemplateBytes(url) {
    if (!templateCache.has(url)) {
      templateCache.set(
        url,
        fetch(url).then(async (response) => {
          if (!response.ok) {
            throw new Error(`Template request failed: ${response.status}`);
          }
          return new Uint8Array(await response.arrayBuffer());
        }),
      );
    }

    return templateCache.get(url);
  }

  async function buildComposedSvgaBlob() {
    if (!state.background || !state.text) {
      throw new UserFacingError("请先上传背景图和文字图");
    }

    const dimension = currentDimension();
    const compressedTemplate = await getTemplateBytes(currentTemplateUrl());
    const inflatedTemplate = pako.inflate(compressedTemplate);
    const entity = MovieEntity.decode(inflatedTemplate);

    entity.images[dimension.bgKey] = state.background.bytes;
    entity.images[dimension.textKey] = state.text.bytes;

    const encoded = MovieEntity.encode(entity).finish();
    const compressed = pako.deflate(encoded);
    return new Blob([compressed], { type: "application/octet-stream" });
  }

  function destroyPreview() {
    if (state.previewPlayer) {
      try {
        state.previewPlayer.destroy();
      } catch (error) {
        console.warn("Preview player cleanup failed", error);
      }
      state.previewPlayer = null;
    }

    if (state.previewParser) {
      try {
        state.previewParser.destroy();
      } catch (error) {
        console.warn("Preview parser cleanup failed", error);
      }
      state.previewParser = null;
    }

    if (state.previewObjectUrl) {
      URL.revokeObjectURL(state.previewObjectUrl);
      state.previewObjectUrl = null;
    }
  }

  async function renderPreview({ composed, quiet = false }) {
    const token = ++state.renderToken;
    elements.stageLoading.hidden = false;
    elements.stageError.hidden = true;

    try {
      let source = currentTemplateUrl();
      if (composed) {
        const blob = await buildComposedSvgaBlob();
        source = URL.createObjectURL(blob);
      }

      if (token !== state.renderToken) {
        if (source.startsWith("blob:")) URL.revokeObjectURL(source);
        return;
      }

      destroyPreview();
      if (source.startsWith("blob:")) state.previewObjectUrl = source;

      const parser = new SVGA.Parser({
        isDisableWebWorker: true,
        isDisableImageBitmapShim: false,
      });
      state.previewParser = parser;
      const video = await parser.load(source);

      if (token !== state.renderToken) {
        parser.destroy();
        return;
      }

      const player = new SVGA.Player({
        container: elements.previewCanvas,
        loop: 0,
        fillMode: "forwards",
        isUseIntersectionObserver: false,
      });
      state.previewPlayer = player;
      await player.mount(video);

      if (token !== state.renderToken) {
        player.destroy();
        return;
      }

      player.start();
      elements.previewStatus.classList.toggle("is-composed", composed);
      elements.previewStatus.lastChild.textContent = composed ? " 已合成预览" : " 模板预览";
    } catch (error) {
      console.error("SVGA preview failed", error);
      elements.stageError.hidden = false;
      if (!quiet) showToast("动效预览失败，请刷新后重试", "error");
      throw error;
    } finally {
      if (token === state.renderToken) elements.stageLoading.hidden = true;
    }
  }

  async function previewComposed() {
    if (!state.background || !state.text) {
      showToast("请先上传背景图和文字图", "error");
      return;
    }

    try {
      setBusy(true);
      await renderPreview({ composed: true });
      showToast("合成预览已更新", "success");
    } catch (error) {
      // renderPreview already reports the actionable error.
    } finally {
      setBusy(false);
    }
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
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function exportSvga() {
    if (!state.background || !state.text) {
      showToast("请先上传背景图和文字图", "error");
      return;
    }

    try {
      setBusy(true);
      const blob = await buildComposedSvgaBlob();
      const filename = `${fileStem(state.text.file.name)}.svga`;
      downloadBlob(blob, filename);
      clearFiles({ announce: false, rerender: true });
      showToast(`${filename} 已导出`, "success");
    } catch (error) {
      console.error("SVGA export failed", error);
      showToast(
        error instanceof UserFacingError ? error.message : "SVGA 导出失败，请稍后重试",
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  function clearFiles({ announce = true, rerender = true } = {}) {
    state.background = null;
    state.text = null;
    elements.backgroundInput.value = "";
    elements.textInput.value = "";
    updateAllUI();

    if (rerender) {
      renderPreview({ composed: false, quiet: true }).catch(() => {});
    }
    if (announce) showToast("已清空背景图和文字图");
  }

  function bindUploadTarget(kind, dropzone, input) {
    dropzone.addEventListener("click", () => input.click());
    dropzone.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        input.click();
      }
    });

    input.addEventListener("change", () => {
      if (input.files && input.files[0]) acceptFile(kind, input.files[0]);
    });

    ["dragenter", "dragover"].forEach((eventName) => {
      dropzone.addEventListener(eventName, (event) => {
        event.preventDefault();
        dropzone.classList.add("is-dragging");
      });
    });

    ["dragleave", "drop"].forEach((eventName) => {
      dropzone.addEventListener(eventName, (event) => {
        event.preventDefault();
        dropzone.classList.remove("is-dragging");
      });
    });

    dropzone.addEventListener("drop", (event) => {
      const file = event.dataTransfer && event.dataTransfer.files[0];
      if (file) acceptFile(kind, file);
    });
  }

  function bindEvents() {
    elements.levelOptions.forEach((option) => {
      option.addEventListener("click", async () => {
        const nextLevel = Number(option.dataset.level);
        if (nextLevel === state.level || state.busy) return;
        state.level = nextLevel;
        updateSelectionUI();
        try {
          setBusy(true);
          await renderPreview({ composed: false, quiet: true });
        } catch (error) {
          showToast("动效模板加载失败，请刷新后重试", "error");
        } finally {
          setBusy(false);
        }
      });
    });

    bindUploadTarget(
      "background",
      elements.backgroundDropzone,
      elements.backgroundInput,
    );
    bindUploadTarget("text", elements.textDropzone, elements.textInput);
    elements.clearButton.addEventListener("click", () => clearFiles());
    elements.previewButton.addEventListener("click", previewComposed);
    elements.exportButton.addEventListener("click", exportSvga);
  }

  async function initialize() {
    bindEvents();
    updateAllUI();

    if (!window.protobuf || !window.pako || !window.SVGA) {
      elements.stageLoading.hidden = true;
      elements.stageError.hidden = false;
      showToast("工具运行库加载失败，请刷新页面", "error");
      return;
    }

    try {
      MovieEntity = createMovieEntityType();
      await renderPreview({ composed: false, quiet: true });
    } catch (error) {
      console.error("Tool initialization failed", error);
    }
  }

  window.addEventListener("beforeunload", destroyPreview);
  initialize();
})();
