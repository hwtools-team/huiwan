# SVGA PNG序列导出器

单一用途的浏览器工具：把 SVGA 2.x 按原始画布、原始帧率和全部帧渲染为透明 RGBA PNG，并打包为 ZIP。

## 使用

1. 打开 <https://hwtools-team.github.io/huiwan/gift-processor-beta/>，或直接双击本目录中的 `index.html`。
2. 拖入或选择一个/多个 `.svga` 文件。
3. 确认大尺寸动画预览和文件信息。
4. 点击“生成并下载 PNG 序列”。

## 输出

- ZIP 文件名：`<SVGA原文件名>-png-sequence.zip`
- ZIP 内文件夹：`<SVGA原文件名>-png-sequence/`
- 帧文件：`000.png`、`001.png`…
- 尺寸：SVGA 原始画布
- 数量：SVGA 全部原始帧
- 像素：8-bit RGBA，保留透明通道

## 限制

- 只接受 SVGA 2.x。
- 单文件最大 50 MB。
- 单批最多 20 个。
- 单文件最多 300 帧。
- 处理全部在当前浏览器完成，不上传服务器。

## 内置依赖

- SVGA.Lite 2.1.1：SVGA 解析、预览与逐帧渲染。
- JSZip 3.10.1：PNG 序列 ZIP 打包。
