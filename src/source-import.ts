import type { CanvasElement, Project, SourceBranchGroup, SourceTopic } from './types'
import { displays } from './displays'

type SourceFormat = 'arduino' | 'esphome'
type Renderer = 'u8g2' | 'tft-espi' | 'gfx' | 'esphome'

function u8g2BaselineOffset(fontSize: number) {
  return Math.round(fontSize)
}

function conditionNumber(value: string, source: string): number | undefined {
  let token = value.trim()
  while (token.startsWith('(') && matchingDelimiter(token, 0, '(', ')') === token.length - 1) token = token.slice(1, -1).trim()
  const direct = Number(token)
  if (token && Number.isFinite(direct)) return direct
  if (!/^[A-Za-z_]\w*$/.test(token)) return undefined
  const define = new RegExp(`^\\s*#\\s*define\\s+${token}\\s+(-?(?:\\d+(?:\\.\\d*)?|\\.\\d+))\\s*$`, 'm').exec(source)
  if (define) return Number(define[1])
  const declaration = new RegExp(`\\b(?:const\\s+)?(?:bool|int|float|double|long|short|unsigned|uint\\d+_t|int\\d+_t|size_t|auto)\\s+${token}\\s*=\\s*([^,;\\r\\n]+)`).exec(source)?.[1]?.trim()
  if (!declaration) return undefined
  const initial = Number(declaration)
  if (Number.isFinite(initial)) return initial
  const stateId = declaration.match(/id\(\s*([A-Za-z_]\w*)\s*\)\.state/)?.[1].toLowerCase()
  if (stateId) {
    if (/temp/.test(stateId)) return 21.5
    if (/hum/.test(stateId)) return 45
    if (/code|weather/.test(stateId)) return 0
  }
  if (/temp/.test(declaration.toLowerCase())) return 21.5
  if (/hum/.test(declaration.toLowerCase())) return 45
  if (/code|weather/.test(declaration.toLowerCase())) return 0
  return undefined
}

interface Call {
  receiver: string
  operator: '.' | '->'
  method: string
  start: number
  end: number
  args: string[]
  indent: string
}

function sourceCondition(condition: string, source: string): boolean {
  let value = condition.trim()
  while (value.startsWith('(') && matchingDelimiter(value, 0, '(', ')') === value.length - 1) value = value.slice(1, -1).trim()
  const logicalParts = (operator: '||' | '&&') => {
    const parts: string[] = []
    let depth = 0
    let start = 0
    for (let index = 0; index < value.length; index += 1) {
      if (value[index] === '(') depth += 1
      else if (value[index] === ')') depth -= 1
      else if (depth === 0 && value.startsWith(operator, index)) {
        parts.push(value.slice(start, index).trim())
        start = index + operator.length
        index += operator.length - 1
      }
    }
    if (parts.length) parts.push(value.slice(start).trim())
    return parts
  }
  const disjunction = logicalParts('||')
  if (disjunction.length) return disjunction.some((part) => sourceCondition(part, source))
  const conjunction = logicalParts('&&')
  if (conjunction.length) return conjunction.every((part) => sourceCondition(part, source))
  if (value.startsWith('!')) return !sourceCondition(value.slice(1), source)
  const comparison = /^(.+?)\s*(==|!=|<=|>=|<|>)\s*(-?(?:\d+(?:\.\d*)?|\.\d+))$/.exec(value)
  if (!comparison) return false
  const left = conditionNumber(comparison[1], source)
  const right = Number(comparison[3])
  if (left === undefined) return false
  switch (comparison[2]) {
    case '==': return left === right
    case '!=': return left !== right
    case '<': return left < right
    case '<=': return left <= right
    case '>': return left > right
    case '>=': return left >= right
    default: return false
  }
}

function sourceStringValue(identifier: string, source: string, depth = 0): string | undefined {
  if (depth > 4) return undefined
  const initial = new RegExp(`\\b${identifier}\\s*=\\s*"((?:\\\\.|[^"])*)"`, 'g').exec(source)
  let value = initial ? literal(`"${initial[1]}"`) : undefined
  let conditionalValueSelected = false
  for (const match of source.matchAll(/\bif\s*\(([^{}]*)\)\s*\{([^{}]*)\}/g)) {
    if (conditionalValueSelected || !new RegExp(`\\b${identifier}\\s*=\\s*"((?:\\\\.|[^"])*)"`).test(match[2]) || !sourceCondition(match[1], source)) continue
    const assignment = new RegExp(`\\b${identifier}\\s*=\\s*"((?:\\\\.|[^"])*)"`).exec(match[2])
    if (assignment) {
      value = literal(`"${assignment[1]}"`)
      conditionalValueSelected = true
    }
  }
  const assignmentPattern = new RegExp(`\\b${identifier}\\s*=\\s*"((?:\\\\.|[^"])*)"`, 'g')
  for (const assignment of source.matchAll(assignmentPattern)) {
    const lineStart = source.lastIndexOf('\n', assignment.index ?? 0) + 1
    const prefix = source.slice(lineStart, assignment.index)
    const condition = /(?:else\s+)?if\s*\(([^()]*)\)\s*$/.exec(prefix.trim())
    if (conditionalValueSelected || !condition || !sourceCondition(condition[1], source)) continue
    value = literal(`"${assignment[1]}"`)
    conditionalValueSelected = true
  }
  return value
}

function sourceStringSample(identifier: string, source: string): string | undefined {
  const value = sourceStringValue(identifier, source)
  if (value) return value

  const declaration = new RegExp(`\\b${identifier}\\s*=\\s*"[^"]*"[^\\r\\n]*`, 'i').exec(source)?.[0]
  if (declaration) {
    const comment = declaration.match(/\/\/\s*(.*)$/)?.[1]
    const examples = comment?.match(/\(([^)]{2,120})\)/)?.[1]
    if (examples) {
      const sample = examples
        .replace(/\b(?:и\s*)?т\.\s*д\.?|\betc\.?/gi, '')
        .split(/[;,]/)
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 2)
        .join(', ')
      if (sample) return sample
    }
  }

  const dynamicAssignment = new RegExp(`\\b${identifier}\\s*=\\s*([A-Za-z_]\\w*)\\s*;`).exec(source)
  if (dynamicAssignment) {
    const valueName = dynamicAssignment[1]
    const literal = new RegExp(`\\b${valueName}\\s*==\\s*"([^"]+)"`, 'i').exec(source)?.[1]
    if (literal) return literal.toUpperCase()
  }
  return undefined
}

function formatSourcePreview(format: string, args: string[], source: string) {
  let argIndex = 0
  const tokens = /%%|%(?:[-+ #0]*\d*(?:\.\d+)?[hlLzjt]*[diuoxXfFeEgGacsp])/g
  return format.replace(tokens, (token) => {
    if (token === '%%') return '%'
    const argument = args[argIndex++]
    if (!argument) return '…'
    const type = token[token.length - 1]
    if (type === 's' || type === 'p') {
      const id = argument.match(/\bid\(\s*([A-Za-z_]\w*)\s*\)/)?.[1] ?? argument.match(/^[A-Za-z_]\w*$/)?.[0]
      return id ? sourceStringSample(id, source) ?? (/status|message|msg/i.test(id) ? 'Сообщение' : '…') : '…'
    }
    const number = sourceNumber(argument, source)
    if (number === undefined) return '0'
    const precision = Number(token.match(/\.(\d+)/)?.[1] ?? 0)
    if ('fFeEgG'.includes(type)) return number.toFixed(Math.min(precision, 4))
    if (type === 'c') return String.fromCharCode(number)
    const integer = String(Math.trunc(number))
    const width = Number(token.match(/%[-+ #0]*(\d+)/)?.[1] ?? 0)
    if (!width || integer.length >= width) return integer
    const padding = token.includes('0') ? '0' : ' '
    return integer.startsWith('-') && padding === '0'
      ? `-${integer.slice(1).padStart(width - 1, padding)}`
      : integer.padStart(width, padding)
  })
}

function sourceFunctionArguments(source: string, method: string) {
  const calls: string[][] = []
  const pattern = new RegExp(`\\b${method}\\s*\\(`, 'g')
  for (const match of source.matchAll(pattern)) {
    const open = (match.index ?? 0) + match[0].lastIndexOf('(')
    const close = matchingDelimiter(source, open, '(', ')')
    if (close >= 0) calls.push(parseCallArgs(source.slice(open + 1, close)))
  }
  return calls
}

function previewStringFunction(expression: string, source: string) {
  const call = /^([A-Za-z_]\w*)\s*\((.*)\)$/.exec(expression.trim())
  if (!call) return undefined
  const functionPattern = new RegExp(`\\b[A-Za-z_][\\w:*\\s]*\\b${call[1]}\\s*\\(([^)]*)\\)\\s*\\{([\\s\\S]*?)\\n\\}`, 'm')
  const definition = functionPattern.exec(source)
  if (!definition) return undefined
  const parameter = definition[1].match(/[A-Za-z_]\w*\s*$/)?.[0]?.trim()
  const argument = parseCallArgs(call[2])[0]
  const argumentValue = argument ? conditionNumber(argument, source) : undefined
  let fallback: string | undefined
  for (const match of definition[2].matchAll(/(?:if\s*\(([^)]*)\)\s*)?return\s+"((?:\\.|[^"])*)"\s*;/g)) {
    const result = literal(`"${match[2]}"`)
    if (!match[1]) fallback = result
    else if (parameter && argumentValue !== undefined) {
      const condition = match[1].replace(new RegExp(`\\b${parameter}\\b`, 'g'), String(argumentValue))
      if (sourceCondition(condition, source)) return result
    }
  }
  return fallback
}

function previewDynamicText(argument: string, source: string) {
  const cleanArg = argument.trim().replace(/\.c_str\(\)\s*$/, '').replace(/^String\s*\(\s*(.*)\s*\)$/, '$1')
  const functionValue = previewStringFunction(cleanArg, source)
  if (functionValue !== undefined) return functionValue
  const id = cleanArg.match(/\bid\(\s*([A-Za-z_]\w*)\s*\)/)?.[1]
  const identifier = id ?? cleanArg.match(/^[A-Za-z_]\w*$/)?.[0]
  if (identifier) {
    const snprintf = sourceFunctionArguments(source, 'snprintf').find((args) => args[0] === identifier)
    const snprintfFormatIndex = snprintf?.findIndex((argument, index) => index > 0 && literal(argument) !== undefined) ?? -1
    if (snprintf && snprintfFormatIndex >= 0) {
      return formatSourcePreview(literal(snprintf[snprintfFormatIndex])!, snprintf.slice(snprintfFormatIndex + 1), source)
    }
    const sprintf = sourceFunctionArguments(source, 'sprintf').find((args) => args[0] === identifier)
    const sprintfFormatIndex = sprintf?.findIndex((argument, index) => index > 0 && literal(argument) !== undefined) ?? -1
    if (sprintf && sprintfFormatIndex >= 0) {
      return formatSourcePreview(literal(sprintf[sprintfFormatIndex])!, sprintf.slice(sprintfFormatIndex + 1), source)
    }
    const sample = sourceStringSample(identifier, source)
    if (sample !== undefined) return sample
    const declaration = new RegExp(`\\b(?:const\\s+)?(?:int|float|double|long|short|unsigned|uint\\d+_t|int\\d+_t|size_t|auto)\\s+${identifier}\\s*=\\s*([^,;\\r\\n]+)`).exec(source)?.[1]
    const numVal = declaration === undefined ? undefined : Number(declaration.trim())
    if (numVal !== undefined && Number.isFinite(numVal)) return String(numVal)

    const lower = `${identifier} ${declaration ?? ''}`.toLowerCase()
    if (/temp/.test(lower)) return '21.5'
    if (/hum/.test(lower)) return '45%'
    if (/speed|rpm/.test(lower)) return '60'
    if (/volt/.test(lower)) return '3.3V'
    if (/time|hour|clock/.test(lower)) return '12:00'
    if (/date/.test(lower)) return '2026-10-15'
    if (/status|message|msg/i.test(lower)) return 'Сообщение'
    if (/ip\b/.test(lower)) return '192.168.1.100'
    return identifier
  }
  const directNum = numeric(cleanArg)
  if (directNum !== undefined) return String(directNum)
  const resolvedNum = sourceNumber(cleanArg, source)
  if (resolvedNum !== undefined) return String(resolvedNum)
  return cleanArg.replace(/[();]/g, '').trim() || '…'
}

interface SourceElement {
  id: string
  start: number
  end: number
  receiver: string
  operator: '.' | '->'
  method: string
  args: string[]
  previewText?: string
  cursor?: { receiver: string; x: string | number; y: string | number; start: number }
  renderer: Renderer
  indent: string
  loopCoordinate?: {
    axis: 'x' | 'y'
    expression: string
    value: number
    offsets: number[]
    originalX: number
    originalY: number
    originalWidth: number
    originalHeight: number
  }
  bitmapGeometry?: {
    xIndex: number
    yIndex: number
    widthIndex: number
    heightIndex: number
    originalX: number
    originalY: number
    originalWidth: number
    originalHeight: number
  }
  triangleGeometry?: {
    points: Array<{ x: number; y: number }>
    colorIndex: number
  }
  originalX?: number
  originalY?: number
  originalCode?: string
  originalElement?: CanvasElement
  fontExpression?: string
}

interface SourceTopicMapping extends SourceTopic {
  start: number
  end: number
  quoted: '"' | "'" | null
}

interface ConditionalBranch {
  start: number
  end: number
  label: string
}

interface ConditionalGroup extends SourceBranchGroup {
  branches: ConditionalBranch[]
  defaultChoice: number
}

export interface ParsedDisplaySource {
  format: SourceFormat
  elements: CanvasElement[]
  renderer: Renderer
  mappings: SourceElement[]
  suggestedDisplayId?: string
  suggestedSize?: { width: number; height: number }
  sourceTopics: SourceTopic[]
  sourceBranchGroups: SourceBranchGroup[]
  sourceBranchSelection: Record<string, number>
  warnings: string[]
}

function parseCallArgs(value: string) {
  const args: string[] = []
  let start = 0
  let depth = 0
  let quote = ''
  let escaped = false
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (quote) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === '(' || char === '[' || char === '{') depth += 1
    else if (char === ')' || char === ']' || char === '}') depth -= 1
    else if (char === ',' && depth === 0) {
      args.push(value.slice(start, index).trim())
      start = index + 1
    }
  }
  if (value.slice(start).trim()) args.push(value.slice(start).trim())
  return args
}

