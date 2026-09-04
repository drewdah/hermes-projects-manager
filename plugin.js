/**
 * projects-manager — Projects CRUD via projects.* RPC.
 *
 * open path: openWorkspace only (no host.navigate after — session tile reclaim).
 * Bridge: pointerdown on data-tour=sidebar-nav-projects-manager:nav only.
 *
 * UX (2026-09-03):
 *  - icon + color picker (projects.icon / projects.color → sidebar Projects grouping)
 *  - remote folder browser + path autocomplete (LXC via complete.path / shell.exec)
 *  - create folder on remote while creating a project
 *  - show description on list rows; no footer help blurb
 * UX (2026-09-04):
 *  - pin project to a Hermes profile on create/edit (projects are per-profile)
 *  - default profile id = "default" when none chosen
 *  - page filter selects which profile's projects.db you manage
 * UX (2026-09-04b):
 *  - appearance: single icon trigger + overlay grid (keeps edit modal short)
 */
import {
  Button,
  cn,
  Codicon,
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  ErrorState,
  GlyphSpinner,
  haptic,
  host,
  Input,
  PALETTE_AREA,
  ROUTES_AREA,
  ScrollArea,
  SIDEBAR_NAV_AREA,
  Textarea,
  Tip,
  usePluginI18n,
  useQuery,
  useQueryClient,
  useValue
} from '@hermes/plugin-sdk'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { jsx, jsxs, Fragment } from 'react/jsx-runtime'

const ID = 'projects-manager'
const ROUTE = '/projects'
const QUERY_KEY = ['projects-manager', 'list']
const NAV_TOUR = 'sidebar-nav-projects-manager:nav'

const AREA_ROUTES = typeof ROUTES_AREA === 'string' && ROUTES_AREA ? ROUTES_AREA : 'routes'
const AREA_NAV = typeof SIDEBAR_NAV_AREA === 'string' && SIDEBAR_NAV_AREA ? SIDEBAR_NAV_AREA : 'sidebar.nav'
const AREA_PALETTE = typeof PALETTE_AREA === 'string' && PALETTE_AREA ? PALETTE_AREA : 'palette'

/** Same curated set stock Desktop uses for project glyphs. */
const PROJECT_ICONS = [
  'folder-library',
  'repo',
  'rocket',
  'beaker',
  'flame',
  'star-full',
  'heart',
  'zap',
  'target',
  'lightbulb',
  'tools',
  'device-desktop',
  'device-mobile',
  'terminal',
  'dashboard',
  'globe',
  'broadcast',
  'cloud',
  'database',
  'package',
  'book',
  'organization',
  'bug',
  'shield',
  'key',
  'gift',
  'telescope',
  'home'
]

/** Match stock PROFILE_SWATCHES (sdk may omit export on older clients). */
const SWATCHES = [
  'hsl(0 68% 58%)',
  'hsl(30 68% 58%)',
  'hsl(60 68% 58%)',
  'hsl(90 68% 58%)',
  'hsl(120 68% 58%)',
  'hsl(150 68% 58%)',
  'hsl(180 68% 58%)',
  'hsl(210 68% 58%)',
  'hsl(240 68% 58%)',
  'hsl(270 68% 58%)',
  'hsl(300 68% 58%)',
  'hsl(330 68% 58%)'
]

/** Gateway $HOME — portable default across remote containers.
 *  We do NOT require a ~/projects dir; that is created only if the user
 *  (or create flow) asks for a path under it. */
let cachedHomeDir = null
let homeResolvePromise = null

function homeFallback() {
  return '/root'
}

function quickRootsFor(home) {
  const h = cleanPath(home || homeFallback())
  const roots = [h]
  // Parent of home on multi-user hosts (e.g. /home), plus common mounts.
  const parent = h.includes('/') && h !== '/' ? cleanPath(h.split('/').slice(0, -1).join('/') || '/') : ''
  for (const extra of [parent, '/home', '/opt', '/var', '/mnt'].filter(Boolean)) {
    if (extra && extra !== '/' && extra !== h && !roots.includes(extra)) roots.push(extra)
  }
  return roots
}

async function resolveGatewayHome() {
  if (cachedHomeDir) return { home: cachedHomeDir }
  if (homeResolvePromise) return homeResolvePromise

  homeResolvePromise = (async () => {
    let home = ''
    try {
      const res = await shellExec(
        "python3 -c 'import os; print(os.path.expanduser(\"~\"), end=\"\")'"
      )
      home = String((res && res.stdout) || '').trim().split(/\r?\n/)[0] || ''
    } catch (_) {}
    if (!home || home === '/') {
      try {
        const res = await shellExec('printf %s "$HOME"')
        home = String((res && res.stdout) || '').trim()
      } catch (_) {}
    }
    if (!home || home === '/') home = homeFallback()
    home = cleanPath(home)
    cachedHomeDir = home
    return { home }
  })()

  try {
    return await homeResolvePromise
  } finally {
    homeResolvePromise = null
  }
}

/** Static fallback until first resolve (root containers). */
const HOME_FALLBACK = homeFallback()
const QUICK_ROOTS_FALLBACK = quickRootsFor(HOME_FALLBACK)

let closeWorkspace = null
let swallowNavClickUntil = 0

function setNavActive(on) {
  if (typeof document === 'undefined') return
  const label = document.querySelector(`[data-tour="${NAV_TOUR}"]`)
  const btn =
    (label && label.closest('[data-sidebar="menu-button"]')) ||
    (label && label.closest('button'))
  if (!btn) return
  if (on) {
    btn.setAttribute('data-projects-nav-active', '1')
    btn.setAttribute('aria-current', 'page')
    btn.classList.add(
      'border-(--ui-stroke-tertiary)',
      'bg-(--ui-control-active-background)',
      'text-foreground'
    )
    btn.classList.remove('border-transparent')
  } else {
    btn.removeAttribute('data-projects-nav-active')
    btn.removeAttribute('aria-current')
    btn.classList.remove(
      'border-(--ui-stroke-tertiary)',
      'bg-(--ui-control-active-background)',
      'text-foreground'
    )
  }
}

function openProjects() {
  try {
    haptic('tap')
  } catch (_) {}

  if (typeof host.openWorkspace !== 'function') {
    try {
      host.navigate(ROUTE)
    } catch (_) {}
    setNavActive(true)
    return
  }

  try {
    closeWorkspace = host.openWorkspace(ID, {
      title: 'Projects',
      minWidth: '28rem',
      headerVeto: true,
      dock: { pane: 'workspace', pos: 'center' },
      render: () => jsx(ProjectsPage, {}),
      onClose: () => {
        closeWorkspace = null
        setNavActive(false)
      }
    })
    setNavActive(true)
  } catch (err) {
    try {
      host.notify({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err)
      })
    } catch (_) {}
  }
}

function isProjectsNavEvent(event) {
  const el = event.target
  if (!el || typeof el.closest !== 'function') return false
  if (el.closest(`[data-tour="${NAV_TOUR}"]`)) return true
  const btn = el.closest('[data-sidebar="menu-button"]') || el.closest('button')
  return Boolean(
    btn &&
      typeof btn.querySelector === 'function' &&
      btn.querySelector(`[data-tour="${NAV_TOUR}"]`)
  )
}

function onProjectsNavPointerDown(event) {
  if (event.button != null && event.button !== 0) return
  if (!isProjectsNavEvent(event)) return
  event.preventDefault()
  event.stopPropagation()
  if (typeof event.stopImmediatePropagation === 'function') {
    event.stopImmediatePropagation()
  }
  swallowNavClickUntil = Date.now() + 500
  openProjects()
}

function onProjectsNavClickCapture(event) {
  if (!isProjectsNavEvent(event)) return
  if (Date.now() > swallowNavClickUntil) return
  event.preventDefault()
  event.stopPropagation()
  if (typeof event.stopImmediatePropagation === 'function') {
    event.stopImmediatePropagation()
  }
}

function onOtherTopNavClick(event) {
  const el = event.target
  if (!el || typeof el.closest !== 'function') return
  if (isProjectsNavEvent(event)) return
  const btn = el.closest('[data-sidebar="menu-button"]')
  if (!btn) return
  if (!btn.querySelector('[data-tour^="sidebar-nav-"]')) return
  setNavActive(false)
}

function installNavBridge() {
  if (typeof document === 'undefined') return () => {}
  document.addEventListener('pointerdown', onProjectsNavPointerDown, true)
  document.addEventListener('click', onProjectsNavClickCapture, true)
  document.addEventListener('click', onOtherTopNavClick, false)
  return () => {
    document.removeEventListener('pointerdown', onProjectsNavPointerDown, true)
    document.removeEventListener('click', onProjectsNavClickCapture, true)
    document.removeEventListener('click', onOtherTopNavClick, false)
  }
}

/** Stock id for the launch / default profile. Projects land here unless chosen. */
const DEFAULT_PROFILE = 'default'

function normalizeProfileKey(value) {
  const s = String(value == null ? '' : value).trim()
  if (!s || s === '__all__' || s === 'all' || s === '*') return DEFAULT_PROFILE
  return s
}

/** Active Desktop profile scope, falling back to default. */
function profileName() {
  try {
    const p = host.state.profile?.get?.()
    if (typeof p === 'string' && p.trim() && p !== '__all__' && p !== 'all') {
      return normalizeProfileKey(p)
    }
  } catch (_) {}
  return DEFAULT_PROFILE
}

function rpcParams(extra = {}) {
  const override = extra && Object.prototype.hasOwnProperty.call(extra, 'profile')
    ? extra.profile
    : undefined
  const profile = normalizeProfileKey(override != null ? override : profileName())
  const rest = { ...(extra || {}) }
  delete rest.profile
  return { profile, ...rest }
}

async function projectsRequest(method, params = {}) {
  return host.request(method, rpcParams(params))
}

