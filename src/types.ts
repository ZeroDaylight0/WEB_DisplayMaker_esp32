export type DisplayKind = 'OLED' | 'TFT' | 'E-Paper' | 'LED Matrix'

export interface DisplayPreset {
  id: string
  name: string
  controller: string
  kind: DisplayKind
  width: number
  height: number
  color: boolean
  interface: string
  library: 'u8g2' | 'arduino-gfx' | 'esphome'
  esphomePlatform?: string
  esphomeModel?: string
  gfxDriver?: string
  u8g2Constructor?: string
  boardFamily?: string
  boardPreset?: boolean
  backlightManaged?: boolean
  boardRotation?: number
  esphomeRotation?: number
  boardOffsets?: { x: number; y: number }
  boardPins?: {
    sck: number
    mosi: number
    cs: number
    dc: number
    reset: number
    backlight?: number
  }
}

export type ElementKind = 'text' | 'rect' | 'circle' | 'line' | 'image'

export interface CanvasElement {
  id: string
  kind: ElementKind
  name: string
  x: number
  y: number
  width: number
  height: number
  text: string
  fill: string
  stroke: string
  radius: number
  fontSize: number
  fontFamily: string
  fontWeight: 'normal' | 'bold'
  imageData?: string
  dynamicVariables?: string[]
  textAnchor?: 'start' | 'middle' | 'end'
  textBaseline?: 'hanging' | 'central' | 'text-after-edge' | 'alphabetic'
  sourceBranchPath?: Array<{ id: string; choice: number }>
  repeatAxis?: 'x' | 'y'
  repeatOffsets?: number[]
}

export interface SourceTopic {
  id: string
  topic: string
}

export interface SourceBranchGroup {
  id: string
  label: string
  choices: string[]
  parentPath?: Array<{ id: string; choice: number }>
}

export interface Project {
  name: string
  cloudProjectId?: string
  cloudOwnerId?: string
  displayId: string
  width: number
  height: number
  color: boolean
  elements: CanvasElement[]
  sourceCode?: string
  sourceFormat?: 'arduino' | 'esphome'
  sourceTopics?: SourceTopic[]
  sourceBranchGroups?: SourceBranchGroup[]
  sourceBranchSelection?: Record<string, number>
  sourceImportVersion?: number
}
