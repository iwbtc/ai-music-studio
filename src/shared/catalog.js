/**
 * AI 音乐工作室 — 共享目录表（唯一权威）。
 * 这里定义所有「插件」：合成器预设、鼓组、效果器类型，以及它们的参数规格。
 * Host（工具校验）与 Client（UI/音频引擎）都必须从这里读取，不得重复定义。
 */

/** 轨道配色（浅色主题友好；无深蓝/深紫）。 */
export const TRACK_COLORS = [
  '#F26B3A', // 珊瑚橙
  '#2FB58C', // 薄荷绿
  '#EFAE3C', // 琥珀
  '#E85D84', // 玫红
  '#4FA3A5', // 灰青
  '#8E9B5A', // 橄榄
  '#B08968', // 焦糖
  '#D98E5F', // 杏色
  '#7FC8A9', // 浅薄荷
  '#C9A227', // 芥末金
]

/** 音轨角色（用于 UI 标签与排序建议）。 */
export const TRACK_ROLES = [
  { id: 'drums', label: '鼓组', hint: '节奏骨架' },
  { id: 'bass', label: '低音', hint: '低频与律动' },
  { id: 'lead', label: '主音', hint: '旋律焦点' },
  { id: 'pad', label: '铺底', hint: '和声氛围' },
  { id: 'arp', label: '琶音', hint: '律动音型' },
  { id: 'keys', label: '键盘', hint: '和弦与色彩' },
  { id: 'fx', label: '音效', hint: '过渡与氛围' },
]

/** 十二平均律音名。 */
export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

/** 音阶定义：以半音为单位的相对音级。 */
export const SCALES = [
  { id: 'minor', label: '自然小调', steps: [0, 2, 3, 5, 7, 8, 10] },
  { id: 'major', label: '自然大调', steps: [0, 2, 4, 5, 7, 9, 11] },
  { id: 'dorian', label: '多利亚', steps: [0, 2, 3, 5, 7, 9, 10] },
  { id: 'phrygian', label: '弗里几亚', steps: [0, 1, 3, 5, 7, 8, 10] },
  { id: 'harmonicMinor', label: '和声小调', steps: [0, 2, 3, 5, 7, 8, 11] },
]

/** 参数规格：type='number' | 'enum' | 'bool'；group 用于 UI 分组。 */
export const SYNTH_PARAM_SPECS = {
  osc: { label: '波形', type: 'enum', options: ['saw', 'square', 'sine', 'triangle'], default: 'saw', group: '振荡器' },
  voices: { label: '叠层', type: 'number', min: 1, max: 9, step: 1, default: 5, group: '振荡器' },
  detune: { label: '失谐', type: 'number', min: 0, max: 1, default: 0.2, group: '振荡器' },
  sub: { label: '超低八度', type: 'number', min: 0, max: 1, default: 0.3, group: '振荡器' },
  fmRatio: { label: 'FM 比率', type: 'number', min: 0.5, max: 8, step: 0.1, default: 2, group: '振荡器' },
  fmAmount: { label: 'FM 深度', type: 'number', min: 0, max: 1, default: 0, group: '振荡器' },
  attack: { label: '起音', type: 'number', min: 0, max: 3, step: 0.001, unit: 's', default: 0.01, group: '包络' },
  decay: { label: '衰减', type: 'number', min: 0.01, max: 3, step: 0.01, unit: 's', default: 0.25, group: '包络' },
  sustain: { label: '延音', type: 'number', min: 0, max: 1, default: 0.5, group: '包络' },
  release: { label: '释音', type: 'number', min: 0.01, max: 3, step: 0.01, unit: 's', default: 0.25, group: '包络' },
  cutoff: { label: '截止', type: 'number', min: 80, max: 16000, step: 1, unit: 'Hz', default: 4200, group: '滤波' },
  resonance: { label: '共振', type: 'number', min: 0.1, max: 20, step: 0.1, default: 1.2, group: '滤波' },
  envAmount: { label: '包络量', type: 'number', min: 0, max: 1, default: 0.3, group: '滤波' },
  lfoRate: { label: 'LFO 速率', type: 'number', min: 0, max: 20, step: 0.01, unit: 'Hz', default: 0.2, group: '调制' },
  lfoAmount: { label: 'LFO 深度', type: 'number', min: 0, max: 1, default: 0, group: '调制' },
  drive: { label: '过载', type: 'number', min: 0, max: 1, default: 0.1, group: '输出' },
  level: { label: '电平', type: 'number', min: 0, max: 1, default: 0.75, group: '输出' },
  glide: { label: '滑音', type: 'number', min: 0, max: 0.5, step: 0.001, unit: 's', default: 0, group: '输出' },
}

/* ------------------------------------------------------------------------- */
/* P8：真实采样音色库（GeneralUser GS v1.471 SoundFont，GM Bank 0）             */
/* 用户反馈「代码合成音源辣耳朵」→ 插件库「乐器」只保留真实采样乐器。             */
/* P12：旧合成预设/合成鼓机已彻底移除（schemaVersion 2 clean break，不兼容旧工程文件）。 */
/* ------------------------------------------------------------------------- */

/**
 * 32 个真实采样乐器（GM Bank 0 程序号）。
 * soundfont.program = GeneralUser GS Bank 0 程序号；engine 用 SF2 采样发声。
 */