/**
 * List Hermes profile ids available on this gateway.
 * Always includes "default". Uses profiles.list when present.
 */
async function listHermesProfiles() {
  const byName = new Map()
  const add = (row) => {
    if (!row) return
    const name = normalizeProfileKey(
      (typeof row === 'string' ? row : row.name || row.id || row.profile || '')
    )
    if (!name) return
    const display =
      (typeof row === 'object' &&
        (row.display_name || row.displayName || row.title || row.label)) ||
      ''
    const isDefault = Boolean(
      typeof row === 'object' && (row.is_default || row.isDefault || name === DEFAULT_PROFILE)
    )
    const prev = byName.get(name) || { name, displayName: '', isDefault: name === DEFAULT_PROFILE }
    byName.set(name, {
      name,
      displayName: String(display || prev.displayName || '').trim(),
      isDefault: isDefault || prev.isDefault || name === DEFAULT_PROFILE
    })
  }

  add({ name: DEFAULT_PROFILE, display_name: 'default', is_default: true })

  try {
    const res = await host.request('profiles.list', { include_sessions: false })
    const rows =
      (res && (res.profiles || res.items || res.data)) ||
      (Array.isArray(res) ? res : [])
    if (Array.isArray(rows)) rows.forEach(add)
  } catch (_) {
    /* profiles.list may be missing on older gateways — still offer default */
  }

  // Stable: default first, then alpha.
  return [...byName.values()].sort((a, b) => {
    if (a.name === DEFAULT_PROFILE) return -1
    if (b.name === DEFAULT_PROFILE) return 1
    return a.name.localeCompare(b.name)
  })
}

function profileLabel(rowOrName) {
  if (!rowOrName) return DEFAULT_PROFILE
  if (typeof rowOrName === 'string') return rowOrName
  const name = rowOrName.name || DEFAULT_PROFILE
  const dn = String(rowOrName.displayName || '').trim()
  if (dn && dn.toLowerCase() !== String(name).toLowerCase()) return `${dn} (${name})`
  if (name === DEFAULT_PROFILE) return 'default'
  return name
}

/** Native select styled for the dialog/page — no Select* import dependency. */
function ProfileSelect({ value, onChange, options, disabled, id }) {
  const opts = Array.isArray(options) && options.length
    ? options
    : [{ name: DEFAULT_PROFILE, displayName: 'default', isDefault: true }]
  return jsx('select', {
    id,
    disabled: Boolean(disabled),
    value: normalizeProfileKey(value),
    onChange: e => onChange && onChange(normalizeProfileKey(e.target.value)),
    className: cn(
      'h-8 w-full rounded-md border border-(--ui-stroke-secondary) bg-transparent',
      'px-2 text-xs text-foreground outline-none',
      'focus-visible:border-(--ui-accent) disabled:opacity-50'
    ),
    children: opts.map(row =>
      jsx(
        'option',
        {
          value: row.name,
          children: profileLabel(row)
        },
        row.name
      )
    )
  })
}

/**
 * Stock sidebar caches $projectTree and only re-pulls on focus / sessions.changed
 * / grouping toggle — not when a plugin writes projects.update. Nudge those
 * paths so icon/color land immediately instead of ~minute lag.
 */
function nudgeSidebarProjectTree() {
  if (typeof window === 'undefined') return
  try {
    // Sidebar listens window focus + visibilitychange → refreshProjectTree().
    window.dispatchEvent(new Event('focus'))
  } catch (_) {}
  try {
    document.dispatchEvent(new Event('visibilitychange'))
  } catch (_) {}
  // Soft second pass after the RPC tree can settle.
  try {
    window.setTimeout(() => {
      try {
        window.dispatchEvent(new Event('focus'))
      } catch (_) {}
    }, 400)
  } catch (_) {}
}

/** Best-effort optimistic paint of project lead glyphs in the session sidebar. */
function paintSidebarProjectLook({ name, icon, color }) {
  if (typeof document === 'undefined' || !name) return
  const label = String(name).trim()
  if (!label) return
  const glyph = icon || 'folder-library'

  // Match row labels that equal the project name (overview grouping headers).
  const nodes = document.querySelectorAll('[data-sidebar], [class*="sidebar"], nav, aside')
  const roots = nodes.length ? nodes : [document.body]
  const seen = new Set()

  for (const root of roots) {
    if (!root || typeof root.querySelectorAll !== 'function') continue
    const labels = root.querySelectorAll('span, div, p, button')
    for (const el of labels) {
      if (seen.has(el)) continue
      if ((el.textContent || '').trim() !== label) continue
      // Prefer a row-ish ancestor with a codicon lead.
      let row = el.closest('[class*="group"]') || el.parentElement
      for (let i = 0; i < 5 && row; i++) {
        const lead = row.querySelector?.('i.codicon, .codicon')
        if (lead) {
          seen.add(el)
          // Reset classes to the chosen glyph.
          const keep = [...lead.classList].filter(c => c === 'codicon' || c.startsWith('codicon-modifier'))
          lead.className = [...keep, 'codicon', `codicon-${glyph}`].filter(Boolean).join(' ')
          if (color) {
            lead.style.color = color
            if (lead.parentElement) lead.parentElement.style.color = color
          } else {
            lead.style.removeProperty('color')
            if (lead.parentElement) lead.parentElement.style.removeProperty('color')
          }
          break
        }
        row = row.parentElement
      }
    }
  }
}

function looksLikeWindowsPath(path) {
  const p = String(path || '')
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\')
}

/**
 * Live backend mode for the active Desktop connection.
 * - local  → Hermes brain is this PC (native folder dialog is valid)
 * - remote → brain is LXC/SSH/cloud (only remote paths group sessions)
 * Defaults remote-safe when unknown (house setup).
 */
async function detectBackendMode() {
  try {
    const desktop = typeof window !== 'undefined' ? window.hermesDesktop : null
    if (desktop && typeof desktop.getConnection === 'function') {
      const conn = await desktop.getConnection()
      if (conn && conn.mode === 'local') return 'local'
      if (conn && conn.mode === 'remote') return 'remote'
    }
  } catch (_) {}

  try {
    const desktop = typeof window !== 'undefined' ? window.hermesDesktop : null
    if (desktop && typeof desktop.getConnectionConfig === 'function') {
      const cfg = await desktop.getConnectionConfig()
      if (cfg && cfg.mode === 'local') return 'local'
      if (cfg && (cfg.mode === 'remote' || cfg.mode === 'cloud' || cfg.mode === 'ssh')) return 'remote'
    }
  } catch (_) {}

  // Soft signals
  try {
    const cwd = host.state.cwd?.get?.()
    if (typeof cwd === 'string' && looksLikeWindowsPath(cwd)) return 'local'
  } catch (_) {}

  try {
    const id = host.state.connectionId?.get?.()
    if (id === 'local') return 'local'
  } catch (_) {}

  return 'remote'
}

function primaryPath(project) {
  if (!project) return ''
  if (project.primary_path) return project.primary_path
  const folders = project.folders || []
  const primary = folders.find(f => f && f.is_primary)
  if (primary?.path) return primary.path
  return (folders[0] && folders[0].path) || ''
}

function cleanPath(path) {
  const raw = String(path || '').trim()
  if (!raw) return '/'
  if (raw === '/') return '/'
  return raw.replace(/\/+$/, '') || '/'
}

function parentPath(path) {
  const value = cleanPath(path)
  if (value === '/') return '/'
  const idx = value.lastIndexOf('/')
  if (idx <= 0) return '/'
  return value.slice(0, idx) || '/'
}

function pathLeaf(path) {
  const value = cleanPath(path)
  if (value === '/') return '/'
  const parts = value.split('/').filter(Boolean)
  return parts[parts.length - 1] || value
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\"'\"'`)}'`
}

async function shellExec(command) {
  return host.request('shell.exec', { command })
}

/**
 * List directories on the backend (LXC when remote). Prefer complete.path;
 * fall back to a tiny python one-liner via shell.exec.
 */
async function listRemoteDirs(dirPath) {
  const target = cleanPath(dirPath)
  const word = target.endsWith('/') ? target : `${target}/`

  try {
    const res = await host.request('complete.path', { word })
    const items = (res && res.items) || []
    const dirs = []
    for (const item of items) {
      const meta = String((item && item.meta) || '')
      const display = String((item && item.display) || '')
      const text = String((item && item.text) || '')
      const isDir = meta === 'dir' || display.endsWith('/') || text.endsWith('/')
      if (!isDir) continue
      let full = text.replace(/\/+$/, '')
      if (!full.startsWith('/')) {
        full = cleanPath(`${target}/${display.replace(/\/+$/, '')}`)
      }
      const name = pathLeaf(full)
      if (!name || name === '.' || name === '..') continue
      dirs.push({ name, path: full })
    }
    if (dirs.length) {
      dirs.sort((a, b) => a.name.localeCompare(b.name))
      return { entries: dirs, error: null }
    }
  } catch (_) {
    /* fall through */
  }

  try {
    const py = [
      'python3 -c ',
      shellQuote(
        [
          'import json,os,sys',
          `p=${JSON.stringify(target)}`,
          'out=[]',
          'try:',
          '  names=sorted(os.listdir(p), key=lambda s: s.lower())',
          'except Exception as e:',
          '  print(json.dumps({"error":str(e),"entries":[]})); sys.exit(0)',
          'for n in names:',
          '  if n.startswith("."): continue',
          '  fp=os.path.join(p,n)',
          '  if os.path.isdir(fp): out.append({"name":n,"path":fp})',
          'print(json.dumps({"error":None,"entries":out}))'
        ].join('\n')
      )
    ].join('')
    const res = await shellExec(py)
    const raw = String((res && res.stdout) || '').trim()
    if (!raw) return { entries: [], error: (res && res.stderr) || 'empty listing' }
    const parsed = JSON.parse(raw)
    return {
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
      error: parsed.error || null
    }
  } catch (err) {
    return {
      entries: [],
      error: err instanceof Error ? err.message : String(err || 'list failed')
    }
  }
}

