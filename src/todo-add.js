/**
 * 待办新增的交互流（/ml todo add 与 /ml mail todo <序号> 共用）：
 * 固定格式提问（类型 → 优先级 → [日期]），全程无 LLM；写入走与手写待办
 * 完全相同的结构化行 + 日志落盘。
 *
 * presetDate：/ml mail todo 场景下邮件里明说的期限——选 deadline 时直接
 * 采用（免日期问答）；选 sleep 仍会问唤醒日（语义不同）。
 *
 * 问题 id（ml-type / ml-prio / ml-date）是宿主与客户端的共享协议，web 端
 * 客户端半据此认领渲染组合卡与日期选择器——两处必须同步改。
 *
 * @module dsh-memoryleak/todo-add
 */
import { buildStructuredTodoLine } from './core/formats/memoryleak-todo.js'
import { recordTodoLine } from './journal.js'

const ML_TYPE_QUESTION_ID = 'ml-type'
const ML_PRIO_QUESTION_ID = 'ml-prio'
const ML_DATE_QUESTION_ID = 'ml-date'

/**
 * 走一遍待办新增交互流并写入 Vault。
 *
 * @param {object} input
 * @param {object} input.ctx 宿主上下文（userQuestions）
 * @param {object} input.agent 命令调用 agent（web Provider 依赖 agent.id 路由弹窗）
 * @param {AbortSignal} input.signal
 * @param {string} input.cwd Vault 绝对路径
 * @param {object} input.settings 生效设置段（journalMode / 模板）
 * @param {string} input.text 待办内容
 * @param {string | null} [input.presetDate] 预填期限（yyyy-mm-dd；仅 deadline 采用）
 * @returns {Promise<{ kind: 'success', text: string } | { kind: 'error', text: string }>}
 */
export async function runTodoAddFlow({ ctx, agent, signal, cwd, settings, text, presetDate = null }) {
  const userQuestions = ctx.get('userQuestions')
  if (userQuestions === undefined) {
    return { kind: 'error', text: '当前环境没有可用的交互提问界面，无法添加待办。' }
  }

  // 第一轮：类型 + 优先级（固定选项）。两问同一批发出：web 端客户端半
  // 认领渲染成一张组合卡（选完两项即自动提交），其余环境走通用逐题问答。
  const choice = await userQuestions.ask({
    agent,
    signal,
    questions: [
      {
        id: ML_TYPE_QUESTION_ID,
        header: 'MemoryLeak 待办',
        question: `待办「${text}」的类型？`,
        options: [
          { label: 'deadline', description: '有固定终结日期，到日截止' },
          { label: 'sleep', description: '先收起，到指定日期唤醒（唤醒前不出现在默认列表）' },
          { label: 'anytime', description: '随时搞一下，只记录' },
        ],
      },
      {
        id: ML_PRIO_QUESTION_ID,
        header: 'MemoryLeak 待办',
        question: '重要程度？',
        options: [
          { label: 'urgent', description: '紧急' },
          { label: 'medium', description: '中等' },
          { label: 'low', description: '低优先级' },
        ],
      },
    ],
  })
  const type = pick(choice, ML_TYPE_QUESTION_ID, ['deadline', 'sleep', 'anytime'])
  const prio = pick(choice, ML_PRIO_QUESTION_ID, ['urgent', 'medium', 'low'])
  if (type === null || prio === null) {
    return { kind: 'error', text: '选择无效：请从给出的选项中选取待办类型与重要程度。' }
  }

  // 第二轮：deadline / sleep 需要日期。问题 id 固定为 ML_DATE_QUESTION_ID：
  // web 端客户端半认领 composer 渲染日期选择器（日历 + 快捷键）；其余环境
  // 仍是自由输入。答案统一走 custom: yyyy-mm-dd，格式裁决留在宿主。
  // 例外：/ml mail todo 带 presetDate 且选 deadline → 邮件里明说的期限直接采用。
  let date = null
  let dateAuto = false
  if (type === 'deadline' || type === 'sleep') {
    if (type === 'deadline' && presetDate !== null) {
      date = presetDate
      dateAuto = true
    } else {
      const hint = type === 'deadline' ? '截止日期' : '唤醒日期'
      const answer = await userQuestions.ask({
        agent,
        signal,
        questions: [{ id: ML_DATE_QUESTION_ID, header: 'MemoryLeak 待办', question: `${hint}是哪天？（yyyy-mm-dd）` }],
      })
      const raw = (answer?.answers?.find((entry) => entry.id === ML_DATE_QUESTION_ID)?.custom ?? '').trim()
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        return { kind: 'error', text: `日期格式无效（收到 "${raw}"），需要 yyyy-mm-dd。待办未写入。` }
      }
      date = raw
    }
  }

  const todoLine = buildStructuredTodoLine({ type, date, prio, text })
  const record = await recordTodoLine({ cwd, settings, todoLine })
  const label = todoLabelOf(type, date, prio)
  const suffix = record.created ? '（新建文件）' : ''
  const autoNote = dateAuto ? '（期限取自 mail read 报告）' : ''
  return { kind: 'success', text: `已添加 → ${record.file} ## Todo${suffix}\n${todoLine}\n${label}${autoNote}` }
}

/** 从 ask 答案中取出一个合法选项值（label 精确匹配，防自定义文本注入）。 */
function pick(answer, id, allowed) {
  const selected = answer?.answers?.find((entry) => entry.id === id)?.selected ?? []
  const label = Array.isArray(selected) ? selected[0] : undefined
  return typeof label === 'string' && allowed.includes(label) ? label : null
}

/** 待办的人类可读摘要。 */
function todoLabelOf(type, date, prio) {
  const names = { deadline: '截止型', sleep: '睡眠型（到日唤醒）', anytime: '随时型' }
  const prioNames = { urgent: '紧急', medium: '中等', low: '低优先级' }
  const datePart = date === null ? '' : `，日期 ${date}`
  return `（${names[type]}${datePart}，${prioNames[prio]}）`
}
