# AI 作曲指南（DeepSeek Harness Agent）

> 本文是给 DeepSeek Harness 里的 AI Agent / 进阶用户看的操作指南；普通用户手动编曲不需要读。

## AI 作曲指南 · AI Music Studio Composer Guide

本文件是给 **DeepSeek Harness 里的 AI Agent**（以及进阶用户）的创作手册：如何用 `studio_*` 工具
在这个工作站里做出像样的电子音乐。乐器是 **GeneralUser GS 真实采样音色库**（18 个采样乐器 +
4 套采样鼓机），加上 MIDI 音符数据与效果器；不再有代码合成的合成器预设。

> 给用户的小提示：在对话里说「按 docs/AI-COMPOSER-GUIDE.md 的流程创作」可以让 AI 读这份文件。

---

## 0. 先确认接线（每次新会话第一步）

1. 确认「AI 音乐工作室」桌面窗口已经打开（窗口没开时工具会直接报错，不会偷偷写后台数据）。
2. 调用 `studio_app_info`：
   - 看 `app.url` / `app.dataDir`：确认作品写到你正在看的那个窗口/工程；
   - 看 `instruments` / `drumKits`：拿合法的采样乐器/鼓机 id（如 grand_piano、finger_bass、
     strings_ensemble、smp_acoustic），`studio_add_track` 的 preset/kit 以它为准；
   - 看 `project.title` / `project.revision`：确认当前工程。
3. 然后再按下面的流程创作。

## 1. 标准创作流程（每次创作都按这个顺序）

1. `studio_app_info` → 确认窗口/工程与合法音色 id。
2. `studio_get_project` —— 先看清当前工程（有没有 demo、BPM/调性/已有轨道/pattern/编排）。
   - 用户说「新建一首」：`studio_create_project`（会清空，谨慎；先确认用户意图）。
   - 用户说「在现有基础上改」：不要 create，直接增量修改。
3. **构思**（先想完再动手，能少走弯路）：
   - 风格 / BPM / 调性 / 小节数 / 段落结构；
   - 配器清单（鼓、bass、chord/pad、lead、arp、fx 各一轨通常足够）；
   - 和弦进行（见 §4）。
4. `studio_add_track` × N —— 每轨从 `studio_app_info` 的列表选 preset/kit 与 role；返回 trackId 记下来。
5. `studio_add_pattern` × N —— 建议：鼓一条、bass 一条、chord/pad 一条、lead 一条、arp 一条，
   按段落再复制变体（Intro/Build/Drop/Break 各一套鼓/lead 是常见做法）。
6. `studio_set_notes` —— 往每个 pattern 写音符（§5–§7 有模板）。**写完一个 pattern 就检查一次**：
   音符 start 必须 < lengthBars×4 beat，否则循环时会丢音。
   改已有 pattern 时优先用 `studio_edit_notes`（加/删/改/移调/力度/量化/人性化，一次撤销），
   不要为改一个音符重写整段。
7. `studio_set_arrangement` —— 一次性写 clips（每条轨道在哪些小节用哪个 pattern、循环多长）+
   sections（段落标签，给 UI 用）；局部改片段用 `studio_edit_clips`。
8. **自检与试听**：`studio_validate_project` 查越界/空轨/静音/重复效果器等问题 →
   `studio_render_preview {fromBar,toBar,tailSeconds,includeStems,soloTrackIds,fast,includeSectionStats}` 拿真 K 加权 lufs、stereoBalanceDb/correlation、spectralCentroidHz、bandEnergyPct、sectionStats、峰值/RMS/削波/分轨电平，
   判断削波、段落起伏、尾音是否被切；有问题改音量/效果器/编排再预览。