async function mkdirRemote(dirPath) {
  const target = cleanPath(dirPath)
  if (!target || target === '/') throw new Error('Refusing to create filesystem root')
  const res = await shellExec(`mkdir -p -- ${shellQuote(target)}`)
  if (res && typeof res.code === 'number' && res.code !== 0) {
    const detail = String(res.stderr || res.stdout || `mkdir failed (${res.code})`).trim()
    const home = cachedHomeDir || HOME_FALLBACK
    const hint =
      target === home || target.startsWith(home + '/')
        ? ''
        : ` Try under gateway home (${home}/…).`
    throw new Error(`${detail}${hint}`)
  }
  return target
}

/** Path suggestions while typing (remote backend). */
async function completeRemotePath(prefix) {
  const word = String(prefix || '').trim()
  if (!word || word.length < 1) return []
  try {
    const res = await host.request('complete.path', { word })
    const items = (res && res.items) || []
    const out = []
    for (const item of items) {
      const text = String((item && item.text) || '')
      const display = String((item && item.display) || '')
      const meta = String((item && item.meta) || '')
      if (!text) continue
      // Prefer directories for project folders.
      if (meta && meta !== 'dir' && !display.endsWith('/') && !text.endsWith('/')) continue
      out.push({
        path: text.replace(/\/+$/, '') || text,
        label: display || text,
        meta: meta || 'dir'
      })
    }
    return out.slice(0, 12)
  } catch (_) {
    return []
  }
}

async function pickLocalDirectory() {
  try {
    const desktop = typeof window !== 'undefined' ? window.hermesDesktop : null
    if (desktop && typeof desktop.selectPaths === 'function') {
      const paths = await desktop.selectPaths({ directories: true, multiple: false })
      if (Array.isArray(paths) && paths[0]) return String(paths[0])
    }
  } catch (_) {}
  return null
}

/**
 * Icon + color picker (compact).
 * Icon = one clickable glyph that opens an overlay grid (keeps edit modal short).
 * Color = compact swatch row. No ColorSwatches / Tip-asChild (disk-plugin safe).
 */
function AppearancePicker({ icon, color, onIcon, onColor, disabled }) {
  const t = usePluginI18n(ID)
  const activeIcon = icon || 'folder-library'
  const [iconOpen, setIconOpen] = useState(false)
  const rootRef = useRef(null)

  useEffect(() => {
    if (!iconOpen) return
    const onKey = e => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setIconOpen(false)
      }
    }
    const onPointer = e => {
      const el = rootRef.current
      if (!el) return
      if (el.contains(e.target)) return
      setIconOpen(false)
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('pointerdown', onPointer, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('pointerdown', onPointer, true)
    }
  }, [iconOpen])

  // Inline styles — Desktop plugin CSS often purges uncommon Tailwind
  // (grid-cols-7, bg with comma fallbacks), which left the picker transparent
  // and single-column.
  const panelStyle = {
    display: 'block',
    width: '100%',
    marginTop: 6,
    padding: 10,
    borderRadius: 8,
    border: '1px solid var(--ui-stroke-secondary, rgba(255,255,255,0.12))',
    backgroundColor: 'var(--card, var(--ui-control-background, var(--background, #161616)))',
    boxShadow: '0 10px 28px rgba(0,0,0,0.45)',
    boxSizing: 'border-box'
  }
  const gridStyle = {
    display: 'grid',
    gridTemplateColumns: 'repeat(5, minmax(0, 1fr))',
    gap: 6
  }

  return jsxs('div', {
    ref: rootRef,
    className: 'flex flex-col gap-1.5',
    children: [
      jsx('span', {
        className: 'text-[0.6875rem] font-medium text-(--ui-text-tertiary)',
        children: t('appearanceLabel')
      }),

      // Single row: icon trigger + swatches + clear color.
      jsxs('div', {
        className: 'flex items-center gap-2',
        children: [
          jsx('button', {
            type: 'button',
            disabled,
            'aria-label': t('pickIconTip'),
            'aria-expanded': iconOpen,
            'aria-haspopup': 'dialog',
            title: activeIcon,
            className: cn(
              'grid size-9 shrink-0 place-items-center rounded-md border transition disabled:opacity-50',
              iconOpen
                ? 'border-(--ui-accent) bg-(--ui-control-active-background)'
                : 'border-(--ui-stroke-secondary) bg-(--ui-control-hover-background) hover:border-(--ui-stroke-tertiary)'
            ),
            style: color ? { color } : undefined,
            onClick: () => {
              if (disabled) return
              setIconOpen(v => !v)
            },
            children: jsx('i', {
              'aria-hidden': true,
              className: cn('codicon', `codicon-${activeIcon}`),
              style: { fontSize: '1.1rem', lineHeight: 1 }
            })
          }),

          jsx('div', {
            className: 'flex min-w-0 flex-1 flex-wrap items-center gap-1.5',
            children: [
              ...SWATCHES.map(swatch =>
                jsx(
                  'button',
                  {
                    type: 'button',
                    disabled,
                    title: swatch,
                    'aria-label': swatch,
                    className:
                      'size-4 shrink-0 rounded-full transition-transform hover:scale-110 disabled:opacity-50',
                    style: {
                      backgroundColor: swatch,
                      color: swatch,
                      boxShadow:
                        color === swatch
                          ? '0 0 0 2px var(--ui-bg-elevated, #111), 0 0 0 3.5px currentColor'
                          : undefined
                    },
                    onClick: () => onColor(color === swatch ? null : swatch)
                  },
                  swatch
                )
              ),
              jsx(
                'button',
                {
                  type: 'button',
                  disabled,
                  title: t('noColor'),
                  'aria-label': t('noColor'),
                  className: cn(
                    'grid size-4 shrink-0 place-items-center rounded-full border border-(--ui-stroke-secondary) text-(--ui-text-quaternary) transition hover:text-foreground disabled:opacity-50',
                    !color && 'border-(--ui-accent) text-foreground'
                  ),
                  onClick: () => onColor(null),
                  children: jsx('i', {
                    'aria-hidden': true,
                    className: 'codicon codicon-circle-slash',
                    style: { fontSize: '0.55rem', lineHeight: 1 }
                  })
                },
                'no-color'
              )
            ]
          })
        ]
      }),

      // Expand-in-place panel (not absolute) so dialog scroll/overflow can't
      // strip the background or collapse the grid to one column.
      iconOpen
        ? jsxs('div', {
            role: 'dialog',
            'aria-label': t('pickIconTitle'),
            style: panelStyle,
            onClick: e => e.stopPropagation(),
            children: [
              jsxs('div', {
                className: 'mb-2 flex items-center justify-between gap-2',
                children: [
                  jsx('span', {
                    className: 'text-[0.65rem] font-medium text-(--ui-text-tertiary)',
                    children: t('pickIconTitle')
                  }),
                  jsx('button', {
                    type: 'button',
                    className:
                      'grid size-5 place-items-center rounded text-(--ui-text-quaternary) hover:bg-(--ui-control-hover-background) hover:text-foreground',
                    'aria-label': t('closeIconPicker'),
                    onClick: () => setIconOpen(false),
                    children: jsx('i', {
                      'aria-hidden': true,
                      className: 'codicon codicon-close',
                      style: { fontSize: '0.7rem', lineHeight: 1 }
                    })
                  })
                ]
              }),
              jsx('div', {
                style: gridStyle,
                children: PROJECT_ICONS.map(name => {
                  const selected = activeIcon === name
                  return jsx(
                    'button',
                    {
                      type: 'button',
                      disabled,
                      title: name,
                      'aria-label': name,
                      'aria-pressed': selected,
                      className: cn(
                        'grid place-items-center rounded-md text-(--ui-text-tertiary) transition hover:bg-(--ui-control-hover-background) disabled:opacity-50',
                        selected && 'bg-(--ui-control-active-background) text-foreground'
                      ),
                      style: {
                        height: 32,
                        width: '100%',
                        color: selected && color ? color : undefined
                      },
                      onClick: () => {
                        onIcon(name)
                        setIconOpen(false)
                      },
                      children: jsx('i', {
                        'aria-hidden': true,
                        className: cn('codicon', `codicon-${name}`),
                        style: { fontSize: '0.9rem', lineHeight: 1 }
                      })
                    },
                    name
                  )
                })
              })
            ]
          })
        : null,

      !iconOpen
        ? jsx('p', {
            className: 'text-[0.65rem] text-(--ui-text-quaternary)',
            children: t('appearanceHint')
          })
        : null
    ]
  })
}

