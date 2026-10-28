## v2.4.0 — 2026-10-26（AI 快速混音反馈）

- 新增 studio_quick_mix_check：默认 1 小节/8000Hz/fast/no stems，1 小节 render 约 175–354ms；同 revision 缓存 ~15ms；不写工程/undo。
- 新增 studio_measure_live：UI 播放 1–4 小节，50ms 采样 master/track RMS/peak/lufsApprox，约 2s/小节，不改工程。
- 修复编辑后立即 quick 的静音竞态：preview/meter request 带 revision，UI 等待最新 state 后渲染。
- 工具 112（110 应用 + 2 本地）；单测 2407；v22-quick-mix 10/10、回归 14/14；发布前 full。
- AI 仍无真实听觉；quick/live 为客观指标近似，推荐“draft → full preview → 导出”流程。
## v2.3.0 — 2026-10-26（插件参数写回/预设/自动化）

- studio_set_plugin_parameter 支持 trackId/effectId，写回 	rack.vst3.params/effect.vst3.params，进 undo/redo；mergeKey 连续拖动合并一次撤销。
- 实时面板参数以工程为真源，50ms 节流写回 + 「已同步工程」；AI/工具改参实时同步、无音频重建。
- 插件工厂预设浏览/选择（program list）、state 保存/载入；新增 4 个预设/状态 AI 工具。
- 插件参数自动化：	rack.pluginAutomation、40ms tick、播放/seek/stop 恢复；新增 3 个自动化 AI 工具与 UI 曲线编辑。
- 工具 110（108 应用 + 2 本地）；单测 2262；v22-v23 11/11、回归 15/15。
- 原生插件 GUI 仍未嵌入，新增 docs/VST3-NATIVE-GUI-PLAN.md 方案。
## v2.2.0 — 2026-10-25（外部 VST3 插件）

- 新增外部 VST3 安装/扫描/托管/卸载与插件管理器：.vst3 文件/目录导入，托管到 data/plugins，卸载只删副本。
- 新增实时 VST3 效果器（轨 FX 链尾）：AudioWorklet + SharedArrayBuffer + 独立 Node sidecar，参数/旁路/延迟/underrun 状态；TAL-Reverb 实测 RMS 0.128598。
- 新增实时 VST3 乐器/MIDI：NoteOn/Off、CC、键盘试听、停止/静音；TAL-NoiseMaker params 2169、NoteOn RMS 0.154539。
- 新增冻结/导出：外部乐器轨/含 VST3 effect 的普通轨离线冻结 WAV，导出自动冻结；stale 检测与自动重冻；bars 2/4/8 hash/media 隔离。
- 新增插件状态持久化（stateBase64 ≤2MB/实例）与 missing 保留。
- 打包版内置 Node 24.19.0 runtime 与 sidecar，无需 PATH Node；preload/COOP/COEP 跨源隔离；tools 103。
- 单测 2089/2089；M1–M4 目标套件 4/4、5/5、5/5、6/6；发布前 full 一次。
# 更新日志（CHANGELOG）

> AI 音乐工作室 版本历史。日期为交付日期；详细验收记录见 `tests-report.md`，
> 各阶段契约见仓库根 `CONTRACT-*.md`。

## v2.1.0 — 2026-10-25（v2.1 维护版：P0 修复 + P1 清理）

**基于用户 `2.txt` 实测反馈的维护版**：不改变产品方向，集中修复「窗口遮挡导致预览/导出超时、
导出重复下载/多客户端重复渲染、subtractive 乐器名、effectId 冲突、音量自动化语义、未保存误报、
sectionStats 偏移、apply_mix 对自动化无效、导出/预览响度不一致、迁移响度提示」等 P0 问题，
并完成 endpoint mode、陈旧恢复锁、SKILL 文档、build-info 对齐 HEAD 等 P1 清理。

### P0 修复（用户反馈）

- **预览/导出超时（窗口遮挡/最小化）**：desktop 主进程禁用后台节流（`backgroundThrottling:false` +
  `webContents.setBackgroundThrottling(false)`）、`--disable-features=CalculateNativeWinOcclusion`、
  `powerSaveBlocker('prevent-app-suspension')`；host 预览超时默认 60s→**120s**（`AIMS_PREVIEW_TIMEOUT_MS`
  可配），超时错误明确「窗口被遮挡/最小化或渲染过慢」；≥32 小节大段预览自动 `fast(22050Hz)`
  （`AIMS_PREVIEW_AUTO_FAST_BARS` 可调）；预览串行队列超时后继续后续请求，不再 60s 硬卡死。