function scanSourceTopics(source: string): SourceTopicMapping[] {
  const lines = source.match(/[^\n]*(?:\n|$)/g)?.filter((line) => line.length > 0) ?? []
  const records: Array<{ indent: number; topic: string; start: number; end: number; quoted: '"' | "'" | null; line: number }> = []
  let offset = 0
  lines.forEach((rawLine, lineIndex) => {
    const line = rawLine.replace(/\r?\n$/, '')
    const match = /^(\s*)-\s+topic:\s*(?:"((?:\\.|[^"])*)"|'([^']*)'|([^#\s]+))\s*(?:#.*)?$/.exec(line)
    if (match) {
      const raw = match[2] ?? match[3] ?? match[4]
      const quote = match[2] !== undefined ? '"' : match[3] !== undefined ? "'" : null
      const valueStart = line.indexOf(quote ?? raw, line.indexOf('topic:') + 6) + (quote ? 1 : 0)
      records.push({
        indent: match[1].length,
        topic: raw,
        start: offset + valueStart,
        end: offset + valueStart + raw.length,
        quoted: quote,
        line: lineIndex,
      })
    }
    offset += rawLine.length
  })
  const mappings: SourceTopicMapping[] = []
  records.forEach((record) => {
    let endLine = record.line + 1
    while (endLine < lines.length) {
      const line = lines[endLine].replace(/\r?\n$/, '')
      const indentation = /^(\s*)/.exec(line)?.[1].length ?? 0
      if (line.trim() && indentation <= record.indent) break
      endLine += 1
    }
    const body = lines.slice(record.line + 1, endLine).join('\n')
    for (const match of body.matchAll(/\bid\(\s*([A-Za-z_]\w*)\s*\)\s*=/g)) {
      mappings.push({ id: match[1], topic: record.topic, start: record.start, end: record.end, quoted: record.quoted })
    }
  })
  return mappings
}

function scanCalls(source: string): Call[] {
  const calls: Call[] = []
  let index = 0
  while (index < source.length) {
    const char = source[index]
    if (char === '"' || char === "'" || char === '`') {
      const quote = char
      index += 1
      while (index < source.length) {
        if (source[index] === '\\') index += 2
        else if (source[index++] === quote) break
      }
      continue
    }
    if (char === '/' && source[index + 1] === '/') {
      index = source.indexOf('\n', index + 2)
      if (index < 0) break
      continue
    }
    if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2)
      index = end < 0 ? source.length : end + 2
      continue
    }
    if (!/[A-Za-z_$]/.test(char)) {
      index += 1
      continue
    }
    const start = index
    index += 1
    while (/[\w$]/.test(source[index] ?? '')) index += 1
    const receiver = source.slice(start, index)
    let cursor = index
    while (/\s/.test(source[cursor] ?? '')) cursor += 1
    let operator: Call['operator']
    if (source.startsWith('->', cursor)) { operator = '->'; cursor += 2 }
    else if (source[cursor] === '.') { operator = '.'; cursor += 1 }
    else continue
    while (/\s/.test(source[cursor] ?? '')) cursor += 1
    if (!/[A-Za-z_$]/.test(source[cursor] ?? '')) continue
    const methodStart = cursor
    cursor += 1
    while (/[\w$]/.test(source[cursor] ?? '')) cursor += 1
    const method = source.slice(methodStart, cursor)
    while (/\s/.test(source[cursor] ?? '')) cursor += 1
    if (source[cursor] !== '(') continue
    const argsStart = ++cursor
    let depth = 1
    let quote = ''
    let escaped = false
    while (cursor < source.length && depth > 0) {
      const current = source[cursor]
      if (quote) {
        if (escaped) escaped = false
        else if (current === '\\') escaped = true
        else if (current === quote) quote = ''
      } else if (current === '"' || current === "'" || current === '`') quote = current
      else if (current === '(') depth += 1
      else if (current === ')') depth -= 1
      cursor += 1
    }
    if (depth !== 0) continue
    let end = cursor
    while (/\s/.test(source[end] ?? '')) end += 1
    if (source[end] === ';') end += 1
    const lineStart = source.lastIndexOf('\n', start - 1) + 1
    const prefix = source.slice(lineStart, start)
    calls.push({ receiver, operator, method, start, end, args: parseCallArgs(source.slice(argsStart, cursor - 1)), indent: /^\s*$/.test(prefix) ? prefix : '' })
    index = cursor
  }
  return calls
}

function skipQuotedOrComment(source: string, index: number) {
  const char = source[index]
  if (char === '"' || char === "'" || char === '`') {
    index += 1
    while (index < source.length) {
      if (source[index] === '\\') index += 2
      else if (source[index++] === char) break
    }
    return index
  }
  if (source.startsWith('//', index)) {
    const end = source.indexOf('\n', index + 2)
    return end < 0 ? source.length : end + 1
  }
  if (source.startsWith('/*', index)) {
    const end = source.indexOf('*/', index + 2)
    return end < 0 ? source.length : end + 2
  }
  return index
}

function matchingDelimiter(source: string, start: number, open: string, close: string) {
  let depth = 1
  let index = start + 1
  while (index < source.length && depth > 0) {
    const skipped = skipQuotedOrComment(source, index)
    if (skipped !== index) {
      index = skipped
      continue
    }
    if (source[index] === open) depth += 1
    else if (source[index] === close) depth -= 1
    index += 1
  }
  return depth === 0 ? index - 1 : -1
}

function conditionalGroups(source: string, calls: Call[]): ConditionalGroup[] {
  const groups: ConditionalGroup[] = []
  const consumedIfs = new Set<number>()
  let index = 0
  while (index < source.length) {
    const skipped = skipQuotedOrComment(source, index)
    if (skipped !== index) { index = skipped; continue }
    if (!/[A-Za-z_$]/.test(source[index])) {
      index += 1
      continue
    }
    const start = index++
    while (/[\w$]/.test(source[index] ?? '')) index += 1
    if (source.slice(start, index) !== 'if' || consumedIfs.has(start)) continue
    let cursor = index
    while (/\s/.test(source[cursor] ?? '')) cursor += 1
    if (source[cursor] !== '(') continue
    const conditionEnd = matchingDelimiter(source, cursor, '(', ')')
    if (conditionEnd < 0) continue
    const condition = source.slice(cursor + 1, conditionEnd).trim()
    cursor = conditionEnd + 1
    while (/\s/.test(source[cursor] ?? '')) cursor += 1
    if (source[cursor] !== '{') continue
    const ifOpen = cursor
    let ifClose = matchingDelimiter(source, ifOpen, '{', '}')
    if (ifClose < 0) continue
    const branches: ConditionalBranch[] = [{ start: ifOpen + 1, end: ifClose, label: `if (${condition})` }]
    cursor = ifClose + 1
    while (true) {
      while (/\s/.test(source[cursor] ?? '')) cursor += 1
      if (!source.startsWith('else', cursor) || /[\w$]/.test(source[cursor + 4] ?? '')) break
      cursor += 4
      while (/\s/.test(source[cursor] ?? '')) cursor += 1
      let label = 'else'
      if (source.startsWith('if', cursor) && !/[\w$]/.test(source[cursor + 2] ?? '')) {
        const elseIfStart = cursor
        consumedIfs.add(elseIfStart)
        cursor += 2
        while (/\s/.test(source[cursor] ?? '')) cursor += 1
        if (source[cursor] !== '(') break
        const elseIfEnd = matchingDelimiter(source, cursor, '(', ')')
        if (elseIfEnd < 0) break
        label = `else if (${source.slice(cursor + 1, elseIfEnd).trim()})`
        cursor = elseIfEnd + 1
        while (/\s/.test(source[cursor] ?? '')) cursor += 1
      }
      if (source[cursor] !== '{') break
      const branchOpen = cursor
      const branchClose = matchingDelimiter(source, branchOpen, '{', '}')
      if (branchClose < 0) break
      branches.push({ start: branchOpen + 1, end: branchClose, label })
      cursor = branchClose + 1
    }
    const hasFinalElse = branches.at(-1)?.label === 'else'
    if (!hasFinalElse) branches.push({ start: cursor, end: cursor, label: 'ни одно условие не выполнено' })
    const id = `branch-${start}`
    const counts = branches.map((branch) => calls.filter((call) => call.start >= branch.start && call.start < branch.end).length)
    if (!counts.some((count) => count > 0)) continue
    const defaultChoice = hasFinalElse
      ? counts.reduce((best, count, choice) => count > counts[best] ? choice : best, 0)
      : branches.length === 2 ? 0 : branches.length - 1
    groups.push({
      id,
      label: branches[0].label,
      choices: branches.map((branch) => branch.label),
      branches,
      defaultChoice,
    })
  }
  for (const group of groups) {
    const groupStart = Number(group.id.slice('branch-'.length))
    const parent = groups
      .filter((candidate) => candidate !== group)
      .flatMap((candidate) => candidate.branches.map((branch, choice) => ({ candidate, branch, choice })))
      .filter(({ branch }) => groupStart >= branch.start && groupStart < branch.end)
      .sort((left, right) => left.branch.end - left.branch.start - (right.branch.end - right.branch.start))[0]
    if (parent) group.parentPath = [...(parent.candidate.parentPath ?? []), { id: parent.candidate.id, choice: parent.choice }]
  }
  return groups
}

function displayLambdaRange(source: string) {
  const lines = source.match(/[^\n]*(?:\n|$)/g)?.filter((line) => line.length > 0) ?? []
  let offset = 0
  let inDisplay = false
  let displayEnd = source.length
  let lambdaStart = -1
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r?\n$/, '')
    if (/^display:\s*(?:#.*)?$/.test(line)) {
      inDisplay = true
      offset += rawLine.length
      continue
    }
    if (inDisplay && /^\S[\w-]*\s*:/.test(line) && !/^\s*#/.test(line)) {
      displayEnd = offset
      break
    }
    if (inDisplay && lambdaStart < 0 && /^\s+lambda:\s*\|[-+]?\s*(?:#.*)?$/.test(line)) {
      lambdaStart = offset + rawLine.length
    }
    offset += rawLine.length
  }
  if (lambdaStart < 0) return undefined
  return { start: lambdaStart, end: displayEnd }
}

function displayConditionalGroups(source: string, calls: Call[], format: SourceFormat) {
  if (format !== 'esphome') return conditionalGroups(source, calls)
  const range = displayLambdaRange(source)
  if (!range) return []
  const lambda = source.slice(range.start, range.end)
  const localCalls = calls
    .filter((call) => call.start >= range.start && call.start < range.end)
    .map((call) => ({ ...call, start: call.start - range.start, end: call.end - range.start }))
  return conditionalGroups(lambda, localCalls).map((group) => ({
    ...group,
    id: `branch-${range.start + Number(group.id.slice('branch-'.length))}`,
    parentPath: group.parentPath?.map(({ id, choice }) => ({
      id: `branch-${range.start + Number(id.slice('branch-'.length))}`,
      choice,
    })),
    branches: group.branches.map((branch) => ({ ...branch, start: branch.start + range.start, end: branch.end + range.start })),
  }))
}