function RemoteFolderBrowser({ open, initialPath, onClose, onSelect }) {
  const t = usePluginI18n(ID)
  const [current, setCurrent] = useState(HOME_FALLBACK)
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  const [quickRoots, setQuickRoots] = useState(QUICK_ROOTS_FALLBACK)

  useEffect(() => {
    if (!open) return
    setNewName('')
    setError('')
    let cancelled = false
    void (async () => {
      const { home } = await resolveGatewayHome()
      if (cancelled) return
      setQuickRoots(quickRootsFor(home))
      let start = cleanPath(initialPath || '')
      if (!start || start === '/') {
        try {
          const cwd = host.state.cwd?.get?.()
          // Prefer cwd when it already lives under gateway home.
          if (typeof cwd === 'string' && cwd.trim() && cleanPath(cwd).startsWith(home)) {
            start = cleanPath(cwd)
          } else {
            start = home
          }
        } catch (_) {
          start = home
        }
      }
      setCurrent(start)
    })()
    return () => {
      cancelled = true
    }
  }, [open, initialPath])

  useEffect(() => {
    if (!open) return
    let alive = true
    setLoading(true)
    setError('')
    void listRemoteDirs(current)
      .then(res => {
        if (!alive) return
        setEntries(res.entries || [])
        setError(res.error || '')
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [open, current])

  const crumbs = useMemo(() => {
    const parts = cleanPath(current).split('/').filter(Boolean)
    const out = [{ label: '/', path: '/' }]
    let acc = ''
    for (const part of parts) {
      acc += `/${part}`
      out.push({ label: part, path: acc })
    }
    return out
  }, [current])

  const createHere = async () => {
    const leaf = newName.trim().replace(/[\\/]/g, '')
    if (!leaf || creating) return
    setCreating(true)
    setError('')
    try {
      const full = cleanPath(current === '/' ? `/${leaf}` : `${current}/${leaf}`)
      await mkdirRemote(full)
      setNewName('')
      setCurrent(full)
      try {
        haptic('tap')
      } catch (_) {}
      host.notify({ kind: 'success', message: t('folderCreated', leaf) })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setCreating(false)
    }
  }

  return jsx(Dialog, {
    open,
    onOpenChange: next => {
      if (!next) onClose && onClose()
    },
    children: jsxs(DialogContent, {
      className: 'flex max-h-[min(36rem,calc(100vh-4rem))] max-w-lg flex-col gap-0 overflow-hidden p-0',
      children: [
        jsxs('div', {
          className: 'shrink-0 border-b border-(--ui-stroke-secondary) px-4 py-3',
          children: [
            jsx(DialogTitle, { className: 'text-sm', children: t('browseTitle') }),
            jsx(DialogDescription, {
              className: 'mt-1 text-xs',
              children: t('browseDesc')
            })
          ]
        }),
        jsx('div', {
          className: 'flex shrink-0 flex-wrap items-center gap-1 border-b border-(--ui-stroke-secondary) px-3 py-2',
          children: crumbs.map((crumb, index) =>
            jsx(
              'button',
              {
                type: 'button',
                className: cn(
                  'rounded px-1.5 py-0.5 text-xs text-(--ui-text-tertiary) hover:bg-(--ui-control-hover-background) hover:text-foreground',
                  index === crumbs.length - 1 && 'text-foreground'
                ),
                onClick: () => setCurrent(crumb.path),
                children: crumb.label
              },
              crumb.path
            )
          )
        }),
        jsx('div', {
          className: 'flex shrink-0 flex-wrap gap-1 border-b border-(--ui-stroke-secondary) px-3 py-2',
          children: quickRoots.map(root =>
            jsx(
              'button',
              {
                type: 'button',
                className:
                  'rounded-full border border-(--ui-stroke-tertiary) px-2 py-0.5 text-[0.65rem] text-(--ui-text-secondary) hover:bg-(--ui-control-hover-background)',
                onClick: () => setCurrent(root),
                children: root
              },
              root
            )
          )
        }),
        jsxs('div', {
          className: 'min-h-0 flex-1 overflow-y-auto p-2',
          children: [
            jsxs('button', {
              type: 'button',
              disabled: current === '/',
              className:
                'row-hover flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-(--ui-text-secondary) hover:text-foreground disabled:opacity-40',
              onClick: () => setCurrent(parentPath(current)),
              children: [
                jsx(Codicon, { name: 'arrow-up', size: '0.85rem' }),
                jsx('span', { children: '..' })
              ]
            }),
            loading
              ? jsxs('div', {
                  className: 'flex items-center gap-2 px-2 py-3 text-xs text-(--ui-text-tertiary)',
                  children: [jsx(GlyphSpinner, {}), ' ', t('loadingDirs')]
                })
              : null,
            !loading && error
              ? jsx('div', {
                  className: 'px-2 py-3 text-xs text-red-400',
                  children: error
                })
              : null,
            !loading && !error && entries.length === 0
              ? jsx('div', {
                  className: 'px-2 py-3 text-xs text-(--ui-text-quaternary)',
                  children: t('emptyDir')
                })
              : null,
            entries.map(entry =>
              jsxs(
                'button',
                {
                  type: 'button',
                  className:
                    'row-hover flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-(--ui-text-secondary) hover:text-foreground',
                  onClick: () => setCurrent(entry.path),
                  children: [
                    jsx(Codicon, { name: 'folder', size: '0.875rem' }),
                    jsx('span', { className: 'min-w-0 truncate', children: entry.name })
                  ]
                },
                entry.path
              )
            )
          ]
        }),
        jsxs('div', {
          className: 'shrink-0 border-t border-(--ui-stroke-secondary) px-4 py-2',
          children: [
            jsx('div', {
              className: 'mb-2 truncate font-mono text-[0.65rem] text-(--ui-text-quaternary)',
              title: current,
              children: current
            }),
            jsxs('div', {
              className: 'mb-2 flex gap-2',
              children: [
                jsx(Input, {
                  className: 'flex-1 text-xs',
                  disabled: creating,
                  placeholder: t('newFolderPlaceholder'),
                  value: newName,
                  onChange: e => setNewName(e.target.value),
                  onKeyDown: e => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      void createHere()
                    }
                  }
                }),
                jsx(Button, {
                  type: 'button',
                  size: 'sm',
                  variant: 'secondary',
                  disabled: creating || !newName.trim(),
                  onClick: () => void createHere(),
                  children: creating ? t('creating') : t('createFolder')
                })
              ]
            }),
            jsxs('div', {
              className: 'flex justify-end gap-2',
              children: [
                jsx(Button, {
                  type: 'button',
                  size: 'sm',
                  variant: 'ghost',
                  onClick: () => onClose && onClose(),
                  children: t('cancel')
                }),
                jsx(Button, {
                  type: 'button',
                  size: 'sm',
                  onClick: () => {
                    onSelect && onSelect(current)
                    onClose && onClose()
                  },
                  children: t('useThisFolder')
                })
              ]
            })
          ]
        })
      ]
    })
  })
}

function ProjectFormDialog({ open, mode, initial, defaultProfile, onClose, onSaved }) {
  const t = usePluginI18n(ID)
  const [name, setName] = useState('')
  const [folder, setFolder] = useState('')
  const [description, setDescription] = useState('')
  const [icon, setIcon] = useState(null)
  const [color, setColor] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [browserOpen, setBrowserOpen] = useState(false)
  const [suggestions, setSuggestions] = useState([])
  const [suggestOpen, setSuggestOpen] = useState(false)
  /** 'local' | 'remote' — drives browse affordances. */
  const [backendMode, setBackendMode] = useState('remote')
  /** Live folder list while editing (rename mode). */
  const [editFolders, setEditFolders] = useState([])
  /** Hermes profile this project is pinned to (per-profile projects.db). */
  const [profile, setProfile] = useState(DEFAULT_PROFILE)
  const [profileOptions, setProfileOptions] = useState([
    { name: DEFAULT_PROFILE, displayName: 'default', isDefault: true }
  ])
  const suggestTimer = useRef(null)
  const isLocal = backendMode === 'local'
  const sourceProfile = normalizeProfileKey(
    (initial && (initial.profile || initial._profile)) || defaultProfile || DEFAULT_PROFILE
  )

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void listHermesProfiles().then(rows => {
      if (!cancelled && Array.isArray(rows) && rows.length) setProfileOptions(rows)
    })
    return () => {
      cancelled = true
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    setError('')
    setBusy(false)
    setBrowserOpen(false)
    setSuggestions([])
    setSuggestOpen(false)
    void detectBackendMode().then(m => setBackendMode(m || 'remote'))
    if (mode === 'rename' && initial) {
      setName(initial.name || '')
      setFolder('')
      setEditFolders(folderList(initial))
      setDescription(initial.description || '')
      setIcon(initial.icon || null)
      setColor(initial.color || null)
      setProfile(sourceProfile)
    } else if (mode === 'add-folder' && initial) {
      setName(initial.name || '')
      setFolder('')
      setDescription('')
      setIcon(initial.icon || null)
      setColor(initial.color || null)
      setProfile(sourceProfile)
      void resolveGatewayHome().then(({ home }) => {
        // Seed add-folder path under home so Browse starts somewhere sensible.
        setFolder(prev => prev || home)
      })
    } else {
      setName('')
      setDescription('')
      setIcon('folder-library')
      setColor(null)
      // Create defaults to the page filter, else stock "default" profile.
      setProfile(normalizeProfileKey(defaultProfile || DEFAULT_PROFILE))
      // Default folder = gateway $HOME (always exists). Subdirs are created on demand.
      setFolder(cachedHomeDir || HOME_FALLBACK)
      void resolveGatewayHome().then(({ home }) => {
        setFolder(prev => (!prev || prev === HOME_FALLBACK ? home : prev))
      })
    }
  }, [open, mode, initial, defaultProfile, sourceProfile])


  useEffect(() => {
    if (!open || mode !== 'rename' || !initial) return
    setEditFolders(folderList(initial))
  }, [open, mode, initial, initial && initial.folders, initial && initial.primary_path])

  useEffect(() => {
    return () => {
      if (suggestTimer.current) clearTimeout(suggestTimer.current)
    }
  }, [])

  const title =
    mode === 'rename' ? t('renameTitle') : mode === 'add-folder' ? t('addFolderTitle') : t('createTitle')

  const canSubmit = (() => {
    if (busy) return false
    if (mode === 'rename') return Boolean(name.trim())
    if (mode === 'add-folder') return Boolean(folder.trim())
    return Boolean(name.trim() && folder.trim())
  })()

  const scheduleSuggest = value => {
    if (suggestTimer.current) clearTimeout(suggestTimer.current)
    const next = String(value || '')
    if (!next.trim() || next.trim().length < 2) {
      setSuggestions([])
      setSuggestOpen(false)
      return
    }
    suggestTimer.current = setTimeout(() => {
      void completeRemotePath(next).then(items => {
        setSuggestions(items)
        setSuggestOpen(items.length > 0)
      })
    }, 180)
  }

  const refreshInitialFolders = async () => {
    if (!initial?.id) return
    try {
      const res = await projectsRequest('projects.get', { id: initial.id, profile: sourceProfile })
      const proj = res && res.project
      if (proj) {
        setEditFolders(folderList(proj))
        if (initial) {
          initial.folders = proj.folders || []
          initial.primary_path = proj.primary_path || primaryPath(proj)
        }
      }
    } catch (_) {
      /* list refresh still helps the outer page */
    }
    onSaved && onSaved()
  }

  const validateFolderPath = path => {
    const p = String(path || '').trim()
    if (!p) throw new Error('Folder path required')
    if (!isLocal && looksLikeWindowsPath(p)) {
      throw new Error('Windows paths are not valid on a remote gateway. Use Browse.')
    }
    if (!isLocal && !p.startsWith('/')) {
      throw new Error('Folder should be an absolute path (starts with /).')
    }
    return p
  }

  const onEditAddFolder = async () => {
    if (!initial?.id || busy) return
    setBusy(true)
    setError('')
    try {
      const path = validateFolderPath(folder)
      if (!isLocal) {
        try {
          await mkdirRemote(path)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          if (!/File exists|already exists/i.test(msg)) throw err
        }
      }
      await projectsRequest('projects.add_folder', { id: initial.id, path, profile: sourceProfile })
      setFolder('')
      host.notify({ kind: 'success', message: t('folderAdded', path) })
      await refreshInitialFolders()
      nudgeSidebarProjectTree()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
      host.notify({ kind: 'error', message: msg })
    } finally {
      setBusy(false)
    }
  }

  const onEditSetPrimary = async path => {
    if (!initial?.id || busy) return
    setBusy(true)
    setError('')
    try {
      await projectsRequest('projects.set_primary', { id: initial.id, path, profile: sourceProfile })
      host.notify({ kind: 'success', message: t('primarySet', path) })
      await refreshInitialFolders()
      nudgeSidebarProjectTree()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
      host.notify({ kind: 'error', message: msg })
    } finally {
      setBusy(false)
    }
  }

  const onEditRemoveFolder = async path => {
    if (!initial?.id || busy) return
    if (editFolders.length <= 1) {
      host.notify({ kind: 'warning', message: t('removeLastFolder') })
      return
    }
    setBusy(true)
    setError('')
    try {
      await projectsRequest('projects.remove_folder', { id: initial.id, path, profile: sourceProfile })
      host.notify({ kind: 'success', message: t('folderRemoved', path) })
      await refreshInitialFolders()
      nudgeSidebarProjectTree()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
      host.notify({ kind: 'error', message: msg })
    } finally {
      setBusy(false)
    }
  }

  const submit = async () => {
    if (!canSubmit) return
    setBusy(true)
    setError('')
    try {
      const iconVal = icon || undefined
      const colorVal = color || undefined
      let skipGenericSaved = false
      if (mode === 'create' || mode === 'add-folder') {
        const path = folder.trim()
        if (!isLocal && looksLikeWindowsPath(path)) {
          throw new Error(
            'That looks like a Windows path. This gateway is remote — use an LXC path (e.g. /mnt/labs/…) via Browse.'
          )
        }
        if (!isLocal && path && !path.startsWith('/')) {
          throw new Error('Folder should be an absolute path on the house brain (starts with /).')
        }
        if (isLocal && path && !looksLikeWindowsPath(path) && !path.startsWith('/') && !path.startsWith('~')) {
          throw new Error('Folder should be an absolute path the local Hermes can open.')
        }
      }
      const targetProfile = normalizeProfileKey(profile || DEFAULT_PROFILE)
      if (mode === 'create') {
        const path = folder.trim()
        // Create the directory if needed (e.g. ~/my-app) — home itself already exists.
        if (!isLocal) {
          try {
            await mkdirRemote(path)
          } catch (err) {
            // If it already exists, mkdir -p is fine; real failures surface.
            const msg = err instanceof Error ? err.message : String(err)
            if (!/File exists|already exists/i.test(msg)) throw err
          }
        }
        await projectsRequest('projects.create', {
          profile: targetProfile,
          name: name.trim(),
          folders: [path],
          primary_path: path,
          description: description.trim() || undefined,
          icon: iconVal,
          color: colorVal,
          use: true
        })
      } else if (mode === 'rename' && initial) {
        const meta = {
          name: name.trim(),
          description: description.trim() || '',
          icon: icon == null ? '' : icon,
          color: color == null ? '' : color
        }
        if (targetProfile === sourceProfile) {
          await projectsRequest('projects.update', {
            profile: sourceProfile,
            id: initial.id,
            ...meta
          })
        } else {
          // Move pin: recreate under the target profile's projects.db, then drop source.
          const folders = (editFolders.length ? editFolders : folderList(initial)).map(f => f.path).filter(Boolean)
          if (!folders.length) throw new Error('Project needs at least one folder to move profiles')
          const primary =
            (editFolders.find(f => f.isPrimary) || editFolders[0] || {}).path ||
            initial.primary_path ||
            folders[0]
          const created = await projectsRequest('projects.create', {
            profile: targetProfile,
            name: meta.name,
            folders,
            primary_path: primary,
            description: meta.description || undefined,
            icon: meta.icon || undefined,
            color: meta.color || undefined,
            use: false
          })
          try {
            await projectsRequest('projects.delete', { profile: sourceProfile, id: initial.id })
          } catch (delErr) {
            // Best-effort cleanup of the new copy if source delete fails hard.
            const newId = created && created.project && created.project.id
            if (newId) {
              try {
                await projectsRequest('projects.delete', { profile: targetProfile, id: newId })
              } catch (_) {}
            }
            throw delErr
          }
          skipGenericSaved = true
          host.notify({
            kind: 'success',
            message: t('movedProfile', meta.name, targetProfile)
          })
        }
      } else if (mode === 'add-folder' && initial) {
        const path = folder.trim()
        if (!isLocal) {
          try {
            await mkdirRemote(path)
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            if (!/File exists|already exists/i.test(msg)) throw err
          }
        }
        await projectsRequest('projects.add_folder', {
          profile: sourceProfile,
          id: initial.id,
          path
        })
      }
      try {
        haptic('tap')
      } catch (_) {}
      if (!skipGenericSaved) host.notify({ kind: 'success', message: t('saved') })
      // Sidebar tree is a separate client cache — push appearance + force refresh.
      try {
        paintSidebarProjectLook({
          name: name.trim() || (initial && initial.name) || '',
          icon: iconVal || (initial && initial.icon) || 'folder-library',
          color: colorVal || null
        })
      } catch (_) {}
      nudgeSidebarProjectTree()
      onSaved && onSaved()
      onClose && onClose()
      // One more nudge after dialog unmounts / list invalidates.
      try {
        window.setTimeout(() => nudgeSidebarProjectTree(), 600)
      } catch (_) {}
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err || 'failed')
      setError(msg)
      host.notify({ kind: 'error', message: msg })
    } finally {
      setBusy(false)
    }
  }

  return jsxs(Fragment, {
    children: [
      jsx(Dialog, {
        open,
        onOpenChange: next => {
          if (!next && !busy) onClose && onClose()
        },
        children: jsxs(DialogContent, {
          className: 'max-h-[min(36rem,calc(100vh-4rem))] max-w-md overflow-y-auto',
          onInteractOutside: e => {
            if (busy) e.preventDefault()
          },
          children: [
            jsxs(DialogHeader, {
              children: [
                jsx(DialogTitle, { children: title }),
                mode === 'create' ? jsx(DialogDescription, { children: t('createDesc') }) : null
              ]
            }),
            mode !== 'add-folder'
              ? jsxs('div', {
                  className: 'flex flex-col gap-1.5',
                  children: [
                    jsx('span', {
                      className: 'text-[0.6875rem] font-medium text-(--ui-text-tertiary)',
                      children: t('nameLabel')
                    }),
                    jsx(Input, {
                      autoFocus: true,
                      disabled: busy,
                      value: name,
                      placeholder: t('namePlaceholder'),
                      onChange: e => setName(e.target.value),
                      onKeyDown: e => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          void submit()
                        }
                      }
                    })
                  ]
                })
              : null,
            mode === 'create' || mode === 'rename'
              ? jsxs('div', {
                  className: 'flex flex-col gap-1.5',
                  children: [
                    jsx('span', {
                      className: 'text-[0.6875rem] font-medium text-(--ui-text-tertiary)',
                      children: t('profileLabel')
                    }),
                    jsx(ProfileSelect, {
                      value: profile,
                      disabled: busy,
                      options: profileOptions,
                      onChange: setProfile
                    }),
                    jsx('p', {
                      className: 'text-[0.65rem] text-(--ui-text-quaternary)',
                      children:
                        mode === 'rename' && normalizeProfileKey(profile) !== sourceProfile
                          ? t('profileMoveHint', sourceProfile, normalizeProfileKey(profile))
                          : t('profileHint')
                    })
                  ]
                })
              : null,
            mode === 'create' || mode === 'add-folder'
              ? jsxs('div', {
                  className: 'relative flex flex-col gap-1.5',
                  children: [
                    jsx('span', {
                      className: 'text-[0.6875rem] font-medium text-(--ui-text-tertiary)',
                      children: isLocal ? t('folderLabelLocal') : t('folderLabel')
                    }),
                    jsxs('div', {
                      className: 'flex gap-2',
                      children: [
                        jsx(Input, {
                          className: 'flex-1 font-mono text-xs',
                          disabled: busy,
                          value: folder,
                          placeholder: isLocal ? t('folderPlaceholderLocal') : t('folderPlaceholder'),
                          onChange: e => {
                            setFolder(e.target.value)
                            if (!isLocal) scheduleSuggest(e.target.value)
                          },
                          onFocus: () => {
                            if (!isLocal && suggestions.length) setSuggestOpen(true)
                          },
                          onBlur: () => {
                            setTimeout(() => setSuggestOpen(false), 150)
                          },
                          onKeyDown: e => {
                            if (e.key === 'Enter') {
                              e.preventDefault()
                              void submit()
                            }
                          }
                        }),
                        // ONE primary Browse — remote browser or native PC dialog.
                        jsx(Button, {
                          type: 'button',
                          variant: 'secondary',
                          disabled: busy,
                          onClick: () => {
                            if (isLocal) {
                              void pickLocalDirectory().then(dir => {
                                if (dir) setFolder(dir)
                              })
                            } else {
                              setBrowserOpen(true)
                            }
                          },
                          children: jsxs(Fragment, {
                            children: [
                              jsx(Codicon, {
                                name: 'folder-opened',
                                size: '0.75rem',
                                className: 'mr-1'
                              }),
                              t('browse')
                            ]
                          })
                        })
                      ]
                    }),
                    !isLocal && suggestOpen && suggestions.length
                      ? jsx('div', {
                          className:
                            'absolute top-[4.25rem] z-20 max-h-40 w-full overflow-auto rounded-md border border-(--ui-stroke-secondary) bg-(--ui-control-background,var(--card)) py-1 shadow-md',
                          children: suggestions.map(item =>
                            jsx(
                              'button',
                              {
                                type: 'button',
                                className:
                                  'flex w-full items-center gap-2 px-2 py-1.5 text-left font-mono text-[0.7rem] text-(--ui-text-secondary) hover:bg-(--ui-control-hover-background) hover:text-foreground',
                                onMouseDown: e => e.preventDefault(),
                                onClick: () => {
                                  setFolder(item.path)
                                  setSuggestOpen(false)
                                },
                                children: item.path
                              },
                              item.path
                            )
                          )
                        })
                      : null,
                    // Local-only optional second path: still can open remote browser
                    // if someone points a local Desktop at a weird dual setup — skip.
                    isLocal
                      ? jsx('p', {
                          className: 'text-[0.65rem] text-(--ui-text-quaternary)',
                          children: t('folderLocalHint')
                        })
                      : jsx('p', {
                          className: 'text-[0.65rem] text-(--ui-text-quaternary)',
                          children: t('folderRemoteHint')
                        })
                  ]
                })
              : null,
            mode === 'create' || mode === 'rename'
              ? jsx(AppearancePicker, {
                  icon,
                  color,
                  disabled: busy,
                  onIcon: setIcon,
                  onColor: setColor
                })
              : null,
            mode === 'rename' && initial
              ? jsxs('div', {
                  className: 'flex flex-col gap-1.5',
                  children: [
                    jsx('span', {
                      className: 'text-[0.6875rem] font-medium text-(--ui-text-tertiary)',
                      children: t('foldersSection')
                    }),
                    (editFolders.length
                      ? jsx('ul', {
                          className: 'flex flex-col gap-1',
                          children: editFolders.map(f =>
                            jsxs(
                              'li',
                              {
                                className:
                                  'flex items-center gap-1.5 rounded-md border border-(--ui-stroke-secondary) bg-(--ui-control-hover-background) px-2 py-1.5',
                                children: [
                                  jsx('i', {
                                    'aria-hidden': true,
                                    className: 'codicon codicon-folder shrink-0 text-(--ui-text-tertiary)',
                                    style: { fontSize: '0.75rem' }
                                  }),
                                  jsx('span', {
                                    className:
                                      'min-w-0 flex-1 truncate font-mono text-[0.7rem] text-(--ui-text-secondary)',
                                    title: f.path,
                                    children: f.path
                                  }),
                                  f.isPrimary
                                    ? jsx('span', {
                                        className:
                                          'shrink-0 rounded-[3px] px-1 py-0.5 text-[0.6rem] uppercase text-(--ui-text-quaternary)',
                                        children: t('primaryBadge')
                                      })
                                    : jsx(Button, {
                                        type: 'button',
                                        size: 'sm',
                                        variant: 'secondary',
                                        className: 'h-6 shrink-0 px-1.5 text-[0.65rem]',
                                        disabled: busy,
                                        onClick: () => void onEditSetPrimary(f.path),
                                        children: t('makePrimary')
                                      }),
                                  jsx(Tip, {
                                    label: t('removeFolderTip'),
                                    children: jsx(Button, {
                                      type: 'button',
                                      size: 'sm',
                                      variant: 'ghost',
                                      className: 'h-6 shrink-0 px-1 text-(--ui-text-quaternary) hover:text-red-400',
                                      disabled: busy,
                                      onClick: () => void onEditRemoveFolder(f.path),
                                      children: jsx('i', {
                                        'aria-hidden': true,
                                        className: 'codicon codicon-close',
                                        style: { fontSize: '0.7rem' }
                                      })
                                    })
                                  })
                                ]
                              },
                              f.path
                            )
                          )
                        })
                      : jsx('p', {
                          className: 'text-[0.7rem] text-(--ui-text-quaternary)',
                          children: t('noFolder')
                        })),
                    jsxs('div', {
                      className: 'flex gap-2',
                      children: [
                        jsx(Input, {
                          className: 'flex-1 font-mono text-xs',
                          disabled: busy,
                          value: folder,
                          placeholder: isLocal ? t('folderPlaceholderLocal') : t('folderPlaceholder'),
                          onChange: e => {
                            setFolder(e.target.value)
                            if (!isLocal) scheduleSuggest(e.target.value)
                          }
                        }),
                        jsx(Button, {
                          type: 'button',
                          variant: 'secondary',
                          disabled: busy,
                          onClick: () => {
                            if (isLocal) {
                              void pickLocalDirectory().then(dir => {
                                if (dir) setFolder(dir)
                              })
                            } else {
                              setBrowserOpen(true)
                            }
                          },
                          children: t('browse')
                        }),
                        jsx(Button, {
                          type: 'button',
                          disabled: busy || !folder.trim(),
                          onClick: () => void onEditAddFolder(),
                          children: t('addFolder')
                        })
                      ]
                    }),
                    jsx('p', {
                      className: 'text-[0.65rem] text-(--ui-text-quaternary)',
                      children: t('editFoldersHint')
                    })
                  ]
                })
              : null,
            mode === 'create' || mode === 'rename'
              ? jsxs('div', {
                  className: 'flex flex-col gap-1.5',
                  children: [
                    jsx('span', {
                      className: 'text-[0.6875rem] font-medium text-(--ui-text-tertiary)',
                      children: t('descLabel')
                    }),
                    jsx(Textarea, {
                      disabled: busy,
                      value: description,
                      placeholder: t('descPlaceholder'),
                      rows: 3,
                      onChange: e => setDescription(e.target.value)
                    })
                  ]
                })
              : null,
            error ? jsx('p', { className: 'text-xs text-red-400', children: error }) : null,
            jsxs(DialogFooter, {
              className: 'gap-2',
              children: [
                jsx(Button, {
                  type: 'button',
                  variant: 'ghost',
                  disabled: busy,
                  onClick: () => onClose && onClose(),
                  children: t('cancel')
                }),
                jsx(Button, {
                  type: 'button',
                  disabled: !canSubmit,
                  onClick: () => void submit(),
                  children: busy ? t('saving') : mode === 'create' ? t('create') : t('save')
                })
              ]
            })
          ]
        })
      }),
      jsx(RemoteFolderBrowser, {
        open: browserOpen,
        initialPath: folder || undefined,
        onClose: () => setBrowserOpen(false),
        onSelect: path => setFolder(path)
      })
    ]
  })
}

