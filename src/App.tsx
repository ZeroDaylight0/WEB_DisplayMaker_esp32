import { useEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent } from 'react'
import {
  ArrowDown, ArrowUp, Check, ChevronDown, Circle, Code2, Copy, Download, Eye, FileCode2,
  Cloud, FolderOpen, Grid2X2, Image, Layers3, LogOut, Minus, Monitor, MoreHorizontal, Plus, Search, Settings2,
  Redo2, Save, Sparkles, Square, Type, Undo2, UserRound, Wifi, X, ZoomIn, ZoomOut,
} from 'lucide-react'
import { generateCode, type CodeTarget } from './codegen'
import { displays, initialElements } from './displays'
import { parseDisplaySource, updateImportedSource } from './source-import'
import { deleteCloudProject, getCloudProjects, getCurrentUser, loadCloudProject, saveCloudProject, signIn, signOut, type AccountUser, type CloudProjectSummary } from './cloud'
import type { CanvasElement, DisplayKind, DisplayPreset, Project } from './types'

const STORAGE_KEY = 'pixelforge-project-v1'
const SOURCE_IMPORT_VERSION = 7
const categories: (DisplayKind | 'All')[] = ['All', 'OLED', 'TFT', 'E-Paper', 'LED Matrix']
const elementKinds: CanvasElement['kind'][] = ['text', 'rect', 'circle', 'line', 'image']

function isProject(value: unknown): value is Project {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.name === 'string'
    && (candidate.cloudProjectId === undefined || typeof candidate.cloudProjectId === 'string')
    && (candidate.cloudOwnerId === undefined || typeof candidate.cloudOwnerId === 'string')
    && typeof candidate.displayId === 'string'
    && Number.isFinite(candidate.width) && Number(candidate.width) >= 8 && Number(candidate.width) <= 2048
    && Number.isFinite(candidate.height) && Number(candidate.height) >= 8 && Number(candidate.height) <= 2048
    && typeof candidate.color === 'boolean'
    && (candidate.sourceImportVersion === undefined || Number.isInteger(candidate.sourceImportVersion))
    && (candidate.sourceCode === undefined || typeof candidate.sourceCode === 'string')
    && (candidate.sourceFormat === undefined || candidate.sourceFormat === 'arduino' || candidate.sourceFormat === 'esphome')
    && Array.isArray(candidate.elements)
    && candidate.elements.every((element: unknown) => {
      if (!element || typeof element !== 'object') return false
      const item = element as Record<string, unknown>
      return typeof item.id === 'string' && typeof item.name === 'string'
        && typeof item.kind === 'string' && elementKinds.includes(item.kind as CanvasElement['kind'])
        && ['x', 'y', 'width', 'height', 'radius', 'fontSize'].every((key) => Number.isFinite(item[key]))
        && typeof item.text === 'string' && typeof item.fill === 'string' && typeof item.stroke === 'string'
        && typeof item.fontFamily === 'string'
        && (item.dynamicVariables === undefined || Array.isArray(item.dynamicVariables) && item.dynamicVariables.every((id) => typeof id === 'string'))
        && (item.textAnchor === undefined || item.textAnchor === 'start' || item.textAnchor === 'middle' || item.textAnchor === 'end')
        && (item.textBaseline === undefined || item.textBaseline === 'hanging' || item.textBaseline === 'central' || item.textBaseline === 'text-after-edge' || item.textBaseline === 'alphabetic')
        && (item.sourceBranchPath === undefined || Array.isArray(item.sourceBranchPath) && item.sourceBranchPath.every((branch) =>
          !!branch && typeof branch.id === 'string' && Number.isInteger(branch.choice),
        ))
        && (item.repeatAxis === undefined || item.repeatAxis === 'x' || item.repeatAxis === 'y')
        && (item.repeatOffsets === undefined || Array.isArray(item.repeatOffsets) && item.repeatOffsets.every((offset) => Number.isFinite(offset)))
        && (item.fontWeight === 'normal' || item.fontWeight === 'bold')
        && (item.kind !== 'image' || typeof item.imageData === 'string')
    })
    && (candidate.sourceTopics === undefined || Array.isArray(candidate.sourceTopics) && candidate.sourceTopics.every((topic) =>
      !!topic && typeof topic === 'object' && typeof topic.id === 'string' && typeof topic.topic === 'string',
    ))
    && (candidate.sourceBranchGroups === undefined || Array.isArray(candidate.sourceBranchGroups) && candidate.sourceBranchGroups.every((group: unknown) => {
      if (!group || typeof group !== 'object') return false
      const item = group as Record<string, unknown>
      return typeof item.id === 'string' && typeof item.label === 'string'
        && Array.isArray(item.choices) && item.choices.every((choice: unknown) => typeof choice === 'string')
        && (item.parentPath === undefined || Array.isArray(item.parentPath) && item.parentPath.every((branch: unknown) =>
          !!branch && typeof branch === 'object'
          && typeof (branch as Record<string, unknown>).id === 'string'
          && Number.isInteger((branch as Record<string, unknown>).choice),
        ))
    }))
    && (candidate.sourceBranchSelection === undefined || !!candidate.sourceBranchSelection && typeof candidate.sourceBranchSelection === 'object' && Object.values(candidate.sourceBranchSelection).every(Number.isInteger))
}

const makeElement = (kind: CanvasElement['kind'], index: number): CanvasElement => {
  const common = { id: crypto.randomUUID(), x: 12 + index * 3, y: 12 + index * 3, width: 40, height: 20, text: '', fill: '#c3f36b', stroke: '#c3f36b', radius: 4, fontSize: 12, fontFamily: 'monospace', fontWeight: 'normal' as const }
  if (kind === 'text') return { ...common, kind, name: 'Текст', width: 72, height: 16, text: 'Новый текст', fill: '#e7e7e7', stroke: 'none', radius: 0, fontSize: 12 }
  if (kind === 'circle') return { ...common, kind, name: 'Круг', width: 24, height: 24, radius: 12 }
  if (kind === 'line') return { ...common, kind, name: 'Линия', width: 32, height: 0, fill: 'none', stroke: '#c3f36b', radius: 0 }
  if (kind === 'image') return { ...common, kind, name: 'Изображение', width: 40, height: 40, fill: 'none', stroke: 'none', radius: 0 }
  return { ...common, kind, name: 'Прямоугольник' }
}

function makeProject(display = displays[0]): Project {
  return { name: 'Погодная станция', displayId: display.id, width: display.width, height: display.height, color: display.color, elements: initialElements.map((item) => ({ ...item })) }
}

function elementExceedsDisplay(element: CanvasElement, width: number, height: number) {
  const repeatMin = Math.min(0, ...(element.repeatOffsets ?? []))
  const repeatMax = Math.max(0, ...(element.repeatOffsets ?? []))
  const x1 = element.x + (element.repeatAxis === 'x' ? repeatMin : 0)
  const y1 = element.y + (element.repeatAxis === 'y' ? repeatMin : 0)
  const x2 = element.x + element.width + (element.repeatAxis === 'x' ? repeatMax : 0)
  const y2 = element.y + element.height + (element.repeatAxis === 'y' ? repeatMax : 0)
  const left = element.kind === 'text'
    ? element.x - (element.textAnchor === 'middle' ? element.width / 2 : element.textAnchor === 'end' ? element.width : 0)
    : Math.min(x1, x2)
  const top = element.kind === 'text'
    ? element.y - (element.textBaseline === 'central' ? element.height / 2 : element.textBaseline === 'text-after-edge' || element.textBaseline === 'alphabetic' ? element.height : 0)
    : Math.min(y1, y2)
  const right = element.kind === 'text' ? left + element.width : Math.max(x1, x2)
  const bottom = element.kind === 'text' ? top + element.height : Math.max(y1, y2)
  return left < 0 || top < 0 || right > width || bottom > height
}

function measureImportedText(elements: CanvasElement[]) {
  const context = document.createElement('canvas').getContext('2d')
  if (!context) return elements
  return elements.map((element) => {
    if (element.kind !== 'text') return element
    context.font = `${element.fontWeight} ${element.fontSize}px ${element.fontFamily}`
    const metrics = context.measureText(element.text)
    return {
      ...element,
      width: Math.max(1, Math.ceil(metrics.width)),
      height: Math.max(1, Math.ceil(metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent)),
    }
  })
}