function numeric(value?: string) {
  if (!value || !/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim())) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.round(parsed) : undefined
}

function evaluateArithmetic(expr: string): number | undefined {
  const matched = expr.match(/\d+(?:\.\d+)?|[+\-*/%()]/g)
  if (!matched) return undefined
  const tokens = matched
  let pos = 0
  function parseExpr(): number {
    let result = parseTerm()
    while (pos < tokens.length && (tokens[pos] === '+' || tokens[pos] === '-')) {
      const op = tokens[pos++]
      const right = parseTerm()
      result = op === '+' ? result + right : result - right
    }
    return result
  }
  function parseTerm(): number {
    let result = parseFactor()
    while (pos < tokens.length && (tokens[pos] === '*' || tokens[pos] === '/' || tokens[pos] === '%')) {
      const op = tokens[pos++]
      const right = parseFactor()
      if (op === '*') result = result * right
      else if (op === '/') result = right === 0 ? 0 : result / right
      else result = right === 0 ? 0 : result % right
    }
    return result
  }
  function parseFactor(): number {
    if (pos >= tokens.length) return 0
    if (tokens[pos] === '+') { pos++; return parseFactor() }
    if (tokens[pos] === '-') { pos++; return -parseFactor() }
    if (tokens[pos] === '(') {
      pos++
      const result = parseExpr()
      if (tokens[pos] === ')') pos++
      return result
    }
    const num = Number(tokens[pos++])
    return Number.isFinite(num) ? num : 0
  }
  const res = parseExpr()
  return Number.isFinite(res) ? Math.round(res) : undefined
}

function resolveSourceNumber(expression: string, source: string, depth = 0, size?: { width: number; height: number }): number | undefined {
  let value = expression.trim().replace(/^\(\s*(?:int|float|double|long|short|unsigned|uint\d+_t|int\d+_t|size_t)\s*\)\s*/, '')
  while (value.startsWith('(') && matchingDelimiter(value, 0, '(', ')') === value.length - 1) {
    value = value.slice(1, -1).trim()
  }
  const direct = numeric(value)
  if (direct !== undefined) return direct
  if (depth > 6) return undefined

  const screenW = size?.width ?? 128
  const screenH = size?.height ?? 64

  if (/^(?:tft\.|display\.|u8g2\.|screen\.|it\.)?(?:getDisplayWidth|getWidth|width)\s*\(\s*\)$/i.test(value)) return screenW
  if (/^(?:tft\.|display\.|u8g2\.|screen\.|it\.)?(?:getDisplayHeight|getHeight|height)\s*\(\s*\)$/i.test(value)) return screenH
  if (/^(?:SCREEN_WIDTH|TFT_WIDTH|DISP_WIDTH|DISPLAY_WIDTH|SCREEN_W|TFT_W|WIDTH)$/i.test(value)) return screenW
  if (/^(?:SCREEN_HEIGHT|TFT_HEIGHT|DISP_HEIGHT|DISPLAY_HEIGHT|SCREEN_H|TFT_H|HEIGHT)$/i.test(value)) return screenH

  const stateValue = /^id\(\s*([A-Za-z_]\w*)\s*\)\.state$/.exec(value)
  if (stateValue) {
    const id = stateValue[1].toLowerCase()
    if (/temp/.test(id)) return 21.5
    if (/hum|humid/.test(id)) return 45
    if (/code|weather/.test(id)) return 0
    return 0
  }

  // Compound expression containing arithmetic operators
  if (/[+\-*/%]/.test(value)) {
    let replaced = value
      .replace(/(?:tft\.|display\.|u8g2\.|screen\.|it\.)?(?:getDisplayWidth|getWidth|width)\s*\(\s*\)/gi, String(screenW))
      .replace(/(?:tft\.|display\.|u8g2\.|screen\.|it\.)?(?:getDisplayHeight|getHeight|height)\s*\(\s*\)/gi, String(screenH))
      .replace(/\b(?:SCREEN_WIDTH|TFT_WIDTH|DISP_WIDTH|DISPLAY_WIDTH|SCREEN_W|TFT_W|WIDTH)\b/gi, String(screenW))
      .replace(/\b(?:SCREEN_HEIGHT|TFT_HEIGHT|DISP_HEIGHT|DISPLAY_HEIGHT|SCREEN_H|TFT_H|HEIGHT)\b/gi, String(screenH))

    const idMatches = [...new Set(replaced.match(/[A-Za-z_]\w*/g) ?? [])]
    let allResolved = true
    for (const id of idMatches) {
      const resolved = resolveSourceNumber(id, source, depth + 1, size)
      if (resolved !== undefined) {
        replaced = replaced.replace(new RegExp(`\\b${id}\\b`, 'g'), String(resolved))
      } else {
        allResolved = false
      }
    }
    if (allResolved && /^[\d\s+\-*/%().]+$/.test(replaced)) {
      const mathResult = evaluateArithmetic(replaced)
      if (mathResult !== undefined) return mathResult
    }
  }

  if (!/^[A-Za-z_]\w*$/.test(value)) return undefined

  // Check #define
  const defMatch = source.match(new RegExp(`^\\s*#\\s*define\\s+${value}\\s+([^/\\r\\n]+)`, 'm'))
  if (defMatch) {
    const resolved = resolveSourceNumber(defMatch[1].trim(), source, depth + 1, size)
    if (resolved !== undefined) return resolved
  }

  // Check const declarations
  const declMatch = source.match(new RegExp(`\\bconst\\s+(?:int|float|double|long|short|unsigned|uint\\d+_t|int\\d+_t|size_t|auto)\\s+[^;]*?\\b${value}\\s*=\\s*([^,;\\r\\n]+)`))
  if (declMatch) {
    const resolved = resolveSourceNumber(declMatch[1].trim(), source, depth + 1, size)
    if (resolved !== undefined) return resolved
  }

  const assignments = [...source.matchAll(new RegExp(`\\b${value}\\s*=\\s*([^,;\\r\\n]+)`, 'g'))]
  for (const match of source.matchAll(/\bif\s*\(([^{}]*)\)\s*\{([^{}]*)\}/g)) {
    const bodyOffset = (match.index ?? 0) + match[0].indexOf(match[2])
    if (bodyOffset > (assignments.at(-1)?.index ?? -1) || !new RegExp(`\\b${value}\\s*=`).test(match[2])) continue
    if (sourceCondition(match[1], source)) {
      const branchAssignment = new RegExp(`\\b${value}\\s*=\\s*([^,;\\r\\n]+)`).exec(match[2])
      const resolved = branchAssignment ? resolveSourceNumber(branchAssignment[1], source, depth + 1, size) : undefined
      if (resolved !== undefined) return resolved
    }
  }
  for (const assignment of assignments.reverse()) {
    const resolved = resolveSourceNumber(assignment[1], source, depth + 1, size)
    if (resolved !== undefined) return resolved
  }

  if (/^w(?:idth)?$/i.test(value)) return 40
  if (/^h(?:eight)?$/i.test(value)) return 20
  if (/^r(?:adius)?$/i.test(value)) return 5

  return undefined
}

function sourceNumber(value: string | undefined, source: string, size?: { width: number; height: number }) {
  return value === undefined ? undefined : resolveSourceNumber(value, source, 0, size)
}

