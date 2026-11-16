type ParsedVideo = import("svga/dist/types").Video;
type FrameDrawablePlayer = Omit<import("svga").Player, "drawFrame"> & {
  drawFrame: (frame: number) => void;
};

type ExportOptions = {
  targetBytes?: number;
  shouldCancel?: () => boolean;
};
type Encoding = { format: "png" | "webp"; quality: number };

const MAX_TOTAL_PIXELS = 60_000_000;
const MAX_EDGE = 2048;
const TIMEOUT_MS = 180_000;
const encoder = new TextEncoder();
const byteLength = (value: string) => encoder.encode(value).byteLength;

/** Every frame uses the same timeline; exactly one image is visible at a time. */
function frameAnimation(index: number, count: number, duration: number) {
  if (count === 1) return "";
  const times = [0];
  const values = [index === 0 ? 1 : 0];
  if (index > 0) {
    times.push(index / count);
    values.push(1);
  }
  if (index + 1 < count) {
    times.push((index + 1) / count);
    values.push(0);
  }
  times.push(1);
  values.push(values[values.length - 1]);
  return `<animate attributeName="opacity" values="${values.join(";")}" keyTimes="${times.join(";")}" dur="${duration}s" repeatCount="indefinite" calcMode="discrete"/>`;
}

function frameNode(video: ParsedVideo, dataUrl: string, index: number) {
  return `<image class="svga-raster-frame" href="${dataUrl}" x="0" y="0" width="${video.size.width}" height="${video.size.height}" opacity="${index === 0 ? 1 : 0}">${frameAnimation(index, video.frames, video.frames / video.fps)}</image>`;
}

function svgHeader(video: ParsedVideo, width: number, height: number, encoding: Encoding, targetBytes?: number) {
  const scale = Math.min(width / video.size.width, height / video.size.height);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${video.size.width}" height="${video.size.height}" style="width:100%;height:100%" viewBox="0 0 ${video.size.width} ${video.size.height}" preserveAspectRatio="xMidYMid meet" data-svga-export="raster-frames" data-source-frames="${video.frames}" data-source-fps="${video.fps}" data-render-scale="${scale.toFixed(6)}" data-render-width="${width}" data-render-height="${height}" data-image-format="${encoding.format}" data-image-quality="${encoding.quality}"${targetBytes === undefined ? "" : ` data-target-bytes="${targetBytes}"`}><metadata>逐帧动画 SVG；保留全部帧、透明通道和原始时长。${encoding.format === "webp" ? "帧图片使用有损 WebP 压缩。" : "帧图片使用 PNG。"}</metadata>`;
}

function validateVideo(video: ParsedVideo) {
  if (!Number.isFinite(video.size.width) || !Number.isFinite(video.size.height) ||
      video.size.width <= 0 || video.size.height <= 0 ||
      !Number.isSafeInteger(video.frames) || video.frames <= 0 ||
      !Number.isFinite(video.fps) || video.fps <= 0 ||
      !Number.isFinite(video.frames / video.fps)) {
    throw new Error("SVGA 动画参数无效");
  }
}

/** Scale the outer sprite matrices, so the player's own canvases are bounded too. */
function scaledVideo(video: ParsedVideo, width: number, height: number): ParsedVideo {
  const sx = width / video.size.width;
  const sy = height / video.size.height;
  if (sx === 1 && sy === 1) return video;
  return {
    ...video,
    size: { ...video.size, width, height },
    sprites: video.sprites.map((sprite) => ({
      ...sprite,
      frames: sprite.frames.map((frame) => {
        const t = frame.transform;
        return {
          ...frame,
          transform: {
            a: (t?.a ?? 1) * sx, b: (t?.b ?? 0) * sy,
            c: (t?.c ?? 0) * sx, d: (t?.d ?? 1) * sy,
            tx: (t?.tx ?? 0) * sx, ty: (t?.ty ?? 0) * sy,
          },
        };
      }),
    })),
  };
}

