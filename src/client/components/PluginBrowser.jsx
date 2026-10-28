/**
 * 左栏下：插件库（合成器预设 / 鼓组 / 效果器卡片）。
 *
 * 纯只读浏览：AI 决定用哪个插件；这里展示目录与参数摘要，点击卡片可看详情。
 * R5a：搜索 / 分类 chips / 收藏（localStorage）/ 仅收藏 / 试听（engine.previewNote）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  DRUM_KITS, DRUM_PARAM_SPECS, FX_PARAM_SPECS, FX_TYPES, SYNTH_INSTRUMENTS, SYNTH_INSTRUMENT_PARAM_SPECS,
  SYNTH_PRESETS, SYNTH_PARAM_SPECS,
} from '../../shared/catalog.js'
import { Panel, IconSearch, IconSparkle, fmtParam } from './ui.jsx'
import { InstrumentPanel } from './InstrumentPanel.jsx'
import { PluginManager, externalPluginApi } from './PluginManager.jsx'
import { ExternalPluginPanel } from './ExternalPluginPanel.jsx'

const FAVORITES_STORAGE_KEY = 'aims:presetFavorites'

const SEGMENTS = [
  { id: 'synth', label: '乐器', en: 'INSTRUMENTS' },
  { id: 'synthbox', label: '合成器', en: 'SYNTHESIZERS' },
  { id: 'drum', label: '鼓组', en: 'DRUM KITS' },
  { id: 'fx', label: '效果器', en: 'EFFECTS' },
  { id: 'external', label: '外部插件', en: 'VST3' },
]

const CATEGORY_IDS = {
  '键盘 Keys': 'keys',
  '吉他 Guitar': 'guitar',
  '贝斯 Bass': 'bass',
  '弦乐 Strings': 'strings',
  '合唱 Choir': 'vocals',
  '合唱 Vocals': 'vocals',
  '铜管 Brass': 'brass',
  '木管 Woodwind': 'winds',
  '木管 Winds': 'winds',
  '铺底 Pad': 'pad',
  '打击 Mallet': 'mallet',
}

/** 分类 id：优先已知中文/英文映射，否则取 category 里的英文词。 */
function categoryIdOf(category) {
  const text = String(category ?? '').trim()
  if (CATEGORY_IDS[text]) return CATEGORY_IDS[text]
  const english = text.match(/[A-Za-z]+/g)
  return english?.length ? english[english.length - 1].toLowerCase() : (text || 'other')
}

function readFavorites() {
  try {
    const raw = JSON.parse(window.localStorage.getItem(FAVORITES_STORAGE_KEY) || '[]')
    return Array.isArray(raw) ? raw.filter((key) => typeof key === 'string') : []
  } catch (err) {
    return []
  }
}

const DATA = {
  synth: SYNTH_PRESETS.map((p) => ({
    key: `synth:${p.id}`,
    name: p.name, label: p.label, category: p.category, desc: p.desc,
    color: p.color, params: p.params, specs: SYNTH_PARAM_SPECS, summary: ['osc', 'voices', 'cutoff'],
    /* P8：采样乐器（GeneralUser GS）不显示合成参数，改为 GM program / SoundFont 标签 */
    sampled: Boolean(p.soundfont),
    program: p.soundfont?.program ?? null,
    bank: p.soundfont?.bank ?? 0,
  })),
  drum: DRUM_KITS.map((k) => ({
    key: `drum:${k.id}`, name: k.name, label: k.label, category: k.category, desc: k.desc,
    color: k.color, params: k.params, specs: DRUM_PARAM_SPECS, summary: ['kickPitch', 'kickDecay', 'hatDecay'],
    sampled: Boolean(k.samplerPieces),
  })),
  synthbox: SYNTH_INSTRUMENTS.map((s) => ({
    key: `synthbox:${s.id}`, name: s.name, label: s.label, category: s.category, desc: s.desc,
    color: s.color, params: s.synthPreset, specs: SYNTH_INSTRUMENT_PARAM_SPECS,
    summary: ['wave', 'unison', 'filterCutoff'], sampled: false, subtractive: true, presetId: s.id,
  })),
  fx: FX_TYPES.map((f) => ({
    key: `fx:${f.id}`, name: f.name, label: f.label, category: f.category, desc: f.desc,
    color: f.color, params: {}, specs: FX_PARAM_SPECS[f.id] ?? {}, summary: Object.keys(FX_PARAM_SPECS[f.id] ?? {}).slice(0, 3),
    sampled: false,
  })),
}