9. `studio_update_track` / `studio_add_effect` —— 调音色与效果器（§8）。
10. `studio_transport play` —— 让用户听到。建议先 `stop` 再 `play` 从头试听。
11. 根据用户反馈迭代（改音符→改编排→改音色），每次大改后 `studio_set_activity` 说明在做什么。
12. 工程管理：`studio_save_project` / `studio_list_projects` / `studio_open_project`；
   用户满意后 `studio_export` 导出 WAV（可用 `tailSeconds` 保留尾音、`normalize` 归一化、`name` 定名）。
13. 钢琴/弦乐表现力：`studio_set_sustain`（踏板曲线 0/1 点）、`studio_set_vibrato`（揉弦）、
   `studio_add_effect {type:'highshelf', params:{freq:6000,gain:6}}`（提亮）、reverb `preDelay`；
   `studio_get_project {includeNotes:true}` 可一次拿到全部音符。
14. 速度变化（渐慢/rubato）：`studio_set_tempo_map {points:[{beat,bpm}]}`，`studio_clear_tempo_map` 恢复常量；
   导出/播放头/MIDI 都按速度积分。
15. 表情与混音：`studio_set_automation` 支持 pitchBend（半音）/modulation（揉弦深度）/expression（表情/aftertouch）；
   EQ3 支持 lowFreq/midFreq/midQ/highFreq；多步编辑用 `studio_batch`（一次撤销，≤200 op，支持建轨/建 pattern）；新空工程 master 链为空。
   表情自动化在**音符起始采样**，不做音符内连续弯音。
16. 导出/参考曲：`studio_export {format:'mp3'|'flac'|'wav', tailSeconds, normalize, name, targetLufs}`；
   `studio_import_reference {path}` 导入参考曲，UI 的 A/B 按钮切参考/工程；MP3 编码依赖 lamejs（LGPL，见 THIRD-PARTY-NOTICES.md）。
17. 窗口没开时先调 `studio_launch_app` 启动 exe；录音设备在工具栏下拉选择（记忆到 localStorage）。
18. 侧链触发过滤：`studio_set_sidechain {trackId,sourceTrackId,triggerNotes:[36]}` 只让底鼓(36)触发 duck；`[]`=任意音符；工具单数用 `triggerNote:36`，`/edit` 也用同一字段；Mixer UI 可填「触发音高」。
19. 工程恢复/诊断：异常退出后先 `studio_get_recovery`，需要时 `studio_restore_recovery`（先备份当前）；引用/越界/媒体问题用 `studio_doctor_project {repair:true}`；性能用 `studio_get_metrics`，基准 `node scripts\bench.mjs`。
20. 音频片段：`studio_update_audio_clip {clipId,gainDb,fadeInSeconds,fadeOutSeconds,reverse,stretchRatio,semitones,offsetSeconds,startBar,lengthBars}` 调电平/淡变/反向/拉伸/变调（ratio 0.25–4、semitones ±12）；`studio_split_audio_clip {clipId,atBar}` 按 tempo/ratio 分割（左 fadeIn/右 fadeOut，默认无 crossfade）；UI 右键音频 clip「音频属性…」。
21. 多 take/叠录：TransportBar「叠录」同位置录音自动加入同一 takeGroup；studio_set_take_active {takeGroup,takeIndex} 切换 active；split 后各段可分别选 take 做 comping；「监听」开关低增益监听输入。
22. 乐理/作曲：studio_get_theory 看 key/scale/级数；studio_write_chords 写 I-V-vi-IV；studio_generate_arp 生成琶音；studio_apply_groove 加 swing/MPC groove；PianoRoll「乐理」popover 可直接插入。
23. CC/控制器：自动化面板可画 CC1 调制/CC11 表情/CC64 延音/CC74 亮度；MIDI 导入导出含 CC、pitch bend、aftertouch；CC64 仅数据（听感用延音踏板），CC74 在无 cutoff 曲线时驱动滤波。
24. MIDI Learn：KeyboardPanel 8 槽点「学习」后发 CC 绑定；可映射音量/声像/发送/效果参数；studio_set_midi_mapping/clear/list 管理；完整 MIDI 导入导出含 CC/pitch bend/tempo。
> 注意：当前 `schemaVersion=3`；schema2 工程首次打开会自动迁移（原文备份到 `data/migrations/`），schema1 仍不兼容（冷备份到 `data/legacy-v1/`，不加载）。