function centeredU8g2X(value: string | undefined, source: string, size?: { width: number; height: number }) {
  if (!value || !/\.getStrWidth\s*\(/.test(value)) return undefined
  const dimensions = value.match(/^\s*\(*\s*([^()-]+?)\s*-/)
  const divisor = value.match(/\/\s*(\d+)\s*\)*\s*$/)
  if (!dimensions || !divisor) return undefined
  const width = sourceNumber(dimensions[1], source, size)
  const divisorValue = Number(divisor[1])
  return width !== undefined && divisorValue > 0 ? width / divisorValue : undefined
}

function usesCursorWidth(value: string | undefined, source: string, receiver: string) {
  if (!value || !/^[A-Za-z_]\w*$/.test(value.trim())) return false
  return new RegExp(`\\b${value.trim()}\\s*=\\s*${receiver}\\.getCursorX\\s*\\(`).test(source)
}

function sourceLoopForCall(call: Call, source: string) {
  let index = 0
  while (index < source.length) {
    const skipped = skipQuotedOrComment(source, index)
    if (skipped !== index) { index = skipped; continue }
    if (source.startsWith('for', index) && !/[\w$]/.test(source[index - 1] ?? '') && !/[\w$]/.test(source[index + 3] ?? '')) {
      let cursor = index + 3
      while (/\s/.test(source[cursor] ?? '')) cursor += 1
      if (source[cursor] !== '(') { index += 3; continue }
      const headerEnd = matchingDelimiter(source, cursor, '(', ')')
      if (headerEnd < 0) break
      const header = source.slice(cursor + 1, headerEnd).split(';')
      const bodyStart = source.indexOf('{', headerEnd + 1)
      const bodyEnd = bodyStart < 0 ? -1 : matchingDelimiter(source, bodyStart, '{', '}')
      if (bodyStart < 0 || bodyEnd < 0) { index = headerEnd + 1; continue }
      if (call.start < bodyStart || call.start >= bodyEnd) { index = bodyEnd + 1; continue }
      const initializer = /^(?:(?:(?:const|unsigned|signed|long|short|int|size_t|auto)\s+))*([A-Za-z_]\w*)\s*=\s*(.+)$/.exec(header[0].trim())
      if (!initializer || header.length !== 3) return undefined
      const variable = initializer[1]
      const condition = new RegExp(`^${variable}\\s*(<=|<|>=|>)\\s*(.+)$`).exec(header[1].trim())
      if (!condition) return undefined
      const increment = header[2].trim()
      let step: number | undefined
      if (new RegExp(`^(?:${variable}\\s*\\+\\+|\\+\\+\\s*${variable})$`).test(increment)) step = 1
      else if (new RegExp(`^(?:${variable}\\s*--|--\\s*${variable})$`).test(increment)) step = -1
      else {
        const assignment = new RegExp(`^${variable}\\s*(\\+=|-=)\\s*(.+)$`).exec(increment)
        const amount = assignment ? sourceNumber(assignment[2], source) : undefined
        if (assignment && amount !== undefined) step = amount * (assignment[1] === '+=' ? 1 : -1)
      }
      const startValue = sourceNumber(initializer[2], source)
      const endValue = sourceNumber(condition[2], source)
      if (!step || !Number.isFinite(step) || startValue === undefined || endValue === undefined) return undefined
      const values: number[] = []
      let value = startValue
      const compare = (current: number) => condition[1] === '<' ? current < endValue
        : condition[1] === '<=' ? current <= endValue
          : condition[1] === '>' ? current > endValue
            : current >= endValue
      while (compare(value) && values.length < 256) {
        values.push(value)
        value += step
      }
      if (compare(value) || values.length < 2) return undefined
      const coordinate = [0, 1].find((coordinateIndex) => new RegExp(`\\b${variable}\\b`).test(call.args[coordinateIndex] ?? ''))
      if (coordinate === undefined) return undefined
      const expression = call.args[coordinate]
      const axis = coordinate === 0 ? 'x' : 'y'
      const offsets = values.map((current) => current - startValue)
      return { axis, expression, offsets } as const
    }
    index += 1
  }
  return undefined
}

function literal(value?: string) {
  if (!value) return undefined
  let str = value.trim()
  const macroMatch = str.match(/^(?:F|_F|PSTR|String)\s*\(\s*(".*")\s*\)$/s)
  if (macroMatch) str = macroMatch[1]
  if (str[0] !== '"' || str[str.length - 1] !== '"') return undefined
  try {
    return JSON.parse(str)
  } catch {
    return str.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
}

const namedColors: Record<string, string> = {
  WHITE: '#ffffff', BLACK: '#000000', RED: '#ff0000', GREEN: '#00ff00', BLUE: '#0000ff',
  YELLOW: '#ffff00', CYAN: '#00ffff', MAGENTA: '#ff00ff', ORANGE: '#ffa500', PURPLE: '#800080',
  PINK: '#ffc0cb', NAVY: '#000080', DARKGREEN: '#006400', DARKCYAN: '#008b8b', MAROON: '#800000',
  OLIVE: '#808000', LIGHTGREY: '#d3d3d3', DARKGREY: '#a9a9a9', GREENYELLOW: '#adff2f',
  GOLD: '#ffd700', SILVER: '#c0c0c0', VIOLET: '#ee82ee', BROWN: '#a52a2a',
  COLOR_OFF: '#000000', COLOR_ON: '#ffffff',
  SSD1306_WHITE: '#ffffff', SSD1306_BLACK: '#000000', SSD1306_INVERSE: '#ffffff',
  SH110X_WHITE: '#ffffff', SH110X_BLACK: '#000000',
  TFT_WHITE: '#ffffff', TFT_BLACK: '#000000', TFT_RED: '#ff0000', TFT_GREEN: '#00ff00',
  TFT_BLUE: '#0000ff', TFT_YELLOW: '#ffff00', TFT_CYAN: '#00ffff', TFT_MAGENTA: '#ff00ff',
  TFT_ORANGE: '#ffa500', TFT_PURPLE: '#800080', TFT_PINK: '#ffc0cb', TFT_NAVY: '#000080',
  TFT_DARKGREEN: '#006400', TFT_DARKCYAN: '#008b8b', TFT_MAROON: '#800000', TFT_OLIVE: '#808000',
  TFT_LIGHTGREY: '#d3d3d3', TFT_DARKGREY: '#a9a9a9', TFT_GREENYELLOW: '#adff2f',
  TFT_GOLD: '#ffd700', TFT_SILVER: '#c0c0c0', TFT_VIOLET: '#ee82ee', TFT_BROWN: '#a52a2a',
  ILI9341_WHITE: '#ffffff', ILI9341_BLACK: '#000000', ILI9341_RED: '#ff0000',
  ILI9341_GREEN: '#00ff00', ILI9341_BLUE: '#0000ff', ILI9341_YELLOW: '#ffff00',
  ILI9341_CYAN: '#00ffff', ILI9341_MAGENTA: '#ff00ff', ILI9341_ORANGE: '#ffa500',
  HIGH: '#ffffff', LOW: '#000000',
}

function isStaticColor(value?: string) {
  if (!value) return false
  const token = value.trim()
  if (/^0x[\da-f]{1,8}$/i.test(token)) return true
  if (/^(?:tft\.|display\.|gfx->)?(?:color565|rgb565)\s*\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)$/i.test(token)) return true
  if (/^Color\(\s*(?:0x[\da-f]{1,2}|\d+)\s*,\s*(?:0x[\da-f]{1,2}|\d+)\s*,\s*(?:0x[\da-f]{1,2}|\d+)\s*\)$/i.test(token)) return true
  if (/^Color::\w+$/.test(token)) return true
  const stripped = token.replace(/^(?:TFT_|SSD1306_|ILI9341_|ST7735_|SH110X_)/, '')
  return Object.hasOwn(namedColors, token) || Object.hasOwn(namedColors, stripped)
}

function color(value?: string) {
  if (!value) return '#ffffff'
  const token = value.trim()
  if (token === '0' || token === 'LOW') return '#000000'
  if (token === '1' || token === 'HIGH') return '#ffffff'
  if (token.startsWith('Color::')) return namedColors[token.slice('Color::'.length)] ?? '#ffffff'
  const c565 = token.match(/(?:color565|rgb565)\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/i)
  if (c565) {
    const r = Math.min(255, Number(c565[1])).toString(16).padStart(2, '0')
    const g = Math.min(255, Number(c565[2])).toString(16).padStart(2, '0')
    const b = Math.min(255, Number(c565[3])).toString(16).padStart(2, '0')
    return `#${r}${g}${b}`
  }
  const match24 = token.match(/^0x([0-9a-f]{6})$/i)
  if (match24) return `#${match24[1]}`
  const rgb565 = token.match(/^0x([0-9a-f]{4})$/i)
  if (rgb565) {
    const packed = Number.parseInt(rgb565[1], 16)
    const red = Math.round(((packed >> 11) & 0x1f) * 255 / 31)
    const green = Math.round(((packed >> 5) & 0x3f) * 255 / 63)
    const blue = Math.round((packed & 0x1f) * 255 / 31)
    return `#${[red, green, blue].map((part) => part.toString(16).padStart(2, '0')).join('')}`
  }
  const shortHex = token.match(/^0x([0-9a-f]{1,3})$/i)
  if (shortHex) {
    const num = Number.parseInt(shortHex[1], 16)
    return num === 0 ? '#000000' : '#ffffff'
  }
  const rgb = token.match(/Color\(\s*(0x[\da-f]{1,2}|\d+)\s*,\s*(0x[\da-f]{1,2}|\d+)\s*,\s*(0x[\da-f]{1,2}|\d+)\s*\)/i)
  if (rgb) return `#${rgb.slice(1).map((part) => Number(part).toString(16).padStart(2, '0')).join('')}`
  const stripped = token.replace(/^(?:TFT_|SSD1306_|ILI9341_|ST7735_|SH110X_)/, '')
  return namedColors[token] ?? namedColors[stripped] ?? '#ffffff'
}

function svgDataUri(width: number, height: number, content: string) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${content}</svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

function bitmapData(source: string, call: Call, size: { width: number; height: number } | undefined, fallbackColor: string) {
  const isU8g2 = call.method === 'drawXBMP' || call.method === 'drawXBM'
  const widthIndex = isU8g2 ? 2 : 3
  const heightIndex = isU8g2 ? 3 : 4
  const bitmapIndex = isU8g2 ? 4 : 2
  const width = sourceNumber(call.args[widthIndex], source, size)
  const height = sourceNumber(call.args[heightIndex], source, size)
  const x = sourceNumber(call.args[0], source, size)
  const y = sourceNumber(call.args[1], source, size)
  const symbol = call.args[bitmapIndex]?.match(/&?\s*([A-Za-z_]\w*)/)?.[1]
  if (x === undefined || y === undefined || width === undefined || height === undefined || width < 1 || height < 1 || width > 512 || height > 512 || !symbol) return undefined
  const declaration = new RegExp(`\\b${symbol}\\s*\\[[^\\]]*\\]\\s*(?:PROGMEM\\s*)?=\\s*\\{([^}]*)\\}`, 's').exec(source)
  if (!declaration) return undefined
  const bytesSource = declaration[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\r\n]*/g, '')
  const bytes = [...bytesSource.matchAll(/0[xX][\da-fA-F]+|0[bB][01]+|\b\d+\b/g)].map(([token]) => Number(token))
  const stride = Math.ceil(width / 8)
  if (bytes.length < stride * height) return undefined
  const foreground = isU8g2 ? fallbackColor : color(call.args[5] ?? fallbackColor)
  const background = isU8g2 ? undefined : call.args[6] ? color(call.args[6]) : undefined
  const pixels: string[] = []
  if (background) pixels.push(`<rect width="${width}" height="${height}" fill="${background}"/>`)
  const lsbFirst = isU8g2 || call.method === 'drawXBitmap'
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const byte = bytes[y * stride + Math.floor(x / 8)]
      const mask = lsbFirst ? 1 << (x % 8) : 0x80 >> (x % 8)
      const set = (byte & mask) !== 0
      if (set || background) pixels.push(`<rect x="${x}" y="${y}" width="1" height="1" fill="${set ? foreground : background}"/>`)
    }
  }
  return {
    width,
    height,
    imageData: svgDataUri(width, height, pixels.join('')),
    geometry: {
      xIndex: 0, yIndex: 1, widthIndex, heightIndex,
      originalX: x,
      originalY: y,
      originalWidth: width,
      originalHeight: height,
    },
  }
}

