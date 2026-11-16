import { Parser, Player } from "svga";
import { buildLightweightSvg, getLightweightCompatibility, verifyLightweightSvgStructure } from "../src/lightweight-export";
import { renderRasterFrameSvg, verifySvgStructure } from "../src/raster-export";

type Video = import("svga/dist/types").Video;

async function parse(url: string) {
  const parser = new Parser({ isDisableWebWorker: true, isDisableImageBitmapShim: true });
  try { return await parser.load(url); } finally { parser.destroy(); }
}

/** Read real SMIL state at a timestamp, then rasterize that state for pixel QA. */
async function rasterizeAt(svg: SVGSVGElement, seconds: number, canvas: HTMLCanvasElement) {
  svg.pauseAnimations();
  svg.setCurrentTime(seconds);
  // Chromium applies SMIL seeks on an animation tick. Foreground the QA page
  // before running this harness so background-tab throttling cannot stall it.
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const originals = svg.querySelectorAll("use, image, g");
  const copies = clone.querySelectorAll("use, image, g");
  originals.forEach((node, i) => copies[i].setAttribute("opacity", getComputedStyle(node).opacity));
  clone.querySelectorAll("animate").forEach(node => node.remove());
  clone.removeAttribute("style");
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: "image/svg+xml" }));
  try {
    const image = new Image(); image.src = url; await image.decode();
    const context = canvas.getContext("2d")!;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return context.getImageData(0, 0, canvas.width, canvas.height).data;
  } finally { URL.revokeObjectURL(url); }
}

async function compare(video: Video, text: string, frames: number[]) {
  const source = document.createElement("canvas");
  const output = document.createElement("canvas");
  // Repeated readbacks otherwise make Chromium switch rendering backends after
  // a few frames, changing antialiasing in the reference during the comparison.
  source.getContext("2d", { willReadFrequently: true });
  output.getContext("2d", { willReadFrequently: true });
  output.width = video.size.width; output.height = video.size.height;
  const svg = document.importNode(new DOMParser().parseFromString(text, "image/svg+xml").documentElement, true) as unknown as SVGSVGElement;
  svg.style.cssText = `position:fixed;left:0;top:0;width:${video.size.width}px;height:${video.size.height}px;z-index:-1`;
  document.body.append(svg);
  const player = new Player({ container: source, loop: false, isCacheFrames: false, isUseIntersectionObserver: false });
  const results = [];
  try {
    await player.mount(video);
    for (const frame of frames) {
      const index = ((frame % video.frames) + video.frames) % video.frames;
      player.currentFrame = index;
      (player as unknown as {drawFrame(frame: number):void}).drawFrame(index);
      const expected = source.getContext("2d")!.getImageData(0, 0, source.width, source.height).data;
      const actual = await rasterizeAt(svg, (frame + 0.25) / video.fps, output);
      let sum = 0, max = 0, changed = 0, alphaSum = 0;
      for (let pixel = 0; pixel < expected.length; pixel += 4) {
        let pixelError = 0;
        const ea = expected[pixel + 3] / 255, aa = actual[pixel + 3] / 255;
        alphaSum += Math.abs(expected[pixel + 3] - actual[pixel + 3]);
        for (let c = 0; c < 3; c++) {
          const error = Math.max(Math.abs(expected[pixel+c]*ea - actual[pixel+c]*aa), Math.abs(expected[pixel+c]*ea+255*(1-ea) - actual[pixel+c]*aa-255*(1-aa)));
          sum += error; max = Math.max(max, error); pixelError = Math.max(pixelError, error);
        }
        if (pixelError > 8) changed++;
      }
      const checksum = (data: Uint8ClampedArray) => { let hash = 2166136261; for (const byte of data) hash = Math.imul(hash ^ byte, 16777619); return hash >>> 0; };
      results.push({ frame, expectedHash: checksum(expected), actualHash: checksum(actual), meanError: sum / (expected.length / 4 * 3), maxError: max, pixelsOver8: changed / (expected.length / 4), alphaMeanError: alphaSum / (expected.length / 4) });
    }
    return results;
  } finally { player.destroy(); svg.remove(); }
}

Object.assign(window, { svgTest: { parse, compare, buildLightweightSvg, getLightweightCompatibility, verifyLightweightSvgStructure, renderRasterFrameSvg, verifySvgStructure } });
