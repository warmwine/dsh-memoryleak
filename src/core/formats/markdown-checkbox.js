/**
 * Markdown 复选框格式 —— V1 唯一内置的 TodoFormat Strategy。
 *
 * 匹配（单行，遵循用户给出的 V1 定义「形如 - [ ] xxxxx 的单行文本」）：
 *   - 列表标记 `-` / `*` / `+`（允许少量缩进）
 *   - 紧跟 `[ ]`、`[x]`、`[X]`
 *   - 后跟非空正文
 * 空复选框（`- [ ]` 后无正文）视为噪音，不匹配。
 *
 * 未来：AI 生成的特定格式（自定义围栏、元数据块……）实现同一 Strategy
 * 接口注册进 Registry 即可，扫描器一行不改（开闭原则）。
 *
 * @module dsh-notes/core/formats/markdown-checkbox
 */

/** 匹配一行 Markdown 任务列表项。 */
const MARKDOWN_CHECKBOX_PATTERN = /^[ \t]*(?:[-*+])[ \t]+\[([ xX])][ \t]+(\S.*)$/

/**
 * @typedef {object} TodoFormatMatch
 * @property {boolean} done
 * @property {string} text 已 trim 的正文
 * @property {string} raw 原始行
 */

/**
 * @typedef {object} TodoFormat
 * @property {string} id 唯一 id（^[a-z][a-z0-9-]*$）
 * @property {string} title 人类可读标题（设置窗口展示）
 * @property {(line: string) => TodoFormatMatch | null} parse 单行解析
 */

/** @satisfies {TodoFormat} */
export const markdownCheckboxFormat = Object.freeze({
  id: 'markdown-checkbox',
  title: 'Markdown 任务列表（- [ ] / - [x]）',
  /**
   * @param {string} line
   * @returns {TodoFormatMatch | null}
   */
  parse(line) {
    const match = MARKDOWN_CHECKBOX_PATTERN.exec(line)
    if (match === null) return null
    return Object.freeze({
      done: match[1] !== ' ',
      text: match[2].trim(),
      raw: line,
    })
  },
})