function folderList(project) {
  const folders = Array.isArray(project?.folders) ? project.folders : []
  return folders
    .filter(f => f && f.path)
    .map(f => ({
      path: String(f.path),
      isPrimary: Boolean(f.is_primary) || f.path === project.primary_path,
      label: f.label || null
    }))
}

function ProjectRow({ project, activeId, onRename, onDelete }) {
  const t = usePluginI18n(ID)
  const isActive = project.id === activeId
  const description = String(project.description || '').trim()
  const folders = folderList(project)

  const stop = e => {
    e.preventDefault()
    e.stopPropagation()
  }

  return jsxs('div', {
    role: 'button',
    tabIndex: 0,
    title: t('rowEditTip'),
    className: cn(
      'group relative flex cursor-pointer items-start gap-3 rounded-lg border border-(--ui-stroke-secondary) px-3 py-2.5 pr-10 transition-colors',
      'hover:border-(--ui-stroke-tertiary) hover:bg-(--ui-control-hover-background)/40',
      'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50',
      isActive && 'border-(--ui-accent)/40'
    ),
    onClick: () => onRename(project),
    onKeyDown: e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onRename(project)
      }
    },
    children: [
      jsx(Tip, {
        label: t('delete'),
        children: jsx('button', {
          type: 'button',
          'aria-label': t('delete'),
          className:
            'absolute top-2 right-2 grid size-7 place-items-center rounded-md text-(--ui-text-quaternary) transition hover:bg-red-500/10 hover:text-red-400',
          onClick: e => {
            stop(e)
            onDelete(project)
          },
          children: jsx('i', {
            'aria-hidden': true,
            className: 'codicon codicon-trash',
            style: { fontSize: '0.85rem', lineHeight: 1 }
          })
        })
      }),
      jsx('div', {
        className: 'mt-0.5 grid size-8 shrink-0 place-items-center rounded-md bg-(--ui-control-hover-background)',
        style: project.color ? { color: project.color } : undefined,
        children: jsx('i', {
          'aria-hidden': true,
          className: cn('codicon', `codicon-${project.icon || 'folder-library'}`),
          style: { fontSize: '1rem', lineHeight: 1 }
        })
      }),
      jsxs('div', {
        className: 'min-w-0 flex-1',
        children: [
          jsxs('div', {
            className: 'flex flex-wrap items-center gap-2',
            children: [
              jsx('span', {
                className: 'truncate text-sm font-medium text-foreground',
                children: project.name
              }),
              isActive
                ? jsx('span', {
                    className:
                      'rounded-[3px] bg-primary/10 px-1.5 py-0.5 text-[0.65rem] font-medium text-primary',
                    children: t('active')
                  })
                : null
            ]
          }),
          description
            ? jsx('div', {
                className: 'mt-0.5 line-clamp-2 text-[0.75rem] leading-snug text-(--ui-text-secondary)',
                title: description,
                children: description
              })
            : null,
          folders.length === 0
            ? jsx('div', {
                className: 'mt-0.5 font-mono text-[0.6875rem] text-(--ui-text-quaternary)',
                children: t('noFolder')
              })
            : jsx('ul', {
                className: 'mt-1.5 flex flex-col gap-1',
                children: folders.map(f =>
                  jsxs(
                    'li',
                    {
                      className:
                        'flex items-center gap-1.5 rounded-md border border-(--ui-stroke-secondary)/60 bg-(--ui-control-hover-background) px-2 py-1',
                      children: [
                        jsx('i', {
                          'aria-hidden': true,
                          className: 'codicon codicon-folder shrink-0 text-(--ui-text-tertiary)',
                          style: { fontSize: '0.75rem' }
                        }),
                        jsx('span', {
                          className:
                            'min-w-0 flex-1 truncate font-mono text-[0.6875rem] text-(--ui-text-secondary)',
                          title: f.path,
                          children: f.path
                        }),
                        f.isPrimary
                          ? jsx('span', {
                              className:
                                'shrink-0 rounded-[3px] px-1 py-0.5 text-[0.6rem] uppercase tracking-wide text-(--ui-text-quaternary)',
                              children: t('primaryBadge')
                            })
                          : null
                      ]
                    },
                    f.path
                  )
                )
              })
        ]
      })
    ]
  })
}

