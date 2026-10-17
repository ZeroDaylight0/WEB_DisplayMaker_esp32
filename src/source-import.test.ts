import { describe, expect, it } from 'vitest'
import { parseDisplaySource, updateImportedSource } from './source-import'
import type { Project } from './types'

describe('imported display source', () => {
  it('parses U8g2 draw calls and patches only display calls in the original sketch', () => {
    const source = [
      '#include <U8g2lib.h>',
      'void setup() { pinMode(2, OUTPUT); }',
      'void loop() {',
      '  u8g2.clearBuffer();',
      '  u8g2.drawStr(10, 20, "Hello");',
      '  u8g2.drawRBox(2, 28, 50, 20, 3);',
      '  sendSensorData();',
      '  u8g2.sendBuffer();',
      '}',
    ].join('\n')
    const parsed = parseDisplaySource(source, 'arduino')
    expect(parsed.renderer).toBe('u8g2')
    expect(parsed.elements).toHaveLength(2)
    expect(parsed.elements[0]).toMatchObject({ kind: 'text', x: 10, y: 12, text: 'Hello' })
    const project: Project = {
      name: 'Imported', displayId: 'ssd1306-128x64', width: 128, height: 64, color: false,
      elements: [{ ...parsed.elements[0], x: 14, text: 'Updated' }, parsed.elements[1]],
      sourceCode: source, sourceFormat: 'arduino',
    }
    const result = updateImportedSource(project)
    expect(result?.code).toContain('u8g2.drawStr(14, 20, "Updated");')
    expect(result?.code).toContain('u8g2.clearBuffer();')
    expect(result?.code).toContain('sendSensorData();')
    expect(result?.code).toContain('u8g2.sendBuffer();')
    expect(result?.code).not.toContain('u8g2.drawStr(10, 20, "Hello");')
  })

  it('uses the detected board dimensions to preview and patch the background', () => {
    const source = [
      '// ESP32-2432S028R',
      'void loop() {',
      '  gfx->fillScreen(0x0000);',
      '  gfx->fillRect(4, 8, 20, 10, 0x07E0);',
      '}',
    ].join('\n')
    const parsed = parseDisplaySource(source, 'arduino')
    expect(parsed.elements[0]).toMatchObject({ kind: 'rect', name: 'Блок 1', width: 320, height: 240, fill: '#000000' })
    const project: Project = {
      name: 'CYD', displayId: 'cyd-28-ili9341', width: 320, height: 240, color: true,
      elements: [{ ...parsed.elements[0], fill: '#ffffff' }, parsed.elements[1]],
      sourceCode: source, sourceFormat: 'arduino',
    }
    expect(updateImportedSource(project)?.code).toContain('gfx->fillScreen(0xFFFF);')
  })

  it('parses ESPHome display lambdas and preserves the rest of YAML', () => {
    const source = [
      'sensor:',
      '  - platform: homeassistant',
      '    id: room_temperature',
      'display:',
      '  - platform: ili9xxx',
      '    model: ILI9341',
      '    lambda: |-',
      '      it.printf(10, 12, id(font_small), "Hello");',
      '      it.filled_rectangle(2, 20, 40, 12, Color(255, 0, 0));',
    ].join('\n')
    const parsed = parseDisplaySource(source, 'esphome')
    expect(parsed.renderer).toBe('esphome')
    expect(parsed.elements).toHaveLength(2)
    const project: Project = {
      name: 'Imported', displayId: 'ili9341-240x320', width: 240, height: 320, color: true,
      elements: [{ ...parsed.elements[0], text: 'Ready', x: 16 }, parsed.elements[1]],
      sourceCode: source, sourceFormat: 'esphome',
    }
    const result = updateImportedSource(project)
    expect(result?.code).toContain('it.printf(16, 12, id(font_small), Color(255, 255, 255), TextAlign::TOP_LEFT, "Ready");')
    expect(result?.code).toContain('sensor:\n  - platform: homeassistant')
    expect(result?.code).toContain('model: ILI9341')
  })

  it('keeps a sketch intact when it contains no supported drawing calls', () => {
    const source = '#include <Arduino.h>\nvoid setup() {}\nvoid loop() { update(); }'
    const parsed = parseDisplaySource(source, 'arduino')
    expect(parsed.elements).toHaveLength(0)
    const result = updateImportedSource({
      name: 'Unrecognized', displayId: 'ssd1306-128x64', width: 128, height: 64, color: false,
      elements: [], sourceCode: source, sourceFormat: 'arduino',
    })
    expect(result?.code).toBe(source)
    expect(result?.warnings[0]).toContain('Не удалось распознать')
  })

  it('detects integrated CYD and LilyGO board names in uploaded source', () => {
    expect(parseDisplaySource('// ESP32-2432S028R ILI9341', 'arduino').suggestedDisplayId).toBe('cyd-28-ili9341')
    expect(parseDisplaySource('// LilyGO T-Embed ST7789', 'arduino').suggestedDisplayId).toBe('t-embed-170x320')
    expect(parseDisplaySource('// TTGO T-Display 135x240', 'arduino').suggestedDisplayId).toBe('ttgo-tdisplay-135x240')
    expect(parseDisplaySource('#include <U8g2lib.h>\nU8G2_SSD1309_128X64_NONAME0_F_HW_I2C display;', 'arduino').suggestedDisplayId).toBe('ssd1309-128x64')
  })

  it('renders static Arduino bitmaps and preserves their drawing call when edited', () => {
    const source = [
      '#include <Adafruit_GFX.h>',
      'const uint8_t logo[] PROGMEM = { 0x80, 0x40 };',
      'void loop() { gfx->drawBitmap(2, 3, logo, 8, 2, 0xFFFF); }',
    ].join('\n')
    const parsed = parseDisplaySource(source, 'arduino')
    expect(parsed.elements).toHaveLength(1)
    expect(parsed.elements[0]).toMatchObject({ kind: 'image', x: 2, y: 3, width: 8, height: 2 })
    expect(decodeURIComponent(parsed.elements[0].imageData!.split(',')[1])).toContain('<rect x="0" y="0"')
    const project: Project = {
      name: 'Bitmap', displayId: 'ssd1309-128x64', width: 128, height: 64, color: false,
      elements: [{ ...parsed.elements[0], x: 5, width: 16 }],
      sourceCode: source, sourceFormat: 'arduino',
    }
    const updated = updateImportedSource(project)?.code
    expect(updated).toContain('gfx->drawBitmap(5, 3, logo, 16, 2, 0xFFFF);')
    expect(updated).not.toContain('is not converted to a bitmap')
  })

  it('renders Arduino triangles as triangles and patches their vertices', () => {
    const source = 'void loop() { gfx->fillTriangle(1, 2, 8, 2, 4, 9, 0xF800); }'
    const parsed = parseDisplaySource(source, 'arduino')
    expect(parsed.elements).toHaveLength(1)
    expect(parsed.elements[0]).toMatchObject({ kind: 'image', x: 1, y: 2, width: 7, height: 7 })
    expect(decodeURIComponent(parsed.elements[0].imageData!.split(',')[1])).toContain('<polygon')
    const project: Project = {
      name: 'Triangle', displayId: 'ili9341-240x320', width: 240, height: 320,
      color: true, elements: [{ ...parsed.elements[0], x: 3, y: 4 }],
      sourceCode: source, sourceFormat: 'arduino',
    }
    expect(updateImportedSource(project)?.code).toContain('gfx->fillTriangle(3, 4, 10, 4, 6, 11, 0xF800);')
  })

  it('preserves C++ pointer calls and translates RGB565 colors when patching', () => {
    const source = 'void loop() { gfx->fillRoundRect(10, 20, 50, 30, 4, 0xF800); }'
    const parsed = parseDisplaySource(source, 'arduino')
    expect(parsed.elements[0].fill).toBe('#ff0000')
    const project: Project = {
      name: 'CYD', displayId: 'cyd-28-ili9341', width: 320, height: 240, color: true,
      elements: [{ ...parsed.elements[0], x: 17 }],
      sourceCode: source, sourceFormat: 'arduino',
    }
    expect(updateImportedSource(project)?.code).toContain('gfx->fillRoundRect(17, 20, 50, 30, 4, 0xF800);')
  })

  it('keeps outline drawing calls unfilled and preserves their stroke colors', () => {
    const source = [
      '#include <Adafruit_GFX.h>',
      'void loop() {',
      '  gfx->drawRect(4, 5, 20, 10, 0xF800);',
      '  gfx->fillRect(30, 5, 20, 10, 0x07E0);',
      '  gfx->drawRoundRect(55, 5, 20, 10, 3, 0x001F);',
      '  gfx->drawCircle(90, 10, 5, 0xFFFF);',
      '  gfx->fillCircle(110, 10, 5, 0xF800);',
      '}',
    ].join('\n')
    const parsed = parseDisplaySource(source, 'arduino')
    expect(parsed.elements.map(({ kind, fill, stroke }) => ({ kind, fill, stroke }))).toEqual([
      { kind: 'rect', fill: 'none', stroke: '#ff0000' },
      { kind: 'rect', fill: '#00ff00', stroke: '#00ff00' },
      { kind: 'rect', fill: 'none', stroke: '#0000ff' },
      { kind: 'circle', fill: 'none', stroke: '#ffffff' },
      { kind: 'circle', fill: '#ff0000', stroke: '#ff0000' },
    ])
    const project: Project = {
      name: 'Outlines', displayId: 'ili9341-240x320', width: 240, height: 320, color: true,
      elements: parsed.elements, sourceCode: source, sourceFormat: 'arduino',
    }
    const updated = updateImportedSource(project)?.code
    expect(updated).toContain('gfx->drawRect(4, 5, 20, 10, 0xF800);')
    expect(updated).toContain('gfx->drawRoundRect(55, 5, 20, 10, 3, 0x001F);')
    expect(updated).toContain('gfx->drawCircle(90, 10, 5, 0xFFFF);')
  })

  it('imports text color and size, then writes the edited style into the original calls', () => {
    const source = [
      'void loop() {',
      '  gfx->setTextColor(0xF800);',
      '  gfx->setTextSize(2);',
      '  gfx->setCursor(4, 8);',
      '  gfx->print("Ready");',
      '}',
    ].join('\n')
    const parsed = parseDisplaySource(source, 'arduino')
    expect(parsed.elements[0]).toMatchObject({ kind: 'text', fill: '#ff0000', fontSize: 16 })
    const project: Project = {
      name: 'Styled', displayId: 'ili9341-240x320', width: 240, height: 320, color: true,
      elements: [{ ...parsed.elements[0], fill: '#00ff00', fontSize: 24 }],
      sourceCode: source, sourceFormat: 'arduino',
    }
    const result = updateImportedSource(project)
    expect(result?.code).toContain('gfx->setTextSize(3);')
    expect(result?.code).toContain('gfx->setTextColor(0x07E0);')
    expect(result?.code).toContain('gfx->print("Ready");')
  })

  it('imports U8g2 font size and draw color for text previews', () => {
    const source = [
      '#include <U8g2lib.h>',
      'void loop() {',
      '  u8g2.setFont(u8g2_font_6x10_tf);',
      '  u8g2.setDrawColor(0);',
      '  u8g2.drawStr(10, 20, "Ready");',
      '}',
    ].join('\n')
    const parsed = parseDisplaySource(source, 'arduino')
    expect(parsed.elements[0]).toMatchObject({ kind: 'text', fontSize: 10, fill: '#000000' })
    const project: Project = {
      name: 'Imported', displayId: 'ssd1306-128x64', width: 128, height: 64, color: false,
      elements: [{ ...parsed.elements[0], fontSize: 18, fill: '#ffffff' }],
      sourceCode: source, sourceFormat: 'arduino',
    }
    const result = updateImportedSource(project)
    expect(result?.code).toContain('u8g2.setFont(u8g2_font_helvR18_tr);')
    expect(result?.code).toContain('u8g2.setDrawColor(1);')
  })

  it('leaves formatted dynamic ESPHome printf calls untouched', () => {
    const dynamicText = '      it.printf(4, 8, id(font), "Temp: %.1f", id(room_temperature).state);'
    const source = [
      'display:',
      '  - platform: ili9xxx',
      '    lambda: |-',
      dynamicText,
      '      it.filled_rectangle(2, 20, 40, 12, Color(255, 0, 0));',
    ].join('\n')
    const parsed = parseDisplaySource(source, 'esphome')
    expect(parsed.elements).toHaveLength(2)
    expect(parsed.warnings.join(' ')).not.toContain('команда(ы)')
    const project: Project = {
      name: 'Imported', displayId: 'ili9341-240x320', width: 240, height: 320, color: true,
      elements: parsed.elements.map((element, index) => index === 1 ? { ...element, x: 12 } : element),
      sourceCode: source, sourceFormat: 'esphome',
    }
    const result = updateImportedSource(project)
    expect(result?.code).toContain('it.printf(4, 8, id(font), Color(255, 255, 255), TextAlign::TOP_LEFT, "Temp: %.1f", id(room_temperature).state);')
  })

  it('escapes percent signs when editing ESPHome printf text', () => {
    const source = [
      'display:',
      '  - platform: ili9xxx',
      '    lambda: |-',
      '      it.printf(4, 8, id(font), "100%%");',
    ].join('\n')
    const parsed = parseDisplaySource(source, 'esphome')
    expect(parsed.elements[0].text).toBe('100%')
    const project: Project = {
      name: 'Imported', displayId: 'ili9341-240x320', width: 240, height: 320, color: true,
      elements: [{ ...parsed.elements[0], text: 'Ready 100%' }],
      sourceCode: source, sourceFormat: 'esphome',
    }
    expect(updateImportedSource(project)?.code).toContain('"Ready 100%%"')
  })

  it('imports a CYD ESPHome lambda with dynamic printf values and keeps them on export', () => {
    const source = [
      '# CYD display',
      'mqtt:',
      '  on_message:',
      '    - topic: esp/alert/reason',
      '      then:',
      '        - lambda: |',
      '            id(alert_reason) = x;',
      '    - topic: esp/weather/temp',
      '      then:',
      '        - lambda: |',
      '            id(cur_temp) = atof(x.c_str());',
      'font:',
      '  - file: "large.ttf"',
      '    id: font_huge',
      '    size: 48',
      '  - file: "small.ttf"',
      '    id: font_small',
      '    size: 16',
      'display:',
      '  - platform: ili9xxx',
      '    model: ili9342',
      '    dimensions:',
      '      width: 320',
      '      height: 240',
      '    lambda: |-',
      '      it.fill(Color::BLACK);',
      '      if (status == 3) {',
      '        it.printf(160, 40, id(font_huge), Color(0xFF, 0x11, 0x11), TextAlign::CENTER, "ALERT!");',
      '      } else if (status == 2) {',
      '        it.printf(160, 40, id(font_huge), Color(0xFF, 0xBB, 0x00), TextAlign::CENTER, "WARNING");',
      '      } else {',
      '        it.printf(160, 40, id(font_huge), Color(0x00, 0xFF, 0x22), TextAlign::CENTER, "SAFE");',
      '      }',
      '      it.printf(160, 210, id(font_small), Color(0x99, 0x99, 0x99), TextAlign::CENTER, "%d%%  %s", id(cur_hum), id(weather_desc).c_str());',
    ].join('\n')
    const parsed = parseDisplaySource(source, 'esphome')
    expect(parsed.suggestedDisplayId).toBe('cyd-28-ili9341')
    expect(parsed.elements).toHaveLength(5)
    expect(parsed.sourceTopics).toEqual([])
    expect(parsed.elements[0]).toMatchObject({ kind: 'rect', width: 320, height: 240, fill: '#000000' })
    expect(parsed.elements[1]).toMatchObject({ kind: 'text', fill: '#ff1111', text: 'ALERT!', fontSize: 48 })
    expect(parsed.elements[2]).toMatchObject({ kind: 'text', fill: '#ffbb00', text: 'WARNING', fontSize: 48 })
    expect(parsed.elements[3]).toMatchObject({ kind: 'text', fill: '#00ff22', text: 'SAFE', fontSize: 48 })
    expect(parsed.elements[4]).toMatchObject({ kind: 'text', fill: '#999999', text: '0%  …', fontSize: 16 })
    expect(parsed.elements[4].dynamicVariables).toEqual(['cur_hum', 'weather_desc'])
    expect(parsed.warnings.join(' ')).not.toContain('команда(ы)')
    expect(parsed.warnings.join(' ')).toContain('Условные ветки можно переключать')

    const project: Project = {
      name: 'Alert', displayId: 'cyd-28-ili9341', width: 320, height: 240, color: true,
      elements: parsed.elements.map((element, index) => index === 1 ? { ...element, x: 150 } : element),
      sourceCode: source, sourceFormat: 'esphome',
    }
    const result = updateImportedSource(project)
    expect(result?.code).toContain('it.fill(Color(0, 0, 0));')
    expect(result?.code).toContain('it.printf(150, 40, id(font_huge), Color(255, 17, 17), TextAlign::CENTER, "ALERT!");')
    expect(result?.code).toContain('it.printf(160, 40, id(font_huge), Color(255, 187, 0), TextAlign::CENTER, "WARNING");')
    expect(result?.code).toContain('it.printf(160, 40, id(font_huge), Color(0, 255, 34), TextAlign::CENTER, "SAFE");')
    expect(result?.code).toContain('it.printf(160, 210, id(font_small), Color(153, 153, 153), TextAlign::CENTER, "%d%%  %s", id(cur_hum), id(weather_desc).c_str());')
  })

  it('detects an SSD1306 YAML model and previews runtime text at its centered anchor', () => {
    const source = [
      'mqtt:',
      '  on_message:',
      '    - topic: esp/zvonok',
      '      then:',
      '        - lambda: |-',
      '            id(status_msg) = x;',
      '            if (x == "yellow") {',
      '              id(status_led).turn_on().perform();',
      '            } else {',
      '              id(status_led).turn_off().perform();',
      '            }',
      'interval:',
      '  - interval: 2min',
      '    then:',
      '      - lambda: |-',
      '          if (has_alert) {',
      '            id(alert_status) = 3;',
      '          } else {',
      '            id(alert_status) = 1;',
      '          }',
      'display:',
      '  - platform: ssd1306_i2c',
      '    model: "SSD1306 128x64"',
      '    lambda: |-',
      '      if (id(show_msg)) {',
      '        it.printf(64, 32, id(font_large), TextAlign::CENTER, id(status_msg).c_str());',
      '      } else {',
      '        it.print(0, 10, id(font_small), "NOW");',
      '      }',
      'font:',
      '  - file: "arial.ttf"',
      '    id: font_large',
      '    size: 18',
    ].join('\n')
    const parsed = parseDisplaySource(source, 'esphome')
    expect(parsed.suggestedDisplayId).toBe('ssd1306-128x64')
    expect(parsed.elements).toHaveLength(2)
    expect(parsed.elements[0]).toMatchObject({
      kind: 'text',
      text: 'Сообщение',
      x: 64,
      y: 32,
      fontSize: 18,
      textAnchor: 'middle',
      textBaseline: 'central',
      dynamicVariables: ['status_msg'],
    })
    expect(parsed.elements[1]).toMatchObject({ x: 0, y: 10, textAnchor: 'start', textBaseline: 'hanging' })
    expect(parsed.sourceTopics).toEqual([{ id: 'status_msg', topic: 'esp/zvonok' }])
    expect(parsed.warnings.join(' ')).not.toContain('Не удалось распознать')
    expect(parsed.warnings.join(' ')).not.toContain('команда(ы)')
    const project: Project = {
      name: 'Weather alert', displayId: 'ssd1306-128x64', width: 128, height: 64, color: false,
      elements: parsed.elements.map((element, index) => index === 0 ? { ...element, x: 60 } : element),
      sourceCode: source, sourceFormat: 'esphome',
    }
    const result = updateImportedSource(project)
    expect(result?.code).toContain('it.printf(60, 32, id(font_large), TextAlign::CENTER, id(status_msg).c_str());')
    expect(result?.code).toContain('it.printf(0, 10, id(font_small), Color(255, 255, 255), TextAlign::TOP_LEFT, "NOW");')
  })

  it('imports every drawable element from both conditional states in a weather dashboard lambda', () => {
    const source = [
      'mqtt:',
      '  on_message:',
      '    - topic: esp/zvonok',
      '      then:',
      '        - lambda: |-',
      '            id(status_msg) = x;',
      '            if (x == "yellow") {',
      '              id(status_led).turn_on().perform();',
      '            } else {',
      '              id(status_led).turn_off().perform();',
      '            }',
      'interval:',
      '  - interval: 2min',
      '    then:',
      '      - lambda: |-',
      '          if (has_alert) {',
      '            id(alert_status) = 3;',
      '          } else {',
      '            id(alert_status) = 1;',
      '          }',
      'display:',
      '  - platform: ssd1306_i2c',
      '    model: "SSD1306 128x64"',
      '    lambda: |-',
      '      if (id(show_msg)) {',
      '        it.printf(64, 32, id(font_large), TextAlign::CENTER, id(status_msg).c_str());',
      '      } else {',
      '        it.print(0, 10, id(font_small), "NOW");',
      '        it.printf(95, 10, id(font_small), "%.0f%%", id(current_hum).state);',
      '        it.line(0, 13, 128, 13);',
      '        if ((millis() % 1000) > 500) {',
      '          it.rectangle(122, 2, 4, 4);',
      '        }',
      '        float t = id(current_temp).state;',
      '        int c = (int)id(current_code).state;',
      '        char temp_buf[10];',
      '        snprintf(temp_buf, sizeof(temp_buf), "%.1f", t);',
      '        it.print(0, 46, id(font_temp), temp_buf);',
      '        int temp_width = 0;',
      '        if (t >= 10.0 || t <= -10.0) { temp_width = 55; } else if (t >= 0.0) { temp_width = 45; } else { temp_width = 50; }',
      '        it.print(temp_width, 44, id(font_medium), "C");',
      '        if (id(alert_status) > 0) {',
      '          int box_x = 75, box_y = 18, box_w = 50, box_h = 24;',
      '          it.rectangle(box_x, box_y, box_w, box_h);',
      '          if (id(alert_status) == 3) {',
      '            it.filled_rectangle(box_x, box_y, box_w, box_h);',
      '            it.print(box_x + 8, box_y + 16, id(font_small), COLOR_OFF, TextAlign::TOP_LEFT, "RED");',
      '          } else if (id(alert_status) == 2) {',
      '            for (int i = box_y + 2; i < box_y + box_h - 2; i += 3) {',
      '              it.horizontal_line(box_x + 2, i, box_w - 4);',
      '            }',
      '            it.print(box_x + 4, box_y + 16, id(font_small), "WARN");',
      '          } else if (id(alert_status) == 1) {',
      '            it.print(box_x + 6, box_y + 16, id(font_small), "SAFE");',
      '          }',
      '        }',
      '        const char* weather_str = "UNKNOWN";',
      '        if (c == 0) weather_str = "CLEAR"; else if (c <= 3) weather_str = "CLOUDY";',
      '        it.print(0, 63, id(font_weather), weather_str);',
      '      }',
      'font:',
      '  - file: "arial.ttf"',
      '    id: font_large',
      '    size: 18',
    ].join('\n')
    const parsed = parseDisplaySource(source, 'esphome')
    expect(parsed.suggestedDisplayId).toBe('ssd1306-128x64')
    expect(parsed.sourceTopics).toEqual([{ id: 'status_msg', topic: 'esp/zvonok' }])
    expect(parsed.elements.map((element) => element.text).filter(Boolean)).toEqual([
      'Сообщение', 'NOW', '45%', '21.5', 'C', 'RED', 'WARN', 'SAFE', 'CLEAR',
    ])
    expect(parsed.elements.find((element) => element.y === 46)).toMatchObject({ dynamicVariables: ['temp_buf'] })
    expect(parsed.elements.at(-1)?.dynamicVariables).toEqual(['weather_str'])
    expect(parsed.elements.find((element) => element.text === 'C')?.x).toBe(55)
    expect(parsed.elements.some((element) => element.kind === 'line' && element.width === 128)).toBe(true)
    expect(parsed.elements.some((element) => element.kind === 'rect' && element.x === 75 && element.y === 18 && element.fill === 'none')).toBe(true)
    const hatch = parsed.elements.find((element) => element.kind === 'line' && element.x === 77 && element.y === 20 && element.width === 46)
    expect(hatch).toMatchObject({ repeatAxis: 'y', repeatOffsets: [0, 3, 6, 9, 12, 15, 18] })
    const loopProject: Project = {
      name: 'Weather', displayId: 'ssd1306-128x64', width: 128, height: 64, color: false,
      elements: parsed.elements, sourceCode: source, sourceFormat: 'esphome',
    }
    const exported = updateImportedSource(loopProject)?.code
    expect(exported).toContain('it.horizontal_line(box_x + 2, i, box_w - 4);')
    expect(exported).toContain('it.printf(95, 10, id(font_small), Color(255, 255, 255), TextAlign::TOP_LEFT, "%.0f%%", id(current_hum).state);')
    expect(parsed.sourceBranchGroups.length).toBeGreaterThanOrEqual(2)
    expect(parsed.sourceBranchGroups.every((group) => !group.label.includes('msg ==') && !group.label.includes('has_alert'))).toBe(true)
    const mainScreen = parsed.sourceBranchGroups.find((group) => group.label.includes('id(show_msg)'))
    expect(mainScreen).toBeDefined()
    expect(parsed.sourceBranchSelection[mainScreen!.id]).toBe(1)
    const alertState = parsed.sourceBranchGroups.find((group) => group.label.includes('id(alert_status) == 3'))
    expect(alertState?.choices.at(-1)).toBe('ни одно условие не выполнено')
    expect(parsed.sourceBranchSelection[alertState!.id]).toBe(alertState!.choices.length - 1)
    const alertContainer = parsed.sourceBranchGroups.find((group) => group.label.includes('id(alert_status) > 0'))
    expect(alertContainer).toBeDefined()
    expect(parsed.sourceBranchSelection[alertContainer!.id]).toBe(0)
    expect(alertState?.parentPath).toContainEqual({ id: alertContainer!.id, choice: 0 })
    expect(parsed.warnings.join(' ')).not.toContain('Не удалось распознать')
    expect(parsed.warnings.join(' ')).not.toContain('команда(ы)')
  })

  it('updates extracted MQTT topic values without rewriting unrelated YAML', () => {
    const source = [
      'mqtt:',
      '  on_message:',
      '    - topic: "esp/alert/reason"',
      '      then:',
      '        - lambda: |-',
      '            id(alert_reason) = x;',
      'wifi:',
      '  ssid: !secret wifi_ssid',
      'display:',
      '  - platform: ili9xxx',
      '    lambda: |-',
      '      it.printf(10, 20, id(font), "%s", id(alert_reason).c_str());',
    ].join('\n')
    const parsed = parseDisplaySource(source, 'esphome')
    expect(parsed.sourceTopics).toEqual([{ id: 'alert_reason', topic: 'esp/alert/reason' }])
    const project: Project = {
      name: 'Topic', displayId: 'ili9341-240x320', width: 240, height: 320, color: true,
      elements: parsed.elements,
      sourceCode: source,
      sourceFormat: 'esphome',
      sourceTopics: [{ id: 'alert_reason', topic: 'custom/alert/message' }],
    }
    const result = updateImportedSource(project)
    expect(result?.code).toContain('- topic: "custom/alert/message"')
    expect(result?.code).toContain('id(alert_reason) = x;')
    expect(result?.code).toContain('ssid: !secret wifi_ssid')
  })

  it('extracts topics assigned to dynamic text ids from MQTT handlers with CRLF lines', () => {
    const source = [
      'mqtt:',
      '  on_message:',
      '    - topic: esp/weather/humidity',
      '      then:',
      '        - lambda: |-',
      '            id(cur_hum) = atoi(x.c_str());',
      '            id(weather_desc) = x;',
      'display:',
      '  - platform: ili9xxx',
      '    lambda: |-',
      '      it.printf(10, 20, id(font), "%d%% %s", id(cur_hum), id(weather_desc).c_str());',
    ].join('\r\n')
    const parsed = parseDisplaySource(source, 'esphome')
    expect(parsed.sourceTopics).toEqual([
      { id: 'cur_hum', topic: 'esp/weather/humidity' },
      { id: 'weather_desc', topic: 'esp/weather/humidity' },
    ])
    expect(parsed.elements[0].dynamicVariables).toEqual(['cur_hum', 'weather_desc'])
    const project: Project = {
      name: 'Weather', displayId: 'ili9341-240x320', width: 240, height: 320, color: true,
      elements: parsed.elements,
      sourceCode: source,
      sourceFormat: 'esphome',
      sourceTopics: parsed.sourceTopics.map((item) => item.id === 'cur_hum' ? { ...item, topic: 'weather/humidity' } : item),
    }
    expect(updateImportedSource(project)?.code).toContain('- topic: weather/humidity')
  })

  it('imports an Arduino sketch with print and println sequences, advancing virtual cursor and resolving F() macros', () => {
    const source = [
      '#include <Adafruit_SSD1306.h>',
      '#define SCREEN_WIDTH 128',
      '#define SCREEN_HEIGHT 64',
      'Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, -1);',
      'void loop() {',
      '  display.clearDisplay();',
      '  display.setTextSize(1);',
      '  display.setTextColor(SSD1306_WHITE);',
      '  display.setCursor(0, 0);',
      '  display.println(F("Title"));',
      '  display.print(F("Temp: "));',
      '  display.print(temperature);',
      '  display.println(F(" C"));',
      '  display.print(F("Hum: "));',
      '  display.println(humidity);',
      '  display.drawFastHLine(0, 32, 128, SSD1306_WHITE);',
      '  display.display();',
      '}',
    ].join('\n')
    const parsed = parseDisplaySource(source, 'arduino')
    expect(parsed.suggestedDisplayId).toBe('ssd1306-128x64')
    expect(parsed.suggestedSize).toEqual({ width: 128, height: 64 })
    expect(parsed.warnings.join(' ')).not.toContain('команда(ы)')
    expect(parsed.elements.map((e) => e.text).filter(Boolean)).toEqual([
      'Title', 'Temp: ', '21.5', ' C', 'Hum: ', '45%',
    ])
    expect(parsed.elements[0]).toMatchObject({ kind: 'text', x: 0, y: 0, text: 'Title' })
    expect(parsed.elements[1]).toMatchObject({ kind: 'text', x: 0, y: 10, text: 'Temp: ' })
    expect(parsed.elements[2]).toMatchObject({ kind: 'text', y: 10, text: '21.5' })
    expect(parsed.elements[2].x).toBeGreaterThan(0)
    expect(parsed.elements[4]).toMatchObject({ kind: 'text', x: 0, y: 20, text: 'Hum: ' })
    const line = parsed.elements.find((e) => e.kind === 'line')
    expect(line).toMatchObject({ x: 0, y: 32, width: 128, height: 0 })

    const project: Project = {
      name: 'OLED', displayId: 'ssd1306-128x64', width: 128, height: 64, color: false,
      elements: parsed.elements,
      sourceCode: source, sourceFormat: 'arduino',
    }
    const updated = updateImportedSource(project)?.code
    expect(updated).toContain('display.clearDisplay();')
    expect(updated).toContain('display.display();')
    expect(updated).toContain('display.drawFastHLine(0, 32, 128, 0xFFFF);')
  })

  it('imports U8g2 Russian Cyrillic drawUTF8, drawHLine, drawVLine, and drawDisc', () => {
    const source = [
      '#include <U8g2lib.h>',
      'U8G2_SSD1306_128X64_NONAME_F_HW_I2C u8g2(U8G2_R0, U8X8_PIN_NONE);',
      'void loop() {',
      '  u8g2.clearBuffer();',
      '  u8g2.setFont(u8g2_font_helvB14_tr);',
      '  u8g2.setDrawColor(1);',
      '  u8g2.drawUTF8(10, 24, "Привет");',
      '  u8g2.drawHLine(0, 30, 128);',
      '  u8g2.drawVLine(64, 30, 34);',
      '  u8g2.drawDisc(100, 48, 8);',
      '  u8g2.sendBuffer();',
      '}',
    ].join('\n')
    const parsed = parseDisplaySource(source, 'arduino')
    expect(parsed.renderer).toBe('u8g2')
    expect(parsed.suggestedDisplayId).toBe('ssd1306-128x64')
    expect(parsed.warnings.join(' ')).not.toContain('команда(ы)')
    expect(parsed.elements).toHaveLength(4)
    expect(parsed.elements[0]).toMatchObject({ kind: 'text', x: 10, y: 10, text: 'Привет', fontSize: 14 })
    expect(parsed.elements[1]).toMatchObject({ kind: 'line', x: 0, y: 30, width: 128, height: 0 })
    expect(parsed.elements[2]).toMatchObject({ kind: 'line', x: 64, y: 30, width: 0, height: 34 })
    expect(parsed.elements[3]).toMatchObject({ kind: 'circle', x: 92, y: 40, width: 16, height: 16, fill: '#ffffff' })

    const project: Project = {
      name: 'U8g2 UTF8', displayId: 'ssd1306-128x64', width: 128, height: 64, color: false,
      elements: [{ ...parsed.elements[0], text: 'Мир' }, ...parsed.elements.slice(1)],
      sourceCode: source, sourceFormat: 'arduino',
    }
    const updated = updateImportedSource(project)?.code
    expect(updated).toContain('u8g2.drawUTF8(10, 24, "Мир");')
    expect(updated).toContain('u8g2.drawHLine(0, 30, 128);')
    expect(updated).toContain('u8g2.drawVLine(64, 30, 34);')
    expect(updated).toContain('u8g2.clearBuffer();')
    expect(updated).toContain('u8g2.sendBuffer();')
  })

  it('imports SSD1309 U8g2 font variants, centered and cursor-positioned text without warnings', () => {
    const source = [
      '#include <U8g2lib.h>',
      'U8G2_SSD1306_128X64_NONAME_F_HW_I2C u8g2(U8G2_R0, U8X8_PIN_NONE);',
      'String statusMsg = "ALERT";',
      'float t = 21.5;',
      'void draw() {',
      '  u8g2.setFont(u8g2_font_helvB14_tf);',
      '  u8g2.drawStr((128 - u8g2.getStrWidth(statusMsg.c_str())) / 2, 40, statusMsg.c_str());',
      '  u8g2.setFont(u8g2_font_logisoso24_tn);',
      '  u8g2.setCursor(0, 46);',
      '  u8g2.print(t, 1);',
      '  int tempWidth = u8g2.getCursorX();',
      '  u8g2.setFont(u8g2_font_helvB14_tf);',
      '  u8g2.drawStr(tempWidth, 44, "C");',
      '  u8g2.setFont(u8g2_font_9x15_tf);',
      '  u8g2.drawStr(0, 63, getWeatherStr(0).c_str());',
      '  Serial.println("debug");',
      '}',
      'String getWeatherStr(int code) {',
      '  if (code == 0) return "CLEAR";',
      '  return "STORM";',
      '}',
    ].join('\n')
    const parsed = parseDisplaySource(source, 'arduino')
    expect(parsed.warnings.join(' ')).not.toContain('команда(ы)')
    expect(parsed.elements.find((element) => element.text === 'ALERT')).toMatchObject({
      x: 64, textAnchor: 'middle', text: 'ALERT',
    })
    expect(parsed.elements.find((element) => element.text === '21.5')).toMatchObject({ fontSize: 24 })
    expect(parsed.elements.find((element) => element.text === 'C')?.x).toBeGreaterThan(0)
    expect(parsed.elements.find((element) => element.text === 'CLEAR')).toMatchObject({ y: 48, fontSize: 15 })

    const project: Project = {
      name: 'SSD1309', displayId: 'ssd1309-128x64', width: 128, height: 64, color: false,
      elements: parsed.elements, sourceCode: source, sourceFormat: 'arduino',
    }
    const exported = updateImportedSource(project)?.code
    expect(exported).toContain('u8g2.drawStr((128 - u8g2.getStrWidth(statusMsg.c_str())) / 2, 40, statusMsg.c_str());')
    expect(exported).toContain('u8g2.print(t, 1);')
    expect(exported).toContain('u8g2.drawStr(tempWidth, 44, "C");')
    expect(exported).toContain('Serial.println("debug");')
    const moved = updateImportedSource({
      ...project,
      elements: parsed.elements.map((element) => element.text === 'ALERT' ? { ...element, x: 60 } : element),
    })?.code
    expect(moved).toContain('u8g2.drawStr(60, 40, statusMsg.c_str());')
  })

  it('uses likely string examples from source comments for dynamic display values', () => {
    const source = [
      '#include <U8g2lib.h>',
      'U8G2_SSD1309_128X64_NONAME0_F_HW_I2C u8g2(U8G2_R0, U8X8_PIN_NONE);',
      'String alertReason = ""; // Тип тревоги (Ракети, Дрони, і т.д.)',
      'void callback(char* topic, byte* payload) {',
      '  String msg = "";',
      '  if (String(topic) == "esp/alert/reason") alertReason = msg;',
      '}',
      'void draw() {',
      '  u8g2.setFont(u8g2_font_5x7_tf);',
      '  u8g2.drawStr(0, 20, alertReason.c_str());',
      '}',
    ].join('\n')
    const parsed = parseDisplaySource(source, 'arduino')
    expect(parsed.elements.find((element) => element.dynamicVariables?.includes('alertReason'))?.text).toBe('Ракети, Дрони')
  })

  it('imports TFT_eSPI with landscape rotation, drawString, drawCentreString, and drawNumber', () => {
    const source = [
      '#include <TFT_eSPI.h>',
      'TFT_eSPI tft = TFT_eSPI();',
      'void loop() {',
      '  tft.setRotation(1);',
      '  tft.fillScreen(TFT_BLACK);',
      '  tft.setTextColor(TFT_YELLOW);',
      '  tft.drawString("Speed", 10, 10);',
      '  tft.drawCentreString("100", 160, 50, 4);',
      '  tft.drawNumber(42, 20, 80);',
      '}',
    ].join('\n')
    const parsed = parseDisplaySource(source, 'arduino')
    expect(parsed.renderer).toBe('tft-espi')
    expect(parsed.suggestedSize).toEqual({ width: 320, height: 240 })
    expect(parsed.warnings.join(' ')).not.toContain('команда(ы)')
    expect(parsed.elements).toHaveLength(4)
    expect(parsed.elements[0]).toMatchObject({ kind: 'rect', width: 320, height: 240, fill: '#000000' })
    expect(parsed.elements[1]).toMatchObject({ kind: 'text', x: 10, y: 10, text: 'Speed', fill: '#ffff00' })
    expect(parsed.elements[2]).toMatchObject({ kind: 'text', x: 160, y: 50, text: '100', textAnchor: 'middle' })
    expect(parsed.elements[3]).toMatchObject({ kind: 'text', x: 20, y: 80, text: '42' })
  })

  it('evaluates arithmetic expressions with macros in coordinates and dimensions', () => {
    const source = [
      '#define SCREEN_WIDTH 320',
      '#define SCREEN_HEIGHT 240',
      '#define PAD 10',
      'void loop() {',
      '  gfx->fillRect(PAD, PAD, SCREEN_WIDTH - PAD * 2, SCREEN_HEIGHT - PAD * 2, 0x07E0);',
      '}',
    ].join('\n')
    const parsed = parseDisplaySource(source, 'arduino')
    expect(parsed.elements[0]).toMatchObject({ kind: 'rect', x: 10, y: 10, width: 300, height: 220, fill: '#00ff00' })
  })
})