function migrateSourceProject(value: Project): Project {
  if (!value.sourceCode || !value.sourceFormat) return value
  const parsed = parseDisplaySource(value.sourceCode, value.sourceFormat)
  const measuredElements = measureImportedText(parsed.elements)
  const importedElements = new Map(measuredElements.map((element) => [element.id, element]))
  const currentIds = new Set(value.elements.map((element) => element.id))
  const resetPreviewState = value.sourceImportVersion !== SOURCE_IMPORT_VERSION
  const elements = value.elements.map((element) => {
    const imported = importedElements.get(element.id)
    if (!imported) return element
    return {
      ...imported,
      ...element,
      ...(resetPreviewState && imported.kind === 'text'
        ? { x: imported.x, y: imported.y, width: imported.width, height: imported.height, text: imported.text }
        : {}),
      dynamicVariables: imported.dynamicVariables,
      sourceBranchPath: imported.sourceBranchPath,
      textAnchor: imported.textAnchor,
      textBaseline: imported.textBaseline,
      repeatAxis: imported.repeatAxis,
      repeatOffsets: imported.repeatOffsets,
    }
  })
  if (!value.sourceBranchGroups) elements.push(...measuredElements.filter((element) => !currentIds.has(element.id)))
  const topicIds = new Set(parsed.sourceTopics.map((topic) => topic.id))
  const sourceTopics = (value.sourceTopics ?? parsed.sourceTopics).filter((topic) => topicIds.has(topic.id))
  return {
    ...value,
    sourceImportVersion: SOURCE_IMPORT_VERSION,
    sourceTopics,
    sourceBranchGroups: parsed.sourceBranchGroups,
    sourceBranchSelection: Object.fromEntries(parsed.sourceBranchGroups.map((group) => [
      group.id,
      resetPreviewState ? parsed.sourceBranchSelection[group.id] : value.sourceBranchSelection?.[group.id] ?? parsed.sourceBranchSelection[group.id] ?? 0,
    ])),
    elements,
  }
}

function readSavedProject(): Project {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (!saved) return makeProject()
    const value: unknown = JSON.parse(saved)
    if (!isProject(value)) {
      throw new Error('Файл проекта в хранилище имеет неверный формат.')
    }
    return migrateSourceProject(value)
  } catch (error) {
    console.error('Не удалось загрузить сохранённый проект:', error)
    return makeProject()
  }
}

