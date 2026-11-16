import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Exercise the real export orchestration against deterministic canvas encoders.
// Browser image quality and visual parity are checked separately with real SVGA files.
const bundle = await build({
  entryPoints: [fileURLToPath(new URL("../src/raster-export.ts", import.meta.url))],
  bundle: true, write: false, format: "esm", platform: "node",
  plugins: [{ name: "fake-svga-player", setup(builder) {
    builder.onResolve({ filter: /^svga$/ }, () => ({ path: "player", namespace: "test" }));
    builder.onLoad({ filter: /.*/, namespace: "test" }, () => ({ contents: `
      export class Player {
        constructor(options) { this.canvas = options.container; this.currentFrame = 0; }
        async mount(video) {
          this.canvas.width = video.size.width; this.canvas.height = video.size.height;
          globalThis.__rasterTest.mountedVideo = video;
          if (globalThis.__rasterTest.hangMount) await new Promise(() => {});
        }
        drawFrame(frame) { globalThis.__rasterTest.frames.push(frame); }
        destroy() { globalThis.__rasterTest.destroyed++; }
      }
    ` }));
  } }],
});
const { renderRasterFrameSvg } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

function setup(overrides = {}) {
  const state = { frames: [], destroyed: 0, canvases: [], encodings: [],
    payloadSize: (_format, _quality, width, height) => width * height,
    ...overrides };
  globalThis.__rasterTest = state;
  globalThis.window = { setTimeout: (callback) => setTimeout(callback, 0) };
  globalThis.document = { createElement(name) {
    assert.equal(name, "canvas");
    const canvas = { width: 0, height: 0,
      getContext: () => ({ clearRect() {}, drawImage() {} }),
      toDataURL(format, quality) {
        state.encodings.push({ format, quality, width: this.width, height: this.height });
        return `data:${format};base64,${"A".repeat(Math.max(4, Math.ceil(state.payloadSize(format, quality, this.width, this.height) / 4) * 4))}`;
      },
    };
    state.canvases.push(canvas);
    return canvas;
  } };
  return state;
}

function video(frames = 3, width = 100, height = 100) {
  return { size: { width, height }, frames, fps: 30, sprites: [], images: {}, dynamicElements: {}, replaceElements: {} };
}

test("PNG export preserves each frame and uses a synchronized timeline", async () => {
  const state = setup();
  const svg = await renderRasterFrameSvg(video());
  assert.equal((svg.match(/class="svga-raster-frame"/g) ?? []).length, 3);
  assert.match(svg, /data-image-format="png"/);
  assert.match(svg, /data-source-fps="30"/);
  assert.match(svg, /dur="0.1s"/);
  assert.match(svg, /keyTimes="0;0.3333333333333333;1"/);
  assert.doesNotMatch(svg, /animation-delay/);
  assert.deepEqual(state.frames, [0, 1, 2]);
  assert.equal(state.destroyed, 1);
  assert.ok(state.canvases.every((canvas) => canvas.width === 0 && canvas.height === 0));
});

test("single-frame output stays visible and has no animation", async () => {
  setup();
  const svg = await renderRasterFrameSvg(video(1));
  assert.doesNotMatch(svg, /<animate/);
  assert.match(svg, /opacity="1"/);
});

test("budget keeps native dimensions and selects the first fitting WebP quality", async () => {
  const state = setup({ payloadSize: (format, quality) => format === "image/png" ? 9000 : quality === 0.92 ? 6000 : 1200 });
  const svg = await renderRasterFrameSvg(video(), { targetBytes: 8000 });
  assert.ok(Buffer.byteLength(svg, "utf8") <= 8000);
  assert.match(svg, /data-render-width="100" data-render-height="100"/);
  assert.match(svg, /data-image-format="webp" data-image-quality="0.82"/);
  assert.equal((svg.match(/class="svga-raster-frame"/g) ?? []).length, 3);
  assert.ok(state.encodings.some((item) => item.quality === 0.92));
  assert.ok(!state.encodings.some((item) => item.quality === 0.72));
});

test("budget scales encoded pixels while preserving canvas size, frames and timing", async () => {
  setup({ payloadSize: (_format, _quality, width, height) => width * height });
  const svg = await renderRasterFrameSvg(video(4, 200, 100), { targetBytes: 20000 });
  assert.ok(Buffer.byteLength(svg, "utf8") <= 20000);
  assert.match(svg, /width="200" height="100"/);
  assert.match(svg, /data-source-frames="4" data-source-fps="30"/);
  assert.match(svg, /dur="0.13333333333333333s"/);
  const renderedWidth = Number(svg.match(/data-render-width="(\d+)"/)[1]);
  assert.ok(renderedWidth >= 64 && renderedWidth < 200);
});

test("an impossible budget rejects instead of downloading an oversized SVG", async () => {
  const state = setup();
  await assert.rejects(renderRasterFrameSvg(video(), { targetBytes: 100 }), /仍无法压到/);
  assert.equal(state.destroyed, 1);
  assert.ok(state.canvases.every((canvas) => canvas.width === 0));
});

test("cancellation during frames frees player and canvases", async () => {
  const state = setup();
  await assert.rejects(renderRasterFrameSvg(video(100), { shouldCancel: () => state.frames.length >= 3 }), /任务已取消/);
  assert.equal(state.frames.length, 3);
  assert.equal(state.destroyed, 1);
  assert.ok(state.canvases.every((canvas) => canvas.width === 0));
});

test("cancellation also interrupts a stuck player mount", async () => {
  const state = setup({ hangMount: true });
  let cancelled = false;
  setTimeout(() => { cancelled = true; }, 5);
  await assert.rejects(renderRasterFrameSvg(video(), { shouldCancel: () => cancelled }), /任务已取消/);
  assert.equal(state.destroyed, 1);
});

test("large originals keep the player's own render canvas within the pixel bound", async () => {
  const state = setup({ payloadSize: () => 20 });
  const original = video(60, 8000, 4000);
  original.sprites = [{ frames: [{ transform: { a: 1, b: 0, c: 0, d: 1, tx: 100, ty: 80 } }] }];
  const svg = await renderRasterFrameSvg(original);
  assert.ok(state.mountedVideo.size.width * state.mountedVideo.size.height * 60 <= 60_000_000);
  assert.ok(state.mountedVideo.size.width <= 2048);
  assert.equal(original.sprites[0].frames[0].transform.a, 1, "source must not be mutated");
  assert.match(svg, /width="8000" height="4000"/);
});

test("invalid animation and byte budget fail before allocating a player", async () => {
  const state = setup();
  await assert.rejects(renderRasterFrameSvg(video(1.5)), /动画参数无效/);
  await assert.rejects(renderRasterFrameSvg(video(), { targetBytes: NaN }), /正整数/);
  assert.equal(state.destroyed, 0);
  assert.equal(state.canvases.length, 0);
});
