import assert from "node:assert/strict";
import test from "node:test";
import { buildLightweightSvg, getLightweightCompatibility } from "../src/lightweight-export.ts";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a42cAAAAASUVORK5CYII=";
const identity = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
function frame(transform = identity, alpha = 1, layout = { x: 0, y: 0, width: 1, height: 1 }) {
  return { transform, alpha, layout, shapes: [], clipPath: "", maskPath: null };
}
function video(frames, extraSprites = []) {
  return { size: { width: 240, height: 240 }, frames: frames.length, fps: 30,
    images: { image: png }, sprites: [{ imageKey: "image", frames }, ...extraSprites],
    replaceElements: {}, dynamicElements: {} };
}
function attribute(text, name) {
  return text.match(new RegExp(`(?:^| )${name}="([^"]*)"`))?.[1];
}
// Independently sample the exported opacity timelines at a point inside each frame.
function exportedSpritesAt(svg, fraction) {
  return [...svg.matchAll(/<g ([^>]*)>(.*?)<\/g>/g)].map(([, , group]) =>
    [...group.matchAll(/<use ([^>]*)>(.*?)<\/use>/g)].flatMap(([, attrs, body]) => {
      let opacity = Number(attribute(attrs, "opacity"));
      const animation = body.match(/<animate ([^>]*)\/>/);
      if (animation) {
        const times = attribute(animation[1], "keyTimes").split(";").map(Number);
        const values = attribute(animation[1], "values").split(";").map(Number);
        assert.equal(times.length, values.length);
        assert.equal(times[0], 0);
        assert.equal(times.at(-1), 1);
        for (let i = 1; i < times.length; i++) assert.ok(times[i] > times[i - 1]);
        opacity = values[times.findLastIndex((time) => time <= fraction)];
      }
      return opacity ? [{ matrix: attribute(attrs, "transform"), opacity }] : [];
    }),
  );
}

test("rotation, skew, reflection and nonuniform scale preserve each frame and sprite stacking", () => {
  const transforms = [identity,
    { a: 0, b: 1, c: -1, d: 0, tx: 8, ty: 9 },
    { a: 1, b: 0.25, c: 0.5, d: 2, tx: -3, ty: 2 },
    { a: -1, b: 0, c: 0, d: 0.5, tx: 5, ty: 6 }, identity];
  const alphas = [1, 0.5, 0.75, 1, 0];
  const input = video(transforms.map((t, i) => frame(t, alphas[i])), [
    { imageKey: "image", frames: transforms.map(() => frame(identity, 0.8)) },
  ]);
  const svg = buildLightweightSvg(input);
  assert.equal((svg.match(/data:image\/png;base64,/g) ?? []).length, 1);
  const expected = ["matrix(1 0 0 1 0 0)", "matrix(0 1 -1 0 8 9)",
    "matrix(1 0.25 0.5 2 -3 2)", "matrix(-1 0 0 0.5 5 6)"];
  for (let i = 0; i < transforms.length; i++) {
    const sampled = exportedSpritesAt(svg, (i + 0.5) / transforms.length);
    assert.deepEqual(sampled[0], i === 4 ? [] : [{ matrix: expected[i], opacity: alphas[i] }]);
    assert.deepEqual(sampled[1], [{ matrix: "matrix(1 0 0 1 0 0)", opacity: 0.8 }]);
  }
  assert.ok(!svg.includes("animateTransform"));
});

test("hidden frames, returning states, alpha threshold and frame-59 hold are correct", () => {
  const move = { ...identity, tx: 10 };
  const frames = Array.from({ length: 60 }, (_, i) =>
    frame(i >= 20 && i < 40 ? move : identity, i === 0 ? 0.049 : i < 5 ? 0.05 : 1));
  const svg = buildLightweightSvg(video(frames));
  for (let i = 0; i < 60; i++) {
    const sample = exportedSpritesAt(svg, (i + 0.25) / 60)[0];
    const expected = i === 0 ? [] : [{ matrix: i >= 20 && i < 40 ? "matrix(1 0 0 1 10 0)" : "matrix(1 0 0 1 0 0)", opacity: i < 5 ? 0.05 : 1 }];
    assert.deepEqual(sample, expected);
  }
  assert.deepEqual(exportedSpritesAt(svg, 1 - 1e-10)[0], [{ matrix: "matrix(1 0 0 1 0 0)", opacity: 1 }]);
  assert.deepEqual(exportedSpritesAt(svg, 0)[0], []);
});

test("layout scales matrix columns and ignores x/y, zero-sized images do not appear", () => {
  const t = { a: 0.5, b: 0.25, c: -0.25, d: 0.5, tx: 3, ty: 4 };
  const svg = buildLightweightSvg(video([
    frame(t, 1, { x: 100, y: 200, width: 2, height: 4 }),
    frame(t, 1, { x: 100, y: 200, width: 0, height: 4 }),
  ]));
  assert.deepEqual(exportedSpritesAt(svg, 0.25)[0], [{ matrix: "matrix(1 0.5 -1 2 3 4)", opacity: 1 }]);
  assert.deepEqual(exportedSpritesAt(svg, 0.75)[0], []);
});

test("static animation omits timing nodes; sparse changing transforms use linear memory", () => {
  const staticSvg = buildLightweightSvg(video(Array.from({ length: 60 }, () => frame())));
  assert.ok(!staticSvg.includes("<animate"));
  const count = 5000;
  const plan = getLightweightCompatibility(video(Array.from({ length: count }, (_, i) => frame({ ...identity, tx: i }))));
  assert.equal(plan.compatible, true);
  assert.equal(plan.spritePlans[0].states.length, count);
  assert.ok(plan.spritePlans[0].states.reduce((sum, state) => sum + state.points.length, 0) <= 3 * count);
});

test("mask, vector, matte, dynamic replacement and invalid geometry fail closed", () => {
  const cases = [
    video([{ ...frame(), clipPath: "M0 0L1 1" }]),
    video([{ ...frame(), maskPath: {} }]),
    video([{ ...frame(), shapes: [{}] }]),
    { ...video([frame()]), sprites: [{ imageKey: "image", matteKey: "mask", frames: [frame()] }] },
    { ...video([frame()]), dynamicElements: { image: {} } },
    video([frame({ ...identity, a: NaN })]),
    video([frame(identity, Infinity)]),
    { ...video([frame()]), frames: 0.5 },
    { ...video([frame()]), images: { image: 'data:image/png;base64," onload="alert(1)' } },
  ];
  for (const input of cases) {
    assert.equal(getLightweightCompatibility(input).compatible, false);
    assert.throws(() => buildLightweightSvg(input));
  }
});
