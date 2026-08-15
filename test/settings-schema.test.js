import { describe, expect, it } from 'vitest'
import {
  NOTES_SETTINGS_DEFAULTS,
  NOTES_SETTINGS_NAMESPACE,
  notesSettingsSchema,
  resolveNotesSettings,
} from '../src/settings-schema.js'

describe('notes 设置命名空间', () => {
  it('空输入解析为冻结的默认值', () => {
    const resolved = resolveNotesSettings(undefined)
    expect(resolved).toEqual(NOTES_SETTINGS_DEFAULTS)
    expect(Object.isFrozen(resolved)).toBe(true)
  })

  it('部分覆盖与其余默认合并', () => {
    const resolved = resolveNotesSettings({ defaultStatus: 'done', extensions: ['md'] })
    expect(resolved.defaultStatus).toBe('done')
    expect(resolved.extensions).toEqual(['md'])
    expect(resolved.maxFiles).toBe(NOTES_SETTINGS_DEFAULTS.maxFiles)
    expect(resolved.excludeDirs).toEqual(NOTES_SETTINGS_DEFAULTS.excludeDirs)
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
    expect(() => resolveNotesSettings(raw)).toThrow(pattern)
  })

  it('schema 与默认值形状一致（防止字段漂移）', () => {
    expect(Object.keys(notesSettingsSchema({})).sort()).toEqual(Object.keys(NOTES_SETTINGS_DEFAULTS).sort())
  })

  it('命名空间名稳定（settings.yaml 段名）', () => {
    expect(NOTES_SETTINGS_NAMESPACE).toBe('notes')
  })
})
