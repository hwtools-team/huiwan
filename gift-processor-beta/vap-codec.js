function readType(bytes, offset) {
  return String.fromCharCode(
    bytes[offset],
    bytes[offset + 1],
    bytes[offset + 2],
    bytes[offset + 3],
  );
}

function readUint32(bytes, offset) {
  return (
    bytes[offset] * 0x1000000 +
    (bytes[offset + 1] << 16) +
    (bytes[offset + 2] << 8) +
    bytes[offset + 3]
  );
}

function writeUint32(bytes, offset, value) {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

export function extractVapConfig(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);

  for (let offset = 0; offset + 8 <= bytes.length; ) {
    let size = readUint32(bytes, offset);
    const type = readType(bytes, offset + 4);
    let headerSize = 8;

    if (size === 1 && offset + 16 <= bytes.length) {
      const high = readUint32(bytes, offset + 8);
      const low = readUint32(bytes, offset + 12);
      size = high * 0x100000000 + low;
      headerSize = 16;
    } else if (size === 0) {
      size = bytes.length - offset;
    }

    if (size < headerSize || offset + size > bytes.length) break;

    if (type === "vapc") {
      const payload = bytes.slice(offset + headerSize, offset + size);
      const text = new TextDecoder().decode(payload);
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start >= 0 && end > start) {
        try {
          return JSON.parse(text.slice(start, end + 1));
        } catch (error) {
          console.warn("VAP 配置存在但 JSON 无法解析", error);
        }
      }
    }

    offset += size;
  }

  return null;
}

export function buildVapConfig({
  frames,
  width,
  height,
  fps,
  alphaX,
  alphaY = 0,
  videoWidth,
  videoHeight,
}) {
  return {
    info: {
      v: 2,
      f: frames,
      w: width,
      h: height,
      fps,
      videoW: videoWidth,
      videoH: videoHeight,
      aFrame: [alphaX, alphaY, width, height],
      rgbFrame: [0, 0, width, height],
      isVapx: 0,
      orien: 0,
    },
  };
}

export function appendVapConfig(mp4Bytes, config) {
  const payload = new TextEncoder().encode(JSON.stringify(config));
  const box = new Uint8Array(8 + payload.length);
  writeUint32(box, 0, box.length);
  box.set([0x76, 0x61, 0x70, 0x63], 4);
  box.set(payload, 8);

  const output = new Uint8Array(mp4Bytes.length + box.length);
  output.set(mp4Bytes, 0);
  output.set(box, mp4Bytes.length);
  return output;
}

export function vapDisplayMetadata(config) {
  const info = config?.info;
  if (!info) return null;
  return {
    width: Number(info.w) || 0,
    height: Number(info.h) || 0,
    fps: Number(info.fps) || 0,
    frames: Number(info.f) || 0,
    duration:
      Number(info.fps) > 0 && Number(info.f) > 0
        ? Number(info.f) / Number(info.fps)
        : 0,
  };
}