- **导出重复下载 / 多客户端重复渲染**：AI `studio_export` 默认 `silent`（`download:false`：只存盘 +
  toast 路径 + 打开文件夹），手动导出仍可下载；新增 `POST /studio/api/export-claim` 与
  `exportRequest.claimedBy/claimedAt`，多客户端只有首个 claim 渲染，其余只查进度/结果。
- **subtractive 乐器名错误**：合成器轨 `instrument.preset=null`，UI 按 `engine/synthPreset` 显示
  synth label（不再错误显示 Grand Piano 等采样乐器名）。
- **effectId 全局唯一**：master / 返回总线 / 轨道 / 组链共享同一 `fx_N` 命名空间；旧工程加载时
  `normalizeGlobalEffectIds` 自动重分配重复 id；场景/撤销/AI 变更日志不再歧义。
- **音量自动化语义**：改为 **`track.volume × automation` 乘算**（不再覆盖静态音量）；
  `studio_validate_project` 对「自动化首点与静态音量不一致」给出 warning。
- **未保存误报**：新增 `contentRevision` / `savedContentRevision`；activity/transport/exportRequest
  等 meta 更新不再增加内容版本，dirty 只由内容决定，保存后同步基线。
- **sectionStats 偏移**：`fromBar>0` 预览时 `sectionStats` 按预览起点相对计算（`beatToSeconds` 减起点）。
- **apply_mix 对自动化无效**：对带 volume 自动化的轨道按比例缩放曲线点或返回 warning，
  不再静默失败；`suggest_mix` 建议同样识别自动化。
- **导出响度/峰值与 preview 不同源**：导出使用与预览同源的真 K 加权分析，`exportStatus`/`lastExport`
  返回 `achievedLufs/peakDb/truePeak/gainDb/limited` 等指标（导出与 preview 偏差目标 <0.2dB）；
  `targetLufs` 生效并记录 achieved 值。
- **迁移响度削波提示**：旧工程加载/迁移做 headroom 检查，返回 `migrationWarnings`
  （「预设响度已归一化，请重新配平混音」；master/轨道音量 >0.9 时提示可能削波）。

### P1 清理（发布/维护）

- **`app-endpoint.json` mode**：Electron exe 写 `desktop-exe`，`node launch.mjs` 窗口版写 `window`
  （v2.0 及以前一律 `window`；现在 AI 桥/诊断可区分安装/便携 exe 与浏览器窗口版）。
- **陈旧 recovery 锁自动识别清理**：`session.lock` 对应进程已退出且无更新 autosave（或锁损坏）→
  启动时自动清理、不再重复误报「上次异常退出」；仍有可恢复 autosave → 保留并正常提示恢复；
  另一存活实例的锁 → 保留并提示（建议单实例运行）。新增 `cleanupStaleRecoveryLock()`。
- **build-info 对齐最终 HEAD**：`desktop/build-exe.mjs` 新增 `--require-clean`（工作区 dirty 时发布构建
  直接失败，不产生半成品），发布产物 `build-info.json` 为 `gitDirty:false`、`gitCommit=最终 HEAD`。
- **SKILL 文档更新**：`.dsh/skills/ai-music-studio/SKILL.md` 更新为 **92 工具**（90 应用 + 2 本地）、
  **32 采样乐器 + 4 采样鼓机 + 8 subtractive 合成器 + 15 效果器**、`schemaVersion=3`，
  补齐 R5–R8 新工具、托盘常驻、静默导出、schema 迁移等使用说明。

### 发布

- 版本 **2.1.0**（根/`desktop/package.json`、exe 版本资源、`build-info.json` channel=stable、安装包）；
  重建便携版与 `AI音乐工作室-Setup-2.1.0.exe`，**保留 Setup-2.0.0 / Setup-1.0.0** 与
  `dist/portable-2.0.0/`、`dist/portable-1.0.0/` 回滚备份（构建不覆盖旧安装包）。
