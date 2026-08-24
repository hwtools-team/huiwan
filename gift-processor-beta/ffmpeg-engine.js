import { FFmpeg } from "./vendor/ffmpeg/index.js";
import {
  encodeSvgaFromFrames,
  renderSvgaFrames,
} from "./svga-codec.js";
import { appendVapConfig, buildVapConfig } from "./vap-codec.js";
import { renderAnimatedImageFrames } from "./image-codec.js";

const CORE_URL = new URL("./vendor/core/ffmpeg-core.js", import.meta.url).href;
const WASM_URL = new URL("./vendor/core/ffmpeg-core.wasm", import.meta.url).href;
const EXEC_TIMEOUT = 180_000;

const ffmpeg = new FFmpeg();
let loadPromise;
let currentLogHandler = () => {};
let currentProgressHandler = () => {};

ffmpeg.on("log", ({ message }) => currentLogHandler(message));
ffmpeg.on("progress", ({ progress }) => {
  currentProgressHandler(Math.max(0, Math.min(1, Number(progress) || 0)));
});

function even(value) {
  const number = Math.max(2, Math.round(Number(value) || 2));
  return number % 2 === 0 ? number : number + 1;
}

function safeExtension(name, fallback = "bin") {
  const match = String(name || "").toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : fallback;
}

function outputExtension(format) {
  return {
    webp: "webp",
    apng: "apng",
    gif: "gif",
    mp4: "mp4",
    vap: "mp4",
    dual: "mp4",
    svga: "svga",
  }[format];
}

function outputMime(format) {
  return {
    webp: "image/webp",
    apng: "image/apng",
    gif: "image/gif",
    mp4: "video/mp4",
    vap: "video/mp4",
    dual: "video/mp4",
    svga: "application/octet-stream",
  }[format];
}

export async function ensureFfmpegLoaded({ onStatus = () => {} } = {}) {
  if (ffmpeg.loaded) return;
  if (!loadPromise) {
    onStatus("首次加载 32 MB 本地编解码引擎…");
    loadPromise = ffmpeg.load({ coreURL: CORE_URL, wasmURL: WASM_URL });
  }
  try {
    await loadPromise;
  } catch (error) {
    loadPromise = null;
    throw error;
  }
}

function buildBaseFilter(metadata, settings, { requireEven = false } = {}) {
  const sourceWidth = Number(metadata.width) || 512;
  const sourceHeight = Number(metadata.height) || 512;
  let width = Number(settings.width) || sourceWidth;
  let height = Number(settings.height) || sourceHeight;

  if (requireEven) {
    width = even(width);
    height = even(height);
  } else {
    width = Math.max(1, Math.round(width));
    height = Math.max(1, Math.round(height));
  }

  const filters = ["format=rgba"];
  if (settings.scaleMode === "cover") {
    filters.push(
      `scale=${width}:${height}:force_original_aspect_ratio=increase`,
      `crop=${width}:${height}`,
    );
  } else if (settings.scaleMode === "stretch") {
    filters.push(`scale=${width}:${height}`);
  } else {
    filters.push(
      `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black@0`,
    );
  }

  const blur = Math.max(0, Math.min(12, Number(settings.edgeBlur) || 0));
  if (blur > 0) filters.push(`gblur=sigma=${blur}:planes=8`);

  const fps = Math.max(1, Math.min(60, Number(settings.fps) || Number(metadata.fps) || 30));
  filters.push(`fps=${fps}`);

  return { filter: filters.join(","), width, height, fps };
}

function sourceDuration(metadata, settings) {
  const original = Math.max(0, Number(metadata.duration) || 0);
  const requested = Math.max(0, Number(settings.duration) || 0);
  return requested || original || 1;
}

async function writeFrameSequence(prefix, sequence) {
  for (let index = 0; index < sequence.frames.length; index += 1) {
    const filename = `${prefix}-in-${String(index + 1).padStart(6, "0")}.png`;
    await ffmpeg.writeFile(filename, sequence.frames[index]);
  }
}

