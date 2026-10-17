import type { CanvasElement, DisplayPreset, Project } from './types'

export type CodeTarget = 'arduino' | 'esphome'

const hex = (value: string) => /^#[\da-f]{6}$/i.test(value) ? value.slice(1) : 'ffffff'
const cppString = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n')}"`
const yamlString = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n').replace(/%/g, '%%')}"`
const commentText = (value: string) => value.replace(/[\r\n]+/g, ' ').replace(/\*\//g, '* /')
const n = (value: number) => Math.round(value)
const esphomeColor = (value: string, display: DisplayPreset) => {
  if (!display.color) return 'Color::WHITE'
  const hexValue = Number.parseInt(hex(value), 16)
  return `Color(${(hexValue >> 16) & 0xff}, ${(hexValue >> 8) & 0xff}, ${hexValue & 0xff})`
}
const rgb565 = (color: string) => {
  const value = Number.parseInt(hex(color), 16)
  return `0x${(((value >> 19) & 0x1f) << 11 | ((value >> 10) & 0x3f) << 5 | ((value >> 3) & 0x1f)).toString(16).padStart(4, '0').toUpperCase()}`
}

function arduinoElement(element: CanvasElement, display: DisplayPreset) {
  const x = n(element.x)
  const y = n(element.y)
  const w = n(element.width)
  const h = n(element.height)

  if (element.kind === 'text') {
    if (display.library === 'u8g2') {
      const font = element.fontSize >= 14 ? 'u8g2_font_helvB14_tr' : element.fontSize >= 10 ? 'u8g2_font_6x10_tr' : 'u8g2_font_5x7_tr'
      return `  u8g2.setFont(${font});\n  u8g2.drawStr(${x}, ${y + element.fontSize}, ${cppString(element.text)});`
    }
    return `  gfx->setTextSize(${Math.max(1, Math.round(element.fontSize / 8))});\n  gfx->setTextColor(${rgb565(element.fill)});\n  gfx->setCursor(${x}, ${y});\n  gfx->print(${cppString(element.text)});`
  }
  if (element.kind === 'image') return `  // Imported image "${commentText(element.name)}" is not converted to a bitmap by this generator.`
  const color = display.library === 'u8g2' ? '1' : rgb565(element.fill)
  if (element.kind === 'rect') {
    return display.library === 'u8g2'
      ? `  u8g2.drawRBox(${x}, ${y}, ${w}, ${h}, ${Math.min(4, element.radius)});`
      : `  gfx->fillRoundRect(${x}, ${y}, ${w}, ${h}, ${element.radius}, ${color});`
  }
  if (element.kind === 'circle') {
    const radius = Math.max(1, Math.min(w, h) / 2)
    return display.library === 'u8g2'
      ? `  u8g2.drawDisc(${n(x + radius)}, ${n(y + radius)}, ${n(radius)});`
      : `  gfx->fillCircle(${n(x + radius)}, ${n(y + radius)}, ${n(radius)}, ${color});`
  }
  return display.library === 'u8g2'
    ? `  u8g2.drawLine(${x}, ${y}, ${x + w}, ${y + h});`
    : `  gfx->drawLine(${x}, ${y}, ${x + w}, ${y + h}, ${color});`
}

function arduinoCode(project: Project, display: DisplayPreset) {
  const body = project.elements.map((element) => arduinoElement(element, display)).join('\n')
  if (display.library === 'u8g2' && display.u8g2Constructor) {
    return `// PixelForge · ${commentText(display.controller)} · ${display.width}×${display.height}\n// Install the U8g2 library from the Arduino Library Manager.\n#include <U8g2lib.h>\n\n${display.u8g2Constructor} u8g2(U8G2_R0, U8X8_PIN_NONE);\n\nvoid setup() {\n  u8g2.begin();\n}\n\nvoid loop() {\n  u8g2.clearBuffer();\n${body}\n  u8g2.sendBuffer();\n  delay(100);\n}`
  }
  if (display.library === 'arduino-gfx' && display.gfxDriver) {
    const pins = display.boardPins ?? { sck: 18, mosi: 23, cs: 5, dc: 2, reset: 4 }
    const rotation = display.boardRotation ?? 0
    const offsets = display.boardOffsets ?? { x: 0, y: 0 }
    const args = display.gfxDriver === 'Arduino_ST7789'
      ? `bus, ${pins.reset} /* reset */, ${rotation} /* rotation */, true, ${display.width}, ${display.height}, ${offsets.x}, ${offsets.y}, ${offsets.x}, ${offsets.y}`
      : display.gfxDriver === 'Arduino_SSD1331' || display.gfxDriver === 'Arduino_ILI9225'
        ? `bus, ${pins.reset} /* reset */, ${rotation} /* rotation */`
        : `bus, ${pins.reset} /* reset */, ${rotation} /* rotation */, true`
    const backlight = pins.backlight === undefined ? '' : `  pinMode(${pins.backlight}, OUTPUT);\n  digitalWrite(${pins.backlight}, HIGH);\n`
    return `// PixelForge · ${commentText(display.boardFamily ?? display.controller)} · ${display.width}×${display.height}\n// Install Arduino_GFX_Library. Verify the board revision and pins before uploading.\n#include <Arduino_GFX_Library.h>\n\nArduino_DataBus *bus = new Arduino_ESP32SPI(${pins.dc} /* DC */, ${pins.cs} /* CS */, ${pins.sck} /* SCK */, ${pins.mosi} /* MOSI */, -1 /* MISO */);\nArduino_GFX *gfx = new ${display.gfxDriver}(${args});\n\nvoid setup() {\n  gfx->begin();\n${backlight}  gfx->fillScreen(0x0000);\n}\n\nvoid loop() {\n  gfx->fillScreen(0x0000);\n${body}\n  delay(100);\n}`
  }
  return `// ${display.controller} has no verified Arduino driver template in PixelForge yet.\n// Select a compatible display preset or add the controller-specific initialization.`
}

function esphomeElement(element: CanvasElement, display: DisplayPreset) {
  const x = n(element.x)
  const y = n(element.y)
  const w = n(element.width)
  const h = n(element.height)
  if (element.kind === 'text') {
    return `  it.printf(${x}, ${y}, id(font_small), ${esphomeColor(element.fill, display)}, TextAlign::TOP_LEFT, ${yamlString(element.text)});`
  }
  if (element.kind === 'image') return `  // Imported image "${commentText(element.name)}" is not converted to a bitmap by this generator.`
  if (element.kind === 'rect') {
    if (element.fill === 'none') return `  it.rectangle(${x}, ${y}, ${w}, ${h}, ${esphomeColor(element.stroke, display)});`
    return `  it.filled_rectangle(${x}, ${y}, ${w}, ${h}, ${esphomeColor(element.fill, display)});`
  }
  if (element.kind === 'circle') {
    const radius = n(Math.max(1, Math.min(w, h) / 2))
    return `  it.filled_circle(${x + radius}, ${y + radius}, ${radius}, ${esphomeColor(element.fill, display)});`
  }
  return `  it.line(${x}, ${y}, ${x + w}, ${y + h}, ${esphomeColor(element.stroke, display)});`
}

function esphomeCode(project: Project, display: DisplayPreset) {
  if (!display.esphomePlatform) return null
  const lines = project.elements.map((element) => esphomeElement(element, display)).join('\n')
  const font = `font:\n  - file: "gfonts://Roboto Mono"\n    id: font_small\n    size: 12\n\n`
  const lambda = `lambda: |-\n${(lines || '// Add elements to draw your screen.').split('\n').map((line) => `      ${line}`).join('\n')}`
  if (display.esphomePlatform === 'ssd1306_i2c' || display.esphomePlatform === 'ssd1327_i2c') {
    const address = display.esphomePlatform === 'ssd1327_i2c' ? '0x3D' : '0x3C'
    return `# PixelForge · ESPHome display snippet\n${font}i2c:\n  sda: GPIO21\n  scl: GPIO22\n\ndisplay:\n  - platform: ${display.esphomePlatform}\n    model: "${display.esphomeModel}"\n    address: ${address}\n    ${lambda}`
  }
  if (display.esphomePlatform === 'mipi_spi' || display.esphomePlatform === 'ili9xxx') {
    const pins = display.boardPins ?? { sck: 18, mosi: 23, cs: 5, dc: 16, reset: 4 }
    const platformOptions = display.boardPreset
      ? `    model: ${display.esphomeModel}\n`
      : `    model: ${display.esphomeModel}\n    dimensions:\n      width: ${display.width}\n      height: ${display.height}\n`
    const platform = display.esphomePlatform === 'mipi_spi' ? 'mipi_spi' : 'ili9xxx'
    const backlight = pins.backlight === undefined || display.backlightManaged ? '' : `output:\n  - platform: ledc\n    pin: GPIO${pins.backlight}\n    id: display_backlight\n\nlight:\n  - platform: monochromatic\n    output: display_backlight\n    name: Display Backlight\n    restore_mode: ALWAYS_ON\n\n`
    const psram = display.id === 't-embed-170x320' ? `psram:\n  mode: octal\n\n` : display.id === 'm5stack-core2-320x240' ? `psram:\n\n` : ''
    const boardOptions = display.boardPreset ? '' : `    cs_pin: GPIO${pins.cs}\n    dc_pin: GPIO${pins.dc}\n    reset_pin: GPIO${pins.reset}\n`
    const displayOptions = display.esphomePlatform === 'ili9xxx'
      ? `    invert_colors: false\n${boardOptions}`
      : boardOptions
    return `# PixelForge · ${commentText(display.boardFamily ?? 'ESPHome display')}\n${font}${psram}${backlight}spi:\n  clk_pin: GPIO${pins.sck}\n  mosi_pin: GPIO${pins.mosi}\n\ndisplay:\n  - platform: ${platform}\n${platformOptions}${displayOptions}    rotation: ${display.esphomeRotation ?? 0}\n    ${lambda}`
  }
  if (display.esphomePlatform === 'st7789v' && display.esphomeModel) {
    const pins = display.boardPins ?? { sck: 18, mosi: 23, cs: 5, dc: 16, reset: 4 }
    return `# PixelForge · ${commentText(display.boardFamily ?? 'ESPHome display')}\n${font}spi:\n  clk_pin: GPIO${pins.sck}\n  mosi_pin: GPIO${pins.mosi}\n\ndisplay:\n  - platform: st7789v\n    model: ${display.esphomeModel}\n    lambda:\n${lines.split('\n').map((line) => `      ${line}`).join('\n')}`
  }
  if (display.esphomePlatform === 'waveshare_epaper' && display.esphomeModel) {
    return `# PixelForge · ESPHome display snippet\n${font}spi:\n  clk_pin: GPIO18\n  mosi_pin: GPIO23\n\ndisplay:\n  - platform: waveshare_epaper\n    model: ${display.esphomeModel}\n    cs_pin: GPIO5\n    dc_pin: GPIO16\n    busy_pin: GPIO4\n    reset_pin: GPIO17\n    ${lambda}`
  }
  if (display.esphomePlatform === 'max7219digit') {
    return `# PixelForge · ESPHome display snippet\n${font}spi:\n  clk_pin: GPIO18\n  mosi_pin: GPIO23\n\ndisplay:\n  - platform: max7219digit\n    cs_pin: GPIO5\n    num_chips: ${Math.max(1, Math.ceil(display.width / 8))}\n    intensity: 3\n    ${lambda}`
  }
  return null
}

export function generateCode(target: CodeTarget, project: Project, display: DisplayPreset) {
  if (target === 'arduino') {
    if (display.library === 'esphome' || display.library === 'u8g2' && !display.u8g2Constructor || display.library === 'arduino-gfx' && !display.gfxDriver) return null
    return arduinoCode(project, display)
  }
  return esphomeCode(project, display)
}