function ProjectsPage() {
  const t = usePluginI18n(ID)
  const qc = useQueryClient()
  const deskProfile = useValue(host.state.profile)
  const [dialog, setDialog] = useState(null)
  const [pendingDelete, setPendingDelete] = useState(null)
  // List follows the active Desktop profile (no page-header picker — profile
  // is chosen on create/edit). Unset / all-profiles → stock default.
  const profile = normalizeProfileKey(
    typeof deskProfile === 'string' && deskProfile && deskProfile !== '__all__' && deskProfile !== 'all'
      ? deskProfile
      : DEFAULT_PROFILE
  )

  const listQuery = useQuery({
    queryKey: [...QUERY_KEY, profile],
    queryFn: async () => {
      const res = await projectsRequest('projects.list', { profile })
      const raw = (res && res.projects) || []
      const stamped = Array.isArray(raw)
        ? raw.map(p => (p && typeof p === 'object' ? { ...p, profile, _profile: profile } : p))
        : []
      return { ...(res || {}), projects: stamped }
    },
    refetchInterval: 15_000,
    retry: 1
  })

  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: QUERY_KEY })
  }, [qc])

  const allProjects = useMemo(() => {
    const raw = (listQuery.data && listQuery.data.projects) || []
    return Array.isArray(raw) ? raw.filter(p => !p.archived) : []
  }, [listQuery.data])

  const activeId = (listQuery.data && listQuery.data.active_id) || null

  const projectProfileOf = project =>
    normalizeProfileKey((project && (project.profile || project._profile)) || profile)

  const onSetActive = async project => {
    try {
      await projectsRequest('projects.set_active', {
        id: project.id,
        profile: projectProfileOf(project)
      })
      host.notify({ kind: 'success', message: t('activated', project.name) })
      refresh()
      nudgeSidebarProjectTree()
    } catch (err) {
      host.notify({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err)
      })
    }
  }

  const onSetPrimary = async (project, path) => {
    try {
      await projectsRequest('projects.set_primary', {
        id: project.id,
        path,
        profile: projectProfileOf(project)
      })
      host.notify({ kind: 'success', message: t('primarySet', path) })
      refresh()
      nudgeSidebarProjectTree()
    } catch (err) {
      host.notify({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err)
      })
    }
  }

  const onRemoveFolder = async (project, path) => {
    const folders = folderList(project)
    if (folders.length <= 1) {
      host.notify({
        kind: 'warning',
        message: t('removeLastFolder')
      })
      return
    }
    try {
      await projectsRequest('projects.remove_folder', {
        id: project.id,
        path,
        profile: projectProfileOf(project)
      })
      host.notify({ kind: 'success', message: t('folderRemoved', path) })
      refresh()
      nudgeSidebarProjectTree()
    } catch (err) {
      host.notify({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err)
      })
    }
  }

  const onDeleteConfirm = async () => {
    const project = pendingDelete
    if (!project) return
    const pProf = projectProfileOf(project)
    try {
      await projectsRequest('projects.delete', { id: project.id, profile: pProf })
      host.notify({ kind: 'success', message: t('deleted', project.name) })
      setPendingDelete(null)
      refresh()
    } catch (err) {
      try {
        await projectsRequest('projects.archive', { id: project.id, profile: pProf })
        host.notify({ kind: 'success', message: t('archivedOk', project.name) })
        setPendingDelete(null)
        refresh()
      } catch (err2) {
        host.notify({
          kind: 'error',
          message: err2 instanceof Error ? err2.message : String(err2)
        })
      }
    }
  }

  return jsxs('div', {
    className: 'flex h-full min-h-0 flex-col bg-transparent',
    'data-projects-manager': 'page',
    children: [
      jsxs('div', {
        className: 'flex shrink-0 items-center gap-2 border-b border-(--ui-stroke-secondary) px-4 py-3',
        children: [
          jsx(Codicon, {
            name: 'folder-library',
            size: '1.1rem',
            className: 'text-(--ui-text-tertiary)'
          }),
          jsxs('div', {
            className: 'min-w-0 flex-1',
            children: [
              jsx('div', { className: 'text-sm font-medium text-foreground', children: t('title') }),
              jsx('div', {
                className: 'text-[0.6875rem] text-(--ui-text-quaternary)',
                children: t('subtitle', String(profile || DEFAULT_PROFILE))
              })
            ]
          }),
          jsx(Tip, {
            label: t('refresh'),
            children: jsx(Button, {
              size: 'sm',
              variant: 'ghost',
              type: 'button',
              onClick: () => {
                try {
                  haptic('tap')
                } catch (_) {}
                refresh()
              },
              children: jsx(Codicon, { name: 'refresh', size: '0.85rem' })
            })
          }),
          jsx(Button, {
            size: 'sm',
            type: 'button',
            onClick: () => {
              try {
                haptic('tap')
              } catch (_) {}
              setDialog({ mode: 'create' })
            },
            children: jsxs(Fragment, {
              children: [jsx(Codicon, { name: 'add', size: '0.75rem', className: 'mr-1' }), t('newProject')]
            })
          })
        ]
      }),

      jsx(ScrollArea, {
        className: 'min-h-0 flex-1',
        children: jsxs('div', {
          className: 'flex flex-col gap-2 p-4',
          children: [
            listQuery.isLoading
              ? jsxs('div', {
                  className: 'flex items-center gap-2 py-8 text-sm text-(--ui-text-tertiary)',
                  children: [jsx(GlyphSpinner, {}), ' ', t('loading')]
                })
              : null,

            listQuery.isError
              ? jsx(ErrorState, {
                  title: t('loadFailed'),
                  description:
                    listQuery.error instanceof Error
                      ? listQuery.error.message
                      : String(listQuery.error || ''),
                  children: jsx(Button, {
                    size: 'sm',
                    variant: 'outline',
                    type: 'button',
                    onClick: () => refresh(),
                    children: t('retry')
                  })
                })
              : null,

            !listQuery.isLoading && !listQuery.isError && allProjects.length === 0
              ? jsxs('div', {
                  className: 'flex flex-col items-center gap-3 py-6',
                  children: [
                    jsx(EmptyState, {
                      title: t('emptyTitle'),
                      description: t('emptyDesc')
                    }),
                    jsx(Button, {
                      size: 'sm',
                      type: 'button',
                      onClick: () => setDialog({ mode: 'create' }),
                      children: t('newProject')
                    })
                  ]
                })
              : null,

            allProjects.map(project =>
              jsx(
                ProjectRow,
                {
                  project,
                  activeId,
                  onRename: p => setDialog({ mode: 'rename', project: p }),
                  onDelete: p => setPendingDelete(p)
                },
                project.id
              )
            )
          ]
        })
      }),

      dialog
        ? jsx(ProjectFormDialog, {
            open: true,
            mode: dialog.mode,
            defaultProfile: profile,
            initial:
              (dialog.project &&
                allProjects.find(p => p.id === dialog.project.id)) ||
              dialog.project ||
              null,
            onClose: () => setDialog(null),
            onSaved: () => {
              // If edit moved the pin, jump the filter to the destination when known.
              refresh()
            }
          })
        : null,

      jsx(ConfirmDialog, {
        open: Boolean(pendingDelete),
        title: pendingDelete ? t('deleteTitle', pendingDelete.name) : t('delete'),
        description: t('deleteConfirm'),
        confirmLabel: t('delete'),
        destructive: true,
        onClose: () => setPendingDelete(null),
        onConfirm: () => void onDeleteConfirm()
      })
    ]
  })
}


