# AI 混音反馈工作流（v2.4）

## 先说明：AI 没有耳朵

本项目不包含音频识别模型，AI 不会真正“听”声音。它只能读取本地算法算出的指标：

- 峰值 / RMS / crest / 削波
- LUFS（K 加权）
- 频谱质心、6 段频段能量
- 立体声平衡、相关性
- 逐轨/分轨电平

这些指标能帮助发现“太响、太糊、太薄、左右失衡、削波”等问题，但不能替代人耳审美。

## 推荐循环

1. **粗调参数后**：`studio_quick_mix_check {fromBar, bars:1}`
   - 默认 1 小节、8kHz、无 stems；
   - 首次约 0.2–0.8 秒，同 revision 缓存约 15ms；
   - 用于快速看峰/削波/低频占比。
2. **需要看动态/泵感**：`studio_measure_live {fromBar, bars:1}`
   - UI 播放约 2 秒，按 50ms 采样 master/track RMS/peak；
   - 不改工程。
3. **需要频段/立体声/轨道平衡**：`studio_render_preview {fromBar,toBar,fast:true}` 或 `sampleRate:8000`，范围控制小一点。
4. **导出前**：只跑一次完整 `studio_render_preview`（44.1/48k，必要时 `includeStems:true`），确认最终质量。
5. **导出**：`studio_export`。

## 为什么 v2.4 之前慢

旧流程每次混音都做完整离线渲染：全采样率、多小节、可能带分轨/尾音，再编码 WAV/解码分析。单次 10s–1min，调十几次就很慢。

v2.4 增加 8k/1 小节的 draft 渲染、缓存和实时电平捕获，把单次反馈压到秒级；正式预览仍保留原质量逻辑。

## 注意

- draft/8k 结果只适合快速决策，不能作为最终音质结论。
- 插件参数自动化目前只驱动实时参数；冻结/导出使用静态参数快照。
- 快速检查需要桌面窗口运行；没有 UI 时缓存命中仍可返回，缓存未命中会中文报错并建议用 `studio_render_preview`。