- **数据兼容**：`schemaVersion=3` 不变；2.0.0/1.0.0 工程可直接打开；升级/回滚不删除
  `%APPDATA%\AI音乐工作室` 内工程/导出/媒体/设置（升级前建议备份 `data` 目录）。
- 验证：`v21-fixes` E2E（P0 九项）+ r1a-recovery 回归；pre-freeze full 通过；
  构建后跑 r7a-packaging-docs / r8-golden 校验 build-info↔Setup↔README 一致性；详见
  `RELEASE-v2.1.md`、`tests-report.md`。

### 已知限制（v2.1.0）

- 未代码签名（SmartScreen 首次提示）；无联网更新服务器/自动更新（仅本地 manifest 检查）、无遥测上传。
- 音频引擎仍为 Web Audio，**不支持 VST/ASIO**；stem separation、audio-to-MIDI、真实音频参考曲分析
  仍延后；多客户端主客户端选举/端口冲突提示仍为后续项（本版仅导出 claim）。
- 便携版必须整目录分发（exe 依赖同目录 Electron 运行库）；升级=覆盖安装目录/dist，数据在 `%APPDATA%`。

## v2.0.0 — 2026-10-25（R8：稳定化 + v2.0 正式发布）

**首个 v2.0 正式版**：不新增功能，完成 soak/长工程稳定性、黄金音频回归、安装/升级/回滚验证与发布文档。
版本号统一为 **2.0.0**（DSH 插件 `package.json`、Electron `desktop/package.json`、安装包、`build-info.json`
`channel=stable`）；重新构建便携版 exe 与 `AI音乐工作室-Setup-2.0.0.exe`，并保留 `Setup-1.0.0.exe` 与
`dist/portable-1.0.0/` 便携备份用于回滚。

### R0–R8 能力总览

- **DAW 核心（P1–P7）**：通道机架/播放列表/钢琴卷帘/混音台四视图；画音符、拖片段、撤销重做（100 步）、
  工程保存/打开、WAV/MIDI 导出；自动化曲线（音量/声像/滤波/弯音/调制/表情）、效果器链编辑、侧链压缩、
  分轨导出；步进音序器、电脑键盘演奏与录制、节拍器/吸附/量化；音频导入/录音、片段裁切/分割/fade/
  reverse/时间拉伸/变调/多 take；混音路由（Group bus、Pre/Post 发送、Mono/相位/Bypass/PDC、返回总线 FX、
  混音场景）；可调布局（拖宽/折叠/紧凑模式/记忆）。
- **AI 原生创作（R5d–R6e）**：真实采样音色库（32 乐器 + 4 鼓机 + 8 内置合成器音色）、工程模板与插件 SDK；
  `studio_generate_beat`/`generate_part`/`variation`/`generate_like_reference` 一键生成；混音建议
  `studio_suggest_mix`/`apply_mix`；参考曲分析；AI 变更日志与 Diff 面板；AI 音频级质量报告
  `studio_ai_quality_report`；当前 **92 个** `studio_*` 工具（90 应用 + 2 启动）。
- **数据与工程（R0–R4）**：schemaVersion=3（schema2 工程首次打开自动迁移并备份，schema1 冷备份不加载）；
  工程安全/恢复/doctor/指标、自动备份与命名工程版本历史（20 个）；片段编辑与 MIDI Learn；MIDI 导入导出往返。
- **安装/发布（R7–R8）**：7-Zip SFX 用户级安装包（`Install.ps1`/`Uninstall.ps1`，默认保留用户数据，
  HKCU 卸载项）；`build-info.json` → `studio_app_info`/`GET /health`/About；新手引导、帮助中心、
  设置/本地更新检查/诊断/命令面板；核心外壳 zh-CN/en-US 双语与无障碍；8 份合规/用户文档。

### R8 验证与交付

- 回归：**1780 单测**、**69/69 套 E2E**（新增 `r8-soak` 长工程稳定性 + `r8-golden` 黄金音频/
  安装升级回滚/发布文档）；`node scripts/verify.mjs --mode full --jobs 3` 在最终 SHA 只跑一次。
- `r8-soak`：空工程 append 4 次 `generate_beat`（32 小节/16 轨）、20 轮编辑/undo/redo/保存/打开/
  doctor/validate/AI 变更日志；`studio_get_metrics` 规模/内存/工具耗时在阈值内；导出 8 小节 WAV 成功。