> 进度反馈：每一两个阶段调用一次 `studio_set_activity`（短句，有画面感），用户在 UI 上能看到
> 「AI 正在创作」的实时动态。

---

## 2. 数据约定（写音符前必读）

- 时间单位 **beat**：1 小节 = 4 beat；16 分音符 = 0.25 beat；8 分 = 0.5；4 分 = 1。
- `pattern.lengthBars` 是循环长度（常用 4 或 8 小节）；`clip.lengthBars` 是它在播放列表里的长度，
  pattern 会**循环平铺**到 clip 长度。
- `notes: [{ pitch, start, dur, vel }]`：`vel` 0–1（默认 0.8），`dur` 必须 > 0。
- 鼓轨用 **GM 音高**（UI 会把它们显示成鼓件名）：

  | 音高 | 36 | 38 | 39 | 37 | 42 | 46 | 45 | 50 | 49 | 51 |
  |---|---|---|---|---|---|---|---|---|---|---|
  | 鼓件 | 底鼓 | 军鼓 | 拍手 | 边击 | 闭镲 | 开镲 | 低嗵 | 高嗵 | 吊镲 | 叮叮镲 |

- `studio_set_notes` 是**整段替换**：改一个 pattern 前先 `studio_get_pattern` 看清原音符，
  否则容易把已写好的内容覆盖掉。
- `studio_set_arrangement` 的 `clips` 也是**整体替换**；sections 省略则保留原段落。
- 每轨 `volume` 0–1；`pan` −1（左）~1（右）；`sends.reverb/delay` 是发送量 0–1。

---

## 3. 电子音乐编曲结构模板（32 小节，4/4）

| 小节 | 段落 | 配器 |
|---|---|---|
| 0–8 | Intro | pad/arp/鼓的 hats 或 ride，不要全奏；可只有 pad + arp |
| 8–16 | Build | 加鼓（4-on-floor）、bass、chord stab；最后一小节军鼓 16 分滚奏 + 滤波打开 |
| 16–24 | Drop | 全奏：鼓 + bass + lead + chord + arp；鼓最满、bass 最实 |
| 24–28 | Break | 撤鼓或半速，pad/lead 长音，加 fx，制造呼吸 |
| 28–32 | Drop 2 | 回到全奏，可加亮点（高八度 lead、加花鼓、更多混响） |

- 16 小节版：Intro 4 / Build 4 / Drop 4 / Break 2 / Drop 2 2。
- 64 小节版：每个段落 ×2，第二个 Drop 加新音色/新旋律变体。
- 段落之间要有「进入感」：crash（49）、riser（fx 轨长音 + 上行音阶或滤波）、滚奏（16 分军鼓）。

---

## 4. 和弦与音阶

- 调性由 `studio_create_project` 的 `key`/`scale` 决定（默认 F# 小调）。常用小调进行（以 i 级为根）：
  - i – VI – III – VII（史诗/lift 感）→ F#m / D / A / E
  - i – VII – VI – VII（循环推进）→ F#m / E / D / E
  - i – iv – VII – III（暗色）→ F#m / Bm / E / A
  - i – VI – iv – V（流行电子）→ F#m / D / Bm / C#
- 写法和弦：把三和弦音（根/三/五）同时放进 pattern 的同一 start，`dur` 按需要（pad 用 3.8，stab 用 0.2）。
- Lead 旋律以和弦音为骨架，再填音阶内的经过音；动机 4 小节重复 + 变体即可。

---

## 5. 鼓组模板（以 4 小节 pattern 为例，鼓轨）