export const SAMPLED_INSTRUMENTS = [
  {
    id: 'grand_piano', name: 'Grand Piano', label: '三角钢琴', category: '键盘 Keys', color: '#F26B3A',
    desc: '真实采样的三角钢琴，力度有层次，适合主旋律与和弦。',
    // R0-10：响度归一基线（同力度单音实测 RMS 归一到 -18dBFS；单位 dB）
    gainDb: 10.5,
    soundfont: { program: 0, bank: 0 },
  },
  {
    id: 'bright_piano', name: 'Bright Piano', label: '亮音钢琴', category: '键盘 Keys', color: '#EFAE3C',
    desc: '明亮通透的采样钢琴，适合流行与欢快段落。',
    // R0-10：响度归一基线（同力度单音实测 RMS 归一到 -18dBFS；单位 dB）
    gainDb: 10.5,
    soundfont: { program: 1, bank: 0 },
  },
  {
    id: 'tine_epiano', name: 'Tine EP', label: '电钢琴', category: '键盘 Keys', color: '#C9A227',
    desc: '经典 tine 电钢琴采样，温暖带金属泛音，适合 R&B / 和弦。',
    // R0-10：响度归一基线（同力度单音实测 RMS 归一到 -18dBFS；单位 dB）
    gainDb: 1,
    soundfont: { program: 4, bank: 0 },
  },
  {
    id: 'harpsichord', name: 'Harpsichord', label: '羽管键琴', category: '键盘 Keys', color: '#B08968',
    desc: '巴洛克羽管键琴采样，清脆并发音短促，适合古典与复古编曲。',
    // R0-10：响度归一基线（同力度单音实测 RMS 归一到 -18dBFS；单位 dB）
    gainDb: 32.5,
    soundfont: { program: 6, bank: 0 },
  },
  {
    id: 'music_box', name: 'Music Box', label: '八音盒', category: '键盘 Keys', color: '#E85D84',
    desc: '八音盒采样，晶莹短促，适合点缀、前奏与童话氛围。',
    // R0-10：响度归一基线（同力度单音实测 RMS 归一到 -18dBFS；单位 dB）
    gainDb: 2,
    soundfont: { program: 10, bank: 0 },
  },
  {
    id: 'marimba', name: 'Marimba', label: '马林巴', category: '键盘 Keys', color: '#D98E5F',
    desc: '真实马林巴采样，木质敲击颗粒清晰，适合副旋律与琶音。',
    // R0-10：响度归一基线（同力度单音实测 RMS 归一到 -18dBFS；单位 dB）
    gainDb: 17.5,
    soundfont: { program: 12, bank: 0 },
  },
  {
    id: 'tonewheel_organ', name: 'Tonewheel Organ', label: '音轮风琴', category: '键盘 Keys', color: '#2FB58C',
    desc: '音轮风琴采样，持续稳定，适合 Soul / House 和弦铺陈。',
    // R0-10：响度归一基线（同力度单音实测 RMS 归一到 -18dBFS；单位 dB）
    gainDb: 1.5,
    soundfont: { program: 16, bank: 0 },
  },
  {
    id: 'nylon_guitar', name: 'Nylon Guitar', label: '尼龙吉他', category: '吉他 Guitar', color: '#B08968',
    desc: '尼龙弦古典吉他采样，柔和圆润，适合拉丁与抒情段落。',
    // R0-10：响度归一基线（同力度单音实测 RMS 归一到 -18dBFS；单位 dB）
    gainDb: 10,
    soundfont: { program: 24, bank: 0 },
  },
  {
    id: 'steel_guitar', name: 'Steel Guitar', label: '钢弦吉他', category: '吉他 Guitar', color: '#7FC8A9',
    desc: '钢弦原声吉他采样，明亮有弹性，适合流行扫弦与分解。',
    // R0-10：响度归一基线（同力度单音实测 RMS 归一到 -18dBFS；单位 dB）
    gainDb: 9,
    soundfont: { program: 25, bank: 0 },
  },
  {
    id: 'acoustic_bass', name: 'Acoustic Bass', label: '原声贝斯', category: '贝斯 Bass', color: '#4FA3A5',
    desc: '原声木贝斯采样，温暖厚实，适合爵士与抒情低音线。',
    // R0-10：响度归一基线（同力度单音实测 RMS 归一到 -18dBFS；单位 dB）
    gainDb: 13.5,
    soundfont: { program: 32, bank: 0 },
  },
  {
    id: 'finger_bass', name: 'Finger Bass', label: '指弹贝斯', category: '贝斯 Bass', color: '#8E9B5A',
    desc: '指弹电贝斯采样，颗粒清晰有律动，适合 Funk / Pop 低音。',
    // R0-10：响度归一基线（同力度单音实测 RMS 归一到 -18dBFS；单位 dB）
    gainDb: 9,
    soundfont: { program: 33, bank: 0 },
  },
  {
    id: 'violin', name: 'Violin', label: '小提琴', category: '弦乐 Strings', color: '#F26B3A',
    desc: '真实小提琴采样，长音带揉弦，适合旋律与副歌。',
    // R0-10：响度归一基线（同力度单音实测 RMS 归一到 -18dBFS；单位 dB）
    gainDb: 1.5,
    soundfont: { program: 40, bank: 0 },
  },
  {
    id: 'cello', name: 'Cello', label: '大提琴', category: '弦乐 Strings', color: '#8E9B5A',
    desc: '大提琴采样，低频饱满，适合低音旋律与情感铺陈。',
    // R0-10：响度归一基线（同力度单音实测 RMS 归一到 -18dBFS；单位 dB）
    gainDb: 3,
    soundfont: { program: 42, bank: 0 },
  },
  {
    id: 'strings_ensemble', name: 'Strings Ensemble', label: '弦乐合奏', category: '弦乐 Strings', color: '#7FC8A9',
    desc: '慢速弦乐合奏采样，长音有循环，适合铺底与氛围。',
    // R0-10：响度归一基线（同力度单音实测 RMS 归一到 -18dBFS；单位 dB）
    gainDb: 8,
    soundfont: { program: 49, bank: 0 },
  },
  {
    id: 'concert_choir', name: 'Concert Choir', label: '合唱', category: '合唱 Choir', color: '#E85D84',
    desc: '合唱团采样，人声和声氛围，适合 Break 与尾声。',
    // R0-10：响度归一基线（同力度单音实测 RMS 归一到 -18dBFS；单位 dB）
    gainDb: 3.5,
    soundfont: { program: 52, bank: 0 },
  },
  {
    id: 'trumpet', name: 'Trumpet', label: '小号', category: '铜管 Brass', color: '#EFAE3C',
    desc: '小号采样，明亮有冲击力，适合 Funk / 爵士与段落落点。',
    // R0-10：响度归一基线（同力度单音实测 RMS 归一到 -18dBFS；单位 dB）
    gainDb: 6.5,
    soundfont: { program: 56, bank: 0 },
  },
  {
    id: 'flute', name: 'Flute', label: '长笛', category: '木管 Woodwind', color: '#2FB58C',
    desc: '长笛采样，柔和通透，适合旋律点缀与空灵段落。',
    // R0-10：响度归一基线（同力度单音实测 RMS 归一到 -18dBFS；单位 dB）
    gainDb: 5.5,
    soundfont: { program: 73, bank: 0 },
  },
  {
    id: 'warm_pad', name: 'Warm Pad', label: '温暖 Pad', category: '铺底 Pad', color: '#D98E5F',
    desc: '温暖 Pad 采样，缓慢起音有循环，适合和声铺底。',
    // R0-10：响度归一基线（同力度单音实测 RMS 归一到 -18dBFS；单位 dB）
    gainDb: 5,
    soundfont: { program: 89, bank: 0 },
  },
  {
    id: 'vibraphone', name: 'Vibraphone', label: '颤音琴', category: '键盘 Keys', color: '#7C6BD6',
    desc: '颤音琴采样，金属音板带柔和余韵，适合爵士/氛围点缀。',
    // R5a：SF2 程序响度归一基线（同力度单音实测待 R5 E2E 校准）
    gainDb: -2,
    soundfont: { program: 11, bank: 0 },
  },
  {
    id: 'glockenspiel', name: 'Glockenspiel', label: '钟琴', category: '键盘 Keys', color: '#8E7CC3',
    desc: '钟琴采样，清脆高亢、衰减快，适合旋律点缀与童话感段落。',
    gainDb: 14.5,
    soundfont: { program: 9, bank: 0 },
  },
  {
    id: 'church_organ', name: 'Church Organ', label: '教堂管风琴', category: '键盘 Keys', color: '#6B7B8C',
    desc: '教堂管风琴采样，宏大持续音，适合庄严铺底与圣咏和声。',
    gainDb: 17.5,
    soundfont: { program: 19, bank: 0 },
  },
  {
    id: 'jazz_guitar', name: 'Jazz Guitar', label: '爵士吉他', category: '吉他 Guitar', color: '#B5651D',
    desc: '爵士空心吉他采样，温暖圆润，适合爵士和弦与轻松旋律。',
    gainDb: 12.5,
    soundfont: { program: 26, bank: 0 },
  },
  {
    id: 'muted_guitar', name: 'Muted Guitar', label: '闷音吉他', category: '吉他 Guitar', color: '#8A5A2B',
    desc: '闷音吉他采样，短促干爽，适合 funk/流行切分节奏。',
    gainDb: 17.5,
    soundfont: { program: 28, bank: 0 },
  },
  {
    id: 'picked_bass', name: 'Picked Bass', label: '拨片贝斯', category: '贝斯 Bass', color: '#2E8B57',
    desc: '拨片电贝斯采样，颗粒清晰，适合摇滚与流行低音线。',
    gainDb: 18.5,
    soundfont: { program: 34, bank: 0 },
  },
  {
    id: 'fretless_bass', name: 'Fretless Bass', label: '无品贝斯', category: '贝斯 Bass', color: '#3CB371',
    desc: '无品贝斯采样，圆滑连奏带滑音感，适合 R&B/爵士。',
    gainDb: 6,
    soundfont: { program: 35, bank: 0 },
  },
  {
    id: 'synth_bass', name: 'Synth Bass', label: '合成贝斯', category: '贝斯 Bass', color: '#1E6F5C',
    desc: '合成贝斯采样，低频厚实稳定，适合电子与舞曲低音。',
    gainDb: -6.5,
    soundfont: { program: 38, bank: 0 },
  },
  {
    id: 'viola', name: 'Viola', label: '中提琴', category: '弦乐 Strings', color: '#9B4F96',
    desc: '中提琴采样，温暖略带鼻音，适合内声部与独奏旋律。',
    gainDb: 9.5,
    soundfont: { program: 41, bank: 0 },
  },
  {
    id: 'pizzicato_strings', name: 'Pizzicato Strings', label: '拨弦弦乐', category: '弦乐 Strings', color: '#C1548A',
    desc: '拨弦弦乐采样，短促有弹性，适合轻快节奏与配乐点缀。',
    gainDb: 19.5,
    soundfont: { program: 45, bank: 0 },
  },
  {
    id: 'voice_oohs', name: 'Voice Oohs', label: '人声 Oohs', category: '合唱 Choir', color: '#7A8FD6',
    desc: '合唱人声 Oohs 采样，柔和铺底，适合氛围与和声垫。',
    gainDb: 15.5,
    soundfont: { program: 53, bank: 0 },
  },
  {
    id: 'french_horn', name: 'French Horn', label: '法国号', category: '铜管 Brass', color: '#C28E2C',
    desc: '法国号采样，圆润宽厚，适合电影感旋律与和声。',
    gainDb: 27.5,
    soundfont: { program: 60, bank: 0 },
  },
  {
    id: 'trombone', name: 'Trombone', label: '长号', category: '铜管 Brass', color: '#D4A017',
    desc: '长号采样，明亮有冲击力，适合爵士大乐队与铜管齐奏。',
    gainDb: 7,
    soundfont: { program: 57, bank: 0 },
  },
  {
    id: 'clarinet', name: 'Clarinet', label: '单簧管', category: '木管 Woodwind', color: '#3A9E9E',
    desc: '单簧管采样，圆润通透，适合古典、爵士与木管独奏。',
    gainDb: 1.5,
    soundfont: { program: 71, bank: 0 },
  },
]