- `r8-golden`：黄金工程（8 小节 house beat）导出两次 **maxDiff ≤1 int16 LSB**；kick 低频/hat 高频能量
  合理；安装 → 覆盖升级（用户数据标记保留）→ 卸载默认保留数据；`Setup-1.0.0.exe` 仍可回滚。
- 产物：`dist/AI音乐工作室-win32-x64/AI音乐工作室.exe`（2.0.0，238.23MB）与
  `dist/installer/AI音乐工作室-Setup-2.0.0.exe`（134.43MB）；PE/大小/哈希/版本资源见 `RELEASE-v2.0.md`。

### 已知限制（v2.0.0）

- 未代码签名：SmartScreen 首次运行需「更多信息 → 仍要运行」；无联网更新服务器、无自动更新
  （仅本地 `update-manifest.json` 检查）、无遥测上传。
- 音频引擎仍为 Web Audio（实时/离线渲染一致），**不支持 VST/ASIO**；stem separation、audio-to-MIDI、
  真实音频参考曲分析延后到 v2.1。
- 便携版必须整目录复制（exe 依赖同目录 Electron 运行库）；升级=覆盖安装目录/dist 文件夹，
  用户数据 `%APPDATA%\AI音乐工作室` 不动；卸载默认保留数据。
- 数据格式 schemaVersion=3 在 v2.0 不变；与保留的 1.0.0 安装包/便携备份数据兼容。

## v1.21 — 2026-10-24（R6e：AI 音频级质量评估 + 10 工程评估集）

- 新增 `studio_ai_quality_report`（只读）：输入 `render_preview` 的 analysis，输出 score/grade/
  metrics/findings/recommendations（响度/峰值削波/crest/立体声/频段/削波样本加权评分）。
- 新增 `scripts/evaluate-audio.mjs`：对 10 个固定 seed 的真实渲染分析做音频级评估，
  `pass = items=10 && clippingCount=0 && avgScore≥70`；固定输入可复现。
- 修复生成 beat 混音削波：`generate_beat`/`generate_like_reference` 空工程新建路径应用安全母带
  （master 0.77 + compressor -13/3.5/0.007/0.2）与 4 轨增益分级；实测 10/10 seed peak -1.76~-1.23dB、
  LUFS -14.10~-13.59、clipping 0。
- 明确 v2.1 延后项：stem separation、audio-to-MIDI、真实音频参考曲分析。

## v1.20 — 2026-10-24（R6d：参考曲风格分析 + 按参考生成）

- 新增 `studio_analyze_reference`（只读）：分析当前/已保存工程的结构、BPM、调式、轨道角色/音色、
  音符密度、鼓音高、效果器、发送量，返回 profile。
- 新增 `studio_generate_like_reference`：按参考 profile 生成 4 轨（drums/bass/chords/lead）、
  沿用 BPM/调式/音色/密度，支持 append、一次撤销。
- 工具数 87。

## v1.19 — 2026-10-24（R6c：AI 修改 Diff 面板 + 变更日志）

- 新增 AI 变更日志（最多 30 条）：每次 AI 写操作记录中文标题、前后 revision、轨道/pattern/clip/
  section/音符/BPM/长度 diff。
- 新增 `studio_get_ai_changes`（只读）与 `GET /ai-changes`。
- UI 新增「AI 修改」面板：接受/撤销/重做/关闭；修复面板遮挡键盘关闭按钮问题。
- 工具数 85。

## v1.18 — 2026-10-24（R6b：一键生成可用 beat + 10 工程评估集）

- 新增 `studio_generate_beat`：空工程一次调用生成 4 轨 + 4 pattern + 4 clip + section，
  支持 house/techno/lofi/pop/cinematic、bars/seed/bpm/key/scale 覆盖、空工程/追加、一次撤销。
- 新增 `scripts/evaluate-ai.mjs`：10 个固定 seed 的结构评估（音阶比例/GM 鼓/边界/结构完整度）。
- 工具数 84。

## v1.17 — 2026-10-24（R6a：AI 原生生成 + 混音 assistant）

