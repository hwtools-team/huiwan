"use client";

import JSZip from "jszip";
import { getLightweightCompatibility, buildLightweightSvg, verifyLightweightSvgStructure } from "./lightweight-export";
import { renderRasterFrameSvg, verifySvgStructure } from "./raster-export";
import {
  ChangeEvent,
  DragEvent,
  KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type ParsedVideo = import("svga/dist/types").Video;
type PlayerInstance = import("svga").Player;
type ParserInstance = import("svga").Parser;

type AssetKind = "svga" | "svg" | "pag";
type PreviewStatus = "parsing" | "ready" | "error";
type ConvertStatus = "idle" | "converting" | "ready" | "error";
type ConvertMode = "lightweight" | "compact" | "high-fidelity";
const COMPACT_SVG_MAX_BYTES = 3_000_000;
type BackgroundMode = "checker" | "dark" | "light";

type AssetMetadata = {
  width?: number;
  height?: number;
  frames?: number;
  fps?: number;
  duration?: number;
  animated?: boolean;
  previewScaled?: boolean;
  svgMode?: "vector" | "lightweight" | "raster-frames" | "compact-frames";
};

type AssetItem = {
  id: string;
  kind: AssetKind;
  file: File;
  name: string;
  size: number;
  previewStatus: PreviewStatus;
  convertStatus: ConvertStatus;
  metadata?: AssetMetadata;
  video?: ParsedVideo;
  previewUrl?: string;
  convertedSvg?: string;
  convertedMode?: ConvertMode;
  exportSummary?: string;
  error?: string;
};

type PagFileInstance = {
  width: () => number;
  height: () => number;
  frameRate: () => number;
  duration: () => number;
  destroy: () => void;
};

type PagViewInstance = {
  play: () => Promise<void>;
  pause: () => void;
  stop: () => Promise<void>;
  setRepeatCount: (count: number) => void;
  destroy: () => void;
};

type PagRuntime = {
  PAGFile: {
    load: (data: File | Blob | ArrayBuffer) => Promise<PagFileInstance>;
  };
  PAGView: {
    init: (
      file: PagFileInstance,
      canvas: HTMLCanvasElement,
      options?: { useScale?: boolean; firstFrame?: boolean },
    ) => Promise<PagViewInstance | null>;
  };
};

type PagLibrary = {
  PAGInit: (options: {
    locateFile?: (name: string) => string;
    wasmBinary?: Uint8Array;
  }) => Promise<PagRuntime>;
};

declare global {
  interface Window {
    libpag?: PagLibrary;
  }
}

const MAX_FILES = 50;
const MAX_SOURCE_FILE_BYTES = 20 * 1024 * 1024;
const MAX_SVG_FILE_BYTES = 100 * 1024 * 1024;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const MAX_ACTIVE_PAG_PLAYERS = 6;
const MAX_PAG_CANVAS_EDGE = 4096;
const MAX_PAG_CANVAS_PIXELS = 8 * 1024 * 1024;
const SVGA_PARSE_TIMEOUT_MS = 30_000;
const PAG_RUNTIME_TIMEOUT_MS = 15_000;
const PAG_FILE_TIMEOUT_MS = 20_000;
const LIBPAG_VERSION = "4.5.81";
const LIBPAG_SCRIPT_MARKER = `libpag-${LIBPAG_VERSION}`;
const LIBPAG_SCRIPT_URL = `./vendor/libpag-${LIBPAG_VERSION}.min.js`;
const LIBPAG_WASM_URL = `./vendor/libpag-${LIBPAG_VERSION}.wasm`;
const LIBPAG_EMBEDDED_WASM_ELEMENT_ID = "libpag-wasm-base64";

let pagRuntimePromise: Promise<PagRuntime> | null = null;
let activePagPlayers = 0;
let pagPreviewLoadingBlocked = false;

type PagSlotRequest = {
  cancelled: boolean;
  resolve: (release: () => void) => void;
};

const pagSlotQueue: PagSlotRequest[] = [];

function pumpPagSlots() {
  while (activePagPlayers < MAX_ACTIVE_PAG_PLAYERS && pagSlotQueue.length) {
    const request = pagSlotQueue.shift();
    if (!request || request.cancelled) continue;

    activePagPlayers += 1;
    let released = false;
    request.resolve(() => {
      if (released) return;
      released = true;
      activePagPlayers = Math.max(0, activePagPlayers - 1);
      pumpPagSlots();
    });
  }
}

function requestPagSlot(priority = false) {
  let request: PagSlotRequest;
  const promise = new Promise<() => void>((resolve) => {
    request = { cancelled: false, resolve };
    if (priority) pagSlotQueue.unshift(request);
    else pagSlotQueue.push(request);
    pumpPagSlots();
  });

  return {
    promise,
    cancel: () => {
      request!.cancelled = true;
    },
  };
}

function formatBytes(bytes: number) {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} KB`;
  return `${(bytes / 1_000_000).toFixed(2)} MB`;
}

function formatSeconds(seconds?: number) {
  if (!seconds || !Number.isFinite(seconds)) return "—";
  return `${seconds.toFixed(2)}s`;
}

function baseName(name: string) {
  return name.replace(/\.[^.]+$/i, "");
}

function kindFromFile(file: File): AssetKind | null {
  const match = file.name.match(/\.(svga|svg|pag)$/i);
  return match ? (match[1].toLowerCase() as AssetKind) : null;
}

function maxBytesForFile(file: File) {
  return kindFromFile(file) === "svg"
    ? MAX_SVG_FILE_BYTES
    : MAX_SOURCE_FILE_BYTES;
}

function safePagCanvasSize(width: number, height: number) {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new Error("PAG 画布尺寸无效");
  }

  const scale = Math.min(
    1,
    MAX_PAG_CANVAS_EDGE / width,
    MAX_PAG_CANVAS_EDGE / height,
    Math.sqrt(MAX_PAG_CANVAS_PIXELS / (width * height)),
  );
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scaled: scale < 1,
  };
}

function takeEmbeddedPagWasm() {
  const source = document.getElementById(LIBPAG_EMBEDDED_WASM_ELEMENT_ID);
  const encoded = source?.textContent?.trim();
  if (!source || !encoded) return undefined;

  const binary = window.atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  source.remove();
  return bytes;
}

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function parseSvgLength(value: string | null) {
  if (!value) return undefined;
  const match = value.trim().match(/^([0-9]+(?:\.[0-9]+)?)(?:px)?$/i);
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function removeExternalCss(css: string) {
  return css
    .replace(/@import\s+[^;]+;?/gi, "")
    .replace(
      /url\(\s*(['"]?)(.*?)\1\s*\)/gi,
      (match, _quote, rawTarget) => {
        const target = String(rawTarget).trim();
        return target.startsWith("#") || target.startsWith("data:")
          ? match
          : "none";
      },
    );
}

function prepareSvgPreview(source: string) {
  const documentNode = new DOMParser().parseFromString(source, "image/svg+xml");
  const root = documentNode.documentElement;

  if (
    documentNode.querySelector("parsererror") ||
    root.localName.toLowerCase() !== "svg"
  ) {
    throw new Error("SVG 文件结构无效");
  }

  documentNode
    .querySelectorAll(
      "script, foreignObject, iframe, object, embed, link, meta, audio, video",
    )
    .forEach((element) => element.remove());

  documentNode.querySelectorAll("*").forEach((element) => {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();

      if (name.startsWith("on")) {
        element.removeAttribute(attribute.name);
        continue;
      }

      if (
        (name === "href" || name.endsWith(":href")) &&
        value &&
        !value.startsWith("#") &&
        !value.startsWith("data:image/")
      ) {
        element.removeAttribute(attribute.name);
        continue;
      }

      if (name === "style") {
        element.setAttribute(attribute.name, removeExternalCss(value));
      } else if (/url\(/i.test(value)) {
        element.setAttribute(attribute.name, removeExternalCss(value));
      }
    }
  });

  documentNode.querySelectorAll("style").forEach((style) => {
    style.textContent = removeExternalCss(style.textContent ?? "");
  });

  if (!root.getAttribute("xmlns")) {
    root.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  }

  const viewBox = (root.getAttribute("viewBox") ?? "")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  const width =
    parseSvgLength(root.getAttribute("width")) ??
    (viewBox.length === 4 && viewBox[2] > 0 ? viewBox[2] : undefined);
  const height =
    parseSvgLength(root.getAttribute("height")) ??
    (viewBox.length === 4 && viewBox[3] > 0 ? viewBox[3] : undefined);
  const exportMode = root.getAttribute("data-svga-export");
  const svgMode: AssetMetadata["svgMode"] =
    exportMode === "raster-frames" && Number(root.getAttribute("data-target-bytes")) > 0
      ? "compact-frames"
      : exportMode === "raster-frames"
      ? "raster-frames"
      : exportMode === "lightweight"
        ? "lightweight"
        : "vector";
  const serialized = normalizeSvgForDisplay(new XMLSerializer().serializeToString(root), width, height);
  const animated = Boolean(
    root.querySelector("animate, animateMotion, animateTransform, set") ||
      /@keyframes|animation\s*:/i.test(serialized),
  );
  const previewUrl = URL.createObjectURL(
    new Blob([serialized], { type: "image/svg+xml;charset=utf-8" }),
  );

  return { previewUrl, metadata: { width, height, animated, svgMode } };
}

function normalizeSvgForDisplay(
  source: string,
  width?: number,
  height?: number,
) {
  try {
    const documentNode = new DOMParser().parseFromString(source, "image/svg+xml");
    const root = documentNode.documentElement;

    if (
      documentNode.querySelector("parsererror") ||
      root.localName.toLowerCase() !== "svg"
    ) {
      return source;
    }

    if (width && height && !root.getAttribute("viewBox")) {
      root.setAttribute("viewBox", `0 0 ${width} ${height}`);
    }

    root.setAttribute("preserveAspectRatio", "xMidYMid meet");
    root.setAttribute("overflow", "visible");

    documentNode.querySelectorAll("animateTransform").forEach((element) => {
      if (element.getAttribute("type") === "skew") {
        element.setAttribute("type", "skewX");
      }
    });

    return new XMLSerializer().serializeToString(root);
  } catch {
    return source;
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  onLateResolve?: (value: T) => void,
) {
  return new Promise<T>((resolve, reject) => {
    let timedOut = false;
    const timer = window.setTimeout(
      () => {
        timedOut = true;
        reject(new Error("操作超时"));
      },
      milliseconds,
    );
    promise.then(
      (value) => {
        if (timedOut) {
          try {
            onLateResolve?.(value);
          } catch {
            // 超时后的清理不能再影响已经结束的任务。
          }
          return;
        }
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (timedOut) return;
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function loadScript(
  src: string,
  marker: string,
  scriptType: "classic" | "module" = "classic",
) {
  return new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[data-svga-tool="${marker}"]`,
    );
    if (existing?.dataset.loaded === "true") {
      resolve();
      return;
    }
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener(
        "error",
        () => reject(new Error("脚本加载失败")),
        { once: true },
      );
      return;
    }

    const script = document.createElement("script");
    script.src = src;
    script.async = false;
    if (scriptType === "module") {
      script.type = "module";
      script.crossOrigin = "anonymous";
    }
    script.dataset.svgaTool = marker;
    script.addEventListener(
      "load",
      () => {
        script.dataset.loaded = "true";
        resolve();
      },
      { once: true },
    );
    script.addEventListener(
      "error",
      () => reject(new Error("脚本加载失败")),
      { once: true },
    );
    document.head.appendChild(script);
  });
}