/* ------------------------------------------------------------------------- */
/* R5d：内置 subtractive 合成器（SYNTH_INSTRUMENTS，8 个）                      */
/* ------------------------------------------------------------------------- */

/** subtractive 合成器参数规格（wave 为枚举，其余数值夹紧/取整）。 */
export const SYNTH_INSTRUMENT_PARAM_SPECS = Object.freeze({
  wave: { type: 'enum', options: ['saw', 'square', 'sine', 'triangle'] },
  unison: { min: 1, max: 2, default: 1, round: 0 },
  detuneCents: { min: 0, max: 30, default: 0, round: 1 },
  subLevel: { min: 0, max: 1, default: 0, round: 2 },
  filterCutoff: { min: 100, max: 18000, default: 3000, round: 1 },
  filterQ: { min: 0.1, max: 20, default: 0.7, round: 1 },
  attack: { min: 0.001, max: 2, default: 0.005, round: 3 },
  decay: { min: 0.005, max: 2, default: 0.2, round: 3 },
  sustain: { min: 0, max: 1, default: 0.7, round: 2 },
  release: { min: 0.01, max: 4, default: 0.25, round: 3 },
  lfoRate: { min: 0.1, max: 12, default: 5, round: 1 },
  lfoDepth: { min: 0, max: 100, default: 0, round: 0 },
  level: { min: 0, max: 1, default: 0.8, round: 2 },
})