**4-on-floor（House/Techno/Drop）**
- 底鼓 36：每拍 1 个，`start = bar*4 + 0/1/2/3`，`dur 0.24`，`vel 0.95`；
- 军鼓 38 / 拍手 39：每小节第 2、4 拍（`+1`、`+3`），`vel 0.85/0.5`；
- 闭镲 42：16 分或 8 分铺满（8 分 `vel≈0.4`，16 分 `vel≈0.3` 交替）；
- 开镲 46：每拍的反拍（`+0.5`），`vel 0.25`；
- 每 8 小节第一拍加吊镲 49（`dur 1.2`）。

**Build**：底鼓保持 4-on-floor；前 3 小节军鼓 2/4 拍；最后 1 小节军鼓 16 分滚奏（vel 递增）。

**Break / Half-time**：底鼓 0 和 2.5，军鼓在第 3 拍（`+2`），hats 稀疏。

**DnB / Breakbeat**：底鼓 0、`+2.5`；军鼓 `+1`、`+3`；hats 16 分；速度 170+。
（用 `studio_update_track` 换 `smp_electro` 鼓组 + `studio_create_project` 的 BPM 175。）

---

## 6. 低音模板

- **Reese / Deep Bass（Drop）**：每小节根音在 `0`（`dur 0.7`）、`1.5`、`2.5`，再加一个 `+12` 八度
  在 `3.25`；`vel 0.9`。和弦换根音时按小节更换。
- **Roll（Build）**：8 分音符 8 个，每 2 个换八度（根/根+12），`dur 0.32`。
- **Acid**：16 分音符跑动，`vel` 在 0.4–0.9 间变化，配合 filter/drive 效果器。
- 低音音符不要写太高（根音 MIDI 26–36 一带），与鼓的底鼓 808 音高错开避免打架。

---

## 7. 旋律 / 琶音 / 铺底

- **Lead（Supersaw）**：4 小节动机，以切分为主（0、0.5、1、2、2.5、3 这种），长音落在强拍；
  Drop 版本可以整体 +12 高八度、音符时值缩短到 0.3 增强能量。
- **Arp**：每小节 8 个 8 分音符，按和弦音循环（根-三-五-三 / 根-五-八度-五 等），
  `dur 0.42`，`vel` 交替 0.55/0.4。
- **Pad**：每小节一个完整和弦，`dur 3.85`，`vel 0.5` 左右；用 Warm Pad 或 Glass Pad。
- **Chord Stab**：反拍（`+0.5/1.5/2.5/3.5`）短促和弦，`dur 0.2`，`vel 0.4`。
- **FX（氛围）**：Break 用 Glass Pad 长音（`dur 7.6`，跨 2 小节）或高音和弦。

---

## 8. 音色与效果器

**乐器音色（真实采样）**：18 个采样乐器来自 GeneralUser GS（GM 程序号），用 `studio_app_info` 查 id。
常用配器：`grand_piano`（主音/keys）、`tine_epiano`（电钢）、`strings_ensemble`（铺底）、
`concert_choir`（氛围）、`finger_bass`/`acoustic_bass`（低音）、`marimba`（琶音）、
`nylon_guitar`/`steel_guitar`、`trumpet`/`flute`/`violin`/`cello` 按风格选用；
鼓组用 `smp_acoustic` / `smp_electro` / `smp_lofi` / `smp_perc`。
采样乐器没有「波形/叠层/截止」合成参数可调，塑形主要靠音量、发送量、EQ/压缩/调制类效果器。

**插入链建议（顺序有意义）**：Filter → Drive → 调制（Chorus/Phaser）→ 时值（Delay）→
空间（Reverb 一般放发送，不插干声）→ EQ → Compressor。

