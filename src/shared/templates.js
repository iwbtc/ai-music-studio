/**
 * R5c：工程模板（内容浏览器「工程模板」卡片）。
 *
 * - PROJECT_TEMPLATES：元数据（id/name/desc/bpm/key/scale/lengthBars/tracks 概览）；
 * - createProjectFromTemplate(id)：生成 schema3 工程（每次新对象，不共享引用）；
 * - 未知 id 抛中文错误（Host 工具/路由负责校验）。
 */
import { createEmptyProject, makeTrack, normalizeProject } from './model.js'
import { createDemoProject } from './demo.js'

/** 模板轨道描述（用于创建与 UI 展示）。 */
function trackSpec(name, kind, options = {}) {
  return { name, kind, ...options }
}

export const PROJECT_TEMPLATES = Object.freeze([
  {
    id: 'empty',
    name: '空白工程',
    desc: '从零开始：无轨道、128 BPM、F# 小调、32 小节。适合自由创作。',
    bpm: 128,
    key: 'F#',
    scale: 'minor',
    lengthBars: 32,
    tracks: [],
  },
  {
    id: 'demo',
    name: '演示工程',
    desc: '霓虹天际线：7 轨电子编曲、母带链、完整 pattern/编排，适合直接播放或拆解学习。',
    bpm: 128,
    key: 'F#',
    scale: 'minor',
    lengthBars: 32,
    tracks: [
      trackSpec('鼓组', 'drum', { kit: 'smp_acoustic' }),
      trackSpec('指弹贝斯', 'synth', { preset: 'finger_bass', role: 'bass' }),
      trackSpec('三角钢琴', 'synth', { preset: 'grand_piano', role: 'keys' }),
      trackSpec('弦乐', 'synth', { preset: 'strings_ensemble', role: 'pad' }),
      trackSpec('马林巴', 'synth', { preset: 'marimba', role: 'arp' }),
      trackSpec('电钢琴', 'synth', { preset: 'tine_epiano', role: 'keys' }),
      trackSpec('合唱', 'synth', { preset: 'concert_choir', role: 'pad' }),
    ],
  },
  {
    id: 'electronic',
    name: '电子 Beat',
    desc: '16 小节电子律动：鼓组 + 拨片贝斯 + 合成贝斯 + Warm Pad + Lead，适合 EDM/流行舞曲。',
    bpm: 128,
    key: 'A',
    scale: 'minor',
    lengthBars: 16,
    tracks: [
      trackSpec('鼓组', 'drum', { kit: 'smp_electro', role: 'drums' }),
      trackSpec('拨片贝斯', 'synth', { preset: 'picked_bass', role: 'bass' }),
      trackSpec('合成贝斯', 'synth', { preset: 'synth_bass', role: 'bass' }),
      trackSpec('Warm Pad', 'synth', { preset: 'warm_pad', role: 'pad' }),
      trackSpec('Lead', 'synth', { preset: 'trumpet', role: 'lead' }),
    ],
  },
  {
    id: 'piano',
    name: '钢琴 + 弦乐',
    desc: '16 小节 C 大调：三角钢琴 + 弦乐合奏，无鼓，适合抒情/配乐草稿。',
    bpm: 96,
    key: 'C',
    scale: 'major',
    lengthBars: 16,
    tracks: [
      trackSpec('三角钢琴', 'synth', { preset: 'grand_piano', role: 'keys' }),
      trackSpec('弦乐合奏', 'synth', { preset: 'strings_ensemble', role: 'pad' }),
    ],
  },
  {
    id: 'song',
    name: '歌曲模板',
    desc: '16 小节歌曲骨架：钢琴 + 指弹贝斯 + 弦乐 + 主音 + 鼓组，适合流行歌曲起步。',
    bpm: 100,
    key: 'G',
    scale: 'major',
    lengthBars: 16,
    tracks: [
      trackSpec('三角钢琴', 'synth', { preset: 'grand_piano', role: 'keys' }),
      trackSpec('指弹贝斯', 'synth', { preset: 'finger_bass', role: 'bass' }),
      trackSpec('弦乐', 'synth', { preset: 'strings_ensemble', role: 'pad' }),
      trackSpec('主音', 'synth', { preset: 'violin', role: 'lead' }),
      trackSpec('鼓组', 'drum', { kit: 'smp_acoustic', role: 'drums' }),
    ],
  },
])

/** 模板元数据摘要（深拷贝，供工具/UI 列表；不含内部实现）。 */
export function listProjectTemplates() {
  return PROJECT_TEMPLATES.map((template) => ({
    id: template.id,
    name: template.name,
    desc: template.desc,
    bpm: template.bpm,
    key: template.key,
    scale: template.scale,
    lengthBars: template.lengthBars,
    trackCount: template.tracks.length,
    tracks: template.tracks.map((track) => ({ ...track })),
  }))
}

/** 内部：根据模板描述创建轨道（demo 直接用现存演示工程）。 */
function buildTemplateProject(template) {
  if (template.id === 'demo') return normalizeProject(createDemoProject())
  const project = createEmptyProject({
    title: template.name,
    bpm: template.bpm,
    key: template.key,
    scale: template.scale,
    lengthBars: template.lengthBars,
  })
  let index = 0
  for (const spec of template.tracks) {
    index += 1
    const track = makeTrack({
      id: `trk_${index}`,
      name: spec.name,
      kind: spec.kind,
      preset: spec.preset,
      kit: spec.kit,
      role: spec.role,
    })
    project.tracks.push(track)
  }
  return normalizeProject(project)
}

/**
 * 根据模板 id 创建 schema3 工程（每次新对象）。
 * @param {string} id
 * @returns {object}
 */
export function createProjectFromTemplate(id) {
  const template = PROJECT_TEMPLATES.find((item) => item.id === id)
  if (!template) {
    throw new Error(`未知工程模板 template=${String(id)}；可选：${PROJECT_TEMPLATES.map((item) => item.id).join(' / ')}`)
  }
  return buildTemplateProject(template)
}