/** 8 个内置合成器音色（synthPreset 为默认参数）。 */
export const SYNTH_INSTRUMENTS = Object.freeze([
  {
    id: 'sub_bass', name: 'Sub Bass', label: 'Sub 贝斯', category: '合成器 Synth', color: '#1E6F5C',
    desc: '正弦波 + 低八度 Sub，低频厚实稳定，适合电子/嘻哈低音。',
    synthPreset: Object.freeze({
      wave: 'sine', unison: 1, detuneCents: 0, subLevel: 0.8,
      filterCutoff: 400, filterQ: 0.7, attack: 0.005, decay: 0.15, sustain: 0.8,
      release: 0.2, lfoRate: 5, lfoDepth: 0, level: 0.9,
    }),
  },
  {
    id: 'saw_lead', name: 'Saw Lead', label: '锯齿主音', category: '合成器 Synth', color: '#F26B3A',
    desc: '双锯齿失谐主音，明亮有穿透力，适合 EDM/流行 lead。',
    synthPreset: Object.freeze({
      wave: 'saw', unison: 2, detuneCents: 8, subLevel: 0.15,
      filterCutoff: 4500, filterQ: 2, attack: 0.01, decay: 0.3, sustain: 0.6,
      release: 0.35, lfoRate: 5, lfoDepth: 6, level: 0.8,
    }),
  },
  {
    id: 'square_lead', name: 'Square Lead', label: '方波主音', category: '合成器 Synth', color: '#EFAE3C',
    desc: '方波主音，复古游戏/芯片感，适合旋律与琶音。',
    synthPreset: Object.freeze({
      wave: 'square', unison: 1, detuneCents: 0, subLevel: 0.2,
      filterCutoff: 3200, filterQ: 1.5, attack: 0.005, decay: 0.2, sustain: 0.7,
      release: 0.25, lfoRate: 5, lfoDepth: 4, level: 0.75,
    }),
  },
  {
    id: 'supersaw', name: 'Supersaw', label: '超级锯', category: '合成器 Synth', color: '#8B5CF6',
    desc: '双锯齿大失谐 + 宽立体声，适合 trance/EDM 和弦与 lead。',
    synthPreset: Object.freeze({
      wave: 'saw', unison: 2, detuneCents: 20, subLevel: 0.1,
      filterCutoff: 6500, filterQ: 0.8, attack: 0.05, decay: 0.4, sustain: 0.7,
      release: 0.6, lfoRate: 0.5, lfoDepth: 8, level: 0.8,
    }),
  },
  {
    id: 'warm_pad', name: 'Warm Pad', label: '温暖 Pad', category: '合成器 Synth', color: '#C9A227',
    desc: '慢起音锯齿 Pad，柔和铺底，适合氛围与和声。',
    synthPreset: Object.freeze({
      wave: 'saw', unison: 2, detuneCents: 10, subLevel: 0.05,
      filterCutoff: 2200, filterQ: 0.6, attack: 0.6, decay: 0.8, sustain: 0.8,
      release: 2, lfoRate: 0.5, lfoDepth: 5, level: 0.75,
    }),
  },
  {
    id: 'pluck', name: 'Pluck', label: '拨弦合成', category: '合成器 Synth', color: '#10B981',
    desc: '短衰减拨弦合成音，适合 arp/节奏点与明亮旋律。',
    synthPreset: Object.freeze({
      wave: 'square', unison: 1, detuneCents: 0, subLevel: 0.1,
      filterCutoff: 2800, filterQ: 4, attack: 0.002, decay: 0.18, sustain: 0,
      release: 0.12, lfoRate: 5, lfoDepth: 0, level: 0.8,
    }),
  },
  {
    id: 'acid_bass', name: 'Acid Bass', label: 'Acid 贝斯', category: '合成器 Synth', color: '#06B6D4',
    desc: '高共振锯齿贝斯，带 squelch 感，适合 acid house/techno。',
    synthPreset: Object.freeze({
      wave: 'saw', unison: 1, detuneCents: 0, subLevel: 0.3,
      filterCutoff: 700, filterQ: 12, attack: 0.003, decay: 0.2, sustain: 0.35,
      release: 0.15, lfoRate: 4, lfoDepth: 0, level: 0.85,
    }),
  },
  {
    id: 'sine_keys', name: 'Sine Keys', label: '正弦键盘', category: '合成器 Synth', color: '#7A8FD6',
    desc: '纯净正弦键盘音，柔和圆润，适合旋律与和弦铺底。',
    synthPreset: Object.freeze({
      wave: 'sine', unison: 1, detuneCents: 0, subLevel: 0,
      filterCutoff: 5000, filterQ: 0.7, attack: 0.01, decay: 0.5, sustain: 0.8,
      release: 0.4, lfoRate: 5, lfoDepth: 3, level: 0.8,
    }),
  },
])

