# 采样音色库（assets/soundfonts）

本目录存放「AI 音乐工作室」使用的**真实采样乐器**（非代码合成）。

## GeneralUser.sf2

- 名称：**GeneralUser GS v1.471**（General MIDI SoundFont 2 音色库，269 个预设、864 个采样）
- 作者：S. Christian Collins
- 官网：http://www.schristiancollins.com
- 许可：GeneralUser GS License v2.0（见 `LICENSE-GeneralUser.txt`）——允许免费用作音乐创作、
  允许在软件项目中使用与修改/再分发；音色库内采样权利随音色库一并提供给音乐制作使用。
- 用途：本工作室取其中 **Bank 0 的 18 个 GM 程序**（钢琴/电钢/风琴/马林巴/吉他/贝斯/
  弦乐/合唱/小号/长笛/温暖 Pad 等）作为插件库的「乐器」，由 `src/client/audio/soundfont.js`
  解析 SF2 采样并按音高/力度/循环点实时演奏；实时播放与离线导出共用同一套采样。
- 版本：v1.471（npm 包 `generaluser@1.47.1` 内附，32MB 未压缩 SF2）。

## 解析器

`src/client/audio/vendor/soundfont2.cjs` 是 [soundfont2](https://github.com/Mrtenz/soundfont2)
v0.5.0 的浏览器构建（MIT 许可，见 `src/client/audio/vendor/LICENSE-soundfont2.txt`），
用于解析 SF2 的 RIFF 结构、预设/乐器/采样区与发生器参数。

## 采样鼓机

`assets/samples/` 内还保留 4 套 CC0 采样鼓机（39 个 FLAC，来自 Sonic Pi 采样库），
见 `assets/samples/LICENSES.md`。它们与 GeneralUser 的鼓组不重复，作为独立鼓组使用。

## 换用其它音色库

把 `.sf2` 文件放进本目录，并在 `src/shared/catalog.js` 的采样乐器定义里更新
`soundfont.file` 与 `program` 即可；请确认新音色库的许可证允许随本软件分发。
