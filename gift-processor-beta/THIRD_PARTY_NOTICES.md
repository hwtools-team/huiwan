# Third-party notices

This beta bundles the following browser-side runtimes so files can be processed locally.

- `@ffmpeg/ffmpeg` 0.12.15 — MIT — <https://github.com/ffmpegwasm/ffmpeg.wasm>
- `@ffmpeg/core` 0.12.10 — GPL-2.0-or-later — <https://github.com/ffmpegwasm/ffmpeg.wasm-core>
- FFmpeg — GPL build used by `@ffmpeg/core`; corresponding source is available from the upstream repositories above.
- `video-animation-player` 1.0.5 / Tencent VAP Web — MIT — <https://github.com/Tencent/vap>
- SVGA.Lite 2.1.1 — browser parser/player distributed with the existing team SVGA tools.
- `pako` — MIT; full license included in `vendor/pako-LICENSE.txt`.
- `protobuf.js` — BSD-3-Clause; full license included in `vendor/protobufjs-LICENSE.txt`.

The full GPL-2.0 text is included in `vendor/GPL-2.0.txt`. The VAP and ffmpeg.wasm MIT licenses are also included in the vendor directory.

All processing code in this beta runs in the user's browser. Bundled runtimes are loaded from the same GitHub Pages origin rather than from a third-party CDN.
