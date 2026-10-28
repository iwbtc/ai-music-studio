# AI 音乐工作室 · 第三方组件与许可证

> 版本：v1.0.0（2026-10-24）；随安装包/便携版一起分发。
> 仓库根 `THIRD-PARTY-NOTICES.md` 为精简版，本文件为完整清单。

## 1. 运行时与界面框架

| 组件 | 版本 | 许可证 | 用途/说明 |
|---|---|---|---|
| Electron | 45.0.0 | MIT | 桌面窗口与运行时（含 Chromium/Node.js）；完整许可证见 `LICENSE`/`LICENSES.chromium.html` |
| React / ReactDOM | 18.3.1 | MIT | 界面渲染 |
| esbuild | 0.25.10 | MIT | 构建时打包（仅开发依赖，不随应用分发） |
| @electron/packager | 20.3.0 | MIT | 构建时打包 exe（仅开发依赖） |

Electron 附带的 Chromium/Node.js 及其第三方组件适用各自许可证，详见安装目录
`LICENSE` 与 `LICENSES.chromium.html`。

## 2. 音频编码

### 2.1 lamejs（MP3 编码）

- 版本：`lamejs@1.2.1`；来源：https://github.com/zhuker/lamejs
- 许可证：**LGPL-3.0**（LAME 的 JavaScript 移植）
- 使用：仅在导出 MP3 时调用，未修改库代码。
- LGPL 合规：源码可从上游仓库或本仓库 `node_modules/lamejs/src/js/` 获取；
  应用以独立模块方式调用，用户可替换该模块版本（导出功能之外不受影响）。

### 2.2 libflacjs（FLAC 编码）

- 版本：`libflacjs@5.6.0`；来源：https://github.com/mmig/libflac.js
- 许可证：**MIT**；仅在导出 FLAC 时调用。

### 2.3 Web Audio 原生能力

滤波/失真/延迟/混响/压缩等效果器与合成器均为应用自研，基于浏览器 Web Audio API
（W3C 标准，无额外许可证要求）。

## 3. 音频内容：GeneralUser GS SoundFont

- 文件：`assets/soundfonts/GeneralUser.sf2`
- 作者：S. Christian Collins（GeneralUser GS）
- 来源/许可：见 `assets/soundfonts/LICENSE-GeneralUser.txt`；该 SoundFont 允许在音乐作品中
  免费使用与再分发（含商业作品），但不得单独作为音色库转售。
- 用于：32 个采样乐器与 4 个采样鼓机的音色播放。

## 4. 7-Zip 自解压模块（安装包）

- 安装包 `AI音乐工作室-Setup-*.exe` 使用 **7-Zip SFX**（`7z.sfx`）生成自解压安装程序；
- 7-Zip 许可证：**GNU LGPL** + **unRAR 限制条款**；官方说明：https://www.7-zip.org/license.txt
- SFX 模块仅用于解压安装文件，不修改 7-Zip 代码；安装包内附本说明。

## 5. 文档/字体

- 界面与文档使用系统自带字体（Microsoft YaHei 等），不内嵌第三方商用字体；
- 文档中的示例文本均为原创或通用描述。

## 6. 合规提示

- 本项目自身代码以 MIT 许可证发布（见仓库根 `LICENSE` 说明/`package.json`）。
- 如您再分发本应用：请保留本文件、`LICENSE`、Electron 的 `LICENSE`/`LICENSES.chromium.html`
  与 GeneralUser GS 许可文本，并遵守 LGPL（lamejs、7-Zip）的源码提供与替换要求。
- 有任何许可证疑问，请通过项目发布页反馈，我们会尽快补充/更正。
