type ParsedVideo = import("svga/dist/types").Video;

export type LightweightMatrix = [number, number, number, number, number, number];
type OpacityPoint = { frame: number; value: string };
export type LightweightStatePlan = {
  matrix: string;
  points: OpacityPoint[];
};
export type LightweightSpritePlan = {
  imageId: string;
  states: LightweightStatePlan[];
  /** UI compatibility flag: the sprite uses multiple static matrix states. */
  animatedTransforms?: true;
};
type LightweightImagePlan = {
  id: string;
  dataUrl: string;
  width: number;
  height: number;
};
export type LightweightCompatibility =
  | {
      compatible: true;
      spritePlans: LightweightSpritePlan[];
      imagePlans: LightweightImagePlan[];
    }
  | { compatible: false; reason: string };

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const MATRIX_EPSILON = 0.000001;
// Bounds cover ordinary exports while preventing pathological DOM/string growth.
const MAX_FRAME_SPRITE_PAIRS = 300_000;
const MAX_MATRIX_STATES = 20_000;
const MAX_IMAGE_TEXT_BYTES = 24_000_000;
const MAX_EXPORT_BYTES = 40_000_000;
const EXPORT_DESCRIPTION =
  "资源复用 SVG；原图仅嵌入一次，完整矩阵状态按原始帧率离散切换，保留旋转、斜切、镜像和非等比缩放。";

function formatNumber(value: number) {
  return Number((Math.abs(value) < MATRIX_EPSILON ? 0 : value).toFixed(6)).toString();
}

function readPng(raw: string): Omit<LightweightImagePlan, "id"> | undefined {
  const payload = raw.startsWith("data:image/png;base64,")
    ? raw.slice("data:image/png;base64,".length)
    : raw;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(payload) || payload.length % 4 !== 0) return;
  try {
    const header = atob(payload.slice(0, 44));
    if (
      header.length < 24 ||
      Array.from("\x89PNG\r\n\x1a\n").some((byte, i) => header[i] !== byte) ||
      header.slice(12, 16) !== "IHDR"
    ) return;
    const uint32 = (offset: number) =>
      ((header.charCodeAt(offset) << 24) |
        (header.charCodeAt(offset + 1) << 16) |
        (header.charCodeAt(offset + 2) << 8) |
        header.charCodeAt(offset + 3)) >>> 0;
    const width = uint32(16);
    const height = uint32(20);
    if (!width || !height || width > 32768 || height > 32768) return;
    return { dataUrl: `data:image/png;base64,${payload}`, width, height };
  } catch {
    return;
  }
}

function setOpacity(state: LightweightStatePlan, frame: number, value: string) {
  const last = state.points[state.points.length - 1];
  if (last.frame === frame) last.value = value;
  else if (last.value !== value) state.points.push({ frame, value });
}

function hasMatte(sprite: ParsedVideo["sprites"][number]) {
  const extended = sprite as typeof sprite & { matteKey?: unknown };
  return Boolean(extended.matteKey) || /\.matte$/i.test(sprite.imageKey);
}

