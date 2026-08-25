# 道具动效处理台 Beta

纯浏览器本地处理的道具动效工作台。批量导入文件后，可调整尺寸、缩放、帧率、时长、质量、Alpha 边缘柔化和静音，并输出为 WebP、APNG、GIF、MP4、VAP、双通道 MP4、SVGA 或 PNG 序列 ZIP。

> 请通过 <https://hwtools-team.github.io/huiwan/gift-processor-beta/> 使用。不要双击本地 `index.html`；`file://` 页面无法正常加载 ES Module、Web Worker 和 WebAssembly。

## 支持输入

- SVGA 2.x
- VAP v2 MP4（含 `vapc`）
- 双通道 MP4（文件名需包含 `dual` 或 `alpha`）
- 普通 MP4 / MOV / WebM
- 动态 WebP
- APNG / PNG
- GIF

## 处理引擎

- SVGA.Lite：SVGA 解析和逐帧渲染
- Browser `ImageDecoder`：GIF / WebP / APNG / PNG 动画帧解码
- FFmpeg.wasm 0.12.15 + core 0.12.10：尺寸、帧率、时长、音频和多格式编码
- Tencent VAP Web：VAP 透明预览
- protobuf.js + pako：SVGA 2.0 编码

## 测试版限制

- 单文件最大 50 MB，单批最多 20 个，合计最大 200 MB。
- 编解码任务串行执行，防止内存峰值过高。
- SVGA 逐帧输出最多 300 帧，不支持音频。
- PNG 序列只接受 SVGA，使用原始画布、原始帧率和全部帧；保留 RGBA 透明通道，以 `000.png`、`001.png`…命名并打包为 ZIP，最多 300 帧。
- VAP 输出按腾讯 VAP v2 RGB+Alpha 及 `vapc` 公开配置生成，必须用团队实际 Android/iOS/Web 播放器复验。
- 无 `vapc` 的双通道文件依赖文件名标记并默认左 RGB/右 Alpha。
- GIF 仅 256 色，不适合高精度半透明道具。
- 处理记录仅存于当前浏览器 IndexedDB，最多 12 条。

## 建议试用清单

1. 各选一个 SVGA、VAP、双通道 MP4、WebP、APNG和 GIF。
2. 分别测试 Contain、Cover 和 Stretch。
3. 测试 12/20/30 FPS 以及缩短时长。
4. 测试保留音频和移除音频。
5. 将 VAP 输出放到真实客户端播放器验证透明、帧率和音画同步。
6. 用不同背景检查 Alpha 边缘、黑边、白边和锹齿。
7. 记录输入/输出体积、处理时间、浏览器和设备信息。