function printfFormat(value: string) {
  const tokens = value.match(/%%|%(?:[-+ #0]*\d*(?:\.\d+)?[hlLzjt]*[diuoxXfFeEgGaAcsp])/g) ?? []
  const remainder = value.replace(/%%|%(?:[-+ #0]*\d*(?:\.\d+)?[hlLzjt]*[diuoxXfFeEgGaAcsp])/g, '')
  if (remainder.includes('%')) return undefined
  let preview = value
  for (const token of tokens) {
    if (token === '%%') preview = preview.replace('%%', '%')
    else {
      const type = token[token.length - 1]
      const precision = Number(token.match(/\.(\d+)/)?.[1] ?? 1)
      const sample = type === 's' ? '…' : 'fFeEgG'.includes(type) ? precision === 0 ? '0' : `0.${'0'.repeat(Math.min(precision, 4))}` : '0'
      preview = preview.replace(token, sample)
    }
  }
  return { preview, substitutions: tokens.filter((token) => token !== '%%').length }
}

function esphomeFontSizes(source: string) {
  const sizes = new Map<string, number>()
  const fontStart = source.match(/^font:\s*$/m)
  if (!fontStart || fontStart.index === undefined) return sizes
  const start = fontStart.index + fontStart[0].length
  const nextSection = source.slice(start).search(/^[^\s#][\w-]*\s*:/m)
  const section = source.slice(start, nextSection < 0 ? undefined : start + nextSection)
  let id: string | undefined
  let size: number | undefined
  const save = () => {
    if (id && size !== undefined) sizes.set(id, size)
    id = undefined
    size = undefined
  }
  for (const line of section.split(/\r?\n/)) {
    if (/^\s{2}-\s+file\s*:/.test(line)) save()
    const idMatch = /^\s+id:\s*([A-Za-z_]\w*)\s*$/.exec(line)
    const sizeMatch = /^\s+size:\s*(\d+)\s*$/.exec(line)
    if (idMatch) id = idMatch[1]
    if (sizeMatch) size = Number(sizeMatch[1])
  }
  save()
  return sizes
}

function esphomeTextAlignment(args: string[]) {
  const alignment = args.find((arg) => /^TextAlign::(?:TOP|CENTER|BOTTOM|BASELINE)_(?:LEFT|CENTER|RIGHT)$|^TextAlign::CENTER$/.test(arg))
  if (!alignment) return undefined
  const token = alignment.slice('TextAlign::'.length)
  const horizontal = token.endsWith('RIGHT') ? 'end' : token.endsWith('CENTER') || token === 'CENTER' ? 'middle' : 'start'
  const vertical = token.startsWith('TOP') ? 'hanging'
    : token.startsWith('BOTTOM') ? 'text-after-edge'
      : token.startsWith('BASELINE') ? 'alphabetic'
        : 'central'
  return { textAnchor: horizontal as CanvasElement['textAnchor'], textBaseline: vertical as CanvasElement['textBaseline'] }
}

function makeImportedElement(index: number, kind: CanvasElement['kind'], values: Partial<CanvasElement>): CanvasElement {
  return {
    id: `import-${index}`,
    kind,
    name: kind === 'text' ? `Текст ${index + 1}` : kind === 'rect' ? `Блок ${index + 1}` : kind === 'circle' ? `Круг ${index + 1}` : kind === 'image' ? `Изображение ${index + 1}` : 'Линия',
    x: 0, y: 0, width: 20, height: 12, text: '', fill: '#ffffff', stroke: '#ffffff', radius: 0,
    fontSize: 12, fontFamily: 'monospace', fontWeight: 'normal',
    ...values,
  }
}

function detectRenderer(source: string, calls: Call[], format: SourceFormat): Renderer {
  if (format === 'esphome' || calls.some((call) => call.receiver === 'it')) return 'esphome'
  if (/U8G2|U8g2lib|drawStr\s*\(/i.test(source)) return 'u8g2'
  if (/TFT_eSPI|TFT_eSPI\.h|drawString\s*\(/i.test(source)) return 'tft-espi'
  return 'gfx'
}

function detectDisplay(source: string) {
  if (/2432S024|CYD\s*2\.4/i.test(source)) return 'cyd-24-ili9341'
  if (/2432S028|CYD/i.test(source)) return 'cyd-28-ili9341'
  if (/SSD1309/i.test(source)) return 'ssd1309-128x64'
  const displaySectionStart = source.search(/^display:\s*$/m)
  if (displaySectionStart >= 0) {
    const displaySection = source.slice(displaySectionStart).split(/\r?\n/).filter((line) => !/^\S/.test(line) || line.startsWith('display:')).join('\n')
    const platform = displaySection.match(/^\s*-\s+platform:\s*([^\s#]+)/m)?.[1]
    const model = displaySection.match(/^\s+model:\s*["']?([^"'\r\n#]+)/m)?.[1].trim()
    if (platform === 'ssd1306_i2c' || /SSD1306\s*128x64/i.test(model ?? '')) return 'ssd1306-128x64'
    if (platform === 'ssd1327_i2c' || /SSD1327/i.test(model ?? '')) return 'ssd1327-128x128'
    if (/SSD1306\s*128x32/i.test(model ?? '')) return 'ssd1306-128x32'
    if (platform === 'ili9xxx' && /ILI9341/i.test(model ?? '')) return 'ili9341-240x320'
    if (platform === 'mipi_spi' && /T-DISPLAY-S3/i.test(model ?? '')) return 'ttgo-tdisplay-s3-170x320'
    if (platform === 'mipi_spi' && /T-DISPLAY/i.test(model ?? '')) return 'ttgo-tdisplay-135x240'
  }
  if (/T-Embed|TFT_SCK\s+12|BOARD_TFT_SCK\s+12/i.test(source)) return 't-embed-170x320'
  if (/T-Display-S3|TFT_WIDTH\s+170|170\s*[xX]\s*320/i.test(source)) return 'ttgo-tdisplay-s3-170x320'
  if (/T-Display|TTGO_TDISPLAY|135\s*[xX]\s*240/i.test(source)) return 'ttgo-tdisplay-135x240'
  if (/T-Deck/i.test(source)) return 't-deck-320x240'
  if (/M5Stack\s*Core2|M5CORE2/i.test(source)) return 'm5stack-core2-320x240'
  if (/SSD1306\s*128x32|128X32/i.test(source)) return 'ssd1306-128x32'
  if (/SH1106/i.test(source)) return 'sh1106-128x64'
  if (/SSD1327/i.test(source)) return 'ssd1327-128x128'
  if (/SSD1331/i.test(source)) return 'ssd1331-96x64'
  if (/SSD1306/i.test(source)) return 'ssd1306-128x64'
  if (/GC9A01/i.test(source)) return 'gc9a01-240x240'
  if (/ILI9488/i.test(source)) return 'ili9488-320x480'
  if (/ILI9225/i.test(source)) return 'ili9225-176x220'
  if (/ILI9341/i.test(source)) return 'ili9341-240x320'
  if (/ST7735/i.test(source)) return 'st7735-128x160'
  if (/ST7789.*(?:240\s*[xX]\s*240)/i.test(source)) return 'st7789-240x240'
  if (/ST7789/i.test(source)) return 'st7789-240x320'
  return undefined
}

function detectSize(source: string) {
  const yamlWidth = source.match(/^\s*width:\s*(\d+)\s*$/m)
  const yamlHeight = source.match(/^\s*height:\s*(\d+)\s*$/m)
  const yamlParsedWidth = Number(yamlWidth?.[1])
  const yamlParsedHeight = Number(yamlHeight?.[1])
  if (Number.isInteger(yamlParsedWidth) && Number.isInteger(yamlParsedHeight) && yamlParsedWidth >= 8 && yamlParsedHeight >= 8 && yamlParsedWidth <= 2048 && yamlParsedHeight <= 2048) {
    return { width: yamlParsedWidth, height: yamlParsedHeight }
  }
  const width = source.match(/(?:#\s*define\s+)?(?:TFT_WIDTH|SCREEN_WIDTH|DISPLAY_WIDTH|SCREEN_W|TFT_W|WIDTH)\s*[= ]\s*(\d+)/i)
  const height = source.match(/(?:#\s*define\s+)?(?:TFT_HEIGHT|SCREEN_HEIGHT|DISPLAY_HEIGHT|SCREEN_H|TFT_H|HEIGHT)\s*[= ]\s*(\d+)/i)
  const parsedWidth = Number(width?.[1])
  const parsedHeight = Number(height?.[1])
  if (Number.isInteger(parsedWidth) && Number.isInteger(parsedHeight) && parsedWidth >= 8 && parsedHeight >= 8 && parsedWidth <= 2048 && parsedHeight <= 2048) {
    return { width: parsedWidth, height: parsedHeight }
  }
  const ctorMatch = source.match(/(?:Adafruit_\w+|Arduino_\w+)\s+(?:display|tft|gfx)\s*\(\s*(\d{2,4})\s*,\s*(\d{2,4})/i)
    ?? source.match(/new\s+(?:Arduino_\w+|Adafruit_\w+)\s*\([^;]*?(\d{2,4})\s*,\s*(\d{2,4})/i)
  if (ctorMatch) {
    const cw = Number(ctorMatch[1])
    const ch = Number(ctorMatch[2])
    if (cw >= 8 && ch >= 8 && cw <= 2048 && ch <= 2048) {
      return { width: cw, height: ch }
    }
  }
  return undefined
}

export function parseDisplaySource(source: string, requestedFormat?: SourceFormat): ParsedDisplaySource {
  const calls = scanCalls(source)
  const format = requestedFormat ?? (/\b(it\.(?:printf|print|filled_rectangle|rectangle|line)\s*\()/i.test(source) ? 'esphome' : 'arduino')
  const branches = displayConditionalGroups(source, calls, format)
  const sourceBranchGroups = branches.map(({ id, label, choices, parentPath }) => ({ id, label, choices, parentPath }))
  const sourceBranchSelection = Object.fromEntries(branches.map((branch) => [branch.id, branch.defaultChoice]))
  const renderer = detectRenderer(source, calls, format)
  const suggestedDisplayId = detectDisplay(source)
  const suggestedDisplay = displays.find((display) => display.id === suggestedDisplayId)
  let suggestedSize = suggestedDisplay ? { width: suggestedDisplay.width, height: suggestedDisplay.height } : detectSize(source)
  if (!suggestedSize) {
    if (renderer === 'u8g2' || /SSD1306|SSD1309|SH1106/i.test(source)) suggestedSize = { width: 128, height: 64 }
    else if (renderer === 'tft-espi') suggestedSize = { width: 320, height: 240 }
  }
  const rotationMatch = source.match(/\b(?:setRotation|set_rotation)\s*\(\s*([0-3])\s*\)/i)
  const rotationVal = rotationMatch ? Number(rotationMatch[1]) : undefined
  if (suggestedSize && rotationVal !== undefined) {
    const isLandscape = rotationVal === 1 || rotationVal === 3
    if (isLandscape && suggestedSize.width < suggestedSize.height) {
      suggestedSize = { width: suggestedSize.height, height: suggestedSize.width }
    } else if (!isLandscape && suggestedSize.width > suggestedSize.height && !suggestedDisplay?.boardRotation) {
      suggestedSize = { width: suggestedSize.height, height: suggestedSize.width }
    }
  }
  const fontSizes = format === 'esphome' ? esphomeFontSizes(source) : new Map<string, number>()
  const topicMappings = format === 'esphome' ? scanSourceTopics(source) : []
  const detectedSourceTopics = [...new Map(topicMappings.map(({ id, topic }) => [id, { id, topic }])).values()]
  const elements: CanvasElement[] = []
  const mappings: SourceElement[] = []
  const warnings: string[] = []
  let cursor: {
    receiver: string
    x: number
    y: number
    startX: number
    start: number
    isFirst: boolean
  } | undefined
  let textSize = 1
  let textFontSize = 8
  let fontExpression: string | undefined
  let textFontSupported = true
  let isCustomFont = false
  let textColor = '#ffffff'
  let textColorSupported = true
  let unsupported = 0

  for (const call of calls) {
    if (/^Serial\d*$/i.test(call.receiver)) continue
    if (call.method === 'setCursor' && call.receiver !== 'it') {
      const cx = sourceNumber(call.args[0], source, suggestedSize)
      const cy = sourceNumber(call.args[1], source, suggestedSize)
      if (cx !== undefined && cy !== undefined) {
        cursor = {
          receiver: call.receiver,
          x: cx,
          y: renderer === 'u8g2' || isCustomFont ? Math.max(0, cy - u8g2BaselineOffset(textFontSize)) : cy,
          startX: cx,
          start: call.start,
          isFirst: true,
        }
      }
      continue
    }
    if (call.method === 'setTextSize' && numeric(call.args[0]) !== undefined) {
      textSize = Math.max(1, numeric(call.args[0])!)
      textFontSize = textSize * 8
      continue
    }
    if (call.method === 'setTextFont') {
      const f = numeric(call.args[0])
      if (f === 1) textFontSize = 8
      else if (f === 2) textFontSize = 16
      else if (f === 4) textFontSize = 26
      else if (f === 6 || f === 7) textFontSize = 48
      else if (f === 8) textFontSize = 75
      else if (f) textFontSize = f * 8
      textSize = Math.max(1, Math.round(textFontSize / 8))
      continue
    }
    if (call.method === 'setFont') {
      const font = call.args[0] ?? ''
      // nullptr / NULL / 0 / empty — reset to built-in default font
      if (font === 'nullptr' || font === 'NULL' || font === '0' || font === '') {
        textFontSize = 8; textSize = 1; textFontSupported = true; isCustomFont = false; fontExpression = font; continue
      }
      fontExpression = font
      // u8g2 named font: u8g2_font_helvB14_tr → 14, pixel font: u8g2_font_5x7_tf → 7
      const namedFont = font.match(/_(?:[A-Za-z]+?)(\d{1,3})_t[a-z0-9]+$/i)
      const pixelFont = font.match(/_(\d+)x(\d+)_/)
      // Adafruit GFX: &FreeSans9pt7b, &FreeMonoBold12pt7b, &TomThumb, &FreeMono9pt7b
      const gfxPtFont = font.match(/(\d+)pt7b\b/)
      // GFX numeric size hint in name: &Font12, &OpenSans_Regular_20px
      const gfxSizeHint = font.match(/[_\-](\d{1,3})(?:px)?\b/)
      const fontHeight = Number(
        namedFont?.[1] ?? pixelFont?.[2]
          ?? (gfxPtFont ? Math.round(Number(gfxPtFont[1]) * 1.35) : undefined)
          ?? gfxSizeHint?.[1],
      )
      textFontSupported = Number.isFinite(fontHeight) && fontHeight > 0
      if (textFontSupported) {
        textFontSize = fontHeight
        textSize = Math.max(1, Math.round(fontHeight / 8))
        if (renderer !== 'u8g2') isCustomFont = true
      } else unsupported += 1
      continue
    }
    if (call.method === 'setTextColor') {
      textColorSupported = call.args[0] === '0' || call.args[0] === '1' || isStaticColor(call.args[0])
      if (textColorSupported) textColor = color(call.args[0])
      else unsupported += 1
      continue
    }
    if (call.method === 'setDrawColor' && renderer === 'u8g2') {
      textColorSupported = call.args[0] === '0' || call.args[0] === '1'
      if (textColorSupported) textColor = call.args[0] === '0' ? '#000000' : '#ffffff'
      else unsupported += 1
      continue
    }

    let kind: CanvasElement['kind'] | undefined
    let x: number | undefined
    let y: number | undefined
    let width: number | undefined
    let height: number | undefined
    let radius = 0
    let text: string | undefined
    let dynamicVariables: string[] = []
    let textAlignment: Pick<CanvasElement, 'textAnchor' | 'textBaseline'> = {}
    let fill = textColor
    let stroke = textColor
    let bitmapGeometry: SourceElement['bitmapGeometry']
    let triangleGeometry: SourceElement['triangleGeometry']
    const args = call.args
    const method = call.method
    const colorArg = args.find((arg) => /^Color(?:\(|::)/.test(arg))
    const styleColorArg = args.find((arg) => isStaticColor(arg))
    if (colorArg && !isStaticColor(colorArg)) { unsupported += 1; continue }

    if ((method === 'fillScreen' || method === 'fill') && args.length === 1 && suggestedSize) {
      if (!isStaticColor(args[0])) { unsupported += 1; continue }
      kind = 'rect'; x = 0; y = 0; width = suggestedSize.width; height = suggestedSize.height
      fill = color(args[0])
    }
    if (['drawBitmap', 'drawXBitmap', 'drawXBMP', 'drawXBM'].includes(method)) {
      const bitmap = bitmapData(source, call, suggestedSize, textColor)
      if (bitmap) {
        kind = 'image'
        x = bitmap.geometry.originalX
        y = bitmap.geometry.originalY
        width = bitmap.width
        height = bitmap.height
        bitmapGeometry = bitmap.geometry
        fill = 'none'
        stroke = 'none'
        const values = makeImportedElement(elements.length, kind, {
          x: x ?? 0, y: y ?? 0, width, height, text: '', fill, stroke, imageData: bitmap.imageData,
          sourceBranchPath: branches.flatMap((branch) => {
            const choice = branch.branches.findIndex((range) => call.start >= range.start && call.start < range.end)
            return choice < 0 ? [] : [{ id: branch.id, choice }]
          }),
        })
        elements.push(values)
        mappings.push({
          id: values.id, start: call.start, end: call.end, receiver: call.receiver, operator: call.operator,
          method, args, renderer, indent: call.indent, bitmapGeometry,
          originalCode: source.slice(call.start, call.end), originalElement: { ...values }, fontExpression,
        })
        continue
      }
    }

    const currentFontSize = renderer === 'u8g2' || renderer === 'esphome' ? textFontSize : textSize * 8
    const isTextMethod = (
      method === 'drawStr' || method === 'drawUTF8' || method === 'drawString' ||
      method === 'drawCentreString' || method === 'drawCenterString' || method === 'drawRightString' ||
      method === 'print' || method === 'println' || method === 'printf' ||
      method === 'drawNumber' || method === 'drawFloat'
    )

    if (isTextMethod) {
      if (args.length === 0 && method === 'println' && cursor?.receiver === call.receiver) {
        cursor.x = cursor.startX
        cursor.y += Math.max(8, Math.round(currentFontSize * 1.25))
        continue
      }
      if (renderer === 'esphome') {
        const fontId = args.map((arg) => arg.match(/^id\(([A-Za-z_]\w*)\)$/)?.[1]).find(Boolean)
        const configuredSize = fontId ? fontSizes.get(fontId) : undefined
        textFontSize = configuredSize ?? 8
      }
      const textIndex = args.findIndex((arg) => literal(arg) !== undefined)
      text = textIndex >= 0 ? literal(args[textIndex]) : undefined
      const dynamicTextArg = args[args.length - 1]
      if (renderer === 'esphome' && text === undefined && dynamicTextArg && /\bid\(\s*[A-Za-z_]\w*\s*\)|^[A-Za-z_]\w*(?:\[[^\]]+\])?$/.test(dynamicTextArg)) {
        text = previewDynamicText(dynamicTextArg, source)
        dynamicVariables = [...new Set([...dynamicTextArg.matchAll(/\bid\(\s*([A-Za-z_]\w*)\s*\)/g)].map((match) => match[1]))]
        if (!dynamicVariables.length && /^[A-Za-z_]\w*(?:\[[^\]]+\])?$/.test(dynamicTextArg)) dynamicVariables = [dynamicTextArg]
      }
      if (renderer !== 'esphome' && text === undefined && args.length > 0) {
        const candidate = method === 'drawStr' || method === 'drawUTF8' ? args[2]
          : (method === 'drawFloat' && args.length >= 4) ? args[0]
          : (method === 'drawString' || method === 'drawCentreString' || method === 'drawCenterString' || method === 'drawRightString' || method === 'drawNumber') ? args[0]
          : args[0]
        if (candidate) {
          text = previewDynamicText(candidate, source)
          const varMatch = candidate.match(/^(?:&\s*)?([A-Za-z_]\w*)(?:\.c_str\(\))?$/)
          if (varMatch) dynamicVariables = [varMatch[1]]
        }
      }
      if (method === 'printf' && text !== undefined) {
        if (textIndex >= 0) {
          const formatting = printfFormat(text)
          if (textIndex !== args.length - 1 && (!formatting || formatting.substitutions > args.length - textIndex - 1)) text = undefined
          else text = formatting
            ? formatting.substitutions
              ? formatSourcePreview(text, args.slice(textIndex + 1), source)
              : formatting.preview
            : undefined
          if (text !== undefined) {
            dynamicVariables = [...new Set([...dynamicVariables, ...args.slice(textIndex + 1).flatMap((arg) => [...arg.matchAll(/\bid\(\s*([A-Za-z_]\w*)\s*\)/g)].map((match) => match[1]))])]
          }
        }
      }
      if (text !== undefined) {
        kind = 'text'
        if (renderer === 'esphome') textAlignment = esphomeTextAlignment(args) ?? { textAnchor: 'start', textBaseline: 'hanging' }
        if (renderer === 'esphome' && (method === 'printf' || method === 'print')) {
          x = sourceNumber(args[0], source, suggestedSize); y = sourceNumber(args[1], source, suggestedSize)
        } else if (method === 'drawStr' || method === 'drawUTF8') {
          const centeredX = renderer === 'u8g2' ? centeredU8g2X(args[0], source, suggestedSize) : undefined
          x = centeredX ?? sourceNumber(args[0], source, suggestedSize)
          if (centeredX !== undefined) textAlignment = { textAnchor: 'middle' }
          else if (renderer === 'u8g2' && usesCursorWidth(args[0], source, call.receiver) && cursor?.receiver === call.receiver) x = cursor.x
          const rawY = sourceNumber(args[1], source, suggestedSize)
          y = rawY === undefined ? undefined : rawY - Math.max(7, u8g2BaselineOffset(textFontSize))
        } else if (method === 'drawString') {
          x = sourceNumber(args[1], source, suggestedSize); y = sourceNumber(args[2], source, suggestedSize)
        } else if (method === 'drawCentreString' || method === 'drawCenterString') {
          x = sourceNumber(args[1], source, suggestedSize); y = sourceNumber(args[2], source, suggestedSize)
          textAlignment = { textAnchor: 'middle' }
        } else if (method === 'drawRightString') {
          x = sourceNumber(args[1], source, suggestedSize); y = sourceNumber(args[2], source, suggestedSize)
          textAlignment = { textAnchor: 'end' }
        } else if (method === 'drawNumber') {
          x = sourceNumber(args[1], source, suggestedSize); y = sourceNumber(args[2], source, suggestedSize)
        } else if (method === 'drawFloat') {
          x = sourceNumber(args[2], source, suggestedSize); y = sourceNumber(args[3], source, suggestedSize)
        } else if (method === 'printf' && args.length >= 3 && numeric(args[0]) !== undefined && numeric(args[1]) !== undefined) {
          x = sourceNumber(args[0], source, suggestedSize); y = sourceNumber(args[1], source, suggestedSize)
        } else if (cursor?.receiver === call.receiver) {
          x = cursor.x; y = cursor.y
        }
        fill = styleColorArg ? color(styleColorArg) : textColor
      }
    }

    if (method === 'drawBox' || method === 'drawFrame' || method === 'fillRect' || method === 'drawRect' || method === 'fillRoundRect' || method === 'drawRoundRect' || method === 'drawRBox' || method === 'drawRFrame' || method === 'filled_rectangle' || method === 'rectangle') {
      kind = 'rect'; x = sourceNumber(args[0], source, suggestedSize); y = sourceNumber(args[1], source, suggestedSize); width = sourceNumber(args[2], source, suggestedSize); height = sourceNumber(args[3], source, suggestedSize)
      if (method === 'drawRBox' || method === 'drawRFrame' || method === 'fillRoundRect' || method === 'drawRoundRect') {
        radius = sourceNumber(args[4], source, suggestedSize) ?? 0
      }
      const colorIndex = method === 'fillRoundRect' || method === 'drawRoundRect' ? 5
        : method === 'fillRect' || method === 'drawRect' || method === 'rectangle' || method === 'filled_rectangle' ? 4
          : undefined
      const shapeColor = colorIndex === undefined || args[colorIndex] === undefined ? textColor : color(args[colorIndex])
      if (['drawFrame', 'drawRect', 'drawRoundRect', 'drawRFrame', 'rectangle'].includes(method)) {
        fill = 'none'
        stroke = shapeColor
      } else fill = shapeColor
    } else if (method === 'drawCircle' || method === 'drawDisc' || method === 'fillCircle' || method === 'filled_circle' || method === 'circle') {
      kind = 'circle'; x = sourceNumber(args[0], source, suggestedSize); y = sourceNumber(args[1], source, suggestedSize)
      const circleRadius = sourceNumber(args[2], source, suggestedSize)
      if (circleRadius !== undefined && x !== undefined && y !== undefined) { width = circleRadius * 2; height = circleRadius * 2; x -= circleRadius; y -= circleRadius }
      const shapeColor = args[3] === undefined ? textColor : color(args[3])
      if (method === 'drawCircle' || method === 'circle') {
        fill = 'none'
        stroke = shapeColor
      } else fill = shapeColor
    } else if (method === 'drawFastHLine' || method === 'drawFastVLine' || method === 'drawHLine' || method === 'drawVLine') {
      kind = 'line'
      x = sourceNumber(args[0], source, suggestedSize); y = sourceNumber(args[1], source, suggestedSize)
      const fastLen = sourceNumber(args[2], source, suggestedSize)
      width = (method === 'drawFastHLine' || method === 'drawHLine') ? fastLen : 0
      height = (method === 'drawFastVLine' || method === 'drawVLine') ? fastLen : 0
      const colorArg = args[3]
      stroke = colorArg !== undefined && (colorArg === '0' || colorArg === '1' || isStaticColor(colorArg)) ? color(colorArg) : textColor
      fill = stroke
    } else if (method === 'drawLine' || method === 'line' || method === 'writeLine') {
      kind = 'line'
      x = sourceNumber(args[0], source, suggestedSize); y = sourceNumber(args[1], source, suggestedSize)
      const x2 = sourceNumber(args[2], source, suggestedSize); const y2 = sourceNumber(args[3], source, suggestedSize)
      if (x !== undefined && y !== undefined && x2 !== undefined && y2 !== undefined) { width = x2 - x; height = y2 - y }
      fill = renderer === 'u8g2' || args[4] === undefined ? textColor : color(args[4])
    } else if (method === 'horizontal_line' || method === 'vertical_line') {
      kind = 'line'
      x = sourceNumber(args[0], source, suggestedSize); y = sourceNumber(args[1], source, suggestedSize)
      const length = sourceNumber(args[2], source, suggestedSize)
      width = method === 'horizontal_line' ? length : 0
      height = method === 'vertical_line' ? length : 0
      fill = textColor
    } else if (method === 'fillTriangle' || method === 'drawTriangle') {
      const tx0 = sourceNumber(args[0], source, suggestedSize); const ty0 = sourceNumber(args[1], source, suggestedSize)
      const tx1 = sourceNumber(args[2], source, suggestedSize); const ty1 = sourceNumber(args[3], source, suggestedSize)
      const tx2 = sourceNumber(args[4], source, suggestedSize); const ty2 = sourceNumber(args[5], source, suggestedSize)
      if (tx0 !== undefined && ty0 !== undefined && tx1 !== undefined && ty1 !== undefined && tx2 !== undefined && ty2 !== undefined) {
        kind = 'image'
        x = Math.min(tx0, tx1, tx2); y = Math.min(ty0, ty1, ty2)
        width = Math.max(tx0, tx1, tx2) - x; height = Math.max(ty0, ty1, ty2) - y
        const triColor = args[6] !== undefined && isStaticColor(args[6]) ? color(args[6]) : textColor
        const points = [{ x: tx0, y: ty0 }, { x: tx1, y: ty1 }, { x: tx2, y: ty2 }]
        const minX = Math.min(tx0, tx1, tx2)
        const minY = Math.min(ty0, ty1, ty2)
        const pointsString = points.map((point) => `${point.x - minX},${point.y - minY}`).join(' ')
        const triangleStyle = method === 'drawTriangle' ? `fill="none" stroke="${triColor}"` : `fill="${triColor}"`
        const imageData = svgDataUri(Math.max(1, width), Math.max(1, height), `<polygon points="${pointsString}" ${triangleStyle}/>` )
        fill = 'none'
        stroke = triColor
        triangleGeometry = { points, colorIndex: 6 }
        const values = makeImportedElement(elements.length, kind, {
          x, y, width: Math.max(1, width), height: Math.max(1, height), text: '', fill, stroke, imageData,
          sourceBranchPath: branches.flatMap((branch) => {
            const choice = branch.branches.findIndex((range) => call.start >= range.start && call.start < range.end)
            return choice < 0 ? [] : [{ id: branch.id, choice }]
          }),
        })
        elements.push(values)
        mappings.push({
          id: values.id, start: call.start, end: call.end, receiver: call.receiver, operator: call.operator,
          method, args, renderer, indent: call.indent, triangleGeometry,
          originalCode: source.slice(call.start, call.end), originalElement: { ...values }, fontExpression,
        })
        continue
      }
    }

    const colorIndex = method === 'fillRect' || method === 'drawRect' || method === 'rectangle' ? 4
      : method === 'filled_rectangle' ? (args.length > 4 ? args.length - 1 : 4)
      : method === 'fillRoundRect' || method === 'drawRoundRect' ? 5
      : method === 'drawCircle' || method === 'drawDisc' || method === 'fillCircle' || method === 'filled_circle' || method === 'circle' ? 3
      : method === 'drawLine' || method === 'line' || method === 'writeLine' ? 4
      : method === 'drawFastHLine' || method === 'drawFastVLine' ? 3
      : method === 'drawHLine' || method === 'drawVLine' ? 3
      : method === 'fillTriangle' || method === 'drawTriangle' ? 6
      : undefined
    if (colorIndex !== undefined && args[colorIndex] && args[colorIndex] !== '0' && args[colorIndex] !== '1' && !isStaticColor(args[colorIndex])) {
      unsupported += 1
      continue
    }
    // Silently skip pixel-level, bitmap, lifecycle or hardware ops that can't be represented as canvas elements
    const silentSkip = [
      'drawGrayscaleBitmap', 'drawRGBBitmap',
      'pushImage', 'pushColor', 'pushPixel', 'drawChar', 'drawGlyph',
      'startWrite', 'endWrite', 'writecommand', 'writedata', 'display', 'clearDisplay',
      'clear', 'cls', 'clearBuffer', 'sendBuffer', 'firstPage', 'nextPage', 'updateDisplay',
      'begin', 'init', 'setRotation', 'set_rotation', 'setTextWrap', 'setTextDatum',
      'setTextPadding', 'setFontMode', 'setFontDirection', 'setFontPosBaseline', 'setFontPosTop',
      'cp437', 'invertDisplay', 'dim', 'sleep', 'wakeup', 'write',
    ].includes(method)
    if (!kind) {
      if (!silentSkip && /^(draw|fill|print|printf|push|write)/i.test(method) && !['fillScreen', 'fillRect', 'fillRoundRect', 'fillCircle', 'filled_rectangle', 'filled_circle', 'printf', 'print', 'println'].includes(method)) unsupported += 1
      continue
    }
    if (x === undefined || y === undefined || width === undefined && kind !== 'text' || height === undefined && kind !== 'text' || kind === 'text' && (text === undefined || !textColorSupported || !textFontSupported)) {
      unsupported += 1
      continue
    }
    const loop = kind === 'line' && ['horizontal_line', 'vertical_line'].includes(method)
      ? sourceLoopForCall(call, source)
      : undefined
    const loopValue = loop ? sourceNumber(loop.expression, source, suggestedSize) : undefined
    const loopCoordinate = loop && loopValue !== undefined && width !== undefined && height !== undefined
      ? { ...loop, value: loopValue, originalX: x, originalY: y, originalWidth: width, originalHeight: height }
      : undefined
    const elementFontSize = renderer === 'u8g2' || renderer === 'esphome' ? textFontSize : textSize * 8
    const element = makeImportedElement(elements.length, kind, {
      x, y,
      width: width ?? Math.max(10, (text?.length ?? 1) * elementFontSize * (renderer === 'esphome' ? 0.58 : 0.6)),
      height: height ?? Math.max(7, elementFontSize * 1.2),
      text: text ?? '',
      fill,
      stroke: fill === 'none' ? stroke : fill,
      radius,
      fontSize: Math.max(5, elementFontSize),
      dynamicVariables,
      ...textAlignment,
      ...(loopCoordinate ? { repeatAxis: loopCoordinate.axis, repeatOffsets: loopCoordinate.offsets } : {}),
      sourceBranchPath: branches.flatMap((branch) => {
        const choice = branch.branches.findIndex((range) => call.start >= range.start && call.start < range.end)
        return choice < 0 ? [] : [{ id: branch.id, choice }]
      }),
      ...(renderer === 'esphome' ? { fontFamily: 'Arial, sans-serif' } : {}),
    })
    elements.push(element)
    const isFirstPrint = cursor?.receiver === call.receiver && (method === 'print' || method === 'println') && cursor.isFirst
    mappings.push({
      id: element.id,
      start: isFirstPrint && cursor ? cursor.start : call.start,
      end: call.end,
      receiver: call.receiver,
      operator: call.operator,
      method,
      args,
      previewText: text,
      cursor: cursor?.receiver === call.receiver && (method === 'print' || method === 'println') ? { ...cursor } : undefined,
      renderer,
      indent: call.indent,
      loopCoordinate,
      bitmapGeometry,
      triangleGeometry,
      originalX: x,
      originalY: y,
      originalCode: source.slice(isFirstPrint && cursor ? cursor.start : call.start, call.end),
      originalElement: { ...element },
      fontExpression,
    })
    if (cursor?.receiver === call.receiver && (method === 'print' || method === 'println' || method === 'printf')) {
      const textLen = (text?.length ?? 1)
      const charW = Math.max(5, Math.round(elementFontSize * (renderer === 'esphome' ? 0.58 : 0.6)))
      if (method === 'print' || method === 'printf') {
        cursor.x += textLen * charW
        cursor.isFirst = false
      } else if (method === 'println') {
        cursor.x = cursor.startX
        cursor.y += Math.max(8, Math.round(elementFontSize * 1.25))
        cursor.isFirst = false
      }
    }
  }
  const displayVariables = new Set(elements.flatMap((element) => element.dynamicVariables ?? []))
  const sourceTopics = detectedSourceTopics.filter(({ id }) => displayVariables.has(id))
  if (!elements.length) warnings.push('Не удалось распознать поддерживаемые команды рисования. Исходник останется без изменений.')
  if (unsupported) warnings.push(`${unsupported} команда(ы) или динамическое выражение не распознаны и останутся в исходнике без изменений.`)
  if (branches.length) warnings.push('Условные ветки можно переключать в панели над экраном; в превью активна ветка с наибольшим числом команд рисования.')
  warnings.push('Импорт меняет только распознанные команды рисования. Инициализация драйвера, распиновка, периферия и логика программы сохраняются как в исходнике.')
  return { format, elements, mappings, renderer, suggestedDisplayId, suggestedSize, sourceTopics, sourceBranchGroups, sourceBranchSelection, warnings }
}

function cppString(value: string) {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n')}"`
}

function esphomeString(value: string) {
  return cppString(value.replace(/%/g, '%%'))
}

function number(value: number) {
  return String(Math.round(value))
}

function adjustedExpression(expression: string, original: number, current: number) {
  const offset = Math.round(current - original)
  return offset === 0 ? expression : `(${expression}) ${offset > 0 ? '+' : '-'} ${Math.abs(offset)}`
}

function sourceColor(value: string) {
  const hex = /^#[\da-f]{6}$/i.test(value) ? Number.parseInt(value.slice(1), 16) : 0xffffff
  const red = (hex >> 19) & 0x1f
  const green = (hex >> 10) & 0x3f
  const blue = (hex >> 3) & 0x1f
  return `0x${((red << 11) | (green << 5) | blue).toString(16).padStart(4, '0').toUpperCase()}`
}

function u8g2Font(size: number, weight: CanvasElement['fontWeight']) {
  if (size >= 18) return weight === 'bold' ? 'u8g2_font_helvB18_tr' : 'u8g2_font_helvR18_tr'
  if (size >= 14) return weight === 'bold' ? 'u8g2_font_helvB14_tr' : 'u8g2_font_helvR14_tr'
  if (size >= 10) return weight === 'bold' ? 'u8g2_font_6x10_tf' : 'u8g2_font_6x10_tf'
  return 'u8g2_font_5x7_tf'
}

function u8g2Color(value: string) {
  const packed = /^#[\da-f]{6}$/i.test(value) ? Number.parseInt(value.slice(1), 16) : 0xffffff
  const brightness = ((packed >> 16) & 0xff) * 0.299 + ((packed >> 8) & 0xff) * 0.587 + (packed & 0xff) * 0.114
  return brightness >= 128 ? 1 : 0
}

function isUnchangedImportedElement(element: CanvasElement, original: CanvasElement) {
  return element.kind === original.kind
    && element.x === original.x && element.y === original.y
    && (element.kind === 'text' || element.width === original.width && element.height === original.height)
    && element.text === original.text
    && element.fill === original.fill && element.stroke === original.stroke
    && element.radius === original.radius
    && element.fontSize === original.fontSize && element.fontWeight === original.fontWeight
    && element.imageData === original.imageData
}

function hasDynamicU8g2Argument(mapping: SourceElement) {
  return mapping.args.some((arg) =>
    literal(arg) === undefined
    && numeric(arg) === undefined
    && !/^(?:u8g2_font_|U8G2_|U8X8_|true$|false$)/.test(arg.trim()),
  )
}

function emitElement(element: CanvasElement, mapping: SourceElement, fontArg?: string) {
  if (mapping.renderer === 'u8g2' && hasDynamicU8g2Argument(mapping)
    && mapping.originalCode && mapping.originalElement && isUnchangedImportedElement(element, mapping.originalElement)) return mapping.originalCode
  const { renderer, receiver, operator, method, indent } = mapping
  const object = `${receiver}${operator}`
  const x = number(element.x)
  const y = number(element.y)
  const w = number(element.width)
  const h = number(element.height)
  const value = cppString(element.text)
  if (mapping.bitmapGeometry) {
    const args = [...mapping.args]
    const { xIndex, yIndex, widthIndex, heightIndex, originalX, originalY, originalWidth, originalHeight } = mapping.bitmapGeometry
    for (const [index, original, updated] of [
      [xIndex, originalX, element.x],
      [yIndex, originalY, element.y],
      [widthIndex, originalWidth, element.width],
      [heightIndex, originalHeight, element.height],
    ] as const) {
      if (original !== undefined && original !== updated) args[index] = String(number(updated))
    }
    return `${object}${method}(${args.join(', ')});`
  }
  if (mapping.triangleGeometry) {
    const { points, colorIndex } = mapping.triangleGeometry
    const minX = Math.min(...points.map((point) => point.x))
    const minY = Math.min(...points.map((point) => point.y))
    const originalWidth = Math.max(1, Math.max(...points.map((point) => point.x)) - minX)
    const originalHeight = Math.max(1, Math.max(...points.map((point) => point.y)) - minY)
    const args = [...mapping.args]
    points.forEach((point, index) => {
      const xIndex = index * 2
      const yIndex = xIndex + 1
      const nextX = element.x + (point.x - minX) * element.width / originalWidth
      const nextY = element.y + (point.y - minY) * element.height / originalHeight
      if (nextX !== point.x) args[xIndex] = String(number(nextX))
      if (nextY !== point.y) args[yIndex] = String(number(nextY))
    })
    const shapeColor = element.fill === 'none' ? element.stroke : element.fill
    if (colorIndex < args.length) {
      args[colorIndex] = sourceColor(shapeColor)
    }
    return `${object}${method}(${args.join(', ')});`
  }
  if (element.kind === 'image') return `// Imported image "${element.name.replace(/[\r\n]+/g, ' ').replace(/\*\//g, '* /')}" is not converted to a bitmap.`
  if (renderer === 'esphome') {
    if (element.kind === 'text') {
      const formatIndex = mapping.args.findIndex((arg) => literal(arg) !== undefined)
      if (formatIndex < 0) return `it.${method}(${x}, ${y}, ${mapping.args.slice(2).join(', ')});`
      const font = mapping.args.find((arg) => /^id\(/.test(arg)) ?? fontArg ?? 'id(font)'
      const alignment = mapping.args.find((arg) => /^TextAlign::[A-Z_]+$/.test(arg)) ?? 'TextAlign::TOP_LEFT'
      const originalFormat = formatIndex >= 0 ? literal(mapping.args[formatIndex]) : undefined
      const originalPreview = mapping.previewText ?? (originalFormat === undefined ? undefined : printfFormat(originalFormat)?.preview)
      const format = originalPreview === element.text && formatIndex >= 0
        ? mapping.args[formatIndex]
        : esphomeString(element.text)
      const trailingArgs = formatIndex >= 0 ? mapping.args.slice(formatIndex + 1) : []
      const color = `Color(${parseInt(element.fill.slice(1, 3), 16)}, ${parseInt(element.fill.slice(3, 5), 16)}, ${parseInt(element.fill.slice(5, 7), 16)})`
      return `it.printf(${x}, ${y}, ${font}, ${color}, ${alignment}, ${format}${trailingArgs.length ? `, ${trailingArgs.join(', ')}` : ''});`
    }
    if (element.kind === 'rect') {
      const shapeColor = element.fill === 'none' ? element.stroke : element.fill
      const color = `Color(${parseInt(shapeColor.slice(1, 3), 16)}, ${parseInt(shapeColor.slice(3, 5), 16)}, ${parseInt(shapeColor.slice(5, 7), 16)})`
      if (method === 'fill') return `it.fill(${color});`
      if (method === 'rectangle') return `it.rectangle(${x}, ${y}, ${w}, ${h}, ${color});`
      return `it.filled_rectangle(${x}, ${y}, ${w}, ${h}, ${color});`
    }
    if (element.kind === 'circle') {
      const outline = method === 'circle'
      const shapeColor = outline ? element.stroke : element.fill
      const color = `Color(${parseInt(shapeColor.slice(1, 3), 16)}, ${parseInt(shapeColor.slice(3, 5), 16)}, ${parseInt(shapeColor.slice(5, 7), 16)})`
      return `it.${outline ? 'circle' : 'filled_circle'}(${number(element.x + element.width / 2)}, ${number(element.y + element.height / 2)}, ${number(Math.max(1, Math.min(element.width, element.height) / 2))}, ${color});`
    }
    if (element.kind === 'line') {
      if (method === 'horizontal_line' || method === 'vertical_line') {
        const loop = mapping.loopCoordinate
        const xArg = loop ? adjustedExpression(mapping.args[0], loop.originalX, element.x) : x
        const yArg = loop ? adjustedExpression(mapping.args[1], loop.originalY, element.y) : y
        const originalLength = method === 'horizontal_line' ? loop?.originalWidth : loop?.originalHeight
        const length = method === 'horizontal_line' ? element.width : element.height
        const lengthArg = loop && length === originalLength ? mapping.args[2] : number(length)
        const stroke = `Color(${parseInt(element.stroke.slice(1, 3), 16)}, ${parseInt(element.stroke.slice(3, 5), 16)}, ${parseInt(element.stroke.slice(5, 7), 16)})`
        return `it.${method}(${xArg}, ${yArg}, ${lengthArg}${mapping.args.length > 3 ? `, ${stroke}` : ''});`
      }
      return `it.line(${x}, ${y}, ${number(element.x + element.width)}, ${number(element.y + element.height)}, Color(${parseInt(element.stroke.slice(1, 3), 16)}, ${parseInt(element.stroke.slice(3, 5), 16)}, ${parseInt(element.stroke.slice(5, 7), 16)}));`
    }
  }
  if (element.kind === 'text') {
    if (renderer === 'u8g2') {
      const font = mapping.originalElement?.fontSize === element.fontSize && mapping.fontExpression
        ? mapping.fontExpression
        : u8g2Font(element.fontSize, element.fontWeight)
      const textValue = mapping.previewText === element.text && mapping.args[2] ? mapping.args[2] : value
      const xArg = mapping.originalX === element.x && mapping.args[0] ? mapping.args[0] : x
      const yArg = mapping.originalY === element.y && mapping.args[1] ? mapping.args[1] : number(element.y + Math.max(7, u8g2BaselineOffset(element.fontSize)))
      if (method === 'print' || method === 'println') {
        const printArgs = [mapping.previewText === element.text ? mapping.args[0] : value, ...mapping.args.slice(1)].filter(Boolean)
        return `${object}setFont(${font});\n${indent}${object}setDrawColor(${u8g2Color(element.fill)});\n${indent}${object}setCursor(${x}, ${number(element.y + u8g2BaselineOffset(element.fontSize))});\n${indent}${object}${method}(${printArgs.join(', ')});`
      }
      const textMethod = mapping.method === 'drawUTF8' || /[^\x00-\x7F]/.test(element.text) ? 'drawUTF8' : 'drawStr'
      return `${object}setFont(${font});\n${indent}${object}setDrawColor(${u8g2Color(element.fill)});\n${indent}${object}${textMethod}(${xArg}, ${yArg}, ${textValue});`
    }
    const size = `${object}setTextSize(${Math.max(1, Math.round(element.fontSize / 8))});\n${indent}${object}setTextColor(${sourceColor(element.fill)});\n${indent}`
    if ((method === 'print' || method === 'println') && mapping.cursor) return `${size}${object}setCursor(${x}, ${y});\n${indent}${object}${method}(${value});`
    if (method === 'printf') return `${size}${object}setCursor(${x}, ${y});\n${indent}${object}printf(${value});`
    if (method === 'drawString') return `${size}${object}drawString(${value}, ${x}, ${y});`
    if (method === 'drawCentreString' || method === 'drawCenterString') return `${size}${object}${method}(${value}, ${x}, ${y}, ${mapping.args[3] ?? 1});`
    if (method === 'drawRightString') return `${size}${object}drawRightString(${value}, ${x}, ${y}, ${mapping.args[3] ?? 1});`
    return `${size}${object}${method}(${value});`
  }
  if (element.kind === 'rect') {
    const shapeColor = element.fill === 'none' ? element.stroke : element.fill
    const drawColor = renderer === 'u8g2' ? `${object}setDrawColor(${u8g2Color(shapeColor)});\n${indent}` : ''
    if (method === 'fillScreen') return `${object}fillScreen(${sourceColor(element.fill)});`
    if (method === 'drawRBox' || method === 'drawRFrame') return `${drawColor}${object}${method}(${x}, ${y}, ${w}, ${h}, ${number(element.radius)});`
    if (method === 'fillRoundRect' || method === 'drawRoundRect') return `${object}${method}(${x}, ${y}, ${w}, ${h}, ${number(element.radius)}, ${sourceColor(shapeColor)});`
    if (method === 'filled_rectangle' || method === 'rectangle') return `it.${method}(${x}, ${y}, ${w}, ${h}, Color(${parseInt(shapeColor.slice(1, 3), 16)}, ${parseInt(shapeColor.slice(3, 5), 16)}, ${parseInt(shapeColor.slice(5, 7), 16)}));`
    return `${drawColor}${object}${method}(${x}, ${y}, ${w}, ${h}${mapping.args.length > 4 ? `, ${sourceColor(shapeColor)}` : ''});`
  }
  if (element.kind === 'circle') {
    const r = number(Math.max(1, Math.min(element.width, element.height) / 2))
    const cx = number(element.x + element.width / 2)
    const cy = number(element.y + element.height / 2)
    const shapeColor = element.fill === 'none' ? element.stroke : element.fill
    const drawColor = renderer === 'u8g2' ? `${object}setDrawColor(${u8g2Color(shapeColor)});\n${indent}` : ''
    return `${drawColor}${object}${method}(${cx}, ${cy}, ${r}${mapping.args.length > 3 ? `, ${sourceColor(shapeColor)}` : ''});`
  }
  const drawColor = renderer === 'u8g2' ? `${object}setDrawColor(${u8g2Color(element.stroke)});\n${indent}` : ''
  if (method === 'drawFastHLine') return `${object}drawFastHLine(${x}, ${y}, ${w}${mapping.args.length > 3 ? `, ${sourceColor(element.stroke)}` : ''});`
  if (method === 'drawFastVLine') return `${object}drawFastVLine(${x}, ${y}, ${h}${mapping.args.length > 3 ? `, ${sourceColor(element.stroke)}` : ''});`
  if (method === 'drawHLine') return `${drawColor}${object}drawHLine(${x}, ${y}, ${w});`
  if (method === 'drawVLine') return `${drawColor}${object}drawVLine(${x}, ${y}, ${h});`
  if (method === 'horizontal_line' || method === 'vertical_line') {
    const loop = mapping.loopCoordinate
    if (loop) {
      const xArg = adjustedExpression(mapping.args[0], loop.originalX, element.x)
      const yArg = adjustedExpression(mapping.args[1], loop.originalY, element.y)
      const originalLength = method === 'horizontal_line' ? loop.originalWidth : loop.originalHeight
      const length = method === 'horizontal_line' ? element.width : element.height
      const lengthArg = length === originalLength ? mapping.args[2] : number(length)
      return `it.${method}(${xArg}, ${yArg}, ${lengthArg});`
    }
    if (method === 'horizontal_line') return `it.horizontal_line(${x}, ${y}, ${w});`
    return `it.vertical_line(${x}, ${y}, ${h});`
  }
  return `${drawColor}${object}${method}(${x}, ${y}, ${number(element.x + element.width)}, ${number(element.y + element.height)}${mapping.args.length > 4 ? `, ${sourceColor(element.stroke)}` : ''});`
}

function emitAddedElement(element: CanvasElement, mapping: SourceElement, fontArg?: string) {
  if (element.kind === 'image') return `// Imported image "${element.name.replace(/[\r\n]+/g, ' ').replace(/\*\//g, '* /')}" is not converted to a bitmap.`
  const x = number(element.x)
  const y = number(element.y)
  const width = number(element.width)
  const height = number(element.height)
  const receiver = `${mapping.receiver}${mapping.operator}`
  if (mapping.renderer === 'u8g2') {
    const textMethod = /[^\x00-\x7F]/.test(element.text) ? 'drawUTF8' : 'drawStr'
    if (element.kind === 'text') return `${receiver}setFont(${u8g2Font(element.fontSize, element.fontWeight)});\n${mapping.indent}${receiver}setDrawColor(${u8g2Color(element.fill)});\n${mapping.indent}${receiver}${textMethod}(${x}, ${number(element.y + element.fontSize)}, ${cppString(element.text)});`
    if (element.kind === 'rect') return `${receiver}setDrawColor(${u8g2Color(element.fill)});\n${mapping.indent}${receiver}drawRBox(${x}, ${y}, ${width}, ${height}, ${number(element.radius)});`
    if (element.kind === 'circle') return `${receiver}setDrawColor(${u8g2Color(element.fill)});\n${mapping.indent}${receiver}drawDisc(${number(element.x + element.width / 2)}, ${number(element.y + element.height / 2)}, ${number(Math.max(1, Math.min(element.width, element.height) / 2))});`
    return `${receiver}setDrawColor(${u8g2Color(element.stroke)});\n${mapping.indent}${receiver}drawLine(${x}, ${y}, ${number(element.x + element.width)}, ${number(element.y + element.height)});`
  }
  if (mapping.renderer === 'esphome') {
    if (element.kind === 'text') return `it.printf(${x}, ${y}, ${fontArg ?? 'id(font)'}, Color(${parseInt(element.fill.slice(1, 3), 16)}, ${parseInt(element.fill.slice(3, 5), 16)}, ${parseInt(element.fill.slice(5, 7), 16)}), TextAlign::TOP_LEFT, ${esphomeString(element.text)});`
    if (element.kind === 'rect') return `it.filled_rectangle(${x}, ${y}, ${width}, ${height}, Color(${parseInt(element.fill.slice(1, 3), 16)}, ${parseInt(element.fill.slice(3, 5), 16)}, ${parseInt(element.fill.slice(5, 7), 16)}));`
    if (element.kind === 'circle') return `it.filled_circle(${number(element.x + element.width / 2)}, ${number(element.y + element.height / 2)}, ${number(Math.max(1, Math.min(element.width, element.height) / 2))}, Color(${parseInt(element.fill.slice(1, 3), 16)}, ${parseInt(element.fill.slice(3, 5), 16)}, ${parseInt(element.fill.slice(5, 7), 16)}));`
    return `it.line(${x}, ${y}, ${number(element.x + element.width)}, ${number(element.y + element.height)}, Color(${parseInt(element.stroke.slice(1, 3), 16)}, ${parseInt(element.stroke.slice(3, 5), 16)}, ${parseInt(element.stroke.slice(5, 7), 16)}));`
  }
  if (element.kind === 'text') {
    const size = `${receiver}setTextSize(${Math.max(1, Math.round(element.fontSize / 8))});\n${mapping.indent}${receiver}setTextColor(${sourceColor(element.fill)});\n${mapping.indent}`
    if (mapping.renderer === 'tft-espi') return `${size}${receiver}drawString(${cppString(element.text)}, ${x}, ${y});`
    return `${size}${receiver}setCursor(${x}, ${y});\n${mapping.indent}${receiver}print(${cppString(element.text)});`
  }
  if (element.kind === 'rect') return `${receiver}fillRoundRect(${x}, ${y}, ${width}, ${height}, ${number(element.radius)}, ${sourceColor(element.fill)});`
  if (element.kind === 'circle') return `${receiver}fillCircle(${number(element.x + element.width / 2)}, ${number(element.y + element.height / 2)}, ${number(Math.max(1, Math.min(element.width, element.height) / 2))}, ${sourceColor(element.fill)});`
  return `${receiver}drawLine(${x}, ${y}, ${number(element.x + element.width)}, ${number(element.y + element.height)}, ${sourceColor(element.stroke)});`
}

export function updateImportedSource(project: Project) {
  if (!project.sourceCode || !project.sourceFormat) return null
  const parsed = parseDisplaySource(project.sourceCode, project.sourceFormat)
  const elements = new Map(project.elements.map((element) => [element.id, element]))
  const existingIds = new Set(parsed.mappings.map((mapping) => mapping.id))
  const fontArg = parsed.mappings.find((mapping) => mapping.method === 'printf')?.args.find((arg) => /^id\(/.test(arg))
  const replacements = parsed.mappings.map((mapping) => ({
    start: mapping.start,
    end: mapping.end,
    value: elements.has(mapping.id) ? emitElement(elements.get(mapping.id)!, mapping, fontArg) : '',
    id: mapping.id,
  }))
  const currentTopics = new Map((project.sourceTopics ?? parsed.sourceTopics).map(({ id, topic }) => [id, topic]))
  for (const mapping of scanSourceTopics(project.sourceCode)) {
    const topic = currentTopics.get(mapping.id)
    if (topic === undefined || topic === mapping.topic) continue
    const escaped = mapping.quoted
      ? topic.replace(/\\/g, '\\\\').replace(new RegExp(mapping.quoted, 'g'), `\\${mapping.quoted}`)
      : topic
    replacements.push({ start: mapping.start, end: mapping.end, value: escaped, id: `topic-${mapping.id}` })
  }
  const added = project.elements.filter((element) => !existingIds.has(element.id))
  if (added.length && replacements.length) {
    const last = replacements[replacements.length - 1]
    const mapping = parsed.mappings[parsed.mappings.length - 1]
    last.value += added.map((element) => `\n${mapping.indent}${emitAddedElement(element, mapping, fontArg)}`).join('')
  }
  let code = project.sourceCode
  if (!replacements.length) return { code, warnings: parsed.warnings, renderer: parsed.renderer }
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    code = `${code.slice(0, replacement.start)}${replacement.value}${code.slice(replacement.end)}`
  }
  return { code, warnings: parsed.warnings, renderer: parsed.renderer }
}