| 轨道 | 建议效果器 |
|---|---|
| 鼓组 | `compressor`（threshold -20 / ratio 5）→ `eq3`（low +2.5 / high +2） |
| 低音 | `eq3`（low +3 / high −2）→ `drive`（amount 0.25） |
| 主音 | `chorus`（mix 0.3）→ `delay`（mix 0.2, feedback 0.28, pingpong）→ `eq3`（mid +1.5） |
| 铺底 | `chorus`（mix 0.4）+ reverb 发送 0.35–0.4 |
| 琶音 | `delay`（8 分音符时间，mix 0.26）+ reverb 发送 0.25 |
| Master | `eq3`（low +1.5, mid −1, high +1）→ `compressor`（threshold −16, ratio 3） |

- 发送量：鼓 0.03–0.08，bass 0.02，lead 0.15–0.22，pad 0.35+，arp 0.2–0.25。
- 频段分配：底鼓 50–80Hz、bass 80–250Hz、pad/chord 250–2k、lead 1k–6k、hats 6k+；
  同类音色别都挤在中频。
- 音量基准：drums 0.8–0.85、bass 0.78–0.82、lead 0.6–0.7、pad 0.35–0.45、arp/chord 0.35–0.45、
  fx 0.3。master 默认 0.82 足够，不要拉满。

---

## 9. 常见错误清单

- 音符 `start` 超出 `lengthBars×4` → 循环时听不到（工具会返回 warning，但别依赖它）。
- clip 超出 `project.lengthBars` → 播放列表尾部被截断。
- 鼓轨用了非 GM 音高 → UI 显示为无名音高、声音可能怪。
- 所有轨道同时从头全奏 → 没有段落动态，听起来像 loop；一定要做 Intro/Build/Break。
- lead 和 pad 音区重叠打架 → pad 降低八度或减少音量。
- 效果器过度：每轨 2–4 个足够；reverb 过多会糊，delay 过多会乱。
- 一次改太多再听 → 分阶段改，每阶段 `studio_transport play` 试听。
- 忘记 `studio_set_activity` → 用户看不到 AI 在做什么。

---

## 10. 示例：一句话生成一首歌的完整工具序列

用户：「做一首 128 BPM F# 小调 Progressive House，32 小节，要有 Intro/Build/Drop/Break/Drop 2」

```
studio_app_info                            # 确认窗口/数据目录 + 18 采样乐器/4 鼓机 id
studio_get_project                         # 看现状
studio_create_project {title:"...", bpm:128, key:"F#", scale:"minor", lengthBars:32}
studio_add_track {name:"鼓组 · 原声采样鼓", kind:"drum", kit:"smp_acoustic", role:"drums"}
studio_add_track {name:"低音 · 指弹贝斯", kind:"synth", preset:"finger_bass", role:"bass"}
studio_add_track {name:"主音 · 三角钢琴", kind:"synth", preset:"grand_piano", role:"lead"}
studio_add_track {name:"铺底 · 弦乐合奏", kind:"synth", preset:"strings_ensemble", role:"pad"}
studio_add_track {name:"琶音 · 马林巴", kind:"synth", preset:"marimba", role:"arp"}
studio_add_track {name:"和弦 · 电钢琴", kind:"synth", preset:"tine_epiano", role:"keys"}
# 建 8~10 个 pattern：鼓 intro/build/drop/break、bass drive/roll、lead motif/drop/break、pad、arp、stab
studio_add_pattern {...} × N
studio_set_notes {patternId, notes:[...]}  × N   # 用 §3/§5/§6/§7 模板
studio_set_arrangement {clips:[...], sections:[
  {name:"Intro 前奏",startBar:0,lengthBars:8},
  {name:"Build 推进",startBar:8,lengthBars:8},
  {name:"Drop 高潮",startBar:16,lengthBars:8},
  {name:"Break 间奏",startBar:24,lengthBars:4},
  {name:"Drop 2 终章",startBar:28,lengthBars:4}]}
studio_update_track × N（音量/发送）
studio_add_effect × N（每轨 1–3 个）
studio_set_activity {text:"编排完成，正在试听 Drop 段落"}
studio_transport {action:"stop"} → studio_transport {action:"play", positionBar:0}
studio_export （用户确认后）
```