/** 按 id 查合成器音色（未知 undefined）。 */
export function findSynthInstrument(id) {
  return SYNTH_INSTRUMENTS.find((instrument) => instrument.id === id)
}

/** 对外「乐器」列表 = 32 个真实采样乐器（UI/工具/引擎读它；导出名保持不变）。 */
export const SYNTH_PRESETS = SAMPLED_INSTRUMENTS

/** 鼓组参数规格。 */
export const DRUM_PARAM_SPECS = {
  kickPitch: { label: '底鼓音高', type: 'number', min: 30, max: 80, step: 1, default: 48, group: '底鼓' },
  kickDecay: { label: '底鼓衰减', type: 'number', min: 0.1, max: 1.5, step: 0.01, unit: 's', default: 0.55, group: '底鼓' },
  kickDrive: { label: '底鼓过载', type: 'number', min: 0, max: 1, default: 0.2, group: '底鼓' },
  snareTone: { label: '军鼓音色', type: 'number', min: 0, max: 1, default: 0.45, group: '军鼓' },
  clapSpread: { label: '拍手宽度', type: 'number', min: 0, max: 1, default: 0.5, group: '拍手' },
  hatDecay: { label: '踩镲衰减', type: 'number', min: 0.01, max: 0.4, step: 0.005, unit: 's', default: 0.06, group: '踩镲' },
  drive: { label: '鼓组过载', type: 'number', min: 0, max: 1, default: 0.15, group: '输出' },
  level: { label: '电平', type: 'number', min: 0, max: 1, default: 0.8, group: '输出' },
}

/* ------------------------------------------------------------------------- */
/* P8：4 套 CC0 真实采样鼓机（用户可见的唯一鼓组）                              */
/* 采样文件见 assets/samples/LICENSES.md。                                     */
/* ------------------------------------------------------------------------- */

/** 对外「鼓组」列表 = 4 套真实采样鼓机（UI/工具/引擎读它）。 */
export const DRUM_KITS = [
  {
    id: 'smp_acoustic', name: 'Acoustic Kit', label: '原声采样鼓', category: '采样鼓机 Sampler Kit', color: '#B08968',
    desc: 'CC0 原声鼓采样：真实底鼓/军鼓/镲片/嗵鼓，适合流行与 Break。',
    // R0-10：响度归一基线（同力度单音实测 RMS 归一到 -18dBFS；单位 dB）
    gainDb: 1,
    params: { kickPitch: 48, kickDecay: 0.5, kickDrive: 0.1, snareTone: 0.5, clapSpread: 0.5, hatDecay: 0.06, drive: 0.08, level: 0.8 },
    samplerPieces: {
      kick: 'drum_bass_hard.flac', snare: 'drum_snare_hard.flac', clap: 'drum_snare_soft.flac', rim: 'elec_tick.flac',
      hat: 'drum_cymbal_closed.flac', openhat: 'drum_cymbal_open.flac', tomLow: 'drum_tom_lo_hard.flac', tomHigh: 'drum_tom_hi_hard.flac',
      crash: 'drum_cymbal_hard.flac', ride: 'ride_via.flac', perc: 'drum_cowbell.flac',
    },
  },
  {
    id: 'smp_electro', name: 'Electro Kit', label: '电子采样鼓', category: '采样鼓机 Sampler Kit', color: '#F26B3A',
    desc: 'CC0 电子鼓采样：808 底鼓、电军鼓、电子镲与打击，现代电子风。',
    // R0-10：响度归一基线（同力度单音实测 RMS 归一到 -18dBFS；单位 dB）
    gainDb: 7.5,
    params: { kickPitch: 46, kickDecay: 0.6, kickDrive: 0.3, snareTone: 0.4, clapSpread: 0.55, hatDecay: 0.05, drive: 0.18, level: 0.82 },
    samplerPieces: {
      kick: 'bd_808.flac', snare: 'elec_snare.flac', clap: 'elec_hi_snare.flac', rim: 'elec_tick.flac',
      hat: 'hat_zan.flac', openhat: 'elec_cymbal.flac', tomLow: 'elec_fuzz_tom.flac', tomHigh: 'elec_bong.flac',
      crash: 'elec_cymbal.flac', ride: 'elec_chime.flac', perc: 'elec_blip2.flac',
    },
  },
  {
    id: 'smp_lofi', name: 'Lo-Fi Kit', label: 'Lo-Fi 采样鼓', category: '采样鼓机 Sampler Kit', color: '#C9A227',
    desc: 'CC0 Lo-Fi 鼓采样：柔和底鼓/军鼓、噪点踩镲与黑胶刮擦，磁带感。',
    // R0-10：响度归一基线（同力度单音实测 RMS 归一到 -18dBFS；单位 dB）
    gainDb: 3,
    params: { kickPitch: 48, kickDecay: 0.55, kickDrive: 0.08, snareTone: 0.75, clapSpread: 0.4, hatDecay: 0.08, drive: 0.06, level: 0.78 },
    samplerPieces: {
      kick: 'drum_bass_soft.flac', snare: 'drum_snare_soft.flac', clap: 'sn_generic.flac', rim: 'elec_tick.flac',
      hat: 'hat_noiz.flac', openhat: 'drum_cymbal_soft.flac', tomLow: 'drum_tom_lo_soft.flac', tomHigh: 'drum_tom_hi_soft.flac',
      crash: 'drum_splash_hard.flac', ride: 'ride_tri.flac', perc: 'vinyl_scratch.flac',
    },
  },
  {
    id: 'smp_perc', name: 'Percussion Kit', label: '打击乐采样', category: '采样鼓机 Sampler Kit', color: '#4FA3A5',
    desc: 'CC0 打击乐采样：手鼓/Tabla/拍手/铃，适合世界风与过门。',
    // R0-10：响度归一基线（同力度单音实测 RMS 归一到 -18dBFS；单位 dB）
    gainDb: 2,
    params: { kickPitch: 50, kickDecay: 0.4, kickDrive: 0.2, snareTone: 0.5, clapSpread: 0.6, hatDecay: 0.05, drive: 0.12, level: 0.8 },
    samplerPieces: {
      kick: 'bd_zum.flac', snare: 'sn_zome.flac', clap: 'perc_snap.flac', rim: 'tabla_ke2.flac',
      hat: 'hat_tap.flac', openhat: 'drum_cymbal_pedal.flac', tomLow: 'tabla_ghe1.flac', tomHigh: 'tabla_na.flac',
      crash: 'drum_splash_soft.flac', ride: 'ride_tri.flac', perc: 'perc_bell.flac',
    },
  },
]

