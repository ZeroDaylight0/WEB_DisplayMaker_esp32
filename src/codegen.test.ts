import { describe, expect, it } from 'vitest'
import { generateCode } from './codegen'
import { displays } from './displays'
import type { CanvasElement, Project } from './types'

const text: CanvasElement = {
  id: 'label',
  kind: 'text',
  name: 'Label',
  x: 4,
  y: 8,
  width: 40,
  height: 12,
  text: 'Room "A"',
  fill: '#c3f36b',
  stroke: 'none',
  radius: 0,
  fontSize: 12,
  fontFamily: 'monospace',
  fontWeight: 'normal',
}

const project: Project = {
  name: 'Test',
  displayId: 'ssd1306-128x64',
  width: 128,
  height: 64,
  color: false,
  elements: [text],
}

describe('display code generation', () => {
  it('generates U8g2 code and escapes C++ string literals', () => {
    const code = generateCode('arduino', project, displays.find((display) => display.id === 'ssd1306-128x64')!)
    expect(code).toContain('#include <U8g2lib.h>')
    expect(code).toContain('u8g2.drawStr(4, 20, "Room \\"A\\"");')
  })

  it('generates an ESPHome lambda with valid indentation for a custom ST7789 size', () => {
    const code = generateCode('esphome', project, displays.find((display) => display.id === 'st7789-240x240')!)
    expect(code).toContain('  - platform: mipi_spi\n    model: ST7789V\n    dimensions:\n      width: 240\n      height: 240')
    expect(code).toContain('    lambda: |-\n        it.printf(4, 8, id(font_small), Color(195, 243, 107), TextAlign::TOP_LEFT, "Room \\"A\\"");')
  })

  it('escapes printf format markers in static ESPHome text', () => {
    const display = displays.find((item) => item.id === 'st7789-240x240')!
    const code = generateCode('esphome', { ...project, elements: [{ ...text, text: '100%' }] }, display)
    expect(code).toContain('"100%%"')
  })

  it('returns no Arduino code for a display without a verified Arduino template', () => {
    const display = displays.find((item) => item.id === 'epd-154-200x200')!
    expect(generateCode('arduino', project, display)).toBeNull()
  })

  it('generates the ESPHome SSD1327 I2C platform and default address', () => {
    const display = displays.find((item) => item.id === 'ssd1327-128x128')!
    const code = generateCode('esphome', project, display)
    expect(code).toContain('platform: ssd1327_i2c')
    expect(code).toContain('address: 0x3D')
  })

  it('includes an SPI bus for MAX7219 ESPHome displays', () => {
    const display = displays.find((item) => item.id === 'max7219-32x8')!
    const code = generateCode('esphome', project, display)
    expect(code).toContain('spi:\n  clk_pin: GPIO18\n  mosi_pin: GPIO23')
    expect(code).toContain('num_chips: 4')
  })

  it('uses the built-in board profile and pin map for CYD ESPHome output', () => {
    const display = displays.find((item) => item.id === 'cyd-28-ili9341')!
    const code = generateCode('esphome', project, display)
    expect(code).toContain('clk_pin: GPIO14')
    expect(code).toContain('mosi_pin: GPIO13')
    expect(code).toContain('cs_pin: GPIO15')
    expect(code).toContain('dc_pin: GPIO2')
    expect(code).toContain('reset_pin: GPIO4')
    expect(code).toContain('rotation: 90')
  })

  it('generates a profile-aware T-Embed MIPI SPI snippet', () => {
    const display = displays.find((item) => item.id === 't-embed-170x320')!
    const code = generateCode('esphome', project, display)
    expect(code).toContain('psram:\n  mode: octal')
    expect(code).toContain('clk_pin: GPIO12')
    expect(code).toContain('mosi_pin: GPIO11')
    expect(code).toContain('model: T-EMBED')
  })

  it('returns no ESPHome code for an unsupported controller template', () => {
    const display = displays.find((item) => item.id === 'ssd1331-96x64')!
    expect(generateCode('esphome', project, display)).toBeNull()
  })
})