- 新增确定性生成器（5 种 kind × 5 种 style）、`studio_generate_part` / `studio_generate_variation`。
- 新增 `studio_suggest_mix`（只读建议）与 `studio_apply_mix`（安全应用 + 一次撤销）。
- 工具数 83。

## v1.16 — 2026-10-24（R5d：内置 subtractive 合成器）

- 新增 8 个合成器音色与 `track.engine='subtractive'`、`synthPreset`/`synthParams`。
- 新增 `studio_update_synth`；16 复音（超出丢最旧），实时/离线/导出一致。
- UI 插件库新增「合成器」段与 synth 参数面板。
- 工具数 79。

## v1.15 — 2026-10-24（R5c：工程模板 + 插件 SDK 清单）

- 新增 5 个工程模板（空白/演示/电子/钢琴/歌曲）与 `studio_list_templates`；
  `studio_create_project`/`POST /projects/new` 支持 template。
- 新增插件 SDK 清单 `src/shared/plugins.js`（32 乐器 + 15 效果器 schema、序列化）、
  `studio_list_plugins` 与 `GET /plugins`。
- 工具数 78。

## v1.14 — 2026-10-24（R5b：采样器参数：包络/滤波/LFO）

- `track.instrumentParams`（attack/release/filterCutoff/filterQ/lfoRate/lfoDepth）+
  `studio_update_instrument`；实时/离线/导出应用包络、低通滤波与 LFO 揉音。
- UI 新增「乐器」参数面板（含重置/试听）。
- 工具数 76。

## v1.13 — 2026-10-24（R5a：音色库扩容 + 内容浏览器）

- 采样乐器 18 → **32**（新增 14 个 GeneralUser GS Bank 0 音色），程序号全唯一。
- 插件库新增搜索、分类 chips、收藏（localStorage）、仅收藏过滤、试听，显示 32/4/15 计数。
- 工具数不变 75。

## v1.12 — 2026-10-24（R0–R4：数据安全、片段编辑、乐理、混音路由）

- R0：数据/工具安全加固、混音判断修复、侧链触发音高过滤、demo 重配。
- R1：工程安全/恢复/doctor/指标、schema v3 前向兼容与 v2 迁移。
- R2：音频片段 fade/gain/reverse/split、WSOLA 时间拉伸/独立变调、多 take/叠录/comping。
- R3：乐理/和弦/琶音/Groove、CC lanes/Pitch Bend/Aftertouch、MIDI Learn 与完整 MIDI 往返。
- R4：Group bus 路由、Pre/Post 发送/Mono/相位/Bypass/PDC、实时电平表与混音场景、
  自动化模式 Read/Touch/Latch/Write。

## v1.11 — 2026-10-24（P14/P15：导入导出与交付）

- P14a：标准 MIDI 导入、工程版本历史（20 个）。
- P14b：MP3/FLAC 导出、参考曲 A/B、LUFS 目标响度。
- P15：录音设备选择、一键启动、桌面快捷方式、最终交付文档。

## v1.10 — 2026-10-24（P13：表情、EQ 与批量编辑）

- 表情控制、EQ 全参数、批量撤销、Master 默认链、播放提示。

## v1.9 — 2026-10-24（P12：数据格式与速度自动化）

- schema 2 不兼容旧文件（clean break）、速度曲线 tempoMap 与节拍网格同步。

## v1.8 — 2026-10-24（P10/P11：AI 创作闭环与钢琴表现力）

- P10：AI 预览/自检工具、增量编辑、工程管理、导出控制。
- P11：延音踏板、高频架 EQ、揉弦、导出历史、托盘常驻。

## v1.7 — 2026-10-24（P8：真实采样音色库）

- 移除合成音源，改用 GeneralUser GS SoundFont（18 采样乐器 + 4 采样鼓机），
  预置响度归一与真实采样播放。

## v1.6 — 2026-10-24（P7：可调布局）

- 左右栏/钢琴卷帘/混音台可拖宽、折叠、记忆布局，紧凑模式与窄屏适配。

## v1.5 — 2026-10-24（P6：音频片段裁切与分割）

- 音频片段左裁切 offset、播放头处分割、波形显示与拖动。

## v1.4 — 2026-10-24（P5：音源与效果器扩容）

