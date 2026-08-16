import { describe, expect, it } from 'vitest'
import {
  MEMORYLEAK_SETTINGS_DEFAULTS,
  MEMORYLEAK_SETTINGS_NAMESPACE,
  memoryleakSettingsSchema,
  resolveMemoryleakSettings,
} from '../src/settings-schema.js'

describe('memoryleak 设置命名空间', () => {
  it('空输入解析为冻结的默认值', () => {
    const resolved = resolveMemoryleakSettings(undefined)
    expect(resolved).toEqual(MEMORYLEAK_SETTINGS_DEFAULTS)
    expect(Object.isFrozen(resolved)).toBe(true)
  })

  it('部分覆盖与其余默认合并', () => {
    const resolved = resolveMemoryleakSettings({ defaultStatus: 'done', extensions: ['md'] })
    expect(resolved.defaultStatus).toBe('done')
    expect(resolved.extensions).toEqual(['md'])
    expect(resolved.maxFiles).toBe(MEMORYLEAK_SETTINGS_DEFAULTS.maxFiles)
    expect(resolved.excludeDirs).toEqual(MEMORYLEAK_SETTINGS_DEFAULTS.excludeDirs)
  })

  it('日志默认值：daily 模式 + 空日志模板 + start/end 周志模板', () => {
    const defaults = resolveMemoryleakSettings(undefined)
    expect(defaults.journalMode).toBe('daily')
    expect(defaults.dailyTemplate).toBe('')
    expect(defaults.weeklyTemplate).toBe('start: {start}\nend: {end}\n')
    // 旧 settings.yaml（无新字段）解析得到新默认
    const legacy = resolveMemoryleakSettings({ defaultStatus: 'open' })
    expect(legacy.journalMode).toBe('daily')
    expect(legacy.weeklyTemplate).toContain('{start}')
  })

  it.each([
    [{ journalMode: 'monthly' }, /journalMode/],
    [{ dailyTemplate: 'x'.repeat(4097) }, /dailyTemplate/],
    [{ weeklyTemplate: 42 }, /weeklyTemplate/],
  ])('非法日志段 %o 在解析期崩溃', (raw, pattern) => {
    expect(() => resolveMemoryleakSettings(raw)).toThrow(pattern)
  })

  it.each([
    [{ defaultStatus: 'ANY' }, /defaultStatus/],
    [{ extensions: [] }, /extensions/],
    [{ extensions: ['md', '.bad'] }, /extensions/],
    [{ excludeDirs: ['a b'] }, /excludeDirs/],
    [{ maxFiles: 0 }, /maxFiles/],
    [{ maxFileBytes: 1 }, /maxFileBytes/],
    [{ maxItems: 10001 }, /maxItems/],
  ])('非法段 %o 在解析期崩溃（注册期 fail loud）', (raw, pattern) => {
    expect(() => resolveMemoryleakSettings(raw)).toThrow(pattern)
  })

  it('schema 与默认值形状一致（防止字段漂移）', () => {
    expect(Object.keys(memoryleakSettingsSchema({})).sort()).toEqual(Object.keys(MEMORYLEAK_SETTINGS_DEFAULTS).sort())
  })

  it('命名空间名稳定（settings.yaml 段名）', () => {
    expect(MEMORYLEAK_SETTINGS_NAMESPACE).toBe('memoryleak')
  })
})