/** 采样鼓机 = DRUM_KITS。 */
export const SAMPLED_DRUM_KITS = DRUM_KITS

/** 标准 GM 鼓件，pitch 为 MIDI 音高。 */
export const DRUM_PIECES = [
  { id: 'kick', name: 'Kick', label: '底鼓', pitch: 36, key: 'C1', color: '#F26B3A' },
  { id: 'snare', name: 'Snare', label: '军鼓', pitch: 38, key: 'D1', color: '#EFAE3C' },
  { id: 'clap', name: 'Clap', label: '拍手', pitch: 39, key: 'D#1', color: '#E85D84' },
  { id: 'rim', name: 'Rim', label: '边击', pitch: 37, key: 'C#1', color: '#B08968' },
  { id: 'hat', name: 'Closed Hat', label: '闭镲', pitch: 42, key: 'F#1', color: '#2FB58C' },
  { id: 'openhat', name: 'Open Hat', label: '开镲', pitch: 46, key: 'A#1', color: '#7FC8A9' },
  { id: 'tomLow', name: 'Low Tom', label: '低嗵鼓', pitch: 45, key: 'A1', color: '#8E9B5A' },
  { id: 'tomHigh', name: 'High Tom', label: '高嗵鼓', pitch: 50, key: 'D2', color: '#C9A227' },
  { id: 'crash', name: 'Crash', label: '吊镲', pitch: 49, key: 'C#2', color: '#D98E5F' },
  { id: 'ride', name: 'Ride', label: '叮叮镲', pitch: 51, key: 'D#2', color: '#4FA3A5' },
  { id: 'perc', name: 'Perc', label: '打击乐', pitch: 60, key: 'C3', color: '#A88B6A' },
]