const DEFAULT_PLUGIN_KEY = DATA.synth[0]?.key ?? 'synth:grand_piano'

const SUMMARY_KEYS = {}

export function PluginBrowser({
  project, selectedTrackId, engine = null, onNotify = null, onEdit = null, onCreateSynth = null, collapsed = false, onToggleCollapse = null,
}) {
  const [segment, setSegment] = useState('synth')
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('all')
  const [favoriteOnly, setFavoriteOnly] = useState(false)
  const [favorites, setFavorites] = useState(readFavorites)
  const [auditionMsg, setAuditionMsg] = useState('')
  const [selectedKey, setSelectedKey] = useState(DEFAULT_PLUGIN_KEY)
  const [managerOpen, setManagerOpen] = useState(false)
  const [externalPlugins, setExternalPlugins] = useState([])
  const [externalLoading, setExternalLoading] = useState(false)
  const [externalError, setExternalError] = useState('')
  const [externalBackendUnavailable, setExternalBackendUnavailable] = useState(false)
  const [externalSelectedId, setExternalSelectedId] = useState(null)
  const [externalBusy, setExternalBusy] = useState('')

  const loadExternalPlugins = useCallback(async () => {
    setExternalLoading(true)
    try {
      const data = await externalPluginApi.list()
      const list = Array.isArray(data?.plugins) ? data.plugins : Array.isArray(data) ? data : []
      setExternalPlugins(list)
      setExternalError('')
      setExternalBackendUnavailable(false)
      setExternalSelectedId((prev) => (prev && list.some((plugin) => (plugin.pluginId ?? plugin.id) === prev) ? prev : (list[0]?.pluginId ?? list[0]?.id ?? null)))
    } catch (err) {
      if (err?.code === 'PLUGIN_BACKEND_UNAVAILABLE') setExternalBackendUnavailable(true)
      setExternalError(err?.message ?? String(err))
    } finally {
      setExternalLoading(false)
    }
  }, [])

  useEffect(() => { loadExternalPlugins() }, [loadExternalPlugins])

  const selectedTrack = useMemo(
    () => (project?.tracks ?? []).find((track) => track.id === selectedTrackId) ?? null,
    [project?.tracks, selectedTrackId],
  )
  const selectedVst3Track = selectedTrack?.engine === 'vst3' || selectedTrack?.vst3 ? selectedTrack : null
  const selectedVst3Effect = selectedVst3Track
    ? null
    : (selectedTrack?.effects ?? []).find((fx) => fx?.type === 'vst3' && fx.vst3) ?? null

  const toggleExternalBypass = async (next) => {
    const target = selectedVst3Track
      ? { trackId: selectedVst3Track.id }
      : selectedVst3Effect
        ? { effectId: selectedVst3Effect.id }
        : null
    if (!target) return
    try {
      await externalPluginApi.bypass(target, next)
      onNotify?.(next ? '已旁路外部插件（实时处理在 M2 接入）' : '已启用外部插件', 'success')
    } catch (err) {
      if (err?.code === 'PLUGIN_BACKEND_UNAVAILABLE') setExternalBackendUnavailable(true)
      onNotify?.('外部插件旁路失败：' + (err?.message ?? err), 'error')
    }
  }

  const addExternalTrack = async (plugin) => {
    if (externalBusy) return
    setExternalBusy(plugin.pluginId ?? plugin.id)
    try {
      const result = await externalPluginApi.addTrack(plugin.pluginId ?? plugin.id, plugin.name)
      onNotify?.(`已添加外部插件轨道：${(result?.track?.name ?? plugin.name)}（M1 暂不实时处理）`, 'success')
      loadExternalPlugins()
    } catch (err) {
      if (err?.code === 'PLUGIN_BACKEND_UNAVAILABLE') setExternalBackendUnavailable(true)
      onNotify?.('添加外部插件轨道失败：' + (err?.message ?? err), 'error')
    } finally {
      setExternalBusy('')
    }
  }

  const addExternalEffect = async (plugin) => {
    const targetTrack = (project?.tracks ?? []).find((track) => track.id === selectedTrackId)
      ?? (project?.tracks ?? []).find((track) => track.kind === 'synth' && !track.vst3)
      ?? null
    if (!targetTrack) { onNotify?.('请先选中一条轨道，再添加外部效果器', 'error'); return }
    if (externalBusy) return
    if (!selectedTrackId) onNotify?.(`未选中轨道，已自动选择「${targetTrack.name}」作为外部效果器目标`, 'info')
    setExternalBusy(plugin.pluginId ?? plugin.id)
    try {
      await externalPluginApi.addEffect(targetTrack.id, plugin.pluginId ?? plugin.id)
      onNotify?.(`已添加外部效果器到「${targetTrack.name ?? targetTrack.id}」FX 链末尾（M1 暂不实时处理）`, 'success')
      loadExternalPlugins()
    } catch (err) {
      if (err?.code === 'PLUGIN_BACKEND_UNAVAILABLE') setExternalBackendUnavailable(true)
      onNotify?.('添加外部效果器失败：' + (err?.message ?? err), 'error')
    } finally {
      setExternalBusy('')
    }
  }

  useEffect(() => {
    try {
      window.localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(favorites))
    } catch (err) {
      /* localStorage 不可用时收藏仅本次会话有效 */
    }
  }, [favorites])

  const favoriteSet = useMemo(() => new Set(favorites), [favorites])
  const toggleFavorite = (key) => {
    setFavorites((prev) => (prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key]))
  }
  const categories = useMemo(() => {
    const map = new Map()
    for (const item of DATA[segment] ?? []) {
      const id = categoryIdOf(item.category)
      if (!map.has(id)) map.set(id, { id, label: item.category })
    }
    return [...map.values()]
  }, [segment])
  const audition = async (item) => {
    setSelectedKey(item.key)
    setAuditionMsg('')
    const trackId = (project?.tracks ?? []).find((track) => track.id === selectedTrackId && track.kind !== 'audio')?.id
      ?? (project?.tracks ?? []).find((track) => track.kind !== 'audio')?.id
      ?? null
    if (!engine || typeof engine.previewNote !== 'function' || !trackId) {
      const message = '试听暂不可用：请先添加/选中一条乐器轨道并启用音频'
      setAuditionMsg(message)
      onNotify?.(message, 'info')
      return
    }
    try {
      if (!engine.unlocked && typeof engine.unlock === 'function') await engine.unlock()
      const result = engine.previewNote(trackId, item.key.startsWith('drum:') ? 36 : 60, 0.8)
      if (!result) {
        const message = engine.unlocked === false
          ? '音频未解锁：请先点击界面启用音频后再试听'
          : '试听失败：当前轨道不支持试听（音频轨或引擎未就绪）'
        setAuditionMsg(message)
        onNotify?.(message, 'info')
      } else {
        setAuditionMsg(`试听中：${item.name}`)
      }
    } catch (err) {
      const message = '试听失败：音频未解锁或引擎不可用'
      setAuditionMsg(message)
      onNotify?.(message, 'error')
    }
  }

  const inUse = useMemo(() => {
    const map = new Map()
    for (const track of project?.tracks ?? []) {
      const key = track.kind === 'drum' ? `drum:${track.instrument?.kit}` : `synth:${track.instrument?.preset}`
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(track.id)
    }
    return map
  }, [project])

  const usedBySelected = useMemo(() => {
    const track = (project?.tracks ?? []).find((t) => t.id === selectedTrackId)
    if (!track) return null
    return track.kind === 'drum' ? `drum:${track.instrument?.kit}` : `synth:${track.instrument?.preset}`
  }, [project, selectedTrackId])

  const items = useMemo(() => {
    const list = DATA[segment] ?? []
    const q = query.trim().toLowerCase()
    return list.filter((item) => {
      if (category !== 'all' && categoryIdOf(item.category) !== category) return false
      if (favoriteOnly && !favoriteSet.has(item.key)) return false
      if (!q) return true
      return `${item.name} ${item.label} ${item.category} ${item.desc}`.toLowerCase().includes(q)
    })
  }, [segment, query, category, favoriteOnly, favoriteSet])

  const selected = useMemo(() => {
    const all = Object.values(DATA).flat()
    return all.find((item) => item.key === selectedKey) ?? DATA.synth[0]
  }, [selectedKey])

  const externalItems = useMemo(() => {
    const q = query.trim().toLowerCase()
    return externalPlugins.filter((plugin) => {
      if (!q) return true
      return `${plugin.name ?? ''} ${plugin.vendor ?? ''} ${plugin.category ?? ''} ${plugin.pluginId ?? ''}`.toLowerCase().includes(q)
    })
  }, [externalPlugins, query])
  const externalSelected = useMemo(
    () => externalItems.find((plugin) => (plugin.pluginId ?? plugin.id) === externalSelectedId) ?? externalItems[0] ?? null,
    [externalItems, externalSelectedId],
  )
  const segmentCount = segment === 'external' ? externalPlugins.length : (DATA[segment]?.length ?? 0)

  return (
    <>
    <Panel
      title="插件库"
      icon={<IconSparkle size={14} />}
      subtitle="BROWSER"
      badge={`${segmentCount}`}
      className="aims-left-panel aims-browser-panel"
      bodyClassName="aims-browser-body"
      collapsed={collapsed}
      onToggleCollapse={onToggleCollapse}
      collapseTestId="collapse-plugin-browser"
      collapseTitle={collapsed ? '展开插件库' : '折叠插件库'}
    >
      <div className="aims-browser-toolbar">
        <div className="aims-segment" role="tablist" aria-label="插件分类">
          {SEGMENTS.map((seg) => (
            <button
              key={seg.id}
              type="button"
              role="tab"
              aria-selected={segment === seg.id}
              className={`aims-segment-btn ${segment === seg.id ? 'is-active' : ''}`}
              data-testid={`preset-segment-${seg.id}`}
              title={`${seg.label} · ${seg.en} · ${seg.id === 'external' ? externalPlugins.length : (DATA[seg.id] ?? []).length} 个`}
              onClick={() => { setSegment(seg.id); setCategory('all') }}
            >
              {seg.label}
              <span className="aims-segment-count aims-mono">{seg.id === 'external' ? externalPlugins.length : (DATA[seg.id] ?? []).length}</span>
            </button>
          ))}
        </div>
        <button type="button" className="aims-browser-manage" data-testid="plugin-manager-open" title="扫描/导入/卸载外部 VST3 插件" onClick={() => setManagerOpen(true)}>管理外部插件</button>
        <label className="aims-search">
          <IconSearch size={13} />
          <input
            type="search"
            data-testid="preset-search"
            value={query}
            placeholder="搜索名称 / 标签 / 分类…"
            aria-label="搜索插件"
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </div>

      {segment !== 'external' ? (
      <div className="aims-browser-filters" aria-label="分类与收藏过滤">
        <button
          type="button"
          className={`aims-browser-chip ${category === 'all' ? 'is-active' : ''} ${favoriteOnly ? 'is-dim' : ''}`}
          data-testid="preset-category-all"
          aria-pressed={category === 'all'}
          onClick={() => setCategory('all')}
        >全部</button>
        {categories.map((cat) => (
          <button
            key={cat.id}
            type="button"
            className={`aims-browser-chip ${category === cat.id ? 'is-active' : ''}`}
            data-testid={`preset-category-${cat.id}`}
            aria-pressed={category === cat.id}
            title={`只看 ${cat.label}`}
            onClick={() => setCategory((prev) => (prev === cat.id ? 'all' : cat.id))}
          >{cat.label.replace(/\s+[A-Za-z].*$/, '')}</button>
        ))}
        <button
          type="button"
          className={`aims-browser-chip aims-browser-chip--fav ${favoriteOnly ? 'is-active' : ''}`}
          data-testid="preset-favorite-filter"
          aria-pressed={favoriteOnly}
          title="只看收藏（存在浏览器 localStorage）"
          onClick={() => setFavoriteOnly((prev) => !prev)}
        >★ 收藏 {favoriteSet.size > 0 ? <b className="aims-mono">{favoriteSet.size}</b> : null}</button>
      </div>
      ) : null}

      {segment === 'external' ? (
        <div className="aims-browser-list aims-external-list" role="list" data-testid="external-plugin-list">
          {externalLoading ? (
            <div className="aims-browser-none">正在读取外部插件…</div>
          ) : externalBackendUnavailable ? (
            <div className="aims-browser-none" role="status">外部插件需要桌面版/后端未启用。<br />可点击「管理外部插件」查看说明。</div>
          ) : externalItems.length === 0 ? (
            <div className="aims-browser-none">还没有外部插件。点击「管理外部插件」扫描或导入 .vst3。</div>
          ) : externalItems.map((plugin) => {
            const pluginId = plugin.pluginId ?? plugin.id
            const missing = plugin.missing === true
            const instrument = plugin.isInstrument === true || /instrument/i.test(String(plugin.category ?? ''))
            return (
              <div
                key={pluginId}
                role="listitem"
                className={`aims-plugin-card is-external ${externalSelectedId === pluginId ? 'is-selected' : ''} ${missing ? 'is-missing' : ''}`}
                data-testid={`external-plugin-card-${pluginId}`}
                data-missing={missing ? 'true' : 'false'}
                onClick={() => setExternalSelectedId(pluginId)}
              >
                <span className="aims-plugin-swatch" style={{ background: instrument ? '#7FC8A9' : '#4FA3A5' }} aria-hidden="true" />
                <span className="aims-plugin-main">
                  <span className="aims-plugin-name">{plugin.name ?? pluginId}{missing ? <span className="aims-plugin-missing">missing</span> : null}</span>
                  <span className="aims-plugin-label">{[plugin.vendor, plugin.version ? `v${plugin.version}` : '', plugin.category].filter(Boolean).join(' · ') || 'VST3'}</span>
                </span>
                <span className="aims-plugin-actions">
                  <button
                    type="button"
                    className="aims-plugin-external-add"
                    data-testid={`external-plugin-add-${pluginId}`}
                    disabled={missing || externalBusy === pluginId || externalBackendUnavailable}
                    title={instrument ? '添加为外部插件轨道' : '追加到选中轨道 FX 链末尾'}
                    onClick={(event) => { event.stopPropagation(); if (instrument) addExternalTrack(plugin); else addExternalEffect(plugin) }}
                  >{externalBusy === pluginId ? '…' : '添加'}</button>
                </span>
                {missing ? <span className="aims-plugin-missing-tag">缺失引用</span>
                  : plugin.managed === false ? <span className="aims-plugin-managed-tag" title="来自扫描目录，未复制到托管目录">外部</span>
                    : <span className="aims-plugin-managed-tag">VST3</span>}
              </div>
            )
          })}
        </div>
      ) : (
      <div className="aims-browser-list" role="list">
        {items.length === 0 ? (
          <div className="aims-browser-none">没有匹配的插件</div>
        ) : (
          items.map((item) => {
            const usage = inUse.get(item.key) ?? []
            const isSelected = selected?.key === item.key
            const isActive = usedBySelected === item.key
            return (
              <button
                key={item.key}
                type="button"
                role="listitem"
                className={`aims-plugin-card ${isSelected ? 'is-selected' : ''} ${isActive ? 'is-active' : ''}`}
                style={{ '--plugin-color': item.color }}
                title={`${item.name} · ${item.label}\n${item.desc}`}
                aria-label={`${item.name} ${item.label}（${item.category}）`}
                aria-pressed={isSelected}
                data-testid={item.subtractive ? `synth-card-${item.presetId}` : undefined}
                onClick={() => {
                  setSelectedKey(item.key)
                  if (item.subtractive && typeof onCreateSynth === 'function') onCreateSynth(item.presetId)
                }}
              >
                <span className="aims-plugin-swatch" style={{ background: item.color }} aria-hidden="true" />
                <span className="aims-plugin-main">
                  <span className="aims-plugin-name">{item.name}</span>
                  <span className="aims-plugin-label">{item.label}</span>
                </span>
                <span className="aims-plugin-actions">
                  <span
                    role="button"
                    tabIndex={0}
                    className={`aims-plugin-fav ${favoriteSet.has(item.key) ? 'is-fav' : ''}`}
                    data-testid="preset-favorite"
                    data-favorite-key={item.key}
                    aria-pressed={favoriteSet.has(item.key)}
                    title={favoriteSet.has(item.key) ? '取消收藏' : '收藏到本地'}
                    onClick={(event) => { event.stopPropagation(); toggleFavorite(item.key) }}
                    onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); toggleFavorite(item.key) } }}
                  >{favoriteSet.has(item.key) ? '★' : '☆'}</span>
                  <span
                    role="button"
                    tabIndex={0}
                    className="aims-plugin-audition"
                    data-testid="preset-audition"
                    data-audition-key={item.key}
                    title={`试听 ${item.name}`}
                    onClick={(event) => { event.stopPropagation(); audition(item) }}
                    onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); audition(item) } }}
                  >▶</span>
                </span>
                {item.sampled ? <span className="aims-plugin-sampled-tag" title="真实采样音色（GeneralUser GS）">采样</span> : null}
                <span
                  className="aims-plugin-params aims-mono"
                  title={segment === 'synth' ? '内置采样器参数：Attack/Release/Filter/Q/LFO Rate/Depth' : `参数数量 ${Object.keys(item.specs ?? {}).length}`}
                >
                  {segment === 'synth' ? '参数 6' : `参数 ${Object.keys(item.specs ?? {}).length}`}
                </span>
                {isActive ? <span className="aims-plugin-badge">使用中</span>
                  : usage.length > 0 ? <span className="aims-plugin-count" title={`${usage.length} 条轨道使用`}>{usage.length}</span> : null}
              </button>
            )
          })
        )}
      </div>
      )}

      {segment === 'external' ? (
        <div className="aims-browser-detail" data-testid="external-plugin-detail">
          {externalSelected ? (
            <>
              <div className="aims-browser-detail-head">
                <span className="aims-browser-detail-dot" style={{ background: '#4FA3A5' }} />
                <span className="aims-browser-detail-name">{externalSelected.name ?? externalSelected.pluginId}</span>
                <span className="aims-browser-detail-label">{externalSelected.vendor ?? 'VST3'}</span>
                <span className="aims-browser-detail-cat">{externalSelected.category ?? (externalSelected.isInstrument ? 'Instrument' : 'Effect')}</span>
              </div>
              <p className="aims-browser-desc">
                {externalSelected.missing ? '插件副本缺失：工程中的引用会保留为 missing，重新导入后可恢复。'
                  : externalSelected.isInstrument ? '外部乐器插件 · 点击「添加」创建 VST3 轨道（M1 暂不实时处理）'
                    : '外部效果器插件 · 选中轨道后点击「添加」，只追加到 FX 链末尾（M1 暂不实时处理）'}
              </p>
              <div className="aims-browser-note">
                {externalSelected.classId ? <span className="aims-mono">{String(externalSelected.classId).slice(0, 18)}</span> : null}
                {externalSelected.managed === false ? ' · 扫描目录引用（未托管）' : ' · 托管副本'}
              </div>
            </>
          ) : (
            <div className="aims-browser-none">选择外部插件查看信息，或打开「管理外部插件」扫描。</div>
          )}
        </div>
      ) : (
      <div className="aims-browser-detail">
        <div className="aims-browser-detail-head">
          <span className="aims-browser-detail-dot" style={{ background: selected.color }} />
          <span className="aims-browser-detail-name">{selected.name}</span>
          <span className="aims-browser-detail-label">{selected.label}</span>
          <span className="aims-browser-detail-cat">{selected.category}</span>
        </div>
        <p className="aims-browser-desc" title={selected.desc}>{selected.desc}</p>
        {selected.sampled ? (
          <div className="aims-browser-sampled" data-testid="plugin-sampled-info" data-program={selected.program ?? ''}>
            <span className="aims-browser-sampled-badge">{selected.key.startsWith('drum:') ? 'CC0 采样' : 'SoundFont'}</span>
            <span className="aims-browser-sampled-text">
              {selected.key.startsWith('drum:')
                ? '采样鼓机 · 真实采样'
                : selected.program != null ? `采样音色 · GM ${selected.program}` : '采样音色 · 真实采样'}
            </span>
            <span className="aims-browser-sampled-cat">{selected.category}</span>
          </div>
        ) : null}
        <div className="aims-browser-specs">
          {!selected.sampled ? selected.summary.map((key) => {
            const spec = selected.specs?.[key]
            const value = selected.params?.[key]
            if (!spec || value === undefined) return null
            return (
              <span className="aims-browser-spec" key={key} title={`${spec.label}：${fmtParam(spec, value)}`}>
                <span className="aims-browser-spec-k">{spec.label}</span>
                <span className="aims-browser-spec-v aims-mono">{SUMMARY_KEYS[key] ? SUMMARY_KEYS[key](value) : fmtParam(spec, value)}</span>
              </span>
            )
          }) : null}
        </div>
        <div className="aims-browser-note">
          {selected.subtractive
            ? '内置 subtractive 合成器 · 点击卡片创建合成器轨道 · ▶ 试听'
            : selected.sampled ? '真实采样音色 · GeneralUser GS · 由 AI 调度使用' : '由 AI 调度使用 · 此处为只读预览'}
          {favoriteOnly || category !== 'all' || query ? <span className="aims-browser-filter-count aims-mono"> · 筛选 {items.length}/{DATA[segment]?.length ?? 0}</span> : null}
        </div>
        {auditionMsg ? (
          <div className="aims-browser-audition-hint" data-testid="preset-audition-hint" role="status">{auditionMsg}</div>
        ) : null}
      </div>
      )}
      {selectedVst3Track || selectedVst3Effect ? (
        <div className="aims-browser-external-instance">
          <ExternalPluginPanel
            track={selectedVst3Track ?? selectedTrack}
            effect={selectedVst3Effect}
            engine={engine}
            project={project}
            onNotify={onNotify}
            onToggleBypass={externalBackendUnavailable ? null : toggleExternalBypass}
          />
        </div>
      ) : null}
      <InstrumentPanel
        project={project}
        selectedTrackId={selectedTrackId}
        engine={engine}
        onEdit={onEdit}
        onNotify={onNotify}
      />
    </Panel>
    {managerOpen ? (
      <PluginManager
        onClose={() => { setManagerOpen(false); loadExternalPlugins() }}
        onNotify={onNotify}
        onChanged={loadExternalPlugins}
      />
    ) : null}
    </>
  )
}