生成的工程在窗口数据目录（`studio_app_info` 的 `app.dataDir`）下，可备份/复用；`studio_get_pattern` 可随时取回音符继续改。


---

## 9. 批量脚本创作：直接用 tool-call 桥

当 DSH 工具列表不好调用、或要一次性生成整首曲时，可以直接 POST 到窗口后端的 tool-call 桥：

- 地址：`<studio_app_info 返回的 app.url>` + `/studio/api/tool-call`（默认 `http://127.0.0.1:41731`）
- 方法：`POST`
- Body：`{"name":"studio_xxx","args":{...}}`
- 返回：`{"ok":true,"result":{...}}` 或 `{"ok":false,"error":"...","result":{...}}`

示例（PowerShell）：

```powershell
$body = @{
  name = "studio_add_track"
  args = @{ kind = "synth"; preset = "grand_piano"; name = "钢琴"; role = "keys" }
} | ConvertTo-Json -Depth 6
Invoke-RestMethod -Uri "http://127.0.0.1:41731/studio/api/tool-call" -Method Post -ContentType "application/json" -Body $body
```

Node 示例（批量建轨 + pattern + 音符）：

```js
const call = async (name, args) => {
  const r = await fetch('http://127.0.0.1:41731/studio/api/tool-call', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, args }),
  })
  const j = await r.json()
  if (!j.ok) throw new Error(j.error || name + ' failed')
  return j.result
}

const { trackId } = await call('studio_add_track', { kind: 'synth', preset: 'grand_piano', role: 'keys' })
const { patternId } = await call('studio_add_pattern', { name: '钢琴', lengthBars: 4 })
await call('studio_set_notes', { patternId, notes: [{ pitch: 60, start: 0, dur: 1, vel: 0.8 }] })
```

注意：
- 不要绕过 `studio_validate_project` / `studio_render_preview`；批量写入后先自检。
- 写操作尽量一次成功；失败用 `studio_undo`/`studio_redo` 回滚，不要重复覆盖。
- 先 `studio_app_info` 确认端口/dataDir，避免连到旧实例。
- 大批量生成可先用 `studio_import_project_json` 一次写入整份工程，或 `studio_batch` 合并操作（≤200）。
- 导出用 `studio_export` 拿 jobId，`studio_export_status` 查进度；同名会自动改名，不覆盖。


## R6e：音频质量报告

1. 先运行 `studio_generate_beat` 或正常编曲，然后用 `studio_render_preview` 取得 analysis（含 lufs/peakDb/crestDb/stereoBalanceDb/correlation/bandEnergyPct/clipping 等）。
2. 调用 `studio_ai_quality_report {analysis}` 得到 0–100 分、A/B/C/D 等级、问题列表与可操作建议；只读，不改工程、不占撤销步。
3. 批量评估：把 10 个工程的 `{name,seed,analysis}` 写成 JSON，运行 `node scripts/evaluate-audio.mjs --input <file> --out <report>`，查看 `summary.pass/avgScore/clippingCount/gradeCounts`。
4. 评分口径：响度目标 ±2 LUFS、峰值/削波、crest 8–14dB、立体声平衡/相关、低频/高频能量；问题严重度只分 warn/info，不掩盖削波等真实问题。


## R7c：文档与支持（更新/签名/无障碍）

- 升级与回滚、本地更新清单、无代码签名与 SmartScreen、数据保留：见 [更新与签名策略](docs/UPDATE-AND-SIGNING.md)。
- 键盘路径/焦点/对比度/缩放/已知限制：见 [无障碍说明](docs/ACCESSIBILITY.md)。
- 用户手册与常见问题：[docs/USER-MANUAL.md](docs/USER-MANUAL.md)、[docs/FAQ.md](docs/FAQ.md)。
- 设置/更新/命令面板（R7b）：帮助 → 设置；Ctrl/Cmd+K 打开命令面板；关于 → 检查更新（本地 manifest，不联网）。