function getPagRuntime() {
  if (!pagRuntimePromise) {
    pagRuntimePromise = withTimeout(
      (async () => {
        if (!window.libpag?.PAGInit) {
          await loadScript(
            LIBPAG_SCRIPT_URL,
            LIBPAG_SCRIPT_MARKER,
            "module",
          );
        }
        if (!window.libpag?.PAGInit) throw new Error("PAG 组件不可用");
        const wasmBinary = takeEmbeddedPagWasm();
        return window.libpag.PAGInit({
          locateFile: (name) =>
            name.endsWith(".wasm")
              ? new URL(LIBPAG_WASM_URL, document.baseURI).href
              : name,
          ...(wasmBinary ? { wasmBinary } : {}),
        });
      })(),
      PAG_RUNTIME_TIMEOUT_MS,
      (lateRuntime) => {
        pagRuntimePromise = Promise.resolve(lateRuntime);
      },
    );
  }
  return pagRuntimePromise;
}

function useNearViewport<T extends Element>() {
  const ref = useRef<T>(null);
  const [isNearViewport, setIsNearViewport] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setIsNearViewport(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => setIsNearViewport(entry.isIntersecting),
      { rootMargin: "80px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return { ref, isNearViewport };
}

function SvgaCanvas({
  video,
  paused,
  label,
  enabled,
}: {
  video: ParsedVideo;
  paused: boolean;
  label: string;
  enabled: boolean;
}) {
  const { ref: canvasRef, isNearViewport } =
    useNearViewport<HTMLCanvasElement>();
  const playerRef = useRef<PlayerInstance | null>(null);
  const pausedRef = useRef(paused);
  const [mountError, setMountError] = useState(false);

  useEffect(() => {
    if (!isNearViewport || !enabled) return;
    let disposed = false;

    async function mountPlayer() {
      if (!canvasRef.current) return;
      setMountError(false);
      try {
        const { Player } = await import("svga");
        if (disposed || !canvasRef.current) return;

        const player = new Player({
          container: canvasRef.current,
          loop: 0,
          isCacheFrames: false,
          isUseIntersectionObserver: false,
        });
        playerRef.current = player;
        await player.mount(video);
        if (!disposed) {
          player.start();
          if (pausedRef.current) player.pause();
        }
      } catch {
        if (!disposed) setMountError(true);
        playerRef.current?.destroy();
        playerRef.current = null;
      }
    }

    void mountPlayer();

    return () => {
      disposed = true;
      playerRef.current?.destroy();
      playerRef.current = null;
    };
  }, [canvasRef, enabled, isNearViewport, video]);

  useEffect(() => {
    pausedRef.current = paused;
    if (!playerRef.current) return;
    if (paused) playerRef.current.pause();
    else playerRef.current.resume();
  }, [paused]);

  return (
    <>
      <canvas
        ref={canvasRef}
        className="motion-canvas"
        role="img"
        aria-label={label}
      />
      {mountError && <span className="canvas-error">播放失败</span>}
    </>
  );
}

function PagCanvas({
  file,
  paused,
  label,
  enabled,
  priority = false,
}: {
  file: File;
  paused: boolean;
  label: string;
  enabled: boolean;
  priority?: boolean;
}) {
  const { ref: canvasRef, isNearViewport } =
    useNearViewport<HTMLCanvasElement>();
  const handleRef = useRef<{
    pagFile: PagFileInstance;
    pagView: PagViewInstance;
  } | null>(null);
  const pausedRef = useRef(paused);
  const [mountError, setMountError] = useState(false);

  useEffect(() => {
    if (!isNearViewport || !enabled) return;
    let disposed = false;
    let releaseSlot: (() => void) | undefined;
    let mountFinished = false;
    let pendingPagFile: PagFileInstance | undefined;
    let ownedHandle: {
      pagFile: PagFileInstance;
      pagView: PagViewInstance;
    } | null = null;
    const slot = requestPagSlot(priority);

    function destroyOwnedHandle() {
      const handle = ownedHandle;
      if (!handle) return;
      ownedHandle = null;
      if (handleRef.current === handle) handleRef.current = null;
      try {
        handle.pagView.pause();
      } catch {
        // 继续完成 WASM 资源释放。
      }
      try {
        handle.pagView.destroy();
      } catch {
        // 继续释放对应的 PAGFile。
      }
      try {
        handle.pagFile.destroy();
      } catch {
        // 清理是尽力而为，不能阻断播放器槽位归还。
      }
    }

    async function mountPlayer() {
      setMountError(false);
      try {
        releaseSlot = await slot.promise;
        if (disposed || !canvasRef.current) {
          releaseSlot();
          return;
        }

        if (pagPreviewLoadingBlocked) {
          throw new Error("PAG 播放已因超时停止，请刷新页面重试");
        }
        const runtime = await getPagRuntime();
        const pagFile = await withTimeout(
          runtime.PAGFile.load(await file.arrayBuffer()),
          PAG_FILE_TIMEOUT_MS,
          (lateFile) => lateFile.destroy(),
        );
        pendingPagFile = pagFile;
        if (disposed || !canvasRef.current) {
          pagFile.destroy();
          pendingPagFile = undefined;
          releaseSlot();
          return;
        }

        const canvasSize = safePagCanvasSize(pagFile.width(), pagFile.height());
        canvasRef.current.width = canvasSize.width;
        canvasRef.current.height = canvasSize.height;
        // PAGView.init 不可取消；这里不加硬超时，避免超时后提前销毁
        // PAGFile，而底层 WASM 仍在读取它。
        const pagView = await runtime.PAGView.init(
          pagFile,
          canvasRef.current,
          {
            useScale: false,
            firstFrame: true,
          },
        );
        if (!pagView) {
          pagFile.destroy();
          pendingPagFile = undefined;
          throw new Error("PAGView 初始化失败");
        }

        if (disposed) {
          pagView.destroy();
          pagFile.destroy();
          pendingPagFile = undefined;
          releaseSlot();
          return;
        }

        ownedHandle = { pagFile, pagView };
        handleRef.current = ownedHandle;
        pendingPagFile = undefined;
        pagView.setRepeatCount(0);
        await pagView.play();
        mountFinished = true;
        if (disposed) {
          destroyOwnedHandle();
          releaseSlot();
          return;
        }
        if (pausedRef.current) pagView.pause();
      } catch (error) {
        if (error instanceof Error && error.message === "操作超时") {
          pagPreviewLoadingBlocked = true;
        }
        try {
          pendingPagFile?.destroy();
        } catch {
          // 资源清理失败也必须继续归还播放器槽位。
        }
        pendingPagFile = undefined;
        destroyOwnedHandle();
        if (!disposed) setMountError(true);
        releaseSlot?.();
      }
    }

    void mountPlayer();

    return () => {
      disposed = true;
      slot.cancel();
      destroyOwnedHandle();
      // 已启动但尚未结束的 WASM 操作不可取消；继续占用槽位，直到上面的
      // 异步流程真正 resolve/reject，防止快速滚动启动超过 6 个底层任务。
      if (mountFinished) releaseSlot?.();
    };
  }, [canvasRef, enabled, file, isNearViewport, priority]);

  useEffect(() => {
    pausedRef.current = paused;
    const handle = handleRef.current;
    if (!handle) return;
    if (paused) handle.pagView.pause();
    else void handle.pagView.play().catch(() => setMountError(true));
  }, [paused]);

  return (
    <>
      <canvas
        ref={canvasRef}
        className="motion-canvas"
        role="img"
        aria-label={label}
      />
      {mountError && (
        <span className="canvas-error">PAG 播放失败，请检查文件或刷新页面</span>
      )}
    </>
  );
}

function AssetPreview({
  item,
  paused,
  label,
  enabled,
  priority = false,
}: {
  item: AssetItem;
  paused: boolean;
  label: string;
  enabled: boolean;
  priority?: boolean;
}) {
  if (item.kind === "svga" && item.video) {
    return (
      <SvgaCanvas
        video={item.video}
        paused={paused}
        label={label}
        enabled={enabled}
      />
    );
  }
  if (item.kind === "svg" && item.previewUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        className="svg-preview"
        src={item.previewUrl}
        alt={label}
        draggable={false}
      />
    );
  }
  if (item.kind === "pag") {
    return (
      <PagCanvas
        file={item.file}
        paused={paused}
        label={label}
        enabled={enabled}
        priority={priority}
      />
    );
  }
  return null;
}

function StatusBadge({ item }: { item: AssetItem }) {
  if (item.previewStatus === "parsing") {
    return <span className="status status-loading">解析中</span>;
  }
  if (item.previewStatus === "error") {
    return <span className="status status-error">无法解析</span>;
  }
  if (item.convertStatus === "converting") {
    return <span className="status status-loading">转换中</span>;
  }
  if (item.convertStatus === "ready") {
    return (
      <span className="status status-success">
        {item.convertedMode === "lightweight"
          ? "轻量 SVG 就绪"
          : item.convertedMode === "compact" ? "3 MB SVG 就绪" : "高保真 SVG 就绪"}
      </span>
    );
  }
  if (item.convertStatus === "error") {
    return <span className="status status-error">转换失败</span>;
  }
  return <span className="status status-ready">可预览</span>;
}

function FormatBadge({ kind }: { kind: AssetKind }) {
  return <span className={`format-badge format-${kind}`}>{kind.toUpperCase()}</span>;
}

function Metadata({ item }: { item: AssetItem }) {
  const metadata = item.metadata;
  const dimensions =
    metadata?.width && metadata?.height
      ? `${metadata.width} × ${metadata.height}`
      : "尺寸未声明";

  if (item.kind === "svg") {
    return (
      <div className="metadata">
        <span>{dimensions}</span>
        <span>SVG</span>
        <span>{metadata?.animated ? "有动画" : "静态/未识别"}</span>
        <span>
          {metadata?.svgMode === "compact-frames"
            ? "限体积逐帧"
            : metadata?.svgMode === "raster-frames"
            ? "高保真逐帧"
            : metadata?.svgMode === "lightweight"
              ? "轻量资源复用"
              : "矢量预览"}
        </span>
      </div>
    );
  }

  return (
    <div className="metadata">
      <span
        title={
          metadata?.previewScaled
            ? "预览画布已按比例缩小，文件原尺寸未修改"
            : undefined
        }
      >
        {dimensions}
        {metadata?.previewScaled ? " · 预览缩放" : ""}
      </span>
      <span>{metadata?.frames ? `${metadata.frames} 帧` : "—"}</span>
      <span>{metadata?.fps ? `${metadata.fps} FPS` : "—"}</span>
      <span>{formatSeconds(metadata?.duration)}</span>
    </div>
  );
}

function canPreview(item: AssetItem) {
  return item.previewStatus === "ready";
}

function modeLabel(mode: ConvertMode) {
  return mode === "lightweight" ? "轻量" : mode === "compact" ? "3MB" : "高保真";
}

function describeExport(svg: string, video: ParsedVideo) {
  const root = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
  const bytes = new Blob([svg]).size;
  const size = bytes < 1_000_000 ? `${(bytes / 1000).toFixed(1)} KB` : `${(bytes / 1_000_000).toFixed(2)} MB`;
  if (root.getAttribute("data-svga-export") === "lightweight") {
    return `已导出 ${size} · 原图复用 · ${video.frames} 帧 / ${video.fps} FPS`;
  }
  const width = Number(root.getAttribute("data-render-width")) || video.size.width;
  const height = Number(root.getAttribute("data-render-height")) || video.size.height;
  const format = root.getAttribute("data-image-format");
  const quality = Number(root.getAttribute("data-image-quality"));
  const encoding = format === "webp" ? `WebP 质量 ${Math.round(quality * 100)}%` : "PNG";
  const scaled = width !== video.size.width || height !== video.size.height;
  return `已导出 ${size} · ${encoding} · ${scaled ? "内部渲染" : "原尺寸"} ${width} × ${height} · ${video.frames} 帧 / ${video.fps} FPS`;
}

function lightweightReason(video: ParsedVideo) {
  const compatibility = getLightweightCompatibility(video);
  if (!compatibility.compatible) {
    return `轻量模式不可用：${compatibility.reason}`;
  }
  const animatedSpriteCount = compatibility.spritePlans.filter(
    (sprite) => sprite.animatedTransforms,
  ).length;
  return animatedSpriteCount
    ? `复用 SVGA 原始图片，并转译 ${animatedSpriteCount} 个动态变换图层（含旋转、斜切、镜像）`
    : "复用 SVGA 原始图片，体积通常接近原文件";
}

function LightweightCompatibilityNote({ video }: { video: ParsedVideo }) {
  const compatibility = getLightweightCompatibility(video);
  if (compatibility.compatible) return null;
  return (
    <p className="compatibility-note">
      轻量模式不可用：{compatibility.reason}。可选择「3 MB SVG」。
    </p>
  );
}

export default function Home() {
  const [items, setItems] = useState<AssetItem[]>([]);
  const [background, setBackground] = useState<BackgroundMode>("checker");
  const [paused, setPaused] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const converterReady = true;
  const [notice, setNotice] = useState("");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [batchProgress, setBatchProgress] = useState<{
    active: boolean;
    current: number;
    total: number;
    mode?: ConvertMode;
  }>({ active: false, current: 0, total: 0 });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const itemsRef = useRef<AssetItem[]>([]);
  const importQueueRef = useRef<Promise<void>>(Promise.resolve());
  const importGenerationRef = useRef(0);
  const pagImportLoadingBlockedRef = useRef(false);
  const operationEpochRef = useRef(0);
  const removedIdsRef = useRef(new Set<string>());
  const inFlightConversionsRef = useRef(new Map<string, Promise<string>>());

  useEffect(() => {
    function handleEscape(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") setDetailId(null);
    }
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, []);

  const detailItem = useMemo(
    () => items.find((item) => item.id === detailId),
    [detailId, items],
  );
  const readyCount = items.filter(canPreview).length;
  const svgaReadyCount = items.filter(
    (item) => item.kind === "svga" && item.previewStatus === "ready" && item.video,
  ).length;
  const pagCount = items.filter((item) => item.kind === "pag").length;
  const convertedCount = items.filter(
    (item) => item.convertStatus === "ready",
  ).length;
  const errorCount = items.filter(
    (item) => item.previewStatus === "error" || item.convertStatus === "error",
  ).length;

  const updateItem = useCallback((id: string, patch: Partial<AssetItem>) => {
    const next = itemsRef.current.map((item) =>
      item.id === id ? { ...item, ...patch } : item,
    );
    itemsRef.current = next;
    setItems(next);
  }, []);

  const parseItem = useCallback(
    async (item: AssetItem, epoch: number) => {
      const isCurrent = () =>
        operationEpochRef.current === epoch &&
        !removedIdsRef.current.has(item.id);

      if (item.kind === "svg") {
        let previewUrl: string | undefined;
        try {
          const parsed = prepareSvgPreview(await item.file.text());
          previewUrl = parsed.previewUrl;
          if (isCurrent()) {
            updateItem(item.id, {
              previewStatus: "ready",
              previewUrl,
              metadata: parsed.metadata,
              error: undefined,
            });
            previewUrl = undefined;
          }
        } catch {
          if (isCurrent()) {
            updateItem(item.id, {
              previewStatus: "error",
              error: "SVG 结构无法识别，或包含不支持的内容。",
            });
          }
        } finally {
          if (previewUrl) URL.revokeObjectURL(previewUrl);
        }
        return;
      }

      if (item.kind === "pag") {
        let pagFile: PagFileInstance | undefined;
        try {
          if (pagImportLoadingBlockedRef.current) {
            throw new Error("PAG 批次已因超时停止，请刷新页面重试");
          }
          const runtime = await getPagRuntime();
          pagFile = await withTimeout(
            runtime.PAGFile.load(await item.file.arrayBuffer()),
            PAG_FILE_TIMEOUT_MS,
            (lateFile) => lateFile.destroy(),
          );
          const fps = pagFile.frameRate();
          const duration = pagFile.duration() / 1_000_000;
          const width = pagFile.width();
          const height = pagFile.height();
          const canvasSize = safePagCanvasSize(width, height);
          if (isCurrent()) {
            updateItem(item.id, {
              previewStatus: "ready",
              metadata: {
                width,
                height,
                fps,
                duration,
                frames:
                  fps > 0 && duration > 0
                    ? Math.max(1, Math.round(fps * duration))
                    : undefined,
                animated: true,
                previewScaled: canvasSize.scaled,
              },
              error: undefined,
            });
          }
        } catch (error) {
          const timedOut =
            error instanceof Error && error.message === "操作超时";
          if (timedOut) pagImportLoadingBlockedRef.current = true;
          if (isCurrent()) {
            updateItem(item.id, {
              previewStatus: "error",
              error: timedOut
                ? "PAG 加载超时，本页已停止继续解析 PAG；请刷新页面后重试。"
                : pagImportLoadingBlockedRef.current
                  ? "本批 PAG 已因超时停止；请刷新页面后重试。"
                  : "PAG 文件无法解析，或本地播放器初始化失败；请刷新页面后重试。",
            });
          }
        } finally {
          pagFile?.destroy();
        }
        return;
      }

      const url = URL.createObjectURL(item.file);
      let parser: ParserInstance | undefined;
      try {
        const { Parser } = await import("svga");
        parser = new Parser({
          isDisableWebWorker: true,
          isDisableImageBitmapShim: true,
        });
        const video = await withTimeout(
          parser.load(url),
          SVGA_PARSE_TIMEOUT_MS,
        );
        if (isCurrent()) {
          updateItem(item.id, {
            previewStatus: "ready",
            video,
            metadata: {
              width: video.size.width,
              height: video.size.height,
              frames: video.frames,
              fps: video.fps,
              duration: video.fps ? video.frames / video.fps : undefined,
              animated: video.frames > 1,
            },
            error: undefined,
          });
        }
      } catch {
        if (isCurrent()) {
          updateItem(item.id, {
            previewStatus: "error",
            error: "可能是 SVGA 1.x、文件损坏，或文件内容无法识别。",
          });
        }
      } finally {
        parser?.destroy();
        URL.revokeObjectURL(url);
      }
    },
    [updateItem],
  );

  const addFiles = useCallback(
    async (files: File[]) => {
      const currentItems = itemsRef.current;
      const supportedFiles = files.filter((file) => kindFromFile(file));
      const unsupportedCount = files.length - supportedFiles.length;
      const slots = Math.max(0, MAX_FILES - currentItems.length);
      const accepted: File[] = [];
      let rejectedForSize = 0;
      let acceptedBytes = currentItems.reduce(
        (sum, item) => sum + item.size,
        0,
      );

      for (const file of supportedFiles) {
        if (accepted.length >= slots) break;
        if (
          file.size > maxBytesForFile(file) ||
          acceptedBytes + file.size > MAX_TOTAL_BYTES
        ) {
          rejectedForSize += 1;
          continue;
        }
        accepted.push(file);
        acceptedBytes += file.size;
      }

      if (accepted.length === 0) {
        setNotice(
          currentItems.length >= MAX_FILES
            ? `一次最多查看 ${MAX_FILES} 个文件。`
            : rejectedForSize
              ? "文件过大：SVGA/PAG 单个最多 20 MB，SVG 单个最多 100 MB，当前列表合计最多 200 MB。"
              : "请选择扩展名为 .svga、.svg 或 .pag 的文件。",
        );
        return;
      }

      const newItems: AssetItem[] = accepted.map((file) => ({
        id: crypto.randomUUID(),
        kind: kindFromFile(file)!,
        file,
        name: file.name,
        size: file.size,
        previewStatus: "parsing",
        convertStatus: "idle",
      }));
      const epoch = operationEpochRef.current;
      const skippedForLimit = Math.max(
        0,
        supportedFiles.length - accepted.length - rejectedForSize,
      );
      const messages: string[] = [];
      if (rejectedForSize) messages.push(`${rejectedForSize} 个因体积限制跳过`);
      if (skippedForLimit) messages.push(`${skippedForLimit} 个因数量上限跳过`);
      if (unsupportedCount) messages.push(`${unsupportedCount} 个格式不支持`);

      setNotice(
        messages.length
          ? `已导入 ${accepted.length} 个；${messages.join("，")}。`
          : "",
      );
      const nextItems = [...itemsRef.current, ...newItems];
      itemsRef.current = nextItems;
      setItems(nextItems);

      const localItems = [
        ...newItems.filter((item) => item.kind === "svg"),
        ...newItems.filter((item) => item.kind === "svga"),
      ];
      for (const item of localItems) {
        if (operationEpochRef.current !== epoch) break;
        await parseItem(item, epoch);
      }

      const pagItems = newItems.filter((item) => item.kind === "pag");
      let nextPagIndex = 0;
      const pagWorkers = Array.from(
        { length: Math.min(2, pagItems.length) },
        async () => {
          while (operationEpochRef.current === epoch) {
            const index = nextPagIndex;
            nextPagIndex += 1;
            const item = pagItems[index];
            if (!item) return;
            await parseItem(item, epoch);
          }
        },
      );
      await Promise.all(pagWorkers);
    },
    [parseItem],
  );

  const enqueueFiles = useCallback(
    (files: File[]) => {
      const generation = importGenerationRef.current;
      const queued = importQueueRef.current.then(async () => {
        if (generation !== importGenerationRef.current) return;
        await addFiles(files);
      });
      importQueueRef.current = queued.catch(() => undefined);
    },
    [addFiles],
  );

  function handleFileInput(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    enqueueFiles(files);
    event.target.value = "";
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
    enqueueFiles(Array.from(event.dataTransfer.files));
  }

  function handleDropKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      fileInputRef.current?.click();
    }
  }

  const convertItem = useCallback(
    async (item: AssetItem, epoch: number, mode: ConvertMode) => {
      const isCurrent = () =>
        operationEpochRef.current === epoch &&
        !removedIdsRef.current.has(item.id);
      if (!isCurrent()) throw new Error("任务已取消");
      if (
        item.convertedSvg &&
        item.convertedMode === mode &&
        item.video
      ) {
        return item.convertedSvg;
      }
      if (item.kind !== "svga" || !item.video) {
        throw new Error("SVGA 尚未解析完成");
      }
      const video = item.video;

      const conversionKey = `${item.id}:${mode}`;
      const existing = inFlightConversionsRef.current.get(conversionKey);
      if (existing) return existing;

      // Register the promise before even a synchronous lightweight conversion
      // can finish, so its finally can remove the in-flight entry correctly.
      const task = Promise.resolve().then(async () => {
        if (!isCurrent()) throw new Error("任务已取消");
        updateItem(item.id, {
          convertStatus: "converting",
          error: undefined,
        });

        try {
          const convertedSvg =
            mode === "lightweight"
              ? buildLightweightSvg(video)
              : await renderRasterFrameSvg(video, {
                  targetBytes: mode === "compact" ? COMPACT_SVG_MAX_BYTES : undefined,
                  shouldCancel: () => !isCurrent(),
                });
          if (!isCurrent()) throw new Error("任务已取消");
          const verifiedSvg =
            mode === "lightweight"
              ? verifyLightweightSvgStructure(convertedSvg, video)
              : verifySvgStructure(convertedSvg, video, mode === "compact" ? COMPACT_SVG_MAX_BYTES : undefined);
          updateItem(item.id, {
            convertStatus: "ready",
            convertedSvg: verifiedSvg,
            convertedMode: mode,
            exportSummary: describeExport(verifiedSvg, video),
          });
          return verifiedSvg;
        } catch (error) {
          if (isCurrent()) {
            updateItem(item.id, {
              convertStatus: "error",
              error: error instanceof Error ? error.message : "SVG 生成失败，请重试。",
            });
          }
          throw error;
        } finally {
          inFlightConversionsRef.current.delete(conversionKey);
        }
      });

      inFlightConversionsRef.current.set(conversionKey, task);
      return task;
    },
    [updateItem],
  );

  async function convertAndDownload(item: AssetItem, mode: ConvertMode) {
    const epoch = operationEpochRef.current;
    try {
      const svg = await convertItem(item, epoch, mode);
      if (
        operationEpochRef.current !== epoch ||
        removedIdsRef.current.has(item.id)
      )
        return;
      downloadBlob(
        new Blob([svg], { type: "image/svg+xml;charset=utf-8" }),
        `${baseName(item.name)}-${modeLabel(mode)}.svg`,
      );
      setNotice(`${item.name}：${describeExport(svg, item.video!)}`);
    } catch (error) {
      if (operationEpochRef.current !== epoch || removedIdsRef.current.has(item.id)) return;
      setNotice(`${item.name}：${error instanceof Error ? error.message : "转换失败"}`);
    }
  }

  async function convertAllAndDownload(mode: ConvertMode) {
    const candidates = items.filter(
      (item) =>
        item.kind === "svga" &&
        item.previewStatus === "ready" &&
        Boolean(item.video),
    );
    if (!candidates.length || batchProgress.active) return;
    const epoch = operationEpochRef.current;

    setBatchProgress({
      active: true,
      current: 0,
      total: candidates.length,
      mode,
    });
    setNotice("");
    const zip = new JSZip();
    const failures: string[] = [];
    const usedNames = new Set<string>();
    let exportedCount = 0;

    for (let index = 0; index < candidates.length; index += 1) {
      if (operationEpochRef.current !== epoch) return;
      const item = candidates[index];
      if (removedIdsRef.current.has(item.id)) continue;
      setBatchProgress({
        active: true,
        current: index + 1,
        total: candidates.length,
        mode,
      });
      try {
        const svg = await convertItem(item, epoch, mode);
        if (operationEpochRef.current !== epoch) return;
        if (removedIdsRef.current.has(item.id)) continue;
        let outputName = `${baseName(item.name)}.svg`;
        let suffix = 2;
        while (usedNames.has(outputName)) {
          outputName = `${baseName(item.name)}-${suffix}.svg`;
          suffix += 1;
        }
        usedNames.add(outputName);
        zip.file(outputName, svg);
        exportedCount += 1;
      } catch {
        if (!removedIdsRef.current.has(item.id)) failures.push(item.name);
      }
    }

    if (failures.length) {
      zip.file(
        "转换失败.txt",
        `以下文件未能转换：\n${failures.map((name) => `- ${name}`).join("\n")}`,
      );
    }

    try {
      if (operationEpochRef.current !== epoch) return;
      const blob = await zip.generateAsync({ type: "blob" });
      if (operationEpochRef.current !== epoch) return;
      const label = modeLabel(mode);
      downloadBlob(
        blob,
        `SVGA转${label}SVG-${new Date().toISOString().slice(0, 10)}.zip`,
      );
      setNotice(
        failures.length
          ? `已下载 ${exportedCount} 个 SVG，${failures.length} 个失败。`
          : mode === "lightweight"
            ? `已下载 ${exportedCount} 个轻量 SVG；图片资源直接复用，体积通常接近原 SVGA。`
            : mode === "compact"
              ? `已下载 ${exportedCount} 个 SVG；每个文件不超过 3,000,000 字节，保留全部帧与时长。`
              : `已下载 ${exportedCount} 个高保真逐帧 SVG；此模式不限制文件体积。`,
      );
    } catch {
      if (operationEpochRef.current === epoch) setNotice("ZIP 生成失败，请改用单个下载。");
    } finally {
      if (operationEpochRef.current === epoch) setBatchProgress({ active: false, current: 0, total: 0 });
    }
  }

  function removeItem(id: string) {
    const item = itemsRef.current.find((candidate) => candidate.id === id);
    if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
    removedIdsRef.current.add(id);
    const nextItems = itemsRef.current.filter((candidate) => candidate.id !== id);
    itemsRef.current = nextItems;
    setItems(nextItems);
    if (detailId === id) setDetailId(null);
  }

  function clearAll() {
    operationEpochRef.current += 1;
    importGenerationRef.current += 1;
    for (const item of itemsRef.current) {
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    }
    removedIdsRef.current = new Set();
    inFlightConversionsRef.current.clear();
    itemsRef.current = [];
    setItems([]);
    setDetailId(null);
    setNotice("");
    setBatchProgress({ active: false, current: 0, total: 0 });
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <div className="brand-mark" aria-hidden="true">
            M
          </div>
          <div>
            <p className="eyebrow">LOCAL MOTION REVIEW</p>
            <h1>动效批量预览器</h1>
          </div>
        </div>
        <div className="privacy-pill">
          <span className="privacy-dot" aria-hidden="true" />
          文件仅在本机处理
        </div>
      </header>

      <section className="hero-panel">
        <div>
          <p className="section-kicker">SVGA · SVG · PAG · 最多 50 个</p>
          <h2>把一批动效拖进来，一屏看完。</h2>
          <p className="hero-copy">
            三种格式统一批量预览；优先选轻量 SVG 保留原图，复杂素材可选 3 MB SVG 控制体积。
          </p>
        </div>

        <div
          className={`dropzone ${isDragging ? "is-dragging" : ""}`}
          onDragEnter={(event) => {
            event.preventDefault();
            setIsDragging(true);
          }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          onKeyDown={handleDropKey}
          role="button"
          tabIndex={0}
          aria-label="选择或拖入 SVGA、SVG、PAG 文件"
          onClick={() => fileInputRef.current?.click()}
        >
          <input
            ref={fileInputRef}
            className="file-input"
            type="file"
            accept=".svga,.svg,.pag"
            multiple
            onChange={handleFileInput}
          />
          <span className="drop-icon" aria-hidden="true">
            ＋
          </span>
          <strong>拖入 SVGA / SVG / PAG 文件</strong>
          <span>或点击选择，最多 {MAX_FILES} 个</span>
          <small>SVGA/PAG ≤ 20 MB · SVG ≤ 100 MB · 合计 ≤ 200 MB</small>
        </div>
      </section>

      {items.length > 0 && (
        <section className="workspace">
          <div className="toolbar">
            <div className="stats" aria-label="文件统计">
              <span>
                <strong>{items.length}</strong> 个文件
              </span>
              <span>
                <strong>{readyCount}</strong> 可预览
              </span>
              <span>
                <strong>{convertedCount}</strong> 已转换
              </span>
              {errorCount > 0 && (
                <span className="stat-error">
                  <strong>{errorCount}</strong> 异常
                </span>
              )}
            </div>

            <div className="toolbar-actions">
              <div className="background-switch" aria-label="预览背景">
                {(["checker", "dark", "light"] as BackgroundMode[]).map(
                  (mode) => (
                    <button
                      key={mode}
                      type="button"
                      className={background === mode ? "active" : ""}
                      onClick={() => setBackground(mode)}
                      aria-pressed={background === mode}
                    >
                      {mode === "checker"
                        ? "透明"
                        : mode === "dark"
                          ? "黑底"
                          : "白底"}
                    </button>
                  ),
                )}
              </div>
              <button
                type="button"
                className="button button-secondary"
                onClick={() => setPaused((value) => !value)}
                title="SVG 自带动画不受此按钮控制"
              >
                {paused ? "播放 SVGA/PAG" : "暂停 SVGA/PAG"}
              </button>
              <button
                type="button"
                className="button button-primary"
                onClick={() => void convertAllAndDownload("lightweight")}
                disabled={
                  !converterReady || !svgaReadyCount || batchProgress.active || items.some((item) => item.convertStatus === "converting")
                }
              >
                {batchProgress.active && batchProgress.mode === "lightweight"
                  ? `转换 ${batchProgress.current}/${batchProgress.total}`
                  : "全部转轻量 SVG"}
              </button>
              <button
                type="button"
                className="button button-secondary"
                onClick={() => void convertAllAndDownload("compact")}
                disabled={!converterReady || !svgaReadyCount || batchProgress.active || items.some((item) => item.convertStatus === "converting")}
                title="每个 SVG 不超过 3 MB；保留透明背景、全部帧和时长，必要时压缩画质或缩小内部渲染尺寸"
              >
                {batchProgress.active && batchProgress.mode === "compact"
                  ? `转换 ${batchProgress.current}/${batchProgress.total}`
                  : "全部转 3 MB SVG"}
              </button>
              <button
                type="button"
                className="button button-secondary"
                onClick={() => void convertAllAndDownload("high-fidelity")}
                disabled={
                  !converterReady || !svgaReadyCount || batchProgress.active || items.some((item) => item.convertStatus === "converting")
                }
                title="逐帧渲染复杂遮罩和合成效果，输出文件会明显更大"
              >
                {batchProgress.active && batchProgress.mode === "high-fidelity"
                  ? `转换 ${batchProgress.current}/${batchProgress.total}`
                  : "全部转高保真"}
              </button>
              <button
                type="button"
                className="button button-quiet"
                onClick={clearAll}
              >
                清空
              </button>
            </div>
          </div>

          {notice && (
            <div className="notice" role="status">
              {notice}
            </div>
          )}
          {pagCount > 0 && (
            <div className="notice notice-info" role="status">
              PAG 播放器已随页面本地内置；PAG 文件只在本机读取，不会上传。
            </div>
          )}

          <div className="card-grid">
            {items.map((item) => (
              <article className="asset-card" key={item.id}>
                <button
                  type="button"
                  className={`preview-frame background-${background}`}
                  onClick={() => canPreview(item) && setDetailId(item.id)}
                  disabled={!canPreview(item)}
                  aria-label={`放大预览 ${item.name}`}
                >
                  {canPreview(item) ? (
                    <AssetPreview
                      item={item}
                      paused={paused}
                      enabled={!detailId}
                      label={`${item.name} 动画预览`}
                    />
                  ) : item.previewStatus === "parsing" ? (
                    <div className="preview-placeholder">
                      <span className="spinner" />
                      正在解析
                    </div>
                  ) : (
                    <div className="preview-placeholder preview-error">
                      无法预览
                    </div>
                  )}
                  {canPreview(item) && (
                    <span className="zoom-hint">点击放大</span>
                  )}
                </button>

                <div className="card-body">
                  <div className="card-title-row">
                    <div className="file-title" title={item.name}>
                      {item.name}
                    </div>
                    <div className="card-badges">
                      <FormatBadge kind={item.kind} />
                      <StatusBadge item={item} />
                    </div>
                  </div>

                  {canPreview(item) ? (
                    <Metadata item={item} />
                  ) : (
                    <p className="error-copy">
                      {item.error ?? formatBytes(item.size)}
                    </p>
                  )}

                  <div className="card-footer">
                    <span className="file-size">{formatBytes(item.size)}</span>
                    <div className="card-actions">
                      {item.kind === "svga" && item.video && (
                        <>
                          <button
                            type="button"
                            className="text-button text-button-primary"
                            onClick={() =>
                              void convertAndDownload(item, "lightweight")
                            }
                            disabled={
                              !converterReady ||
                              item.convertStatus === "converting" ||
                              batchProgress.active ||
                              !getLightweightCompatibility(item.video)
                                .compatible
                            }
                            title={lightweightReason(item.video)}
                          >
                            {item.convertStatus === "converting"
                              ? "转换中…"
                              : item.convertedSvg &&
                                  item.convertedMode === "lightweight"
                                ? "下载轻量 SVG"
                                : "转轻量 SVG"}
                          </button>
                          <button
                            type="button"
                            className="text-button"
                            onClick={() => void convertAndDownload(item, "compact")}
                            disabled={!converterReady || item.convertStatus === "converting" || batchProgress.active}
                            title="文件上限 3,000,000 字节；保留帧数与时长，自动压缩画质，必要时降低内部渲染尺寸"
                          >
                            {item.convertedSvg && item.convertedMode === "compact" ? "下载 3 MB SVG" : "3 MB SVG"}
                          </button>
                          <button
                            type="button"
                            className="text-button"
                            onClick={() =>
                              void convertAndDownload(item, "high-fidelity")
                            }
                            disabled={
                              !converterReady ||
                              item.convertStatus === "converting" ||
                              batchProgress.active
                            }
                            title="复杂素材兜底；逐帧渲染，输出文件较大"
                          >
                            {item.convertedSvg &&
                            item.convertedMode === "high-fidelity"
                              ? "下载高保真"
                              : "高保真 SVG"}
                          </button>
                        </>
                      )}
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => removeItem(item.id)}
                      >
                        移除
                      </button>
                    </div>
                  </div>
                  {item.exportSummary && <p className="export-summary">{item.exportSummary}</p>}
                  {item.kind === "svga" && item.video && (
                    <LightweightCompatibilityNote video={item.video} />
                  )}
                  {item.error && item.previewStatus !== "error" && (
                    <p className="inline-error">{item.error}</p>
                  )}
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      {items.length === 0 && (
        <section className="empty-guide" aria-label="使用说明">
          <div>
            <span>01</span>
            <strong>混合批量导入</strong>
            <p>一次选择 10～50 个 SVGA、SVG 或 PAG</p>
          </div>
          <div>
            <span>02</span>
            <strong>网格验收</strong>
            <p>透明、黑底、白底快速检查动效</p>
          </div>
          <div>
            <span>03</span>
            <strong>SVGA 按需转换</strong>
            <p>单个 SVG 或整批 ZIP</p>
          </div>
        </section>
      )}

      <footer className="footer">
        <span>SVGA 2.x · SVG · PAG 视觉预览版</span>
        <span>刷新页面后文件不会保留</span>
      </footer>

      {detailItem && canPreview(detailItem) && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setDetailId(null);
          }}
        >
          <section
            className="detail-modal"
            role="dialog"
            aria-modal="true"
            aria-label={`${detailItem.name} 大图预览`}
          >
            <div className="detail-header">
              <div>
                <p className="eyebrow">LARGE PREVIEW</p>
                <h3>{detailItem.name}</h3>
              </div>
              <button
                type="button"
                className="close-button"
                onClick={() => setDetailId(null)}
                aria-label="关闭大图预览"
              >
                ×
              </button>
            </div>
            <div className={`detail-stage background-${background}`}>
              <AssetPreview
                item={detailItem}
                paused={paused}
                enabled
                priority
                label={`${detailItem.name} 大图动画预览`}
              />
            </div>
            {detailItem.exportSummary && <p className="export-summary">{detailItem.exportSummary}</p>}
            {detailItem.kind === "svga" && detailItem.video && (
              <LightweightCompatibilityNote video={detailItem.video} />
            )}
            <div className="detail-footer">
              <FormatBadge kind={detailItem.kind} />
              <span>
                {detailItem.metadata?.width && detailItem.metadata?.height
                  ? `${detailItem.metadata.width} × ${detailItem.metadata.height}`
                  : "尺寸未声明"}
              </span>
              {detailItem.metadata?.frames && (
                <span>{detailItem.metadata.frames} 帧</span>
              )}
              {detailItem.metadata?.fps && (
                <span>{detailItem.metadata.fps} FPS</span>
              )}
              {detailItem.metadata?.duration && (
                <span>{formatSeconds(detailItem.metadata.duration)}</span>
              )}
              {detailItem.metadata?.previewScaled && (
                <span>预览已等比缩小，文件尺寸未修改</span>
              )}
              {detailItem.kind !== "svg" && (
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => setPaused((value) => !value)}
                >
                  {paused ? "播放" : "暂停"}
                </button>
              )}
              {detailItem.kind === "svga" && detailItem.video && (
                <>
                  <button
                    type="button"
                    className="button button-primary"
                    onClick={() =>
                      void convertAndDownload(detailItem, "lightweight")
                    }
                    disabled={
                      !converterReady ||
                      detailItem.convertStatus === "converting" ||
                      batchProgress.active ||
                      !getLightweightCompatibility(detailItem.video)
                        .compatible
                    }
                    title={lightweightReason(detailItem.video)}
                  >
                    {detailItem.convertedSvg &&
                    detailItem.convertedMode === "lightweight"
                      ? "下载轻量 SVG"
                      : "转轻量 SVG"}
                  </button>
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={() => void convertAndDownload(detailItem, "compact")}
                    disabled={!converterReady || detailItem.convertStatus === "converting" || batchProgress.active}
                    title="文件上限 3,000,000 字节；保留帧数与时长，自动压缩画质，必要时降低内部渲染尺寸"
                  >
                    {detailItem.convertedSvg && detailItem.convertedMode === "compact" ? "下载 3 MB SVG" : "3 MB SVG"}
                  </button>
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={() =>
                      void convertAndDownload(detailItem, "high-fidelity")
                    }
                    disabled={
                      !converterReady ||
                      detailItem.convertStatus === "converting" ||
                      batchProgress.active
                    }
                  >
                    {detailItem.convertedSvg &&
                    detailItem.convertedMode === "high-fidelity"
                      ? "下载高保真"
                      : "高保真 SVG"}
                  </button>
                </>
              )}
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