/** 效果器参数规格（每个 FX 类型自己的 schema）。 */
export const FX_PARAM_SPECS = {
  filter: {
    mode: { label: '模式', type: 'enum', options: ['lowpass', 'highpass', 'bandpass'], default: 'lowpass', group: '滤波' },
    cutoff: { label: '截止', type: 'number', min: 80, max: 16000, step: 1, unit: 'Hz', default: 2400, group: '滤波' },
    resonance: { label: '共振', type: 'number', min: 0.1, max: 20, step: 0.1, default: 3, group: '滤波' },
    mix: { label: '混合', type: 'number', min: 0, max: 1, default: 1, group: '输出' },
  },
  drive: {
    amount: { label: '失真量', type: 'number', min: 0, max: 1, default: 0.35, group: '失真' },
    tone: { label: '音色', type: 'number', min: 0, max: 1, default: 0.55, group: '失真' },
    mix: { label: '混合', type: 'number', min: 0, max: 1, default: 0.7, group: '输出' },
  },
  chorus: {
    rate: { label: '速率', type: 'number', min: 0.05, max: 8, step: 0.01, unit: 'Hz', default: 0.8, group: '调制' },
    depth: { label: '深度', type: 'number', min: 0, max: 1, default: 0.4, group: '调制' },
    mix: { label: '混合', type: 'number', min: 0, max: 1, default: 0.35, group: '输出' },
  },
  phaser: {
    rate: { label: '速率', type: 'number', min: 0.02, max: 8, step: 0.01, unit: 'Hz', default: 0.35, group: '调制' },
    depth: { label: '深度', type: 'number', min: 0, max: 1, default: 0.6, group: '调制' },
    mix: { label: '混合', type: 'number', min: 0, max: 1, default: 0.45, group: '输出' },
  },
  delay: {
    time: { label: '延迟时间', type: 'number', min: 0.02, max: 2, step: 0.001, unit: 's', default: 0.36, group: '延迟' },
    feedback: { label: '反馈', type: 'number', min: 0, max: 0.95, step: 0.01, default: 0.32, group: '延迟' },
    mix: { label: '混合', type: 'number', min: 0, max: 1, default: 0.25, group: '输出' },
    pingpong: { label: '乒乓', type: 'bool', default: true, group: '延迟' },
  },
  reverb: {
    size: { label: '空间', type: 'number', min: 0.1, max: 1, default: 0.62, group: '混响' },
    decay: { label: '衰减', type: 'number', min: 0.1, max: 1, default: 0.55, group: '混响' },
    damp: { label: '阻尼', type: 'number', min: 0, max: 1, default: 0.4, group: '混响' },
    preDelay: { label: '预延迟', type: 'number', min: 0, max: 120, step: 1, unit: 'ms', default: 20, group: '混响' },
    mix: { label: '混合', type: 'number', min: 0, max: 1, default: 0.3, group: '输出' },
  },
  bitcrush: {
    bits: { label: '位深', type: 'number', min: 1, max: 16, step: 1, default: 8, group: '降采样' },
    rate: { label: '采样率', type: 'number', min: 0.02, max: 1, step: 0.01, default: 0.5, group: '降采样' },
    mix: { label: '混合', type: 'number', min: 0, max: 1, default: 0.5, group: '输出' },
  },
  compressor: {
    threshold: { label: '阈值', type: 'number', min: -60, max: 0, step: 1, unit: 'dB', default: -18, group: '动态' },
    ratio: { label: '压缩比', type: 'number', min: 1, max: 20, step: 0.5, default: 4, group: '动态' },
    attack: { label: '起音', type: 'number', min: 0, max: 0.2, step: 0.001, unit: 's', default: 0.01, group: '动态' },
    release: { label: '释音', type: 'number', min: 0.02, max: 1, step: 0.01, unit: 's', default: 0.2, group: '动态' },
  },
  eq3: {
    low: { label: '低频', type: 'number', min: -18, max: 18, step: 0.5, unit: 'dB', default: 0, group: '均衡' },
    lowFreq: { label: '低频频率', type: 'number', min: 80, max: 800, step: 10, unit: 'Hz', default: 200, group: '均衡' },
    mid: { label: '中频', type: 'number', min: -18, max: 18, step: 0.5, unit: 'dB', default: 0, group: '均衡' },
    midFreq: { label: '中频频率', type: 'number', min: 300, max: 5000, step: 10, unit: 'Hz', default: 1000, group: '均衡' },
    midQ: { label: '中频 Q', type: 'number', min: 0.3, max: 8, step: 0.1, default: 1, group: '均衡' },
    high: { label: '高频', type: 'number', min: -18, max: 18, step: 0.5, unit: 'dB', default: 0, group: '均衡' },
    highFreq: { label: '高频频率', type: 'number', min: 2000, max: 16000, step: 50, unit: 'Hz', default: 8000, group: '均衡' },
  },
  // P11：高频架（给钢琴/弦乐提亮）
  highshelf: {
    freq: { label: '频率', type: 'number', min: 1000, max: 16000, step: 10, unit: 'Hz', default: 6000, group: '均衡' },
    gain: { label: '增益', type: 'number', min: -12, max: 12, step: 0.1, unit: 'dB', default: 4, group: '均衡' },
  },
  tremolo: {
    rate: { label: '速率', type: 'number', min: 0.2, max: 20, step: 0.1, unit: 'Hz', default: 4.5, group: '调制' },
    depth: { label: '深度', type: 'number', min: 0, max: 1, default: 0.5, group: '调制' },
  },
  autofilter: {
    rate: { label: '扫描速率', type: 'number', min: 0.02, max: 8, step: 0.01, unit: 'Hz', default: 0.25, group: '调制' },
    depth: { label: '扫描深度', type: 'number', min: 0, max: 1, default: 0.7, group: '调制' },
    cutoff: { label: '中心截止', type: 'number', min: 80, max: 12000, step: 1, unit: 'Hz', default: 2200, group: '滤波' },
    mix: { label: '混合', type: 'number', min: 0, max: 1, default: 0.8, group: '输出' },
  },
  // P5：新增 3 种调制类效果器
  flanger: {
    rate: { label: '速率', type: 'number', min: 0.05, max: 5, step: 0.01, unit: 'Hz', default: 0.4, group: '调制' },
    depth: { label: '深度', type: 'number', min: 0, max: 1, default: 0.7, group: '调制' },
    feedback: { label: '反馈', type: 'number', min: 0, max: 0.9, step: 0.01, default: 0.45, group: '延迟' },
    mix: { label: '混合', type: 'number', min: 0, max: 1, default: 0.5, group: '输出' },
  },
  ringmod: {
    frequency: { label: '频率', type: 'number', min: 20, max: 2000, step: 1, unit: 'Hz', default: 440, group: '调制' },
    mix: { label: '混合', type: 'number', min: 0, max: 1, default: 0.5, group: '输出' },
  },
  autopan: {
    rate: { label: '速率', type: 'number', min: 0.05, max: 8, step: 0.01, unit: 'Hz', default: 0.5, group: '调制' },
    depth: { label: '深度', type: 'number', min: 0, max: 1, default: 0.8, group: '调制' },
    mix: { label: '混合', type: 'number', min: 0, max: 1, default: 1, group: '输出' },
  },
}

/** 效果器 = 一个「效果插件」。 */
export const FX_TYPES = [
  { id: 'filter', name: 'Filter', label: '滤波器', category: '滤波', color: '#4FA3A5', desc: '低通/高通/带通滤波器，塑造音色明暗。' },
  { id: 'drive', name: 'Drive', label: '失真', category: '失真', color: '#F26B3A', desc: '软削波过载，增加能量与颗粒。' },
  { id: 'chorus', name: 'Chorus', label: '合唱', category: '调制', color: '#2FB58C', desc: '短延迟调制，让声音更宽更厚。' },
  { id: 'phaser', name: 'Phaser', label: '移相', category: '调制', color: '#EFAE3C', desc: '全通滤波扫频，产生相位漩涡。' },
  { id: 'delay', name: 'Delay', label: '延迟', category: '延迟', color: '#4FA3A5', desc: '反馈延迟，可乒乓，制造空间与节奏回声。' },
  { id: 'reverb', name: 'Reverb', label: '混响', category: '混响', color: '#7FC8A9', desc: '程序化生成脉冲响应，营造空间。' },
  { id: 'bitcrush', name: 'Bitcrush', label: '降采样', category: '失真', color: '#E85D84', desc: '位深与采样率降级，Lo-Fi 与数字质感。' },
  { id: 'compressor', name: 'Compressor', label: '压缩', category: '动态', color: '#8E9B5A', desc: '控制动态，让音色更紧实。' },
  { id: 'eq3', name: 'EQ 3', label: '三段均衡', category: '均衡', color: '#B08968', desc: '低/中/高三段增益调整。' },
  { id: 'tremolo', name: 'Tremolo', label: '颤音', category: '调制', color: '#EFAE3C', desc: '音量周期性起伏。' },
  { id: 'autofilter', name: 'Auto Filter', label: '自动滤波', category: '调制', color: '#2FB58C', desc: 'LFO 自动扫频滤波，制造律动。' },
  // P5：新增 3 种效果器
  { id: 'flanger', name: 'Flanger', label: '镶边', category: '调制', color: '#4FA3A5', desc: '短延迟被 LFO 调制 + 反馈，产生喷气式镶边扫频。' },
  { id: 'ringmod', name: 'Ring Mod', label: '环形调制', category: '调制', color: '#E85D84', desc: '正弦载波与信号相乘，制造金属／机器人音色。' },
  { id: 'autopan', name: 'Auto Pan', label: '自动声像', category: '调制', color: '#2FB58C', desc: 'LFO 自动左右摆动声像，增加宽度与动感。' },
  // P11：高频架（提亮钢琴/弦乐高频）
  { id: 'highshelf', name: 'High Shelf', label: '高频架', category: '均衡', color: '#8E9B5A', desc: '高架均衡，提升或削减高频，让钢琴/弦乐更亮或更柔。' },
]