function ProjectsStatusChip() {
  const t = usePluginI18n(ID)
  const qc = useQueryClient()
  const profile = normalizeProfileKey(useValue(host.state.profile) || profileName())

  const listQuery = useQuery({
    queryKey: [...QUERY_KEY, profile, 'statusbar'],
    queryFn: async () => projectsRequest('projects.list', { profile }),
    refetchInterval: 15_000,
    retry: 1
  })

  const projects = useMemo(() => {
    const raw = (listQuery.data && listQuery.data.projects) || []
    return Array.isArray(raw) ? raw.filter(p => !p.archived) : []
  }, [listQuery.data])

  const activeId = (listQuery.data && listQuery.data.active_id) || null
  const active = projects.find(p => p && p.id === activeId) || null

  const refreshLists = () => {
    void qc.invalidateQueries({ queryKey: QUERY_KEY })
  }

  const activate = async project => {
    try {
      await projectsRequest('projects.set_active', { id: project.id, profile })
      try {
        haptic('tap')
      } catch (_) {}
      host.notify({ kind: 'success', message: t('activated', project.name) })
      refreshLists()
      nudgeSidebarProjectTree()
    } catch (err) {
      host.notify({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err)
      })
    }
  }

  const clearActive = async () => {
    try {
      await projectsRequest('projects.set_active', { id: null, profile })
      try {
        haptic('tap')
      } catch (_) {}
      host.notify({ kind: 'success', message: t('clearedActive') })
      refreshLists()
      nudgeSidebarProjectTree()
    } catch (err) {
      host.notify({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err)
      })
    }
  }

  const triggerLabel = active
    ? jsxs(Fragment, {
        children: [
          jsx('span', {
            key: 'p',
            className: 'text-(--ui-text-quaternary)',
            children: t('chipProjectPrefix')
          }),
          jsx('i', {
            key: 'i',
            'aria-hidden': true,
            className: cn('codicon', `codicon-${active.icon || 'folder-library'}`),
            style: {
              fontSize: '0.7rem',
              lineHeight: 1,
              color: active.color || undefined
            }
          }),
          jsx('span', {
            key: 'n',
            className: 'max-w-[9rem] truncate font-medium text-foreground',
            children: active.name
          })
        ]
      })
    : jsxs(Fragment, {
        children: [
          jsx('i', {
            key: 'i',
            'aria-hidden': true,
            className: 'codicon codicon-folder-library',
            style: { fontSize: '0.7rem', lineHeight: 1 }
          }),
          jsx('span', { key: 't', children: t('title') })
        ]
      })

  return jsx(DropdownMenu, {
    children: jsxs(Fragment, {
      children: [
        jsx(DropdownMenuTrigger, {
          asChild: true,
          children: jsx('button', {
            type: 'button',
            title: active ? t('chipActiveTip', active.name) : t('chipIdleTip'),
            className: cn(
              'inline-flex h-full max-w-[14rem] items-center gap-1 px-1.5 text-[0.6875rem] transition-colors',
              'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
            ),
            children: triggerLabel
          })
        }),
        jsxs(DropdownMenuContent, {
          align: 'end',
          className: 'min-w-[14rem] max-w-[18rem]',
          children: [
            listQuery.isLoading
              ? jsx(DropdownMenuItem, {
                  disabled: true,
                  children: t('loading')
                })
              : null,
            !listQuery.isLoading && projects.length === 0
              ? jsx(DropdownMenuItem, {
                  disabled: true,
                  children: t('emptyTitle')
                })
              : null,
            ...projects.map(p => {
              const isOn = p.id === activeId
              return jsx(
                DropdownMenuItem,
                {
                  onSelect: () => {
                    void activate(p)
                  },
                  className: 'gap-2',
                  children: [
                    jsx('i', {
                      key: 'i',
                      'aria-hidden': true,
                      className: cn('codicon', `codicon-${p.icon || 'folder-library'}`, 'shrink-0'),
                      style: {
                        fontSize: '0.8rem',
                        lineHeight: 1,
                        color: p.color || undefined
                      }
                    }),
                    jsx('span', {
                      key: 'n',
                      className: 'min-w-0 flex-1 truncate',
                      children: p.name
                    }),
                    isOn
                      ? jsx('i', {
                          key: 'c',
                          'aria-hidden': true,
                          className: 'codicon codicon-check shrink-0 text-primary',
                          style: { fontSize: '0.75rem' }
                        })
                      : null
                  ]
                },
                p.id
              )
            }),
            jsx(DropdownMenuSeparator, {}),
            active
              ? jsx(DropdownMenuItem, {
                  onSelect: () => {
                    void clearActive()
                  },
                  children: t('clearActive')
                })
              : null,
            jsx(DropdownMenuItem, {
              onSelect: () => openProjects(),
              children: t('manageProjects')
            })
          ].filter(Boolean)
        })
      ]
    })
  })
}