- 12 合成器预设 + 3 鼓组 + 3 新效果器（Flanger/Ring Mod/Auto Pan），插件库统一卡片浏览。

## v1.3 — 2026-10-24（P3b：音频导入/录音）

- P3b-1 音频导入为音频轨/片段；P3b-2 麦克风录音到音频片段。

## v1.2 — 2026-10-24（P3a/P2c：演奏与步进音序器）

- P3a：电脑键盘演奏、录制、节拍器/吸附/量化。
- P2c：步进音序器（鼓型/音符步进编辑）。
- P2c-2：混音路由（发送量/返回总线电平/返回 FX 链）。

## v1.1 — 2026-10-24（P2a/P2b：自动化与混音）

- P2a：自动化曲线（音量/声像/滤波/弯音/调制/表情）。
- P2b：效果器链编辑、侧链压缩、分轨导出。

## v1.0 — 2026-10-24（首个可用版本）

- 独立窗口版 DAW（FL Studio 风格浅色界面），通道机架 + 播放列表 + 钢琴卷帘 + 混音台。
- 手动编辑：画音符、拖片段、撤销重做、工程保存/打开、导出 WAV/MIDI。
- AI 桥：DeepSeek Harness 的 `studio_*` 工具可直接操作工程；便携版 exe（Electron）。

---

> 版本号说明：v1.13–v1.21 对应 R5a–R6e 交付；R7 系列（安装包/版本信息/新手引导/合规文档）
> 随 v1.0.0 安装包对外发布，构建信息可在应用「帮助 → 关于」中查看。

## v1.22 — 2026-10-25（R7a：安装包 + 版本/构建信息 + 新手引导/帮助 + 合规文档）

- 新增 7-Zip SFX 自解压安装包（`desktop/build-installer.mjs` → `dist/installer/AI音乐工作室-Setup-<版本>.exe`），
  `Install.ps1`（用户级免管理员/快捷方式/HKCU 卸载项）与 `Uninstall.ps1`（默认保留用户数据）。
- 打包生成 `build-info.json`；`studio_app_info` 与 `GET /health` 返回 version/build；
  About 显示版本/提交/日期/Electron/平台。
- 新手引导（localStorage `aims:onboarding:v2`）+ 帮助中心 + 6 份合规/用户文档 + README 链接。
- 验证：1740 单测、R7a E2E 5/5、全量 65/65 套回归。

## v1.23 — 2026-10-25（R7b：设置 / 本地更新检查 / 诊断 / 命令面板）

- 设置对话框：stable/beta 通道、本地使用记录（opt-in，不上传）、崩溃报告开关、zh-CN/en-US 语言；
  保存到 `data/settings.json`，不改变工程 revision/撤销栈。
- 关于对话框「检查更新」：读取本地 update-manifest，显示 up-to-date / update-available / no-source / error。
- 帮助中心「导出诊断日志」：版本/构建/设置/工程规模/崩溃摘要，本地生成 .txt，不上传。
- 命令面板：`Ctrl/Cmd+K` 打开，过滤、上下键选择、Enter 执行、Esc 关闭；覆盖新建/打开/保存/导出/播放/撤销/重做/帮助/设置/关于。
- Host：settings/update-check/diagnostics 模块与路由；崩溃报告本机保留（≤20 条）；新增只读/设置工具。

## v1.24 — 2026-10-25（R7c：核心外壳中英文案 + 无障碍 + 更新/签名策略）

- 核心外壳 zh-CN/en-US 双语（主菜单/About/Help/Settings/Onboarding/命令面板/主要按钮/状态文案），
  设置切换即时生效并持久化；专业面板细项暂保留中文（文档注明）。
- 无障碍：所有对话框 role=dialog/aria-modal/aria-label、Esc 关闭、初始焦点、Tab 循环、焦点恢复；
  图标按钮 aria-label；命令面板 listbox/option + aria-activedescendant；prefers-reduced-motion 禁用大动画。
- 新增文档：`docs/UPDATE-AND-SIGNING.md`（v2.0 本地清单/无签名/SmartScreen/升级回滚/数据保留；
  v2.1 签名/自动更新/opt-in 计划）、`docs/ACCESSIBILITY.md`（键盘/焦点/对比度/缩放/限制）。
- 不新增工具（仍 92）；不联网、不上传、无代码签名。


