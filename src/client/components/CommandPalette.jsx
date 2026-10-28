/** R7b/R7c：命令面板（Ctrl/Cmd+K，过滤/上下键/Enter/Esc），支持 i18n 与无障碍。 */
import { useEffect, useRef, useState } from 'react'
import { IconSearch } from './ui.jsx'
import { useDialogA11y, useI18n } from '../i18n.js'

export function CommandPalette({ open, commands = [], onClose, onRun }) {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef(null)
  const cardRef = useRef(null)
  const listRef = useRef(null)
  useDialogA11y(open, onClose, cardRef)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setIndex(0)
    const timer = setTimeout(() => inputRef.current?.focus(), 20)
    return () => clearTimeout(timer)
  }, [open])

  useEffect(() => {
    if (!open) return undefined
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  useEffect(() => {
    if (!open) return
    setIndex(0)
  }, [query, open])

  const filtered = commands.filter((cmd) => {
    const q = query.trim().toLowerCase()
    if (!q) return true
    return `${cmd.label} ${cmd.id} ${cmd.keywords ?? ''}`.toLowerCase().includes(q)
  })
  const selected = filtered[Math.min(index, Math.max(0, filtered.length - 1))] ?? null

  const run = (cmd) => {
    if (!cmd) return
    onClose?.()
    onRun?.(cmd)
  }

  if (!open) return null
  return (
    <div className="aims-modal aims-command-modal" role="presentation" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose?.() }}>
      <div className="aims-command" role="dialog" aria-modal="true" aria-label={t('cmd.title')} data-testid="command-palette" ref={cardRef}>
        <div className="aims-command-search">
          <IconSearch size={14} />
          <input
            ref={inputRef}
            type="text"
            className="aims-command-input"
            data-testid="command-input"
            placeholder={t('cmd.placeholder')}
            aria-label={t('cmd.title')}
            role="combobox"
            aria-expanded="true"
            aria-controls="aims-command-listbox"
            aria-activedescendant={selected ? `command-option-${selected.id}` : undefined}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setIndex((prev) => (filtered.length === 0 ? 0 : (prev + 1) % filtered.length))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setIndex((prev) => (filtered.length === 0 ? 0 : (prev - 1 + filtered.length) % filtered.length))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                run(selected)
              } else if (e.key === 'Escape') {
                e.preventDefault()
                onClose?.()
              }
            }}
          />
          <kbd className="aims-command-kbd">Ctrl K</kbd>
        </div>
        <div className="aims-command-list" role="listbox" id="aims-command-listbox" ref={listRef} aria-label={t('cmd.title')}>
          {filtered.length === 0 ? (
            <div className="aims-command-empty">{t('cmd.empty')}</div>
          ) : filtered.map((cmd, itemIndex) => (
            <button
              key={cmd.id}
              id={`command-option-${cmd.id}`}
              type="button"
              role="option"
              aria-selected={itemIndex === index}
              className={`aims-command-item ${itemIndex === index ? 'is-active' : ''}`}
              data-testid={`command-item-${cmd.id}`}
              onMouseEnter={() => setIndex(itemIndex)}
              onClick={() => run(cmd)}
            >
              <span className="aims-command-label">{cmd.label}</span>
              {cmd.shortcut ? <kbd className="aims-command-shortcut">{cmd.shortcut}</kbd> : null}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
