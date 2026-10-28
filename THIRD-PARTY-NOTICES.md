# 第三方组件与许可

本仓库原创代码以 MIT 发布；以下组件/资源保留各自许可。

## 运行时与界面

| 组件 | 许可 | 说明 |
|---|---|---|
| Electron 45 | MIT | 桌面窗口/Chromium/Node 运行时 |
| React / ReactDOM 18 | MIT | 界面 |
| esbuild | MIT | 构建工具（开发依赖） |
| @electron/packager | MIT | 打包工具（开发依赖） |

## 音频编码

| 组件 | 许可 | 说明 |
|---|---|---|
| lamejs 1.2.1 | LGPL-3.0 | MP3 编码；未修改源码。源码：https://github.com/zhuker/lamejs |
| libflacjs 5.6.0 | MIT | FLAC 编码；https://github.com/mmig/libflac.js |

## VST3

| 组件 | 许可 | 说明 |
|---|---|---|
| nvst3-host 0.3.1 | MIT | VST3 原生宿主；https://github.com/Henley04/nvst3-host |
| VST3 SDK（由 nvst3-host 内置/构建） | 以 nvst3-host 及其 SDK 许可为准 | 不在本仓库重新授权 |

## 音色与采样

### GeneralUser GS SoundFont

- 文件：`assets/soundfonts/GeneralUser.sf2`
- 作者：S. Christian Collins
- 许可：GeneralUser GS License v2.0（完整文本见 `assets/soundfonts/LICENSE-GeneralUser.txt`）
- 允许在软件项目中使用/修改/再分发，允许免费用作音乐创作（含商业作品）；不得单独作为音色库售卖。
- 官网：http://www.schristiancollins.com

### 鼓采样

- 目录：`assets/samples/`
- 来源：Sonic Pi 官方采样库（`etc/samples/`）
- 许可：CC0 1.0（公共领域），可自由使用/再分发
- 上游说明：https://github.com/sonic-pi-net/sonic-pi/blob/dev/etc/samples/README.md

## 安装包

- 7-Zip SFX 模块：LGPL + unRAR 限制条款；仅用于解压安装包。
- 官方许可：https://www.7-zip.org/license.txt
- 安装包还包含 Electron/Node 的第三方许可文件，随安装目录分发。

## 合规提示

- 再分发安装包时请保留本文件、`LICENSE`、GeneralUser 许可和 Electron/Node 许可文件。
- LGPL 组件（lamejs、7-Zip SFX）需要提供对应源码/替换方式；源码链接已列出。
- 本项目与 Image-Line / FL Studio 无关联。