export async function renderRasterFrameSvg(video: ParsedVideo, options: ExportOptions = {}): Promise<string> {
  validateVideo(video);
  const { targetBytes, shouldCancel } = options;
  if (targetBytes !== undefined && (!Number.isSafeInteger(targetBytes) || targetBytes <= 0)) {
    throw new Error("SVG 体积上限必须为正整数字节数");
  }
  const started = performance.now();
  const check = () => {
    if (shouldCancel?.()) throw new Error("任务已取消");
    if (performance.now() - started >= TIMEOUT_MS) throw new Error("SVG 转换超时，请减少素材帧数或使用轻量 SVG");
  };
  check();
  const scale = Math.min(1, MAX_EDGE / video.size.width, MAX_EDGE / video.size.height,
    Math.sqrt(MAX_TOTAL_PIXELS / (video.size.width * video.size.height * video.frames)));
  const initialWidth = Math.max(1, Math.floor(video.size.width * scale));
  const initialHeight = Math.max(1, Math.floor(video.size.height * scale));
  const sourceCanvas = document.createElement("canvas");
  const outputCanvas = document.createElement("canvas");
  const context = outputCanvas.getContext("2d");
  if (!context) throw new Error("无法创建 SVG 帧画布");
  const { Player } = await import("svga");
  check();
  const player = new Player({ container: sourceCanvas, loop: false,
    isCacheFrames: false, isUseIntersectionObserver: false }) as unknown as FrameDrawablePlayer;
  let cancelled = false;
  let mountTimer: ReturnType<typeof setInterval> | undefined;

  async function attempt(width: number, height: number, encoding: Encoding): Promise<string | undefined> {
    check();
    outputCanvas.width = width;
    outputCanvas.height = height;
    context!.imageSmoothingEnabled = true;
    context!.imageSmoothingQuality = "high";
    const parts = [svgHeader(video, width, height, encoding, targetBytes)];
    let bytes = byteLength(parts[0]) + 6; // </svg>
    for (let frame = 0; frame < video.frames; frame += 1) {
      check();
      player.currentFrame = frame;
      player.drawFrame(frame);
      context!.clearRect(0, 0, width, height);
      context!.drawImage(sourceCanvas, 0, 0, width, height);
      const dataUrl = outputCanvas.toDataURL(`image/${encoding.format}`, encoding.quality);
      if (!dataUrl.startsWith(`data:image/${encoding.format};base64,`)) {
        throw new Error(encoding.format === "webp" ? "当前浏览器不支持 WebP 压缩导出，请使用 Chrome 或 Edge" : "无法编码 SVG 帧图片");
      }
      const node = frameNode(video, dataUrl, frame);
      // Base64 frame nodes contain ASCII only, so character count is byte-exact.
      bytes += node.length;
      if (targetBytes !== undefined && bytes > targetBytes) return undefined;
      parts.push(node);
      if (frame % 2 === 1) await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
    check();
    parts.push("</svg>");
    const result = parts.join("");
    if (targetBytes !== undefined && byteLength(result) > targetBytes) return undefined;
    return result;
  }

  try {
    // The vendor mount promise has no rejection for image decode errors. Bound it
    // explicitly, and clear resources even if its image events arrive afterwards.
    const mounting = player.mount(scaledVideo(video, initialWidth, initialHeight));
    void mounting.then(() => { if (cancelled) { sourceCanvas.width = 0; sourceCanvas.height = 0; } }, () => {});
    await Promise.race([mounting, new Promise<never>((_resolve, reject) => {
      mountTimer = setInterval(() => { try { check(); } catch (error) { reject(error); } }, 100);
    })]);
    if (mountTimer) clearInterval(mountTimer);
    check();
    const png = await attempt(initialWidth, initialHeight, { format: "png", quality: 1 });
    if (png !== undefined) return png;
    for (const quality of [0.92, 0.82, 0.72]) {
      const svg = await attempt(initialWidth, initialHeight, { format: "webp", quality });
      if (svg !== undefined) return svg;
    }
    // Keep all frames. Avoid a false success with an unusable one-pixel animation:
    // the long edge may shrink down to 64 px (or the original size if smaller).
    const initialLongEdge = Math.max(initialWidth, initialHeight);
    const minimumScale = Math.min(1, 64 / initialLongEdge);
    let factor = 1;
    while (factor > minimumScale) {
      factor = Math.max(minimumScale, factor * 0.8);
      const width = Math.max(1, Math.round(initialWidth * factor));
      const height = Math.max(1, Math.round(initialHeight * factor));
      const svg = await attempt(width, height, { format: "webp", quality: 0.72 });
      if (svg !== undefined) return svg;
    }
    throw new Error(`保留全部帧时仍无法压到 ${(targetBytes! / 1_000_000).toFixed(2)} MB；请使用轻量 SVG 或原高保真导出`);
  } finally {
    cancelled = true;
    if (mountTimer) clearInterval(mountTimer);
    player.destroy();
    sourceCanvas.width = 0;
    sourceCanvas.height = 0;
    outputCanvas.width = 0;
    outputCanvas.height = 0;
  }
}

export function verifySvgStructure(svg: string, video: ParsedVideo, targetBytes?: number): string {
  validateVideo(video);
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = doc.documentElement;
  const images = Array.from(doc.querySelectorAll("image.svga-raster-frame"));
  const viewBox = (root.getAttribute("viewBox") ?? "").split(/\s+/).map(Number);
  const format = root.getAttribute("data-image-format");
  const renderWidth = Number(root.getAttribute("data-render-width"));
  const renderHeight = Number(root.getAttribute("data-render-height"));
  const quality = Number(root.getAttribute("data-image-quality"));
  const renderScale = Math.min(renderWidth / video.size.width, renderHeight / video.size.height);
  const invalid = doc.querySelector("parsererror") || root.localName !== "svg" ||
    Number(root.getAttribute("width")) !== video.size.width ||
    Number(root.getAttribute("height")) !== video.size.height ||
    viewBox.length !== 4 || viewBox[0] !== 0 || viewBox[1] !== 0 ||
    viewBox[2] !== video.size.width || viewBox[3] !== video.size.height ||
    root.getAttribute("style") !== "width:100%;height:100%" ||
    root.getAttribute("preserveAspectRatio") !== "xMidYMid meet" ||
    root.getAttribute("data-svga-export") !== "raster-frames" ||
    Number(root.getAttribute("data-source-frames")) !== video.frames ||
    Number(root.getAttribute("data-source-fps")) !== video.fps ||
    !Number.isSafeInteger(renderWidth) || renderWidth < 1 || renderWidth > MAX_EDGE ||
    !Number.isSafeInteger(renderHeight) || renderHeight < 1 || renderHeight > MAX_EDGE ||
    renderWidth > Math.ceil(video.size.width) || renderHeight > Math.ceil(video.size.height) ||
    root.getAttribute("data-render-scale") !== renderScale.toFixed(6) ||
    quality <= 0 || quality > 1 || !Number.isFinite(quality) ||
    (format === "png" && quality !== 1) ||
    !["png", "webp"].includes(format ?? "") || images.length !== video.frames ||
    images.some((image, index) => {
      const animations = image.querySelectorAll("animate");
      if (!image.getAttribute("href")?.startsWith(`data:image/${format};base64,`) ||
        image.getAttribute("x") !== "0" || image.getAttribute("y") !== "0" ||
        Number(image.getAttribute("width")) !== video.size.width ||
        Number(image.getAttribute("height")) !== video.size.height ||
        image.getAttribute("opacity") !== (index === 0 ? "1" : "0") ||
        animations.length !== (video.frames > 1 ? 1 : 0)) return true;
      if (video.frames === 1) return false;
      const expected = new DOMParser().parseFromString(
        `<svg xmlns="http://www.w3.org/2000/svg">${frameAnimation(index, video.frames, video.frames / video.fps)}</svg>`,
        "image/svg+xml",
      ).querySelector("animate")!;
      return Array.from(expected.attributes).some((attr) =>
        animations[0].getAttribute(attr.name) !== attr.value);
    });
  if (invalid) throw new Error("SVG 结构校验失败");
  if (targetBytes !== undefined && (byteLength(svg) > targetBytes || Number(root.getAttribute("data-target-bytes")) !== targetBytes)) {
    throw new Error("SVG 超过设定的体积上限，已停止下载");
  }
  return svg;
}