async function extractVapSequence({
  prefix,
  inputName,
  item,
  settings,
  duration,
  onProgress,
}) {
  const info = item.vapConfig?.info;
  if (!info) throw new Error("VAP 缺少可用的 RGB/Alpha 布局配置");
  const [rgbX, rgbY, rgbW, rgbH] = info.rgbFrame.map(Number);
  const [alphaX, alphaY, alphaW, alphaH] = info.aFrame.map(Number);
  if (![rgbX, rgbY, rgbW, rgbH, alphaX, alphaY, alphaW, alphaH].every(Number.isFinite)) {
    throw new Error("VAP RGB/Alpha 布局配置无效");
  }

  const fps = Math.max(1, Math.min(60, Number(settings.fps) || Number(info.fps) || 30));
  const pattern = `${prefix}-vap-%06d.png`;
  const graph = `[0:v]split=2[rgbraw][alpharaw];[rgbraw]crop=${rgbW}:${rgbH}:${rgbX}:${rgbY}[rgb];[alpharaw]crop=${alphaW}:${alphaH}:${alphaX}:${alphaY},scale=${rgbW}:${rgbH},format=gray[alpha];[rgb][alpha]alphamerge,format=rgba[out]`;
  const code = await ffmpeg.exec(
    [
      "-i",
      inputName,
      "-filter_complex",
      graph,
      "-map",
      "[out]",
      "-r",
      String(fps),
      "-t",
      String(duration),
      pattern,
    ],
    EXEC_TIMEOUT,
  );
  if (code !== 0) throw new Error(`VAP 透明帧还原失败（${code}）`);

  const entries = (await ffmpeg.listDir("."))
    .filter((entry) => entry.name.startsWith(`${prefix}-vap-`) && entry.name.endsWith(".png"))
    .sort((a, b) => a.name.localeCompare(b.name));
  const frames = [];
  for (let index = 0; index < entries.length; index += 1) {
    frames.push(await ffmpeg.readFile(entries[index].name));
    onProgress(((index + 1) / Math.max(1, entries.length)) * 0.25);
  }
  if (!frames.length) throw new Error("VAP 没有解码出可用帧");
  return {
    frames,
    width: rgbW,
    height: rgbH,
    fps,
    duration: frames.length / fps,
    audioInputName: inputName,
  };
}

async function cleanupPrefix(prefix) {
  try {
    const entries = await ffmpeg.listDir(".");
    await Promise.all(
      entries
        .filter((entry) => entry.name.startsWith(prefix) && !entry.isDir)
        .map((entry) => ffmpeg.deleteFile(entry.name).catch(() => {})),
    );
  } catch (error) {
    console.warn("编解码临时文件清理失败", error);
  }
}

function inputArguments({ inputName, sequence, metadata, duration, kind }) {
  if (sequence) {
    const args = [
      "-framerate",
      String(sequence.fps),
      "-i",
      `${inputName}-in-%06d.png`,
    ];
    if (sequence.audioInputName) args.push("-i", sequence.audioInputName);
    return args;
  }

  const args = [];
  const original = Number(metadata.duration) || 0;
  if (duration > original + 0.05 && original > 0) args.push("-stream_loop", "-1");
  if (original === 0 && kind === "png") args.push("-loop", "1");
  args.push("-i", inputName);
  return args;
}

async function readOutput(name, format) {
  const bytes = await ffmpeg.readFile(name);
  return new Blob([bytes], { type: outputMime(format) });
}

async function extractProcessedFrames({
  prefix,
  inputArgs,
  metadata,
  settings,
  duration,
}) {
  const base = buildBaseFilter(metadata, settings);
  const pattern = `${prefix}-out-%06d.png`;
  const args = [
    ...inputArgs,
    "-vf",
    base.filter,
    "-t",
    String(duration),
    pattern,
  ];
  const code = await ffmpeg.exec(args, EXEC_TIMEOUT);
  if (code !== 0) throw new Error(`FFmpeg 逐帧处理失败（${code}）`);

  const entries = (await ffmpeg.listDir("."))
    .filter((entry) => entry.name.startsWith(`${prefix}-out-`) && entry.name.endsWith(".png"))
    .sort((a, b) => a.name.localeCompare(b.name));

  const frames = [];
  for (const entry of entries) frames.push(await ffmpeg.readFile(entry.name));
  if (!frames.length) throw new Error("处理后没有生成动画帧");
  return { ...base, frames, duration: frames.length / base.fps };
}