/** 发送总线（固定两条）。 */
export const BUSES = [
  { id: 'reverb', name: '混响发送', label: 'Reverb Send', color: '#7FC8A9' },
  { id: 'delay', name: '延迟发送', label: 'Delay Send', color: '#4FA3A5' },
]

/** 全局上限（Host 校验使用）。 */
export const LIMITS = {
  maxTracks: 32,
  maxPatterns: 128,
  maxNotesPerPattern: 4096,
  maxClips: 512,
  maxSections: 32,
  maxEffectsPerTrack: 8,
  maxMasterEffects: 8,
  maxBpm: 200,
  minBpm: 40,
  maxBars: 256,
  maxHistory: 40,
}

/** 便捷查询（找不到时返回 undefined，由调用方报错）。 */
/** 在 32 个采样乐器里查找 preset（P12：不再回退旧合成预设）。 */
export const findSynthPreset = (id) => SYNTH_PRESETS.find((p) => p.id === id)
/** 在 4 套采样鼓机里查找 kit（P12：不再回退旧合成鼓机）。 */
export const findDrumKit = (id) => DRUM_KITS.find((k) => k.id === id)
export const findFxType = (id) => FX_TYPES.find((f) => f.id === id)
export const findDrumPiece = (pitch) => DRUM_PIECES.find((d) => d.pitch === pitch)
export const findRole = (id) => TRACK_ROLES.find((r) => r.id === id)
export const findScale = (id) => SCALES.find((s) => s.id === id)

/** 取某个 preset/kit/fx 的完整默认参数（规格默认值 + 预设覆盖）。 */
export function presetParams(preset) {
  const defaults = {}
  for (const [key, spec] of Object.entries(SYNTH_PARAM_SPECS)) defaults[key] = spec.default
  return { ...defaults, ...(preset?.params ?? {}) }
}

/* ------------------------------------------------------------------------- */
/* R0-10：采样预设/鼓机响度归一基线                                            */
/*                                                                            */
/* 测量方式：真实 SF2 采样经引擎离线渲染；每个 preset 在 C4、vel 0.8、2s 窗口  */
/* 下测 RMS，归一到 -18 dBFS 目标（harpsichord 等被 SF2 initialAttenuation      */
/* 严重衰减的音色需要较大正增益）；增益限制为预测峰值 ≤ -1dBFS 以免削波。       */
/* 单位 dB；未知 id/缺省 → 0（保持历史行为）。                                 */
/* ------------------------------------------------------------------------- */
export const PRESET_GAIN_DB_MIN = -24
export const PRESET_GAIN_DB_MAX = 36

function clampGainDb(value) {
  const db = Number(value)
  if (!Number.isFinite(db)) return 0
  return Math.max(PRESET_GAIN_DB_MIN, Math.min(PRESET_GAIN_DB_MAX, db))
}

/** 采样预设响度归一增益（dB）。参数可为 preset 对象或 id；未知 → 0。 */
export function presetGainDb(presetOrId) {
  const preset = typeof presetOrId === 'string' ? findSynthPreset(presetOrId) : presetOrId
  return clampGainDb(preset?.gainDb)
}

/** 采样预设响度归一线性倍数（10^(gainDb/20)）。 */
export function presetGainScale(presetOrId) {
  return Math.pow(10, presetGainDb(presetOrId) / 20)
}

/** 采样鼓机响度归一增益（dB）。参数可为 kit 对象或 id；未知 → 0。 */
export function kitGainDb(kitOrId) {
  const kit = typeof kitOrId === 'string' ? findDrumKit(kitOrId) : kitOrId
  return clampGainDb(kit?.gainDb)
}

/** 采样鼓机响度归一线性倍数。 */
export function kitGainScale(kitOrId) {
  return Math.pow(10, kitGainDb(kitOrId) / 20)
}

export function kitParams(kit) {
  const defaults = {}
  for (const [key, spec] of Object.entries(DRUM_PARAM_SPECS)) defaults[key] = spec.default
  return { ...defaults, ...(kit?.params ?? {}) }
}

export function fxDefaultParams(type) {
  const specs = FX_PARAM_SPECS[type] ?? {}
  const params = {}
  for (const [key, spec] of Object.entries(specs)) params[key] = spec.default
  return params
}

/** 参数值按规格做安全钳制/归一。返回 undefined 表示非法。 */
export function coerceParam(spec, value) {
  if (!spec) return undefined
  if (spec.type === 'number') {
    const n = Number(value)
    if (!Number.isFinite(n)) return undefined
    const clamped = Math.min(spec.max, Math.max(spec.min, n))
    return spec.step && spec.step >= 1 ? Math.round(clamped) : clamped
  }
  if (spec.type === 'bool') return value === true || value === 'true' || value === 1
  if (spec.type === 'enum') return spec.options.includes(value) ? value : undefined
  return value
}