function analyze(video: ParsedVideo): LightweightCompatibility {
  const reject = (reason: string): LightweightCompatibility => ({ compatible: false, reason });
  if (
    !Number.isInteger(video.frames) || video.frames <= 0 ||
    !Number.isFinite(video.fps) || video.fps <= 0 ||
    !Number.isFinite(video.size?.width) || video.size.width <= 0 ||
    !Number.isFinite(video.size?.height) || video.size.height <= 0 ||
    !Number.isFinite(video.frames / video.fps) ||
    !Array.isArray(video.sprites) || !video.images
  ) return reject("动画尺寸、帧数或 FPS 无效");
  if (video.frames * Math.max(1, video.sprites.length) > MAX_FRAME_SPRITE_PAIRS) {
    return reject("图层与帧数过多，请使用限体积 SVG");
  }
  if (
    Object.keys(video.replaceElements ?? {}).length ||
    Object.keys(video.dynamicElements ?? {}).length
  ) return reject("包含动态替换内容");
  if (video.sprites.some((sprite) => !Array.isArray(sprite.frames))) return reject("图层帧数据无效");
  if (video.sprites.some(hasMatte)) return reject("包含 Matte 遮罩图层");

  const imagesByKey = new Map<string, LightweightImagePlan>();
  const imagesByData = new Map<string, LightweightImagePlan>();
  const imagePlans: LightweightImagePlan[] = [];
  let imageTextBytes = 0;
  for (const key of new Set(video.sprites.map((sprite) => sprite.imageKey))) {
    const raw = video.images[key];
    if (typeof raw !== "string") return reject("包含矢量图层、缺失图片或无法复用的图片资源");
    if (raw.length + imageTextBytes > MAX_IMAGE_TEXT_BYTES) return reject("原始图片资源过大，请使用限体积 SVG");
    const image = readPng(raw);
    if (!image) return reject("包含无法识别尺寸的 PNG 图片");
    let plan = imagesByData.get(image.dataUrl);
    if (!plan) {
      plan = { id: `svga-light-image-${imagePlans.length}`, ...image };
      imagesByData.set(image.dataUrl, plan);
      imagePlans.push(plan);
      imageTextBytes += image.dataUrl.length;
    }
    imagesByKey.set(key, plan);
  }

  const spritePlans: LightweightSpritePlan[] = [];
  let stateCount = 0;
  for (const sprite of video.sprites) {
    const image = imagesByKey.get(sprite.imageKey)!;
    const states = new Map<string, LightweightStatePlan>();
    let active: LightweightStatePlan | undefined;
    for (let index = 0; index < video.frames; index += 1) {
      const frame = sprite.frames[index];
      const alpha = frame?.alpha ?? 0;
      if (!Number.isFinite(alpha)) return reject("包含无效的图层透明度");
      // Match the SVGA player's own visibility threshold.
      const opacity = alpha >= 0.05 ? formatNumber(Math.min(1, Math.max(0, alpha))) : "0";
      if (opacity === "0") {
        if (active) setOpacity(active, index, "0");
        active = undefined;
        continue;
      }
      if (frame.shapes?.length || frame.maskPath || frame.clipPath?.trim()) {
        return reject("包含遮罩、裁剪或矢量图层");
      }
      const t = frame.transform ?? { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
      // drawSprite draws at (0,0); layout.x/y must not be added a second time.
      const width = frame.layout?.width ?? image.width;
      const height = frame.layout?.height ?? image.height;
      if (!Number.isFinite(width) || !Number.isFinite(height) || width < 0 || height < 0) {
        return reject("包含无效的图层尺寸");
      }
      if (!width || !height) {
        if (active) setOpacity(active, index, "0");
        active = undefined;
        continue;
      }
      const sx = width / image.width;
      const sy = height / image.height;
      const matrix: LightweightMatrix = [t.a * sx, t.b * sx, t.c * sy, t.d * sy, t.tx, t.ty];
      if (!matrix.every(Number.isFinite)) return reject("包含无效的图层变换");
      const key = matrix.map(formatNumber).join(" ");
      let state = states.get(key);
      if (!state) {
        stateCount += 1;
        if (stateCount > MAX_MATRIX_STATES) return reject("矩阵状态过多，请使用限体积 SVG");
        state = { matrix: key, points: [{ frame: 0, value: "0" }] };
        states.set(key, state);
      }
      if (active && active !== state) setOpacity(active, index, "0");
      setOpacity(state, index, opacity);
      active = state;
    }
    if (states.size) {
      spritePlans.push({
        imageId: image.id,
        states: [...states.values()],
        ...(states.size > 1 ? { animatedTransforms: true as const } : {}),
      });
    }
  }
  if (!spritePlans.length) return reject("没有可复用的可见图片图层");
  const usedImages = new Set(spritePlans.map((sprite) => sprite.imageId));
  return { compatible: true, spritePlans, imagePlans: imagePlans.filter((image) => usedImages.has(image.id)) };
}

// Parsed videos are immutable after import; avoiding repeated analysis keeps React renders cheap.
const cache = new WeakMap<ParsedVideo, LightweightCompatibility>();
export function getLightweightCompatibility(video: ParsedVideo): LightweightCompatibility {
  const previous = cache.get(video);
  if (previous) return previous;
  const plan = analyze(video);
  cache.set(video, plan);
  return plan;
}

function animationAttributes(state: LightweightStatePlan, video: ParsedVideo) {
  if (state.points.length < 2) return undefined;
  // Explicit endpoint holds the final frame until the duration ends, then repeats at frame 0.
  const values = [...state.points.map((point) => point.value), state.points[state.points.length - 1].value];
  const times = [...state.points.map((point) => String(point.frame / video.frames)), "1"];
  return {
    attributeName: "opacity",
    values: values.join(";"),
    keyTimes: times.join(";"),
    dur: `${video.frames / video.fps}s`,
    begin: "0s",
    repeatCount: "indefinite",
    calcMode: "discrete",
  };
}

function rootAttributes(video: ParsedVideo) {
  return {
    xmlns: SVG_NAMESPACE,
    width: String(video.size.width),
    height: String(video.size.height),
    style: "width:100%;height:100%",
    viewBox: `0 0 ${video.size.width} ${video.size.height}`,
    preserveAspectRatio: "xMidYMid meet",
    "data-svga-export": "lightweight",
    "data-source-frames": String(video.frames),
    "data-source-fps": String(video.fps),
  };
}

function imageAttributes(image: LightweightImagePlan) {
  return { id: image.id, href: image.dataUrl, width: String(image.width), height: String(image.height) };
}
function groupAttributes(index: number) {
  return { id: `svga-light-sprite-${index}`, "data-svga-transform": "matrix-states" };
}
function useAttributes(sprite: LightweightSpritePlan, state: LightweightStatePlan, index: number, stateIndex: number) {
  return {
    id: `svga-light-sprite-${index}-state-${stateIndex}`,
    href: `#${sprite.imageId}`,
    transform: `matrix(${state.matrix})`,
    opacity: state.points[0].value,
  };
}
function attributes(values: Record<string, string>) {
  // Attribute values are exclusively validated PNG data, numeric plans, or fixed constants.
  return Object.entries(values).map(([key, value]) => `${key}="${value}"`).join(" ");
}

export function buildLightweightSvg(video: ParsedVideo): string {
  const plan = getLightweightCompatibility(video);
  if (!plan.compatible) throw new Error(plan.reason);
  const definitions = plan.imagePlans.map((image) => `<image ${attributes(imageAttributes(image))}/>`).join("");
  const sprites = plan.spritePlans.map((sprite, index) => {
    const states = sprite.states.map((state, stateIndex) => {
      const animation = animationAttributes(state, video);
      return `<use ${attributes(useAttributes(sprite, state, index, stateIndex))}>${animation ? `<animate ${attributes(animation)}/>` : ""}</use>`;
    }).join("");
    return `<g ${attributes(groupAttributes(index))}>${states}</g>`;
  }).join("");
  const svg = `<svg ${attributes(rootAttributes(video))}><metadata>${EXPORT_DESCRIPTION}</metadata><defs>${definitions}</defs>${sprites}</svg>`;
  if (new Blob([svg]).size > MAX_EXPORT_BYTES) throw new Error("轻量 SVG 状态数据过大，请使用限体积 SVG");
  return svg;
}

function matches(element: Element | undefined, tag: string, expected: Record<string, string>) {
  return Boolean(element && element.namespaceURI === SVG_NAMESPACE && element.localName === tag &&
    element.attributes.length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, value]) => element.getAttribute(key) === value));
}

