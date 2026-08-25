const MAX_RENDERED_FRAMES = 300;

let movieEntityType;

function getMovieEntityType() {
  if (movieEntityType) return movieEntityType;

  const schema = {
    nested: {
      com: {
        nested: {
          opensource: {
            nested: {
              svga: {
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
                    oneofs: { args: { oneof: ["shape", "rect", "ellipse"] } },
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
                        values: { SHAPE: 0, RECT: 1, ELLIPSE: 2, KEEP: 3 },
                      },
                      ShapeArgs: { fields: { d: { type: "string", id: 1 } } },
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

  movieEntityType = protobuf.Root.fromJSON(schema).lookupType(
    "com.opensource.svga.MovieEntity",
  );
  return movieEntityType;
}

function canvasToPng(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) {
        reject(new Error("动画帧无法编码为 PNG"));
        return;
      }
      resolve(new Uint8Array(await blob.arrayBuffer()));
    }, "image/png");
  });
}

export async function parseSvgaFile(file) {
  const url = URL.createObjectURL(file);
  const parser = new SVGA.Parser({
    isDisableWebWorker: true,
    isDisableImageBitmapShim: false,
  });

  try {
    const video = await parser.load(url);
    return {
      video,
      metadata: {
        width: video.size.width,
        height: video.size.height,
        fps: video.fps,
        frames: video.frames,
        duration: video.fps ? video.frames / video.fps : 0,
      },
    };
  } finally {
    parser.destroy();
    URL.revokeObjectURL(url);
  }
}

export async function mountSvgaPreview(video, canvas, paused = false) {
  const player = new SVGA.Player({
    container: canvas,
    loop: 0,
    fillMode: "forwards",
    isUseIntersectionObserver: false,
  });
  await player.mount(video);
  if (paused) player.drawFrame(0);
  else player.start();
  return player;
}

export async function renderSvgaFrames(video, options = {}, onProgress = () => {}) {
  const sourceFps = Math.max(1, Number(video.fps) || 30);
  const outputFps = Math.max(1, Number(options.fps) || sourceFps);
  const sourceDuration = video.frames / sourceFps;
  const duration = Math.max(
    1 / outputFps,
    Math.min(Number(options.duration) || sourceDuration, sourceDuration),
  );
  const totalFrames = Math.min(
    MAX_RENDERED_FRAMES,
    Math.max(1, Math.ceil(duration * outputFps)),
  );

  const canvas = document.createElement("canvas");
  const player = new SVGA.Player({ container: canvas, loop: false });
  await player.mount(video);

  const frames = [];
  try {
    for (let index = 0; index < totalFrames; index += 1) {
      const time = index / outputFps;
      const sourceFrame = Math.min(
        video.frames - 1,
        Math.floor(time * sourceFps),
      );
      player.currentFrame = sourceFrame;
      player.drawFrame(sourceFrame);
      frames.push(await canvasToPng(canvas));
      onProgress((index + 1) / totalFrames);
      if (index % 4 === 3) await new Promise((resolve) => setTimeout(resolve, 0));
    }
  } finally {
    player.destroy();
  }

  return {
    frames,
    width: video.size.width,
    height: video.size.height,
    fps: outputFps,
    duration: totalFrames / outputFps,
  };
}

function transparentFrame(width, height) {
  return {
    alpha: 0,
    layout: { x: 0, y: 0, width, height },
    transform: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 },
    clipPath: "",
    shapes: [],
  };
}

function visibleFrame(width, height) {
  const frame = transparentFrame(width, height);
  frame.alpha = 1;
  return frame;
}

export function encodeSvgaFromFrames({ frames, width, height, fps }) {
  if (!frames.length) throw new Error("没有可编码的动画帧");
  if (frames.length > MAX_RENDERED_FRAMES) {
    throw new Error(`SVGA 测试版最多编码 ${MAX_RENDERED_FRAMES} 帧`);
  }

  const images = {};
  const sprites = frames.map((bytes, imageIndex) => {
    const key = `frame_${String(imageIndex).padStart(4, "0")}`;
    images[key] = bytes;
    return {
      imageKey: key,
      frames: frames.map((_, frameIndex) =>
        frameIndex === imageIndex
          ? visibleFrame(width, height)
          : transparentFrame(width, height),
      ),
    };
  });

  const entity = {
    version: "2.0",
    params: {
      viewBoxWidth: width,
      viewBoxHeight: height,
      fps: Math.round(fps),
      frames: frames.length,
    },
    images,
    sprites,
  };

  const type = getMovieEntityType();
  const encoded = type.encode(type.create(entity)).finish();
  return new Blob([pako.deflate(encoded)], {
    type: "application/octet-stream",
  });
}

export { MAX_RENDERED_FRAMES };