export default {
  id: ID,
  name: 'Projects',
  description: 'Create and manage named workspace projects — pin each to a Hermes profile (default if unset).',
  defaultEnabled: true,
  register(ctx) {
    ctx.i18n.register({
      en: {
        title: 'Projects',
        subtitle: profile => `Named workspaces · profile ${profile}`,
        newProject: 'New project',
        refresh: 'Refresh',
        loading: 'Loading projects…',
        loadFailed: 'Could not load projects',
        retry: 'Retry',
        emptyTitle: 'No projects yet',
        emptyDesc: 'Create a named workspace with at least one folder on the house brain.',
        createTitle: 'New project',
        createDesc: 'Name it, pick a profile + icon, and point it at a folder the backend can see.',
        renameTitle: 'Edit project',
        addFolderTitle: 'Add folder',
        nameLabel: 'Name',
        namePlaceholder: 'e.g. House Presence',
        profileLabel: 'Profile',
        profileFilterLabel: 'Profile',
        profileHint: 'Pins this project to a Hermes profile (projects.db is per-profile). Leave as default if unsure.',
        profileMoveHint: (from, to) => `Saving will move this project from “${from}” → “${to}”.`,
        movedProfile: (name, to) => `Moved “${name}” to profile ${to}`,
        folderLabel: 'Folder (gateway home)',
        folderLabelLocal: 'Folder (this PC)',
        folderPlaceholder: '~/…  (gateway $HOME)',
        folderPlaceholderLocal: 'C:\\… or /Users/…',
        folderRemoteHint: 'Remote gateway — Browse starts at $HOME. New folders are created when you need them.',
        folderLocalHint: 'Local gateway — Browse opens a native folder dialog on this PC.',
        descLabel: 'Description (optional)',
        descPlaceholder: 'What is this project for?',
        appearanceLabel: 'Icon & color',
        appearanceHint: 'Click the icon to change it. Color tints the sidebar glyph.',
        pickIconTip: 'Choose icon',
        pickIconTitle: 'Project icon',
        closeIconPicker: 'Close',
        noColor: 'No color',
        colored: 'Custom color',
        browse: 'Browse',
        browseTitle: 'Choose folder on backend',
        browseDesc: 'Starts at gateway $HOME. Use New folder for a subdir when you need one.',
        loadingDirs: 'Listing…',
        emptyDir: 'No subfolders here',
        newFolderPlaceholder: 'new-folder-name',
        createFolder: 'New folder',
        creating: 'Creating…',
        folderCreated: name => `Created ${name}`,
        useThisFolder: 'Use this folder',
        cancel: 'Cancel',
        create: 'Create',
        save: 'Save',
        saving: 'Saving…',
        saved: 'Project saved',
        active: 'Active',
        noFolder: 'No folder',
        setActive: 'Set active',
        edit: 'Edit',
        rowEditTip: 'Click to edit project',
        addFolder: 'Add folder',
        foldersSection: 'Folders',
        editFoldersHint: 'Add another workspace root, or detach one. Files on disk are never deleted.',
        folderAdded: path => `Added ${path}`,

        primaryBadge: 'primary',
        makePrimary: 'Primary',
        removeFolderTip: 'Detach folder from project (files stay on disk)',
        primarySet: path => `Primary → ${path}`,
        folderRemoved: path => `Removed ${path}`,
        removeLastFolder: 'Keep at least one folder, or delete the whole project.',
        delete: 'Delete',
        deleteTitle: name => `Delete “${name}”?`,
        deleteConfirm:
          'Removes the project record only. Sessions stay in history — they just stop grouping under this name. Files and git repos on disk are untouched.',
        deleted: name => `Deleted ${name}`,
        archivedOk: name => `Archived ${name}`,
        activated: name => `Active project: ${name}`,
        clearedActive: 'Cleared active project',
        clearActive: 'Clear active',
        manageProjects: 'Manage projects…',
        chipProjectPrefix: 'Project:',
        chipIdleTip: 'Pick an active project',
        chipActiveTip: name => `Active: ${name} — click to switch`
      }
    })

    const uninstall = installNavBridge()
    ctx.onDispose(() => {
      uninstall()
      try {
        if (typeof closeWorkspace === 'function') closeWorkspace()
      } catch (_) {}
      closeWorkspace = null
    })

    ctx.registerMany([
      {
        id: 'page',
        area: AREA_ROUTES,
        title: 'Projects',
        data: { path: ROUTE },
        render: () => jsx(ProjectsPage, {})
      },
      {
        id: 'nav',
        area: AREA_NAV,
        order: 45,
        data: {
          path: ROUTE,
          label: 'Projects',
          codicon: 'folder-library'
        }
      },
      {
        id: 'chip',
        area: 'statusBar.right',
        order: 95,
        render: () => jsx(ProjectsStatusChip, {})
      },
      {
        id: 'palette-open',
        area: AREA_PALETTE,
        data: {
          id: 'projects-manager.open',
          label: 'Projects — manage workspaces',
          keywords: ['project', 'workspace', 'folder', 'icon'],
          run: () => openProjects()
        }
      },
      {
        id: 'palette-new',
        area: AREA_PALETTE,
        data: {
          id: 'projects-manager.new',
          label: 'New project…',
          keywords: ['project', 'create', 'new workspace'],
          run: () => openProjects()
        }
      }
    ])
  }
}
