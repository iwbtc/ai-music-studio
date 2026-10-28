# v2.4.0 发布说明（AI 快速混音反馈）

发布日期：2026-10-26  
状态：stable（Windows x64）

## 背景

AI 无法真正“听”音频，原有 `studio_render_preview` 全质量离线渲染单次 10s–1min，混音循环十几轮非常慢。本版不宣称 AI 有听觉，而是把**客观反馈循环**压缩到秒级，并明确“快速草稿 → 正式终检”的流程。

## 新增

1. **`studio_quick_mix_check`（draft 秒级分析）**
   - 默认 1 小节、8000Hz、fast、无 stems/tail/sectionStats；
   - 复用预览渲染管线，返回 peak/rms/lufs/crest/clipping/stereoBalance/bandEnergyPct/centroid 等精简指标；
   - 同 revision 第二次起**缓存命中**（renderMs=0，墙钟约 15ms）；
   - 1 小节 8k 实测 render **约 175–354ms**（v2.3 full 同范围约 465ms 以上；实际工程越复杂差距越大）；
   - 不写工程、不占 undo、不 bump revision。
2. **`studio_measure_live`（实时电平）**
   - UI 播放 1–4 小节，按 50ms 采样 `engine.getMeters()`，返回 master/track RMS/peak/lufsApprox 聚合；
   - 约等于播放时长（1 小节 ≈2s@128BPM），不渲染 WAV，不改工程；
   - 无 UI/未解锁音频时中文错误。
3. **推荐 AI 混音流程**（写入 tests-report）
   - 改参 → `quick_mix_check`（1 小节 8k）看峰/削波/低频 → `suggest_mix`（draft 近似）；
   - 需要动态/泵感 → `measure_live`；
   - 需要频段/轨道平衡 → `render_preview`（fast/8k、多小节）；
   - 导出前仅一次 full preview（44.1/48k + stems）。

## 修复

- **首调静音竞态**：编辑工程后立即 quick check 可能用旧 project 渲染出 0；现在 preview/meter request 带 `revision`，UI 等待 `/state` 同步（≤2s）后渲染；编辑后立即调用实测 peak 0.647/rms 0.142、175ms 非静音。
- no-window：缓存命中可直接返回；缓存 miss 返回中文错误并建议 `studio_render_preview`。

## 工具

112 个 `studio_*`（110 应用 + 2 本地）；新增 quick_mix_check、measure_live。

## 验证

- 单测 **2407/2407**
- `v22-quick-mix` **10/10**：默认/首调非静音/缓存命中/miss/参数校验/速度对比/10 次 benchmark/无窗口/measure_live/unit
- 回归 P10/P1/P2/R5 **14/14**，console 0
- benchmark：quick 1 小节 8k ~175–354ms；同 revision 缓存 ~15ms；10 次调参总 261ms；同范围 full 44.1k 约 465ms（1.75x，复杂工程更高）
- 发布前 full 一次；正式 Setup-2.4.0

## 产物

- `dist/installer/AI音乐工作室-Setup-2.4.0.exe`
- `dist/AI音乐工作室-win32-x64/AI音乐工作室.exe`
- 保留旧 Setup 2.3.0/2.2.0/2.1.0/2.0.0/1.0.0。

## 限制

- AI 仍无真实听觉，quick/live 都是客观指标/近似 LUFS；不能替代人耳审美。
- quick draft 为 8k 近似，高频/瞬态/混响尾音细节不完整；最终用 full preview。
- 插件原生 GUI 仍未实现（见 `docs/VST3-NATIVE-GUI-PLAN.md`）。