function qualityToCrf(quality) {
  const normalized = Math.max(1, Math.min(100, Number(quality) || 80));
  return Math.round(40 - normalized * 0.3);
}

function commonOutputArgs(duration) {
  return ["-t", String(duration)];
}

async function encodeStandardFormat({
  prefix,
  inputArgs,
  metadata,
  settings,
  format,
  duration,
  hasAudio,
  sequence,
}) {
  const requireEven = ["mp4", "vap", "dual"].includes(format);
  const base = buildBaseFilter(metadata, settings, { requireEven });
  const output = `${prefix}-result.${outputExtension(format)}`;
  const quality = Math.max(1, Math.min(100, Number(settings.quality) || 80));
  let args;

  if (format === "webp") {
    args = [
      ...inputArgs,
      "-vf",
      base.filter,
      ...commonOutputArgs(duration),
      "-c:v",
      "libwebp_anim",
      "-lossless",
      quality >= 98 ? "1" : "0",
      "-q:v",
      String(quality),
      "-loop",
      "0",
      "-an",
      output,
    ];
  } else if (format === "apng") {
    args = [
      ...inputArgs,
      "-vf",
      base.filter,
      ...commonOutputArgs(duration),
      "-f",
      "apng",
      "-plays",
      "0",
      "-compression_level",
      String(Math.max(0, Math.min(9, Math.round(quality / 11)))),
      "-an",
      output,
    ];
  } else if (format === "gif") {
    const colors = Math.max(16, Math.min(256, Math.round(16 + quality * 2.4)));
    const graph = `${base.filter},split[s0][s1];[s0]palettegen=max_colors=${colors}:reserve_transparent=1[p];[s1][p]paletteuse=dither=sierra2_4a:alpha_threshold=96`;
    args = [
      ...inputArgs,
      "-filter_complex",
      graph,
      ...commonOutputArgs(duration),
      "-loop",
      "0",
      "-an",
      output,
    ];
  } else if (format === "mp4") {
    args = [
      ...inputArgs,
      "-vf",
      `${base.filter},format=yuv420p`,
      ...commonOutputArgs(duration),
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      String(qualityToCrf(quality)),
      "-movflags",
      "+faststart",
    ];
    if (settings.mute || !hasAudio || (sequence && !sequence.audioInputName)) args.push("-an");
    else {
      const audioInput = sequence?.audioInputName ? 1 : 0;
      args.push("-map", "0:v:0", "-map", `${audioInput}:a?`, "-c:a", "aac", "-b:a", "128k");
    }
    args.push(output);
  } else {
    const alphaToGray = "colorchannelmixer=rr=0:rg=0:rb=0:ra=1:gr=0:gg=0:gb=0:ga=1:br=0:bg=0:bb=0:ba=1,format=rgb24";
    const graph = `[0:v]${base.filter},split=2[rgb][alpha];[rgb]format=rgb24,pad=iw*2:ih:0:0:color=black[canvas];[alpha]${alphaToGray}[mask];[canvas][mask]overlay=x=main_w/2:y=0,format=yuv420p[v]`;
    args = [
      ...inputArgs,
      "-filter_complex",
      graph,
      "-map",
      "[v]",
      ...commonOutputArgs(duration),
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      String(qualityToCrf(quality)),
      "-movflags",
      "+faststart",
    ];
    if (settings.mute || !hasAudio || (sequence && !sequence.audioInputName)) args.push("-an");
    else {
      const audioInput = sequence?.audioInputName ? 1 : 0;
      args.push("-map", `${audioInput}:a?`, "-c:a", "aac", "-b:a", "128k");
    }
    args.push(output);
  }

  const code = await ffmpeg.exec(args, EXEC_TIMEOUT);
  if (code !== 0) throw new Error(`FFmpeg 转换失败（${code}）`);
  let blob = await readOutput(output, format);

  if (format === "vap") {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const frameCount = Math.max(1, Math.round(duration * base.fps));
    const config = buildVapConfig({
      frames: frameCount,
      width: base.width,
      height: base.height,
      fps: base.fps,
      alphaX: base.width,
      videoWidth: base.width * 2,
      videoHeight: base.height,
    });
    blob = new Blob([appendVapConfig(bytes, config)], { type: "video/mp4" });
  }

  return {
    blob,
    width: format === "vap" || format === "dual" ? base.width * 2 : base.width,
    height: base.height,
    displayWidth: base.width,
    displayHeight: base.height,
    fps: base.fps,
    duration,
  };
}

