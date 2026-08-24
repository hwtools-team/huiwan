const MAX_IMAGE_FRAMES = 300;

function mimeForKind(kind, file) {
  if (file.type?.startsWith("image/")) return file.type;
  return {
    gif: "image/gif",
    webp: "image/webp",
    apng: "image/png",
    png: "image/png",
  }[kind];
}

function canvasToPng(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) reject(new Error("动图帧无法编码为 PNG"));
      else resolve(new Uint8Array(await blob.arrayBuffer()));
    }, "image/png");
  });
}

async function createDecoder(file, kind) {
  if (typeof ImageDecoder === "undefined") return null;
  const type = mimeForKind(kind, file);
  if (ImageDecoder.isTypeSupported && !(await ImageDecoder.isTypeSupported(type))) return null;
  const decoder = new ImageDecoder({
    data: new Uint8Array(await file.arrayBuffer()),
    type,
    preferAnimation: true,
  });
  await decoder.tracks.ready;
  return decoder;
}

async function fallbackMetadata(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      resolve({
        width: image.naturalWidth,
        height: image.naturalHeight,
        fps: 30,
        frames: null,
        duration: 0,
        hasAudio: false,
        decoder: "browser-image",
      });
      URL.revokeObjectURL(url);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("图片无法解析"));
    };
    image.src = url;
  });
}

export async function parseAnimatedImageMetadata(file, kind) {
  const decoder = await createDecoder(file, kind);
  if (!decoder) return fallbackMetadata(file);
  try {
    const track = decoder.tracks.selectedTrack;
    const frameCount = Math.max(1, track?.frameCount || 1);
    const first = await decoder.decode({ frameIndex: 0, completeFramesOnly: true });
    const width = first.image.displayWidth;
    const height = first.image.displayHeight;
    const firstDuration = Number(first.image.duration) / 1_000_000 || 1 / 30;
    first.image.close();

    let duration = firstDuration * frameCount;
    if (frameCount <= MAX_IMAGE_FRAMES) {
      duration = firstDuration;
      for (let index = 1; index < frameCount; index += 1) {
        const frame = await decoder.decode({ frameIndex: index, completeFramesOnly: true });
        duration += Number(frame.image.duration) / 1_000_000 || firstDuration;
        frame.image.close();
      }
    }

    return {
      width,
      height,
      fps: Math.max(1, Math.round(frameCount / Math.max(duration, 1 / 60))),
      frames: frameCount,
      duration,
      hasAudio: false,
      decoder: "ImageDecoder",
    };
  } finally {
    decoder.close();
  }
}

export async function renderAnimatedImageFrames(
  file,
  kind,
  { fps = 30, duration = 0 } = {},
  onProgress = () => {},
) {
  const decoder = await createDecoder(file, kind);
  if (!decoder) return null;
  try {
    const track = decoder.tracks.selectedTrack;
    const frameCount = Math.min(MAX_IMAGE_FRAMES, Math.max(1, track?.frameCount || 1));
    const sourceFrames = [];
    const sourceDurations = [];
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { willReadFrequently: false });
    let width = 0;
    let height = 0;

    for (let index = 0; index < frameCount; index += 1) {
      const decoded = await decoder.decode({ frameIndex: index, completeFramesOnly: true });
      width ||= decoded.image.displayWidth;
      height ||= decoded.image.displayHeight;
      canvas.width = width;
      canvas.height = height;
      context.clearRect(0, 0, width, height);
      context.drawImage(decoded.image, 0, 0, width, height);
      sourceFrames.push(await canvasToPng(canvas));
      sourceDurations.push(Number(decoded.image.duration) / 1_000_000 || 1 / fps);
      decoded.image.close();
      onProgress(((index + 1) / frameCount) * 0.18);
      if (index % 4 === 3) await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const sourceDuration = sourceDurations.reduce((sum, value) => sum + value, 0) || 1;
    const outputFps = Math.max(1, Math.min(60, Number(fps) || 30));
    const outputDuration = Math.max(1 / outputFps, Number(duration) || sourceDuration);
    const outputCount = Math.min(MAX_IMAGE_FRAMES, Math.max(1, Math.ceil(outputDuration * outputFps)));
    const timeline = [];
    let accumulated = 0;
    for (const value of sourceDurations) {
      accumulated += value;
      timeline.push(accumulated);
    }

    const frames = [];
    for (let index = 0; index < outputCount; index += 1) {
      const time = (index / outputFps) % sourceDuration;
      const sourceIndex = Math.max(0, timeline.findIndex((edge) => time < edge));
      frames.push(sourceFrames[sourceIndex].slice());
    }

    return {
      frames,
      width,
      height,
      fps: outputFps,
      duration: outputCount / outputFps,
    };
  } finally {
    decoder.close();
  }
}

export { MAX_IMAGE_FRAMES };