/** Validate every node against the source plan; added scripts, CSS and external links fail closed. */
export function verifyLightweightSvgStructure(svg: string, video: ParsedVideo): string {
  const plan = getLightweightCompatibility(video);
  const fail = () => { throw new Error("轻量 SVG 结构校验失败"); };
  if (!plan.compatible) throw new Error(plan.reason);
  if (new Blob([svg]).size > MAX_EXPORT_BYTES || /<!DOCTYPE|<!ENTITY|<\?/i.test(svg)) fail();
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = doc.documentElement;
  if (doc.childNodes.length !== 1 || doc.querySelector("parsererror") || !matches(root, "svg", rootAttributes(video))) fail();
  const children = Array.from(root.children);
  const metadata = children[0];
  const defs = children[1];
  if (children.length !== plan.spritePlans.length + 2 ||
    !matches(metadata, "metadata", {}) || metadata.children.length || metadata.textContent !== EXPORT_DESCRIPTION ||
    !matches(defs, "defs", {}) || defs.children.length !== plan.imagePlans.length) fail();
  plan.imagePlans.forEach((image, index) => {
    const node = defs.children[index];
    if (!matches(node, "image", imageAttributes(image)) || node.children.length) fail();
  });
  plan.spritePlans.forEach((sprite, index) => {
    const group = children[index + 2];
    if (!matches(group, "g", groupAttributes(index)) || group.children.length !== sprite.states.length) fail();
    sprite.states.forEach((state, stateIndex) => {
      const use = group.children[stateIndex];
      const animation = animationAttributes(state, video);
      if (!matches(use, "use", useAttributes(sprite, state, index, stateIndex)) ||
        use.children.length !== (animation ? 1 : 0)) fail();
      if (animation && (!matches(use.children[0], "animate", animation) || use.children[0].children.length)) fail();
    });
  });
  // No processing instructions, CDATA or unexpected text hidden between validated elements.
  const walk = doc.createTreeWalker(root, 0xFFFFFFFF);
  for (let node = walk.nextNode(); node; node = walk.nextNode()) {
    if (node.nodeType !== 1 && !(node.nodeType === 3 && node.parentNode === metadata && node.textContent === EXPORT_DESCRIPTION)) fail();
  }
  return svg;
}