export async function processMediaItem(
  item,
  settings,
  {
    onStatus = () => {},
    onProgress = () => {},
    onLog = () => {},
  } = {},
) {
  await ensureFfmpegLoaded({ onStatus });
  currentLogHandler = onLog;
  currentProgressHandler = onProgress;

  const prefix = `task-${String(item.id).replace(/[^a-z0-9-]/gi, "")}`;
  const duration = sourceDuration(item.metadata, settings);
  let sequence = null;
  let inputName;

  try {
    if (item.kind === "svga") {
      onStatus("正在渲染 SVGA 动画帧…");
      sequence = await renderSvgaFrames(
        item.video,
        { fps: settings.fps, duration },
        (progress) => onProgress(progress * 0.35),
      );
      inputName = prefix;
      await writeFrameSequence(prefix, sequence);
    } else if (["gif", "webp", "apng", "png"].includes(item.kind)) {
      onStatus("正在解码动图帧…");
      sequence = await renderAnimatedImageFrames(
        item.file,
        item.kind,
        { fps: settings.fps, duration },
        onProgress,
      );
      if (sequence) {
        inputName = prefix;
        await writeFrameSequence(prefix, sequence);
      } else {
        inputName = `${prefix}-input.${safeExtension(item.file.name, item.kind)}`;
        await ffmpeg.writeFile(inputName, new Uint8Array(await item.file.arrayBuffer()));
      }
    } else {
      inputName = `${prefix}-input.${safeExtension(item.file.name, item.kind)}`;
      await ffmpeg.writeFile(inputName, new Uint8Array(await item.file.arrayBuffer()));
      if (["vap", "dual"].includes(item.kind) && item.vapConfig) {
        onStatus("正在还原 VAP/双通道透明帧…");
        sequence = await extractVapSequence({
          prefix,
          inputName,
          item,
          settings,
          duration,
          onProgress,
        });
        await writeFrameSequence(prefix, sequence);
        inputName = prefix;
      }
    }

    const inputArgs = inputArguments({
      inputName,
      sequence,
      metadata: item.metadata,
      duration,
      kind: item.kind,
    });

    onStatus("正在处理并编码…");
    let result;
    if (settings.outputFormat === "svga") {
      const processed = await extractProcessedFrames({
        prefix,
        inputArgs,
        metadata: sequence
          ? { ...item.metadata, width: sequence.width, height: sequence.height }
          : item.metadata,
        settings,
        duration,
      });
      result = {
        blob: encodeSvgaFromFrames(processed),
        width: processed.width,
        height: processed.height,
        displayWidth: processed.width,
        displayHeight: processed.height,
        fps: processed.fps,
        duration: processed.duration,
      };
    } else {
      result = await encodeStandardFormat({
        prefix,
        inputArgs,
        metadata: sequence
          ? { ...item.metadata, width: sequence.width, height: sequence.height }
          : item.metadata,
        settings,
        format: settings.outputFormat,
        duration,
        hasAudio: Boolean(item.metadata.hasAudio),
        sequence,
      });
    }

    onProgress(1);
    return {
      ...result,
      extension: outputExtension(settings.outputFormat),
      mime: outputMime(settings.outputFormat),
    };
  } finally {
    currentLogHandler = () => {};
    currentProgressHandler = () => {};
    await cleanupPrefix(prefix);
  }
}

export function terminateFfmpeg() {
  if (ffmpeg.loaded) ffmpeg.terminate();
  loadPromise = null;
}