function App() {
  const [project, setProject] = useState<Project>(readSavedProject)
  const [selectedId, setSelectedId] = useState<string | null>('temperature')
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState<(typeof categories)[number]>('All')
  const [activeTab, setActiveTab] = useState<'design' | 'code'>('design')
  const [rightTab, setRightTab] = useState<'properties' | 'layers'>('properties')
  const [zoom, setZoom] = useState(1)
  const [grid, setGrid] = useState(true)
  const [codeTarget, setCodeTarget] = useState<CodeTarget>('arduino')
  const [isCodeOpen, setIsCodeOpen] = useState(false)
  const [isSourceOpen, setIsSourceOpen] = useState(false)
  const [sourceDraft, setSourceDraft] = useState('')
  const [sourceDraftFormat, setSourceDraftFormat] = useState<'arduino' | 'esphome'>('arduino')
  const [sourceWarnings, setSourceWarnings] = useState<string[]>([])
  const [isCustomOpen, setIsCustomOpen] = useState(false)
  const [customDisplays, setCustomDisplays] = useState<DisplayPreset[]>([])
  const [toast, setToast] = useState('')
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved')
  const [account, setAccount] = useState<AccountUser | null>(null)
  const [isAccountOpen, setIsAccountOpen] = useState(false)
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login')
  const [authUsername, setAuthUsername] = useState('')
  const [authPassword, setAuthPassword] = useState('')
  const [authBusy, setAuthBusy] = useState(false)
  const [cloudBusy, setCloudBusy] = useState(false)
  const [cloudProjects, setCloudProjects] = useState<CloudProjectSummary[]>([])
  const [cloudError, setCloudError] = useState('')
  const [clipboardElement, setClipboardElement] = useState<CanvasElement | null>(null)
  const [history, setHistory] = useState<Project[]>([])
  const [future, setFuture] = useState<Project[]>([])
  const canvasStageRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const importRef = useRef<HTMLInputElement>(null)
  const imageImportRef = useRef<HTMLInputElement>(null)
  const sourceImportRef = useRef<HTMLInputElement>(null)
  const dragRef = useRef<{ id: string; mode: 'move' | 'resize'; dx: number; dy: number } | null>(null)

  useEffect(() => {
    getCurrentUser().then(setAccount).catch((error: unknown) => {
      console.error('Не удалось проверить аккаунт:', error)
      setToast('Не удалось подключиться к серверу аккаунтов')
    })
  }, [])

  useEffect(() => {
    const stage = canvasStageRef.current
    if (!stage) return
    const onWheel = (event: globalThis.WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      setZoom((value) => Math.max(.25, Math.min(2.5, Number((value + (event.deltaY < 0 ? .1 : -.1)).toFixed(1)))))
    }
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => stage.removeEventListener('wheel', onWheel)
  }, [])

  const allDisplays = useMemo(() => [...customDisplays, ...displays], [customDisplays])
  const display = allDisplays.find((item) => item.id === project.displayId) ?? {
    id: project.displayId, name: 'Пользовательский экран', controller: 'Custom', kind: 'TFT' as const,
    width: project.width, height: project.height, color: project.color, interface: 'Custom', library: 'esphome' as const,
  }
  const filteredDisplays = useMemo(() => allDisplays.filter((item) =>
    (category === 'All' || item.kind === category)
    && `${item.name} ${item.controller} ${item.boardFamily ?? ''} ${item.width} ${item.height}`.toLowerCase().includes(search.toLowerCase()),
  ), [allDisplays, category, search])
  const selected = project.elements.find((element) => element.id === selectedId) ?? null
  const visibleElements = project.elements.filter((element) =>
    (element.sourceBranchPath ?? []).every(({ id, choice }) => (project.sourceBranchSelection?.[id] ?? 0) === choice),
  )
  const offscreenElements = visibleElements.filter((element) => elementExceedsDisplay(element, project.width, project.height)).length
  const importedSource = project.sourceCode && project.sourceFormat ? updateImportedSource(project) : null
  const activeSourceWarnings = importedSource?.warnings ?? sourceWarnings
  const unsupportedCommands = activeSourceWarnings.join(' ').match(/(\d+) команда\(ы\)/)?.[1]
  const generatedCode = importedSource?.code ?? generateCode(codeTarget, project, display)
  const codeCaveats = [
    project.elements.some((item) => item.kind === 'image') && 'Импортированные изображения не преобразуются в bitmap и отмечены комментарием в коде.',
    codeTarget === 'esphome' && project.elements.some((item) => item.kind === 'rect' && item.radius > 0) && 'Скругление прямоугольников в ESPHome заменяется обычными прямоугольниками.',
    project.elements.some((item) => item.kind === 'text' && (item.fontFamily !== 'monospace' || item.fontWeight === 'bold')) && 'Гарнитура и начертание текста упрощаются до ближайшего шрифта, доступного библиотеке.',
  ].filter(Boolean)

  useEffect(() => {
    setSaveState('saving')
    const timer = window.setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(project))
        setSaveState('saved')
      } catch (error) {
        console.error('Не удалось сохранить проект:', error)
        setSaveState('error')
      }
    }, 350)
    return () => window.clearTimeout(timer)
  }, [project])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(''), 2400)
    return () => window.clearTimeout(timer)
  }, [toast])

  const updateProject = (next: Project | ((current: Project) => Project)) => {
    const resolved = typeof next === 'function' ? next(project) : next
    if (resolved === project) return
    setHistory((items) => [...items.slice(-49), project])
    setFuture([])
    setProject(resolved)
  }

  const refreshCloudProjects = async () => {
    setCloudError('')
    try {
      setCloudProjects(await getCloudProjects())
    } catch (error) {
      console.error('Не удалось загрузить облачные проекты:', error)
      setCloudError(error instanceof Error ? error.message : 'Не удалось загрузить проекты')
    }
  }

  const openAccount = () => {
    setCloudError('')
    setIsAccountOpen(true)
    if (account) void refreshCloudProjects()
  }

  const submitAuth = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setAuthBusy(true)
    setCloudError('')
    try {
      const user = await signIn(authUsername, authPassword, authMode === 'register')
      setAccount(user)
      setAuthPassword('')
      await refreshCloudProjects()
      setToast(authMode === 'register' ? 'Аккаунт создан' : 'Вход выполнен')
    } catch (error) {
      console.error('Не удалось выполнить вход:', error)
      setCloudError(error instanceof Error ? error.message : 'Не удалось выполнить вход')
    } finally {
      setAuthBusy(false)
    }
  }

  const saveWebProject = async () => {
    if (!account) {
      openAccount()
      setToast('Войдите, чтобы синхронизировать проект')
      return
    }
    setCloudBusy(true)
    setCloudError('')
    try {
      const savedProject = await saveCloudProject(project, account.id)
      setProject(savedProject)
      setCloudProjects(await getCloudProjects())
      setToast('Веб-проект сохранён в облаке')
    } catch (error) {
      console.error('Не удалось сохранить облачный проект:', error)
      setCloudError(error instanceof Error ? error.message : 'Не удалось сохранить проект')
      setToast('Не удалось синхронизировать проект')
    } finally {
      setCloudBusy(false)
    }
  }

  const openCloudProject = async (id: string) => {
    setCloudBusy(true)
    setCloudError('')
    try {
      const loaded = migrateSourceProject({ ...await loadCloudProject(id), cloudOwnerId: account?.id })
      updateProject(loaded)
      setSelectedId(loaded.elements[0]?.id ?? null)
      setIsAccountOpen(false)
      setToast(`Загружен проект «${loaded.name}»`)
    } catch (error) {
      console.error('Не удалось загрузить облачный проект:', error)
      setCloudError(error instanceof Error ? error.message : 'Не удалось загрузить проект')
    } finally {
      setCloudBusy(false)
    }
  }

  const removeCloudProject = async (item: CloudProjectSummary) => {
    if (!window.confirm(`Удалить облачный проект «${item.name}»?`)) return
    setCloudBusy(true)
    setCloudError('')
    try {
      await deleteCloudProject(item.id)
      setCloudProjects((items) => items.filter((projectItem) => projectItem.id !== item.id))
      if (project.cloudProjectId === item.id && project.cloudOwnerId === account?.id) setProject(({ ...project, cloudProjectId: undefined, cloudOwnerId: undefined }))
    } catch (error) {
      console.error('Не удалось удалить облачный проект:', error)
      setCloudError(error instanceof Error ? error.message : 'Не удалось удалить проект')
    } finally {
      setCloudBusy(false)
    }
  }

  const logout = async () => {
    setAuthBusy(true)
    setCloudError('')
    try {
      await signOut()
      setAccount(null)
      setCloudProjects([])
      setIsAccountOpen(false)
      setToast('Вы вышли из аккаунта')
    } catch (error) {
      console.error('Не удалось выйти из аккаунта:', error)
      setCloudError(error instanceof Error ? error.message : 'Не удалось выйти из аккаунта')
    } finally {
      setAuthBusy(false)
    }
  }

  const selectDisplay = (item: DisplayPreset) => {
    const scale = Math.min(item.width / project.width, item.height / project.height)
    const offsetX = (item.width - project.width * scale) / 2
    const offsetY = (item.height - project.height * scale) / 2
    const elements = project.elements.map((element) => ({
      ...element,
      x: Math.round(element.x * scale + offsetX),
      y: Math.round(element.y * scale + offsetY),
      width: Math.max(1, Math.round(element.width * scale)),
      height: Math.max(1, Math.round(element.height * scale)),
      radius: Math.round(element.radius * scale),
      fontSize: Math.max(5, Math.round(element.fontSize * scale)),
    }))
    updateProject({ ...project, displayId: item.id, width: item.width, height: item.height, color: item.color, elements })
    setSelectedId(null)
    setToast(`${item.name} · ${item.width} × ${item.height}`)
  }

  const addElement = (kind: CanvasElement['kind']) => {
    const item = makeElement(kind, project.elements.length)
    item.width = Math.min(item.width, project.width)
    item.height = Math.min(item.height, project.height)
    item.x = Math.min(item.x, project.width - item.width)
    item.y = Math.min(item.y, project.height - item.height)
    if (kind === 'text') item.fontSize = Math.min(item.fontSize, project.height)
    updateProject({ ...project, elements: [...project.elements, item] })
    setSelectedId(item.id)
  }

  const addRoundedRectangle = () => {
    const item = makeElement('rect', project.elements.length)
    item.radius = Math.min(10, Math.floor(Math.min(item.width, item.height) / 2))
    item.width = Math.min(item.width, project.width)
    item.height = Math.min(item.height, project.height)
    item.x = Math.min(item.x, project.width - item.width)
    item.y = Math.min(item.y, project.height - item.height)
    updateProject({ ...project, elements: [...project.elements, item] })
    setSelectedId(item.id)
  }

  const importImage = (file?: File) => {
    if (!file) return
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) {
      setToast('Выберите изображение PNG, JPEG, WebP или GIF')
      return
    }
    if (file.size > 2 * 1024 * 1024) {
      setToast('Размер изображения не должен превышать 2 МБ')
      return
    }
    const reader = new FileReader()
    reader.onerror = () => setToast('Не удалось прочитать изображение')
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        setToast('Не удалось загрузить изображение')
        return
      }
      const dataUrl = reader.result
      const image = new window.Image()
      image.onerror = () => setToast('Файл не удалось открыть как изображение')
      image.onload = () => {
        const ratio = Math.min(1, 64 / Math.max(image.naturalWidth, image.naturalHeight))
        const item = { ...makeElement('image', project.elements.length), name: file.name.replace(/\.[^.]+$/, ''), width: Math.max(1, Math.round(image.naturalWidth * ratio)), height: Math.max(1, Math.round(image.naturalHeight * ratio)), imageData: dataUrl }
        updateProject({ ...project, elements: [...project.elements, item] })
        setSelectedId(item.id)
      }
      image.src = dataUrl
    }
    reader.readAsDataURL(file)
    if (imageImportRef.current) imageImportRef.current.value = ''
  }

  const importSourceFile = async (file?: File) => {
    if (!file) return
    if (file.size > 2 * 1024 * 1024) {
      setToast('Размер файла с кодом не должен превышать 2 МБ')
      return
    }
    const extension = file.name.split('.').pop()?.toLowerCase()
    if (!['ino', 'cpp', 'c', 'h', 'hpp', 'yaml', 'yml', 'txt'].includes(extension ?? '')) {
      setToast('Поддерживаются файлы Arduino C++ (.ino/.cpp/.h) и ESPHome (.yaml/.yml)')
      return
    }
    try {
      setSourceDraft(await file.text())
      setSourceDraftFormat(extension === 'yaml' || extension === 'yml' ? 'esphome' : 'arduino')
      setSourceWarnings([])
      setIsSourceOpen(true)
    } catch (error) {
      console.error('Не удалось прочитать исходный код:', error)
      setToast('Не удалось прочитать файл с кодом')
    } finally {
      if (sourceImportRef.current) sourceImportRef.current.value = ''
    }
  }

  const openSourceImport = () => {
    setSourceDraft(project.sourceCode ?? '')
    setSourceDraftFormat(project.sourceFormat ?? 'arduino')
    setSourceWarnings(project.sourceCode && project.sourceFormat ? parseDisplaySource(project.sourceCode, project.sourceFormat).warnings : [])
    setIsSourceOpen(true)
  }

  const applyImportedSource = () => {
    if (!sourceDraft.trim()) {
      setToast('Загрузите файл или вставьте код')
      return
    }
    const parsed = parseDisplaySource(sourceDraft, sourceDraftFormat)
    const next = { ...project, elements: measureImportedText(parsed.elements), sourceCode: sourceDraft, sourceFormat: sourceDraftFormat, sourceTopics: parsed.sourceTopics, sourceBranchGroups: parsed.sourceBranchGroups, sourceBranchSelection: parsed.sourceBranchSelection, sourceImportVersion: SOURCE_IMPORT_VERSION }
    setSourceWarnings(parsed.warnings)
    let imported = next
    setSelectedId(parsed.elements[0]?.id ?? null)
    if (parsed.suggestedDisplayId) {
      const matched = allDisplays.find((item) => item.id === parsed.suggestedDisplayId)
      if (matched) {
        imported = { ...next, displayId: matched.id, width: matched.width, height: matched.height, color: matched.color }
      }
    } else if (parsed.suggestedSize) {
      imported = {
        ...next,
        displayId: `imported-custom-${parsed.suggestedSize.width}x${parsed.suggestedSize.height}`,
        width: parsed.suggestedSize.width,
        height: parsed.suggestedSize.height,
        color: !/U8G2|SSD1306|SH1106|SSD1327|epaper/i.test(sourceDraft),
      }
    }
    updateProject(migrateSourceProject(imported))
    setCodeTarget(sourceDraftFormat === 'esphome' ? 'esphome' : 'arduino')
    setIsSourceOpen(false)
    setToast(parsed.elements.length ? `Импортировано объектов: ${parsed.elements.length}` : 'Исходник загружен; команды рисования не распознаны')
  }

  const updateElement = (id: string, patch: Partial<CanvasElement>) => {
    updateProject({ ...project, elements: project.elements.map((item) => item.id === id ? { ...item, ...patch } : item) })
  }

  const updateSourceTopic = (id: string, topic: string) => {
    const sourceTopics = project.sourceTopics
      ?? (project.sourceCode && project.sourceFormat ? parseDisplaySource(project.sourceCode, project.sourceFormat).sourceTopics : [])
    updateProject({
      ...project,
      sourceTopics: [...sourceTopics.filter((item) => item.id !== id), { id, topic }],
    })
  }

  const point = (event: PointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current
    const matrix = svg?.getScreenCTM()
    if (!svg || !matrix) return { x: 0, y: 0 }
    const cursor = svg.createSVGPoint()
    cursor.x = event.clientX
    cursor.y = event.clientY
    const transformed = cursor.matrixTransform(matrix.inverse())
    return { x: transformed.x, y: transformed.y }
  }

  const beginDrag = (event: PointerEvent<SVGElement>, item: CanvasElement, mode: 'move' | 'resize') => {
    event.stopPropagation()
    const cursor = point(event as PointerEvent<SVGSVGElement>)
    const boundsX = item.x - (item.textAnchor === 'middle' ? item.width / 2 : item.textAnchor === 'end' ? item.width : 0)
    const boundsY = item.y - (item.textBaseline === 'central' ? item.height / 2 : item.textBaseline === 'text-after-edge' || item.textBaseline === 'alphabetic' ? item.height : 0)
    dragRef.current = { id: item.id, mode, dx: cursor.x - (mode === 'resize' ? boundsX + item.width : item.x), dy: cursor.y - (mode === 'resize' ? boundsY + item.height : item.y) }
    setHistory((items) => [...items.slice(-49), project])
    setFuture([])
    setSelectedId(item.id)
    setRightTab('properties')
    svgRef.current?.setPointerCapture(event.pointerId)
  }

  const moveElement = (event: PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current
    if (!drag) return
    const cursor = point(event)
    if (drag.mode === 'move') {
      setProject((current) => ({ ...current, elements: current.elements.map((item) => item.id === drag.id ? { ...item, x: Math.round(cursor.x - drag.dx), y: Math.round(cursor.y - drag.dy) } : item) }))
    } else {
      setProject((current) => ({ ...current, elements: current.elements.map((item) => item.id === drag.id ? { ...item, width: Math.max(4, Math.round(cursor.x - item.x - drag.dx)), height: Math.max(4, Math.round(cursor.y - item.y - drag.dy)) } : item) }))
    }
  }

  const endDrag = () => { dragRef.current = null }

  const undo = () => {
    const previous = history[history.length - 1]
    if (!previous) return
    setHistory((items) => items.slice(0, -1))
    setFuture((items) => [...items, project])
    setProject(previous)
  }

  const redo = () => {
    const next = future[future.length - 1]
    if (!next) return
    setFuture((items) => items.slice(0, -1))
    setHistory((items) => [...items.slice(-49), project])
    setProject(next)
  }

  const removeSelected = () => {
    if (!selectedId) return
    updateProject({ ...project, elements: project.elements.filter((item) => item.id !== selectedId) })
    setSelectedId(null)
  }

  const duplicateSelected = () => {
    if (!selected) return
    const copy = { ...selected, id: crypto.randomUUID(), name: `${selected.name} copy`, x: selected.x + 4, y: selected.y + 4 }
    updateProject({ ...project, elements: [...project.elements, copy] })
    setSelectedId(copy.id)
  }

  const pasteClipboardElement = () => {
    if (!clipboardElement) return
    const copy = { ...clipboardElement, id: crypto.randomUUID(), name: `${clipboardElement.name} copy`, x: clipboardElement.x + 4, y: clipboardElement.y + 4 }
    updateProject({ ...project, elements: [...project.elements, copy] })
    setSelectedId(copy.id)
    setRightTab('properties')
  }

  const moveLayer = (direction: -1 | 1) => {
    if (!selected) return
    const index = project.elements.findIndex((item) => item.id === selected.id)
    if (direction === 1 && index === project.elements.length - 1 || direction === -1 && index === 0) return
    const elements = [...project.elements]
    elements.splice(index, 1)
    if (direction === 1) elements.push(selected)
    else elements.unshift(selected)
    updateProject({ ...project, elements })
  }

  const download = (content: BlobPart, filename: string, type: string) => {
    const url = URL.createObjectURL(new Blob([content], { type }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const saveProject = () => download(JSON.stringify(project, null, 2), `${project.name.toLowerCase().replace(/\s+/g, '-')}.pixelforge.json`, 'application/json')

  const importProject = async (file?: File) => {
    if (!file) return
    try {
      const imported: unknown = JSON.parse(await file.text())
      if (!isProject(imported)) {
        throw new Error('Файл не похож на проект PixelForge.')
      }
      updateProject(imported)
      setSelectedId(null)
      setToast('Проект импортирован')
    } catch (error) {
      console.error('Ошибка импорта проекта:', error)
      setToast(error instanceof Error ? error.message : 'Не удалось прочитать проект')
    } finally {
      if (importRef.current) importRef.current.value = ''
    }
  }

  const exportSvg = () => {
    if (!svgRef.current) return
    const clone = svgRef.current.cloneNode(true) as SVGSVGElement
    clone.removeAttribute('class')
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    clone.setAttribute('width', String(project.width))
    clone.setAttribute('height', String(project.height))
    clone.querySelectorAll('[data-selection]').forEach((node) => node.remove())
    clone.querySelectorAll('[data-editor-grid]').forEach((node) => node.remove())
    download(new XMLSerializer().serializeToString(clone), `${project.name}.svg`, 'image/svg+xml')
    setToast('SVG экспортирован')
  }

  const exportPng = () => {
    if (!svgRef.current) return
    const clone = svgRef.current.cloneNode(true) as SVGSVGElement
    clone.removeAttribute('class')
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    clone.setAttribute('width', String(project.width))
    clone.setAttribute('height', String(project.height))
    clone.querySelectorAll('[data-selection]').forEach((node) => node.remove())
    clone.querySelectorAll('[data-editor-grid]').forEach((node) => node.remove())
    const source = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml;charset=utf-8' }))
    const image = new window.Image()
    image.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = project.width
      canvas.height = project.height
      const context = canvas.getContext('2d')
      if (!context) {
        URL.revokeObjectURL(source)
        setToast('Браузер не поддерживает экспорт PNG')
        return
      }
      context.drawImage(image, 0, 0)
      canvas.toBlob((blob) => {
        URL.revokeObjectURL(source)
        if (!blob) {
          setToast('Не удалось собрать PNG')
          return
        }
        download(blob, `${project.name}.png`, 'image/png')
        setToast('PNG экспортирован')
      })
    }
    image.onerror = () => {
      URL.revokeObjectURL(source)
      setToast('Не удалось экспортировать PNG')
    }
    image.src = source
  }

  const addCustomDisplay = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const width = Number(data.get('width'))
    const height = Number(data.get('height'))
    const controller = String(data.get('controller') || 'Custom')
    const kind = String(data.get('kind')) as DisplayKind
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 8 || height < 8 || width > 2048 || height > 2048) {
      setToast('Разрешение должно быть от 8 до 2048 пикселей')
      return
    }
    const item: DisplayPreset = {
      id: `custom-${crypto.randomUUID()}`, name: String(data.get('name') || 'Custom display'),
      controller, kind, width, height, color: data.get('color') === 'on', interface: 'Custom',
      library: 'esphome',
    }
    setCustomDisplays((items) => [item, ...items])
    selectDisplay(item)
    setIsCustomOpen(false)
  }

  const codeDownload = () => {
    if (!generatedCode) return
    const format = project.sourceFormat ?? codeTarget
    download(generatedCode, format === 'arduino' ? `${project.name}.ino` : 'display.yaml', format === 'arduino' ? 'text/plain' : 'text/yaml')
  }

  const copyCode = async () => {
    if (!generatedCode) return
    try {
      await navigator.clipboard.writeText(generatedCode)
      setToast('Скопировано в буфер обмена')
    } catch (error) {
      console.error('Не удалось скопировать код:', error)
      setToast('Не удалось скопировать. Скачайте файл с кодом.')
    }
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target
      if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target instanceof HTMLElement && target.isContentEditable) return
      if (target instanceof HTMLInputElement && /^(text|search|email|password|url|tel)$/i.test(target.type)) return
      const modifier = event.ctrlKey || event.metaKey
      if (modifier && event.key.toLowerCase() === 'z' && !event.shiftKey) {
        event.preventDefault()
        const previous = history[history.length - 1]
        if (previous) {
          setHistory((items) => items.slice(0, -1))
          setFuture((items) => [...items, project])
          setProject(previous)
        }
      } else if (modifier && (event.key.toLowerCase() === 'y' || event.key.toLowerCase() === 'z' && event.shiftKey)) {
        event.preventDefault()
        const next = future[future.length - 1]
        if (next) {
          setFuture((items) => items.slice(0, -1))
          setHistory((items) => [...items.slice(-49), project])
          setProject(next)
        }
      } else if (modifier && event.key.toLowerCase() === 'c' && selectedId) {
        const item = project.elements.find((element) => element.id === selectedId)
        if (item) {
          event.preventDefault()
          setClipboardElement({ ...item })
          setToast('Объект скопирован')
        }
      } else if (modifier && event.key.toLowerCase() === 'v' && clipboardElement) {
        event.preventDefault()
        pasteClipboardElement()
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd') {
        event.preventDefault()
        if (selectedId) {
          const item = project.elements.find((element) => element.id === selectedId)
          if (item) {
            const copy = { ...item, id: crypto.randomUUID(), name: `${item.name} copy`, x: item.x + 4, y: item.y + 4 }
            updateProject({ ...project, elements: [...project.elements, copy] })
            setSelectedId(copy.id)
          }
        }
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        if (selectedId) {
          event.preventDefault()
          updateProject({ ...project, elements: project.elements.filter((item) => item.id !== selectedId) })
          setSelectedId(null)
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [history, future, project, selectedId, clipboardElement])

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#" aria-label="PixelForge home">
          <span className="brand-mark"><span /><span /><span /><span /></span>
          <span>pixel<span className="brand-light">forge</span></span>
          <span className="brand-beta">BETA</span>
        </a>
        <div className="top-divider" />
        <button className="project-name" onClick={() => {
          const name = window.prompt('Название проекта', project.name)
          if (name?.trim()) updateProject({ ...project, name: name.trim() })
        }}>{project.name}<ChevronDown size={14} /></button>
        <div className="save-indicator"><span className={`save-dot ${saveState}`} />{saveState === 'error' ? 'Не сохранено' : saveState === 'saving' ? 'Сохранение…' : 'Все изменения сохранены'}</div>
        <div className="topbar-spacer" />
        <button className="icon-button quiet top-action" title="Импортировать проект" onClick={() => importRef.current?.click()}><FolderIcon /> <span>Открыть</span></button>
        <button className="icon-button quiet top-action" title="Загрузить готовый код" onClick={openSourceImport}><FileCode2 size={15} /><span>{project.sourceCode ? 'Исходник' : 'Загрузить код'}</span></button>
        <button className="icon-button quiet top-action" title="Экспортировать веб-проект в JSON" onClick={saveProject}><Download size={16} /><span>Экспорт JSON</span></button>
        <button className="icon-button quiet top-action account-action" title="Аккаунт и синхронизация" onClick={openAccount}><UserRound size={15} /><span>{account?.username ?? 'Аккаунт'}</span></button>
        <button className="button button-secondary save-web-button" onClick={() => void saveWebProject()} disabled={cloudBusy}><Cloud size={15} />{cloudBusy ? 'Синхронизация…' : 'Сохранить веб-проект'}</button>
        <button className="button button-primary" onClick={() => setIsCodeOpen(true)}><Code2 size={16} /> Сгенерировать код <ChevronDown size={13} /></button>
        <input ref={importRef} hidden type="file" accept=".json,.pixelforge.json,application/json" onChange={(event) => void importProject(event.target.files?.[0])} />
        <input ref={imageImportRef} hidden type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => importImage(event.target.files?.[0])} />
        <input ref={sourceImportRef} hidden type="file" accept=".ino,.cpp,.c,.h,.hpp,.yaml,.yml,.txt" onChange={(event) => void importSourceFile(event.target.files?.[0])} />
      </header>

      <div className="workspace">
        <aside className="left-sidebar">
          <div className="sidebar-tabs">
            <button className={`side-tab ${activeTab === 'design' ? 'active' : ''}`} onClick={() => setActiveTab('design')}><Monitor size={16} /> Дисплеи</button>
            <button className={`side-tab ${activeTab === 'code' ? 'active' : ''}`} onClick={() => { setActiveTab('code'); setIsCodeOpen(true) }}><FileCode2 size={16} /> Код</button>
          </div>
          <div className="sidebar-content">
            <div className="panel-heading">
              <div><h2>Библиотека</h2><span>Выберите экран для проекта</span></div>
              <button className="round-button" title="Пользовательский дисплей" onClick={() => setIsCustomOpen(true)}><Plus size={16} /></button>
            </div>
            <label className="search-field"><Search size={15} /><input placeholder="Модель или контроллер…" value={search} onChange={(event) => setSearch(event.target.value)} /><span className="shortcut">⌘ K</span></label>
            <div className="category-scroller">
              {categories.map((item) => <button key={item} className={`category-chip ${category === item ? 'selected' : ''}`} onClick={() => setCategory(item)}>{item === 'All' ? 'Все' : item}</button>)}
            </div>
            <div className="display-list">
              {filteredDisplays.map((item) => <button key={item.id} className={`display-card ${display.id === item.id ? 'chosen' : ''}`} onClick={() => selectDisplay(item)}>
                <span className={`display-thumb ${item.color ? 'color-thumb' : ''} ${item.kind === 'E-Paper' ? 'epaper-thumb' : ''} ${item.kind === 'LED Matrix' ? 'matrix-thumb' : ''}`} style={{ aspectRatio: `${Math.max(1, item.width / item.height)}` }}>
                  {item.kind === 'LED Matrix' ? <span className="matrix-dots" /> : <span className="thumb-sample"><i /><i /><i /><b /></span>}
                  {item.color && item.kind !== 'LED Matrix' && <span className="thumb-colorbar" />}
                </span>
                <span className="display-info"><span className="display-title">{item.name}<span className="display-tag">{item.boardFamily ? 'BOARD' : item.kind}</span></span><span className="display-meta">{item.boardFamily ?? item.controller} <i /> {item.width} × {item.height}</span></span>
                {display.id === item.id && <Check className="display-check" size={16} />}
              </button>)}
              {filteredDisplays.length === 0 && <div className="empty-search">Ничего не найдено.<br /><button onClick={() => setIsCustomOpen(true)}>Добавить свой дисплей</button></div>}
            </div>
            <button className="custom-display-link" onClick={() => setIsCustomOpen(true)}><Plus size={15} /> Настроить свой дисплей</button>
          </div>
          <div className="sidebar-footer"><span className="tiny-led" /> Каталог обновляется <span className="version">v1.0</span></div>
        </aside>

        <main className="editor">
          <div className="editor-toolbar">
            <div className="breadcrumb"><span>Мои проекты</span><span className="crumb-separator">/</span><b>{project.name}</b></div>
            <div className="toolbar-actions">
              <button className="icon-button" title="Отменить (Ctrl+Z)" onClick={undo} disabled={history.length === 0}><Undo2 size={16} /></button>
              <button className="icon-button" title="Повторить (Ctrl+Y)" onClick={redo} disabled={future.length === 0}><Redo2 size={16} /></button>
              <span className="toolbar-divider" />
              <button className={`icon-button ${grid ? 'pressed' : ''}`} title="Сетка" onClick={() => setGrid(!grid)}><Grid2X2 size={16} /></button>
              <button className="icon-button" title="Уменьшить" onClick={() => setZoom(Math.max(.25, Number((zoom - .1).toFixed(1))))}><ZoomOut size={16} /></button>
              <span className="zoom-value">{Math.round(zoom * 100)}%</span>
              <button className="icon-button" title="Увеличить" onClick={() => setZoom(Math.min(2.5, Number((zoom + .1).toFixed(1))))}><ZoomIn size={16} /></button>
              <span className="toolbar-divider" />
              <button className="icon-button" title="Экспорт SVG" onClick={exportSvg}><Image size={16} /></button>
              <button className="icon-button" title="Экспорт PNG" onClick={exportPng}><Download size={16} /></button>
            </div>
          </div>

          <div className="canvas-area">
            <div className="canvas-caption"><span className="canvas-live"><span /> LIVE PREVIEW</span><span>{display.boardFamily ?? display.controller} <i /> {display.interface}</span></div>
            {(project.sourceBranchGroups?.length ?? 0) > 0 && <div className="source-state-controls">
              <span>СОСТОЯНИЕ ЭКРАНА</span>
              <div className="source-state-grid">
                {project.sourceBranchGroups?.map((group) => <label key={group.id}>{group.label}<select className="select-input" value={project.sourceBranchSelection?.[group.id] ?? 0} onChange={(event) => {
                  const sourceBranchSelection = { ...project.sourceBranchSelection }
                  group.parentPath?.forEach(({ id, choice }) => { sourceBranchSelection[id] = choice })
                  sourceBranchSelection[group.id] = Number(event.target.value)
                  updateProject({ ...project, sourceBranchSelection })
                  setSelectedId(null)
                }}>
                  {group.choices.map((choice, index) => <option key={index} value={index}>{choice}</option>)}
                </select></label>)}
              </div>
            </div>}
            <div className="canvas-stage" ref={canvasStageRef}>
              <div className="canvas-wrapper" style={{ width: `${zoom * 100}%` }}>
                <div className={`device-frame ${display.kind === 'OLED' ? 'device-oled' : ''} ${display.kind === 'E-Paper' ? 'device-paper' : ''}`} style={{ aspectRatio: `${project.width} / ${project.height}` }}>
                  <svg ref={svgRef} className={`screen-canvas ${!project.color ? 'mono-canvas' : ''}`} viewBox={`0 0 ${project.width} ${project.height}`} preserveAspectRatio="none" onPointerMove={moveElement} onPointerUp={endDrag} onPointerLeave={endDrag} onPointerDown={() => setSelectedId(null)}>
                    <rect width={project.width} height={project.height} fill={display.kind === 'E-Paper' ? '#eeeae0' : '#111310'} />
                    {grid && <defs><pattern id="grid" width={project.width > 200 ? 10 : 4} height={project.width > 200 ? 10 : 4} patternUnits="userSpaceOnUse"><path d={`M ${project.width > 200 ? 10 : 4} 0 L 0 0 0 ${project.width > 200 ? 10 : 4}`} fill="none" stroke={project.color ? '#ffffff0d' : '#ffffff12'} strokeWidth=".5" /></pattern></defs>}
                    {grid && <rect data-editor-grid="true" width={project.width} height={project.height} fill="url(#grid)" pointerEvents="none" />}
                    {visibleElements.map((item) => <g key={item.id} onPointerDown={(event) => beginDrag(event, item, 'move')} className={`canvas-element ${selectedId === item.id ? 'element-selected' : ''}`}>
                      {item.kind === 'rect' && <rect x={item.x} y={item.y} width={item.width} height={item.height} rx={item.radius} fill={item.fill} stroke={item.stroke} strokeWidth={.7} />}
                      {item.kind === 'circle' && <ellipse cx={item.x + item.width / 2} cy={item.y + item.height / 2} rx={item.width / 2} ry={item.height / 2} fill={item.fill} stroke={item.stroke} strokeWidth={.7} />}
                      {item.kind === 'line' && (item.repeatOffsets
                        ? item.repeatOffsets.map((offset, index) => <line key={index} x1={item.x + (item.repeatAxis === 'x' ? offset : 0)} y1={item.y + (item.repeatAxis === 'y' ? offset : 0)} x2={item.x + item.width + (item.repeatAxis === 'x' ? offset : 0)} y2={item.y + item.height + (item.repeatAxis === 'y' ? offset : 0)} stroke={item.stroke} strokeWidth={Math.max(1, item.fontSize / 5)} />)
                        : <line x1={item.x} y1={item.y} x2={item.x + item.width} y2={item.y + item.height} stroke={item.stroke} strokeWidth={Math.max(1, item.fontSize / 5)} />)}
                      {item.kind === 'image' && item.imageData && <image href={item.imageData} x={item.x} y={item.y} width={item.width} height={item.height} preserveAspectRatio="none" />}
                      {item.kind === 'text' && <text x={item.x} y={item.textBaseline ? item.y : item.y + item.fontSize} textAnchor={item.textAnchor} dominantBaseline={item.textBaseline} fill={item.fill} fontSize={item.fontSize} fontFamily={item.fontFamily} fontWeight={item.fontWeight}>{item.text}</text>}
                      {selectedId === item.id && (() => {
                        const repeatMin = Math.min(0, ...(item.repeatOffsets ?? []))
                        const repeatMax = Math.max(0, ...(item.repeatOffsets ?? []))
                        const boundsX = item.x + (item.repeatAxis === 'x' ? repeatMin : 0) - (item.textAnchor === 'middle' ? item.width / 2 : item.textAnchor === 'end' ? item.width : 0)
                        const boundsY = item.y + (item.repeatAxis === 'y' ? repeatMin : 0) - (item.textBaseline === 'central' ? item.height / 2 : item.textBaseline === 'text-after-edge' || item.textBaseline === 'alphabetic' ? item.height : 0)
                        const boundsWidth = item.width + (item.repeatAxis === 'x' ? repeatMax - repeatMin : 0)
                        const boundsHeight = item.height + (item.repeatAxis === 'y' ? repeatMax - repeatMin : 0)
                        return <g data-selection="true"><rect className="selection-outline" x={boundsX - 1} y={boundsY - 1} width={Math.max(boundsWidth, 4) + 2} height={Math.max(boundsHeight, item.fontSize) + 2} fill="none" stroke="#c3f36b" strokeWidth=".8" strokeDasharray="2 1" pointerEvents="none" />{!item.repeatOffsets && <rect className="resize-handle" x={boundsX + item.width - 1.5} y={boundsY + item.height - 1.5} width="4" height="4" rx="1" onPointerDown={(event) => beginDrag(event, item, 'resize')} />}</g>
                      })()}
                    </g>)}
                  </svg>
                </div>
                <div className="device-caption"><span className="device-dot" /> {display.name} <span className="device-dims">{project.width} × {project.height} px</span></div>
              </div>
              <div className="canvas-side-note"><span className="side-note-line" /><span>1 px = 1 px</span></div>
            </div>
            <div className="canvas-bottom">
              <div className="canvas-status"><span className={`status-check ${offscreenElements || unsupportedCommands ? 'status-warning' : ''}`}>{offscreenElements || unsupportedCommands ? '!' : <Check size={11} />}</span><span>{offscreenElements ? `За границами экрана: ${offscreenElements}; ` : 'Экран готов к экспорту'}</span><span className="status-divider" /><span>{visibleElements.length} из {project.elements.length} объектов</span>{unsupportedCommands && <><span className="status-divider" /><span title="Есть команды исходника, которые пока нельзя отобразить как объекты">Не импортировано: {unsupportedCommands}</span></>}</div>
              <button className="preview-link" onClick={exportPng}><Eye size={14} /> Предпросмотр <ArrowUp size={12} className="up-right-icon" /></button>
            </div>
          </div>

          <div className="tool-dock">
            <span className="dock-label">ДОБАВИТЬ</span>
            <button className="dock-tool" onClick={() => addElement('text')}><Type size={16} /><span>Текст</span></button>
            <span className="dock-separator" />
            <button className="dock-tool" onClick={() => addElement('rect')}><Square size={16} /><span>Блок</span></button>
            <button className="dock-tool" onClick={addRoundedRectangle}><Square size={16} /><span>Скруглённый</span></button>
            <button className="dock-tool" onClick={() => addElement('circle')}><Circle size={16} /><span>Круг</span></button>
            <button className="dock-tool" onClick={() => addElement('line')}><Minus size={16} /><span>Линия</span></button>
            <span className="dock-separator" />
            <button className="dock-tool" onClick={() => imageImportRef.current?.click()}><Image size={16} /><span>Изображение</span></button>
            <div className="dock-spacer" />
            <button className="dock-help" onClick={() => { updateProject({ ...project, elements: initialElements.map((item) => ({ ...item, id: crypto.randomUUID() })) }); setSelectedId(null); setToast('Пример погодного интерфейса загружен') }}><Sparkles size={15} /> Идеи для дизайна</button>
          </div>
        </main>

        <aside className="right-sidebar">
          <div className="right-tabs"><button className={`right-tab ${rightTab === 'properties' ? 'active' : ''}`} onClick={() => setRightTab('properties')}><Settings2 size={15} /> Свойства</button><button className={`right-tab ${rightTab === 'layers' ? 'active' : ''}`} onClick={() => setRightTab('layers')}><Layers3 size={15} /> Слои <span className="layer-count">{project.elements.length}</span></button></div>
          <div className="properties-content">
            <div className="prop-section screen-overview">
              <div className="section-title"><span>ДИСПЛЕЙ</span><button className="more-button" onClick={() => setIsCustomOpen(true)}><MoreHorizontal size={17} /></button></div>
              <div className="selected-display"><span className={`mini-screen ${display.color ? 'mini-color' : ''}`}><i /><i /><b /></span><div><b>{display.name}</b><span>{display.controller}</span></div><button className="tiny-chevron" onClick={() => setActiveTab('design')}><ChevronDown size={14} /></button></div>
              <div className="spec-row"><span>Разрешение</span><b>{project.width} × {project.height}</b></div>
              <div className="spec-row"><span>Интерфейс</span><b>{display.interface}</b></div>
              <div className="spec-row"><span>Тип</span><b>{display.kind}</b></div>
              {display.boardFamily && <div className="spec-row"><span>Плата</span><b>{display.boardFamily}</b></div>}
            </div>
            {(project.sourceTopics?.length ?? 0) > 0 && <><div className="properties-divider" /><div className="prop-section">
              <div className="section-title"><span>MQTT-ТОПИКИ</span><i>({project.sourceTopics?.length})</i></div>
              {project.sourceTopics?.map(({ id, topic }) => <label className="field-label" key={id}><span>{id}</span><input className="text-input" value={topic} onChange={(event) => updateSourceTopic(id, event.target.value)} /></label>)}
              <p className="topic-hint">Переменных экрана с MQTT-топиком: {project.sourceTopics?.length ?? 0}. Погода и другие значения без MQTT-источника топика не имеют.</p>
            </div></>}
            <div className="properties-divider" />
            <div className="prop-section">
              <div className="section-title"><span>{rightTab === 'properties' && selected ? 'ЭЛЕМЕНТ' : 'СЛОИ'} <i>({project.elements.length})</i></span><button className="more-button" onClick={duplicateSelected}><Plus size={15} /></button></div>
              {rightTab === 'properties' && selected ? <>
                <label className="field-label">Название<input className="text-input" value={selected.name} onChange={(event) => updateElement(selected.id, { name: event.target.value })} /></label>
                {selected.kind === 'text' && <label className="field-label">Содержимое<input className="text-input" value={selected.text} onChange={(event) => updateElement(selected.id, { text: event.target.value })} /></label>}
                {selected.kind === 'text' && selected.dynamicVariables && selected.dynamicVariables.length > 0 && <div className="dynamic-settings">
                  <div className="dynamic-settings-title">ДИНАМИЧЕСКИЕ ДАННЫЕ</div>
                  {selected.dynamicVariables.map((id) => {
                    const topic = project.sourceTopics?.find((item) => item.id === id)?.topic
                    return <div className="dynamic-variable" key={id}><span>{id}</span><small>{topic ? `MQTT: ${topic}` : 'Источник не MQTT (например, сенсор/API)'}</small></div>
                  })}
                  <p>Топики из YAML будут обновлены в исходнике при экспорте. «…» в превью обозначает значение, поступающее во время работы устройства.</p>
                </div>}
                <div className="field-row"><label className="field-label">X<input className="number-input" type="number" value={selected.x} onChange={(event) => updateElement(selected.id, { x: Number(event.target.value) })} /></label><label className="field-label">Y<input className="number-input" type="number" value={selected.y} onChange={(event) => updateElement(selected.id, { y: Number(event.target.value) })} /></label></div>
                <div className="field-row"><label className="field-label">Ширина<input className="number-input" type="number" min="1" value={selected.width} onChange={(event) => updateElement(selected.id, { width: Math.max(1, Number(event.target.value)) })} /></label><label className="field-label">Высота<input className="number-input" type="number" min="1" value={selected.height} onChange={(event) => updateElement(selected.id, { height: Math.max(1, Number(event.target.value)) })} /></label></div>
                {selected.kind === 'text' && <div className="field-row"><label className="field-label">Размер шрифта<input className="number-input" type="number" min="5" max="60" value={selected.fontSize} onChange={(event) => updateElement(selected.id, { fontSize: Math.max(5, Number(event.target.value)) })} /></label><label className="field-label">Начертание<select className="select-input" value={selected.fontWeight} onChange={(event) => updateElement(selected.id, { fontWeight: event.target.value as CanvasElement['fontWeight'] })}><option value="normal">Обычный</option><option value="bold">Жирный</option></select></label></div>}
                {selected.kind === 'text' && <label className="field-label">Семейство шрифта<select className="select-input" value={selected.fontFamily} onChange={(event) => updateElement(selected.id, { fontFamily: event.target.value })}><option value="monospace">Моноширинный</option><option value="Arial, sans-serif">Без засечек</option><option value="serif">С засечками</option></select></label>}
                {selected.kind === 'rect' && <label className="field-label">Скругление углов <span className="range-value">{selected.radius}px</span><input className="range-input" type="range" min="0" max={Math.min(30, Math.floor(Math.min(selected.width, selected.height) / 2))} value={selected.radius} onChange={(event) => updateElement(selected.id, { radius: Number(event.target.value) })} /></label>}
                {selected.kind !== 'image' && <label className="field-label">{selected.kind === 'line' ? 'Цвет линии' : 'Цвет заливки'}<div className="color-picker"><input type="color" value={/^#[\da-f]{6}$/i.test(selected.kind === 'line' ? selected.stroke : selected.fill) ? selected.kind === 'line' ? selected.stroke : selected.fill : '#ffffff'} onChange={(event) => updateElement(selected.id, selected.kind === 'line' ? { stroke: event.target.value } : { fill: event.target.value })} /><span>{selected.kind === 'line' ? selected.stroke : selected.fill}</span></div></label>}
                <div className="layer-action-row"><button title="На передний план" onClick={() => moveLayer(1)}><ArrowUp size={14} /></button><button title="На задний план" onClick={() => moveLayer(-1)}><ArrowDown size={14} /></button><button title="Дублировать" onClick={duplicateSelected}><Copy size={14} /></button><button className="delete-action" title="Удалить" onClick={removeSelected}><X size={14} /></button></div>
              </> : <div className="layers-list">{[...project.elements].reverse().map((item) => <button key={item.id} className={`layer-item ${selectedId === item.id ? 'selected-layer' : ''}`} onClick={() => { setSelectedId(item.id); setRightTab('properties') }}><span className="layer-icon">{item.kind === 'text' ? <Type size={14} /> : item.kind === 'circle' ? <Circle size={14} /> : item.kind === 'line' ? <Minus size={14} /> : item.kind === 'image' ? <Image size={14} /> : <Square size={14} />}</span><span>{item.name}</span><span className="layer-visible" title="Выбрать"><Eye size={13} /></span></button>)}</div>}
            </div>
            <div className="quick-export">
              <div className="quick-export-title"><Sparkles size={14} /> Готово к прошивке?</div>
              <p>Экспортируйте код под выбранную библиотеку и дисплей.</p>
              <button className="quick-export-button" onClick={() => setIsCodeOpen(true)}>Открыть генератор <Code2 size={14} /></button>
            </div>
          </div>
          <div className="right-footer"><span><span className="green-dot" /> Готово к экспорту</span><button title="Настройки"><Settings2 size={15} /></button></div>
        </aside>
      </div>

      {isAccountOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !authBusy && !cloudBusy) setIsAccountOpen(false) }}>
        <section className="custom-modal account-modal" role="dialog" aria-modal="true" aria-labelledby="account-title">
          <div className="modal-heading">
            <div><span className="modal-kicker"><Cloud size={13} /> PIXELFORGE CLOUD</span><h2 id="account-title">{account ? 'Аккаунт и проекты' : authMode === 'login' ? 'Войти в аккаунт' : 'Создать аккаунт'}</h2><p>Синхронизируйте веб-проекты между устройствами.</p></div>
            <button className="close-button" onClick={() => setIsAccountOpen(false)} disabled={authBusy || cloudBusy}><X size={18} /></button>
          </div>
          {account ? <>
            <div className="account-user"><span className="account-avatar"><UserRound size={16} /></span><div><b>{account.username}</b><small>Вход выполнен</small></div><button className="button button-secondary" onClick={() => void logout()} disabled={authBusy}><LogOut size={14} /> Выйти</button></div>
            <div className="cloud-project-heading"><b>Облачные проекты</b><button className="icon-button" title="Обновить список" onClick={() => void refreshCloudProjects()} disabled={cloudBusy}><Redo2 size={15} /></button></div>
            <div className="cloud-project-list">
              {cloudProjects.map((item) => <div className="cloud-project-row" key={item.id}>
                <button className="cloud-project-open" onClick={() => void openCloudProject(item.id)} disabled={cloudBusy}><span className="cloud-project-icon"><Monitor size={15} /></span><span><b>{item.name}</b><small>Изменён {new Date(item.updatedAt).toLocaleString()}</small></span><ChevronDown size={14} /></button>
                <button className="cloud-project-delete" title={`Удалить ${item.name}`} onClick={() => void removeCloudProject(item)} disabled={cloudBusy}><X size={15} /></button>
              </div>)}
              {cloudProjects.length === 0 && <p className="cloud-empty">Сохранённых проектов пока нет. Нажмите «Сохранить веб-проект» в верхней панели.</p>}
            </div>
          </> : <>
            <form className="account-form" onSubmit={(event) => void submitAuth(event)}>
              <label className="field-label">Имя пользователя<input className="text-input" autoComplete="username" minLength={3} maxLength={32} value={authUsername} onChange={(event) => setAuthUsername(event.target.value)} required /></label>
              <label className="field-label">Пароль<input className="text-input" type="password" autoComplete={authMode === 'login' ? 'current-password' : 'new-password'} minLength={8} maxLength={256} value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} required /></label>
              <p className="account-hint">Пароль хранится в виде криптографического хеша. Используйте отдельный пароль для этого сайта.</p>
              {cloudError && <p className="account-error" role="alert">{cloudError}</p>}
              <button className="button button-primary account-submit" type="submit" disabled={authBusy}>{authBusy ? 'Подождите…' : authMode === 'login' ? 'Войти' : 'Создать аккаунт'}</button>
            </form>
            <button className="account-mode-switch" onClick={() => { setAuthMode(authMode === 'login' ? 'register' : 'login'); setCloudError('') }}>{authMode === 'login' ? 'Нет аккаунта? Создать' : 'Уже есть аккаунт? Войти'}</button>
          </>}
          {account && cloudError && <p className="account-error" role="alert">{cloudError}</p>}
          <div className="account-footer"><Save size={13} /> Веб-проект и экспорт исходного кода — отдельные функции.</div>
        </section>
      </div>}

      {isCodeOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setIsCodeOpen(false) }}>
        <section className="code-modal" role="dialog" aria-modal="true" aria-labelledby="code-title">
          <div className="modal-heading"><div><span className="modal-kicker"><Sparkles size={13} /> PIXELFORGE CODEGEN</span><h2 id="code-title">Код для вашего дисплея</h2><p>{display.controller} · {project.width} × {project.height} · {project.elements.length} объектов</p></div><button className="close-button" onClick={() => setIsCodeOpen(false)}><X size={18} /></button></div>
          {project.sourceCode ? <div className="code-tabs"><span className="source-mode-label"><FileCode2 size={14} /> ИСХОДНЫЙ {project.sourceFormat === 'esphome' ? 'ESPHOME YAML' : 'ARDUINO C++'}</span><button className="source-replace-button" onClick={() => { setIsCodeOpen(false); openSourceImport() }}>Заменить исходник</button></div> : <div className="code-tabs"><button className={codeTarget === 'arduino' ? 'active' : ''} onClick={() => setCodeTarget('arduino')}><Code2 size={15} /> Arduino</button><button className={codeTarget === 'esphome' ? 'active' : ''} onClick={() => setCodeTarget('esphome')}><WifiIcon /> ESPHome</button><span className="code-tab-note">{codeTarget === 'arduino' ? display.library === 'u8g2' ? 'U8g2' : 'Arduino_GFX' : 'YAML · ESPHome'}</span></div>}
          {!generatedCode ? <div className="unsupported-notice"><span>!</span><div><b>Для этой платы нет проверенного шаблона генерации</b><p>Макет и экспорт PNG/SVG доступны. Импортированный исходник можно сохранить без изменений, пока не добавлен шаблон для этой шины и платы.</p></div></div> : <>
            <div className="code-note"><span className="note-icon"><Sparkles size={14} /></span><span>{project.sourceCode ? 'Экспорт сохраняет загруженный файл и заменяет только распознанные команды отрисовки. Настройка платы, пины, сенсоры и остальная логика остаются как в исходнике.' : codeTarget === 'arduino' ? 'Добавьте библиотеку в Arduino IDE. Проверьте пины и инициализацию дисплея перед загрузкой.' : 'Вставьте фрагмент в конфигурацию ESPHome. Пины подключения указаны как пример для ESP32 — проверьте их перед прошивкой.'}{project.sourceCode ? activeSourceWarnings.length > 0 && ` ${activeSourceWarnings.join(' ')}` : codeCaveats.length > 0 && ` ${codeCaveats.join(' ')}`}</span></div>
            <pre className="code-window"><code>{generatedCode}</code></pre>
            <div className="modal-footer"><span className="code-ready"><span /> {project.sourceCode ? 'Сохранён исходный код' : 'Код готов · проверьте распиновку'}</span><div><button className="button button-secondary" onClick={() => void copyCode()}><Copy size={14} /> Копировать</button><button className="button button-primary" onClick={codeDownload}><Download size={14} /> Скачать {project.sourceFormat === 'arduino' || !project.sourceFormat && codeTarget === 'arduino' ? '.ino' : '.yaml'}</button></div></div>
          </>}
        </section>
      </div>}

      {isSourceOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setIsSourceOpen(false) }}>
        <section className="source-modal" role="dialog" aria-modal="true" aria-labelledby="source-title">
          <div className="modal-heading"><div><span className="modal-kicker"><FileCode2 size={13} /> IMPORT EXISTING FIRMWARE</span><h2 id="source-title">Загрузить готовый код</h2><p>Распознаем экран, покажем макет и сохраним остальной исходник.</p></div><button className="close-button" onClick={() => setIsSourceOpen(false)}><X size={18} /></button></div>
          <div className="source-controls"><label className="source-format">Формат<select className="select-input" value={sourceDraftFormat} onChange={(event) => setSourceDraftFormat(event.target.value as 'arduino' | 'esphome')}><option value="arduino">Arduino / C++</option><option value="esphome">ESPHome YAML</option></select></label><button className="button button-secondary" onClick={() => sourceImportRef.current?.click()}><FolderOpen size={14} /> Загрузить файл</button></div>
          <textarea className="source-editor" spellCheck={false} value={sourceDraft} onChange={(event) => setSourceDraft(event.target.value)} placeholder={'Вставьте исходник сюда или загрузите .ino / .cpp / .yaml файл…\n\nПоддерживаются распространенные команды U8g2, TFT_eSPI, Adafruit_GFX / Arduino_GFX и ESPHome display lambda.'} />
          <div className="source-hint"><span><Sparkles size={13} /> Безопасный импорт: неизвестные строки сохраняются без изменений.</span><span>{sourceDraft.length.toLocaleString('ru-RU')} символов</span></div>
          {sourceWarnings.length > 0 && <div className="source-warnings">{sourceWarnings.map((warning) => <p key={warning}>! {warning}</p>)}</div>}
          <div className="source-footer"><span>Файл остается локально в браузере.</span><div><button className="button button-secondary" onClick={() => setIsSourceOpen(false)}>Отмена</button><button className="button button-primary" onClick={applyImportedSource}><Eye size={14} /> Распознать экран</button></div></div>
        </section>
      </div>}

      {isCustomOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setIsCustomOpen(false) }}><form className="custom-modal" onSubmit={addCustomDisplay}>
        <div className="modal-heading"><div><span className="modal-kicker"><Monitor size={13} /> CUSTOM DISPLAY</span><h2>Свой дисплей</h2><p>Задайте параметры экрана вручную.</p></div><button type="button" className="close-button" onClick={() => setIsCustomOpen(false)}><X size={18} /></button></div>
        <label className="field-label">Название<input className="text-input" name="name" placeholder="Например, мой экран" required /></label>
        <label className="field-label">Контроллер<input className="text-input" name="controller" placeholder="Например, ST7789" /></label>
        <div className="field-row"><label className="field-label">Ширина (px)<input className="number-input" name="width" type="number" min="8" max="2048" defaultValue="128" required /></label><label className="field-label">Высота (px)<input className="number-input" name="height" type="number" min="8" max="2048" defaultValue="64" required /></label></div>
        <div className="field-row"><label className="field-label">Тип экрана<select className="select-input" name="kind" defaultValue="OLED"><option>OLED</option><option>TFT</option><option>E-Paper</option><option>LED Matrix</option></select></label><label className="custom-check"><input type="checkbox" name="color" /> Цветной дисплей</label></div>
        <p className="custom-note">Пользовательские дисплеи доступны для макета и экспорта изображений. Для генерации кода нужен поддерживаемый шаблон контроллера.</p>
        <div className="custom-actions"><button type="button" className="button button-secondary" onClick={() => setIsCustomOpen(false)}>Отмена</button><button className="button button-primary" type="submit"><Plus size={15} /> Создать дисплей</button></div>
      </form></div>}
      {toast && <div className="toast"><Check size={15} />{toast}</div>}
    </div>
  )
}

function FolderIcon() {
  return <FolderOpen size={15} />
}

function WifiIcon() {
  return <Wifi size={15} />
}

export default App
