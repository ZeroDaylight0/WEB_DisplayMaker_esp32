import { describe, expect, it } from 'vitest'
import { autoScale, screenStates } from './render'
import { parseDisplaySource } from './source-import'

describe('screen renders', () => {
  it('lists every distinct page and branch state once', () => {
    const source = [
      'display:',
      '  - platform: ssd1306_i2c',
      '    model: "SSD1306 128x64"',
      '    pages:',
      '      - id: page_main',
      '        lambda: |-',
      '          if (id(alarm)) {',
      '            it.print(0, 0, id(font), "ALARM");',
      '          } else {',
      '            it.print(0, 0, id(font), "OK");',
      '          }',
      '      - id: page_info',
      '        lambda: |-',
      '          it.print(0, 0, id(font), "INFO");',
    ].join('\n')
    const parsed = parseDisplaySource(source, 'esphome')
    const states = screenStates({ elements: parsed.elements, sourceBranchGroups: parsed.sourceBranchGroups, sourceBranchSelection: parsed.sourceBranchSelection })
    const visibleTexts = states.map((state) => parsed.elements
      .filter((element) => (element.sourceBranchPath ?? []).every(({ id, choice }) => (state.selection[id] ?? 0) === choice))
      .map((element) => element.text))
    expect(visibleTexts).toEqual([['ALARM'], ['INFO'], ['OK']])
    expect(states.map((state) => state.label)).toEqual(['Current state', 'page_info', 'page_main · else of if (id(alarm))'])
  })

  it('scales small screens up and keeps large ones near 640 px', () => {
    expect(autoScale(128, 64)).toBe(4)
    expect(autoScale(320, 240)).toBe(2)
    expect(autoScale(800, 480)).toBe(1)
  })
})
