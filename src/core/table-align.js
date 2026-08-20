/**
 * markdown 表格列宽对齐（写时 lint：只动空白，不动内容）。
 *
 * 设计约束：
 *   - 单元格内容逐字保留——解析按「未转义管道」切分并 trim，渲染再按
 *     显示宽度补空格；一轮下来每个单元格 trim 后与原文完全一致；
 *   - 转义管道 `\|` 视为单元格内的字面管道（拆分不破表，重渲染再转义）；
 *   - 代码围栏（``` / ~~~）内的表格样文本一律不动；
 *   - 缩进 4+ 的块视作代码块不动；同块各行缩进不一致（嵌套结构）不动；
 *   - 块内任一行列数不齐（手改坏）或第二行不是分隔线 → 不是规范表格，
 *     整块原样保留，绝不猜测。
 *
 * @module dsh-memoryleak/core/table-align
 */

/**
 * 东亚宽字符区段（Unicode EastAsianWidth W/F 的常用并集）。表格对齐按
 * **显示宽度**计（宽字符占 2 列），否则中文表头/单元格在等宽字体里每字
 * 差一截，对齐形同虚设。
 */
const WIDE_CHAR_RANGES = [
  [0x1100, 0x115f], // 谚文字母
  [0x2e80, 0x303e], // CJK 部首与符号
  [0x3041, 0x33ff], // 假名 / 注音 / CJK 兼容
  [0x3400, 0x4dbf], // CJK 扩展 A
  [0x4e00, 0x9fff], // CJK 统一表意
  [0xa000, 0xa4cf], // 彝文
  [0xa960, 0xa97f], // 谚文扩展 A
  [0xac00, 0xd7a3], // 谚文音节
  [0xf900, 0xfaff], // CJK 兼容表意
  [0xfe10, 0xfe19], // 竖排形式
  [0xfe30, 0xfe6f], // CJK 兼容形式 / 小形变体
  [0xff00, 0xff60], // 全角形式
  [0xffe0, 0xffe6], // 全角符号
  [0x20000, 0x2fffd], // CJK 扩展 B 起
  [0x30000, 0x3fffd],
]

/** 文本显示宽度（东亚宽字符计 2、组合记号计 0；按码点迭代，代理对安全）。 */
export function displayWidth(text) {
  let width = 0
  for (const char of String(text)) {
    const code = char.codePointAt(0)
    if (code >= 0x0300 && code <= 0x036f) continue
    width += WIDE_CHAR_RANGES.some(([lo, hi]) => code >= lo && code <= hi) ? 2 : 1
  }
  return width
}

/** 按显示宽度右补空格到指定列宽。 */
export function padToWidth(text, width) {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)))
}

/** 未转义管道切分（`\|` 是单元格内的字面管道）。 */
const CELL_SPLIT = /(?<!\\)\|/

/** 一行是否是表格行（容许统一前导空白；首尾都是未转义管道）。 */
function isTableRowLine(line) {
  const match = /^[\t ]*\|(.*)$/.exec(line)
  if (match === null) return false
  const rest = match[1]
  return rest.endsWith('|') && !rest.endsWith('\\|') && rest.length >= 2
}

/** 去掉行的前导空白（表格行内容部分）。 */
function rowBody(line) {
  return line.replace(/^[\t ]*/, '')
}

/**
 * 拆表格行为单元格数组：去首尾管道、按未转义管道切分、`\|` 还原为字面
 * 管道（渲染时统一重新转义，往返稳定）。
 */
function splitRowCells(line) {
  let body = line.slice(1)
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1)
  return body.split(CELL_SPLIT).map((cell) => cell.trim().replace(/\\\|/g, '|'))
}

/** 单元格渲染：字面管道转义（结构不破）。 */
function escapeCell(text) {
  return text.replace(/\|/g, '\\|')
}

/** 分隔线单元格解析：`:---` / `---:` / `:---:` / `---` → 冒号模式；其余 null。 */
function separatorPattern(cell) {
  const match = /^(:?)(-{2,})(:?)$/.exec(cell)
  if (match === null) return null
  return { left: match[1] === ':', right: match[3] === ':' }
}

/** 一行的引导空白（缩进）。 */
function indentOf(line) {
  return /^[\t ]*/.exec(line)[0]
}

/** 代码围栏（``` / ~~~，3 个以上，容许 3 以内缩进）。 */
const FENCE = /^\s{0,3}(`{3,}|~{3,})/

/**
 * 对齐一个表格块（首行表头、次行分隔线、其余数据行）。返回对齐后的行
 * 数组；不是规范表格（列数不齐 / 缩进不一致 / 缩进 ≥4 / 次行不是分隔线）
 * 返回 null（调用方整块原样保留）。
 */
function realignBlock(block) {
  if (block.length < 2) return null // 单行不成表（无分隔线可辨认）
  const indent = indentOf(block[0])
  if (indent.includes('\t') || indent.length >= 4) return null
  if (!block.every((line) => indentOf(line) === indent)) return null

  const cells = block.map((line) => splitRowCells(rowBody(line)))
  const columns = cells[0].length
  if (!cells.every((row) => row.length === columns)) return null
  const patterns = cells[1].map(separatorPattern)
  if (patterns.some((pattern) => pattern === null)) return null

  // 列宽：表头 + 数据行的最大显示宽度（分隔线自身不计宽），下限 3
  const widths = []
  for (let index = 0; index < columns; index += 1) {
    widths.push(
      Math.max(3, ...cells.map((row, rowIndex) => (rowIndex === 1 ? 0 : displayWidth(row[index])))),
    )
  }

  const lines = [cells[0], ...cells.slice(2)].map(
    (row) =>
      `${indent}| ${row.map((cell, index) => padToWidth(escapeCell(cell), widths[index])).join(' | ')} |`,
  )
  lines.splice(
    1,
    0,
    `${indent}| ${patterns.map((pattern, index) => `${pattern.left ? ':' : ''}${'-'.repeat(widths[index])}${pattern.right ? ':' : ''}`).join(' | ')} |`,
  )
  return lines
}

/**
 * 写时 lint：把文本里所有规范 markdown 表格的列宽重新对齐（每列取最大
 * 显示宽度补空格，分隔线随列宽伸展、保留对齐冒号）。单元格内容与表格
 * 之外的一切文本逐字保留；识别不了的块原样不动。幂等。
 *
 * @param {string} content
 * @returns {string}
 */
export function realignMarkdownTables(content) {
  const lines = String(content).split('\n')
  const out = []
  let fence = null // { char, length } 代码围栏内的行一律不动
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    const fenceMatch = FENCE.exec(line)
    if (fenceMatch !== null) {
      const char = fenceMatch[1][0]
      if (fence === null) fence = { char, length: fenceMatch[1].length }
      else if (char === fence.char && fenceMatch[1].length >= fence.length) fence = null
      out.push(line)
      index += 1
      continue
    }
    if (fence !== null || !isTableRowLine(line)) {
      out.push(line)
      index += 1
      continue
    }
    let end = index
    while (end < lines.length && isTableRowLine(lines[end])) end += 1
    const block = lines.slice(index, end)
    out.push(...(realignBlock(block) ?? block))
    index = end
  }
  return out.join('\n')
}
