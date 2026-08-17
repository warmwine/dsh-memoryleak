// dsh-memoryleak —— 浏览器半：设置窗口（GUI 设置面板里的「MemoryLeak」分区）。
//
// 与 dsh-ui-font 的字体设置页同款模式：settings.section 槽位注册一个分区。
// 页面通过同源 /api/memoryleak/* 读写宿主侧的 `memoryleak` 设置命名空间（持久化在
// ~/.dsh/settings.yaml），带乐观并发（expectedRevision / 409 重载提示）。
// 所有异步失败都显式渲染在页面上 —— 不吞错、不静默。
window.__ModuleLoader__.load({
  id: "dsh-memoryleak",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require("react");

    const API = "/api/memoryleak";
    const STATUS_OPTIONS = [
      ["open", "未完成"],
      ["done", "已完成"],
      ["all", "全部"],
    ];

    function isPlainObject(value) {
      return value !== null && typeof value === "object" && !Array.isArray(value);
    }

    async function apiGet(path) {
      const res = await fetch(API + path);
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.ok === false) throw new Error(body.error || "HTTP " + res.status);
      return body;
    }

    async function apiPost(path, payload) {
      const res = await fetch(API + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload === undefined ? {} : payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.ok === false) {
        const error = new Error(body.error || "HTTP " + res.status);
        error.status = res.status;
        throw error;
      }
      return body;
    }

    /** 把服务端 section 变成本地可编辑的表单草稿。 */
    function draftOf(section) {
      return {
        vault: typeof section.vault === "string" ? section.vault : "",
        extensionsText: (section.extensions || []).join(", "),
        excludeText: (section.excludeDirs || []).join("\n"),
        maxFiles: section.maxFiles,
        maxFileKb: Math.round(section.maxFileBytes / 1024),
        maxItems: section.maxItems,
        defaultStatus: section.defaultStatus,
        journalMode: section.journalMode === "weekly" ? "weekly" : "daily",
        dailyTemplate: typeof section.dailyTemplate === "string" ? section.dailyTemplate : "",
        weeklyTemplate: typeof section.weeklyTemplate === "string" ? section.weeklyTemplate : "",
      };
    }

    /** 把草稿变回合法 section；畸形输入在这里报人话错误。 */
    function sectionOf(draft) {
      const vault = draft.vault.trim();
      if (vault.length > 1024) throw new Error("Vault 目录路径过长（最多 1024 字符）");
      const extensions = draft.extensionsText.split(/[,\s]+/).map((s) => s.trim().toLowerCase().replace(/^\./, "")).filter((s) => s !== "");
      if (extensions.length === 0) throw new Error("至少需要一个扩展名（如 md）");
      for (const ext of extensions) {
        if (!/^[a-z0-9]+$/i.test(ext)) throw new Error("扩展名只允许字母数字：'" + ext + "'");
      }
      const excludeDirs = draft.excludeText.split(/\r?\n/).map((s) => s.trim()).filter((s) => s !== "");
      if (excludeDirs.length === 0) throw new Error("至少需要一个排除目录（如 node_modules）");
      for (const dir of excludeDirs) {
        if (!/^[^\\/:*?"<>|\s]+$/.test(dir)) throw new Error("目录名不能包含空白或路径分隔符：'" + dir + "'");
      }
      const maxFiles = Number(draft.maxFiles);
      const maxFileKb = Number(draft.maxFileKb);
      const maxItems = Number(draft.maxItems);
      if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 50000) throw new Error("最多文件数必须是 1..50000 的整数");
      if (!Number.isInteger(maxFileKb) || maxFileKb < 1 || maxFileKb > 10240) throw new Error("单文件上限必须是 1..10240 KB");
      if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 10000) throw new Error("最多条目必须是 1..10000 的整数");
      if (!STATUS_OPTIONS.some((option) => option[0] === draft.defaultStatus)) throw new Error("默认过滤词不合法");
      if (draft.journalMode !== "daily" && draft.journalMode !== "weekly") throw new Error("日志模式必须是 daily 或 weekly");
      if (typeof draft.dailyTemplate !== "string" || draft.dailyTemplate.length > 4096) throw new Error("日志模板必须是 4096 字符以内的文本");
      if (typeof draft.weeklyTemplate !== "string" || draft.weeklyTemplate.length > 4096) throw new Error("周志模板必须是 4096 字符以内的文本");
      return {
        vault,
        extensions,
        excludeDirs,
        maxFiles,
        maxFileBytes: maxFileKb * 1024,
        maxItems,
        defaultStatus: draft.defaultStatus,
        journalMode: draft.journalMode,
        dailyTemplate: draft.dailyTemplate,
        weeklyTemplate: draft.weeklyTemplate,
      };
    }

    function NotesSettingsPage({ pickDirectory }) {
      const [draft, setDraft] = React.useState(null);
      const [revision, setRevision] = React.useState(null);
      const [formats, setFormats] = React.useState([]);
      const [message, setMessage] = React.useState(null); // { kind: 'ok'|'error', text }
      const [busy, setBusy] = React.useState(false);

      const load = React.useCallback(() => {
        setBusy(true);
        Promise.all([apiGet("/settings"), apiGet("/formats")])
          .then((results) => {
            const settings = results[0];
            if (!isPlainObject(settings.section)) throw new Error("宿主返回的设置段格式错误");
            setDraft(draftOf(settings.section));
            setRevision(Number.isInteger(settings.revision) ? settings.revision : null);
            setFormats(Array.isArray(results[1].formats) ? results[1].formats : []);
            setMessage(null);
          })
          .catch((error) => setMessage({ kind: "error", text: "加载设置失败：" + error.message }))
          .then(() => setBusy(false));
      }, []);
      React.useEffect(() => { load(); }, [load]);

      const update = (patch) => setDraft((prev) => Object.assign({}, prev, patch));

      // 统一的保存通道：持久化一份完整 section（整段替换），409 自动拉新
      // revision 重试一次（设置页开着时 /ml init 会推进服务端 revision；
      // 整段替换语义下覆盖即用户意图，不能把表单刷回旧值）。
      const persist = (section, okText) => {
        setBusy(true);
        const submit = (expectedRevision) =>
          apiPost("/settings", Object.assign({ section }, expectedRevision === null || expectedRevision === undefined ? {} : { expectedRevision }));
        submit(revision)
          .catch((error) => {
            if (error.status !== 409) throw error;
            return apiGet("/settings").then((fresh) => submit(Number.isInteger(fresh.revision) ? fresh.revision : null));
          })
          .then((body) => {
            setDraft(draftOf(body.section));
            setRevision(Number.isInteger(body.revision) ? body.revision : revision);
            setMessage({ kind: "ok", text: okText });
          })
          .catch((error) => {
            setMessage({ kind: "error", text: "保存失败：" + error.message });
          })
          .then(() => setBusy(false));
      };

      const save = () => {
        let section;
        try {
          section = sectionOf(draft);
        } catch (error) {
          setMessage({ kind: "error", text: error.message });
          return;
        }
        persist(section, "已保存（全局与 Vault 内设置文件已同步）");
      };

      // 清除 = 立即生效：把当前表单（vault 置空）直接持久化，不等「保存」。
      const clearVault = () => {
        let section;
        try {
          section = sectionOf(Object.assign({}, draft, { vault: "" }));
        } catch (error) {
          setMessage({ kind: "error", text: "其他字段尚未合法，无法清除：" + error.message });
          return;
        }
        persist(section, "Vault 已清除（全局与 Vault 内设置文件已同步）");
      };

      const reset = () => {
        setBusy(true);
        apiPost("/settings/reset", {})
          .then((body) => {
            setDraft(draftOf(body.section));
            setRevision(Number.isInteger(body.revision) ? body.revision : revision);
            setMessage({ kind: "ok", text: "已恢复默认" });
          })
          .catch((error) => setMessage({ kind: "error", text: "重置失败：" + error.message }))
          .then(() => setBusy(false));
      };

      const [picking, setPicking] = React.useState(false);
      // 官方目录选择（ctx.workspaces.pickDirectory，跨平台由宿主组合的
      // directory-picker 后端处理）；取消返回 null 静默，失败提示。
      const browse = () => {
        setPicking(true);
        Promise.resolve()
          .then(() => pickDirectory())
          .then((path) => {
            if (typeof path === "string" && path !== "") {
              update({ vault: path });
              setMessage(null);
            }
          })
          .catch((e) => setMessage({ kind: "error", text: "打开目录选择器失败：" + (e instanceof Error ? e.message : String(e)) }))
          .then(() => setPicking(false));
      };

      const rowStyle = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "8px 0", borderBottom: "1px solid rgba(128,128,128,.15)" };
      const labelStyle = { flex: "0 0 auto" };
      const controlStyle = { flex: "1 1 auto", display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 8, minWidth: 0 };
      const hintStyle = { color: "rgba(128,128,128,.9)", fontSize: 12, margin: "2px 0 0" };
      const inputStyle = { width: 96 };

      const row = (label, control, hint) => React.createElement("div", { key: label, style: rowStyle },
        React.createElement("div", { style: { flex: "0 0 auto" } },
          React.createElement("span", null, label),
          hint === undefined ? null : React.createElement("p", { style: hintStyle }, hint)),
        React.createElement("div", { style: controlStyle }, control));

      if (draft === null) {
        return React.createElement("div", null,
          React.createElement("h3", { style: { margin: "4px 0 8px" } }, "MemoryLeak"),
          React.createElement("p", null, message === null ? "正在加载设置…" : message.text));
      }

      return React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
        React.createElement("h3", { style: { margin: "4px 0 8px" } }, "MemoryLeak"),
        React.createElement("div", { key: "Vault 目录", style: { padding: "8px 0", borderBottom: "1px solid rgba(128,128,128,.15)" } },
          React.createElement("span", null, "Vault 目录"),
          React.createElement("p", { style: hintStyle },
            "日志与待办的存放根目录；「浏览…」打开系统目录选择对话框，「清除」立即清空并保存（之后命令会提示先 /ml init）。保存时自动同步到该目录下的 .memoryleak.yaml（vault 路径除外）"),
          React.createElement("div", { style: { display: "flex", gap: 8, alignItems: "center", marginTop: 6 } },
            React.createElement("button", { onClick: browse, disabled: picking || busy, style: { flex: "0 0 auto" } }, picking ? "打开中…" : "浏览…"),
            React.createElement("input", {
              value: draft.vault,
              onChange: (event) => update({ vault: event.target.value }),
              placeholder: "E:\\notes\\MLeak（留空 = 未初始化）",
              style: { flex: "1 1 auto", minWidth: 0, width: "auto", fontVariantNumeric: "tabular-nums" },
            }),
            React.createElement("button", {
              onClick: clearVault,
              disabled: busy || draft.vault.trim() === "",
              style: { flex: "0 0 auto" },
            }, busy ? "处理中…" : "清除"))),
        row("默认过滤",
          React.createElement("select", {
            value: draft.defaultStatus,
            onChange: (event) => update({ defaultStatus: event.target.value }),
            style: { minWidth: 140 },
          }, STATUS_OPTIONS.map((option) => React.createElement("option", { key: option[0], value: option[0] }, option[1]))),
          "/ml todo list 未指定状态时使用的过滤"),
        row("扫描扩展名",
          React.createElement("input", {
            value: draft.extensionsText,
            onChange: (event) => update({ extensionsText: event.target.value }),
            placeholder: "md, markdown",
            style: { minWidth: 220 },
          }),
          "逗号或空格分隔；只扫描这些扩展名的文件"),
        row("排除目录",
          React.createElement("textarea", {
            value: draft.excludeText,
            onChange: (event) => update({ excludeText: event.target.value }),
            rows: 5,
            style: { minWidth: 240, fontVariantNumeric: "tabular-nums" },
          }),
          "每行一个目录名（按名字精确匹配，任意层级生效）"),
        row("最多文件数",
          React.createElement("input", {
            type: "number", min: 1, max: 50000, step: 1,
            value: draft.maxFiles,
            onChange: (event) => update({ maxFiles: event.target.value === "" ? 0 : Number(event.target.value) }),
            style: inputStyle,
          }),
          "单次扫描考虑的文件上限，超出即截断"),
        row("单文件上限 (KB)",
          React.createElement("input", {
            type: "number", min: 1, max: 10240, step: 1,
            value: draft.maxFileKb,
            onChange: (event) => update({ maxFileKb: event.target.value === "" ? 0 : Number(event.target.value) }),
            style: inputStyle,
          }),
          "超过此大小的文件跳过并在结果中注明"),
        row("最多条目",
          React.createElement("input", {
            type: "number", min: 1, max: 10000, step: 1,
            value: draft.maxItems,
            onChange: (event) => update({ maxItems: event.target.value === "" ? 0 : Number(event.target.value) }),
            style: inputStyle,
          }),
          "单次扫描收集的待办条数上限"),
        row("日志模式",
          React.createElement("select", {
            value: draft.journalMode,
            onChange: (event) => update({ journalMode: event.target.value }),
            style: { minWidth: 180 },
          },
            React.createElement("option", { key: "daily", value: "daily" }, "日志（yyyy-mm-dd.md）"),
            React.createElement("option", { key: "weekly", value: "weekly" }, "周志（yyyyWww.md）")),
          "/ml <文本> 写入哪类文件；不存在时按模板新建"),
        row("日志模板",
          React.createElement("textarea", {
            value: draft.dailyTemplate,
            onChange: (event) => update({ dailyTemplate: event.target.value }),
            rows: 3,
            style: { minWidth: 240, fontVariantNumeric: "tabular-nums" },
          }),
          "新建日志文件的初始内容；占位符 {date} {week}"),
        row("周志模板",
          React.createElement("textarea", {
            value: draft.weeklyTemplate,
            onChange: (event) => update({ weeklyTemplate: event.target.value }),
            rows: 4,
            style: { minWidth: 240, fontVariantNumeric: "tabular-nums" },
          }),
          "新建周志文件的初始内容；占位符 {start} {end} {week}"),
        React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12, gap: 8 } },
          React.createElement("span", {
            style: message === null ? { display: "none" } : {
              color: message.kind === "ok" ? "rgba(46,125,50,.95)" : "rgba(198,40,40,.95)",
              fontSize: 12,
            },
          }, message === null ? "" : message.text),
          React.createElement("div", { style: { display: "flex", gap: 8 } },
            React.createElement("button", { onClick: reset, disabled: busy }, "恢复默认"),
            React.createElement("button", { onClick: save, disabled: busy }, busy ? "处理中…" : "保存"))),
        React.createElement("div", { style: { marginTop: 12, borderTop: "1px solid rgba(128,128,128,.15)", paddingTop: 8 } },
          React.createElement("span", { style: hintStyle },
            "已注册的待办格式（可扩展）：" + (formats.length === 0 ? "加载中…" : formats.map((f) => f.id).join("、")),
            formats.length > 0 ? " · " + formats.length + " 个" : ""),
          formats.map((f) => React.createElement("p", { key: f.id, style: hintStyle }, f.id + " — " + f.title + "（优先级 " + f.priority + "）"))));
    }

    /* ---------------- /ml 命令的默认展开视图 ----------------
       conversation.chat.commandview 按命令名派发；默认回退是折叠的
       GenericCommandCard（需点击展开）。这里用「默认展开」的排版替换：
       小字命令回显 + 主题令牌的 pre 块，直接作为会话内容呈现。
       node: { name, args, outcome: null | { kind, text? } }
       （/ml 记录与 /ml todo 两个家族共用此视图。）
       已知边界：blank 会话（从未发过 LLM 消息）不挂载时间线，命令卡片
       无论自定义还是通用都不显示 —— DSH 上游设计，见 README「已知行为」。 */
    /* todo list 的结构化渲染：把条目行拆成 前缀（序号+状态+徽章）与 正文
       两段。正文自然换行并与自身左对齐 —— 悬挂缩进的 CSS 等价实现（宿主
       文本无法预知客户端换行宽度，纯空格缩进在 pre-wrap 下不可对齐）。
       宿主输出的纯文本格式保持不变，TUI/纯文本环境仍是原排版。 */
    const TODO_ITEM_LINE = /^\s*(\d+)\.\s*([☐☑])(?:\s+(\[[^\]]+\]))?\s*(.*)$/;

    function MlTodoListBody({ text, cardStyle }) {
      const lines = String(text).split("\n");
      return React.createElement("div", {
        style: { ...cardStyle, display: "flex", flexDirection: "column", lineHeight: 1.7 },
      }, lines.map((line, index) => {
        const match = TODO_ITEM_LINE.exec(line);
        if (match === null) {
          // 摘要 / 分隔线 / 分组头 / 警告等：原样保留（pre-wrap 保空格）
          return React.createElement("div", {
            key: index,
            style: { whiteSpace: "pre-wrap", overflowWrap: "break-word" },
          }, line === "" ? " " : line);
        }
        const indexText = match[1];
        const glyph = match[2];
        const badge = match[3];
        const content = match[4];
        const done = glyph === "☑";
        return React.createElement("div", {
          key: index,
          style: { display: "flex", alignItems: "flex-start", gap: "8px" },
        },
          React.createElement("span", {
            style: { flex: "0 0 auto", whiteSpace: "pre", color: "var(--dsw-alias-label-tertiary)" },
          }, `${indexText}. `.padStart(4) + glyph + (badge === undefined ? "" : ` ${badge}`) + " "),
          React.createElement("span", {
            style: {
              flex: "1 1 auto",
              minWidth: 0,
              whiteSpace: "pre-wrap",
              overflowWrap: "break-word",
              color: done ? "var(--dsw-alias-label-tertiary)" : "var(--dsw-alias-label-primary)",
              textDecoration: done ? "line-through" : "none",
            },
          }, content === "" ? " " : content));
      }));
    }

    function MlCommandView({ node }) {
      const outcome = node !== null && typeof node === "object" && node.outcome !== undefined ? node.outcome : null;
      const header = "/ml" + (typeof node?.args === "string" && node.args !== "" ? node.args : "");
      const captionStyle = {
        color: "var(--dsw-alias-label-tertiary)",
        fontSize: 12,
        margin: "0 0 2px 4px",
      };
      if (outcome === null) {
        return React.createElement("div", null,
          React.createElement("div", { style: captionStyle }, header + " · 正在执行…"));
      }
      const text = typeof outcome.text === "string" ? outcome.text : "";
      const isError = outcome.kind === "error";
      const cardStyle = {
        border: "1px solid var(--dsw-alias-border-l1)",
        background: "var(--dsw-alias-markdown-code-block)",
        color: isError ? "var(--dsw-alias-state-error-primary)" : "var(--dsw-alias-label-primary)",
        font: "var(--dsw-font-markdown-code-block-small)",
        whiteSpace: "pre-wrap",
        borderRadius: 12,
        padding: "12px 16px",
        margin: 0,
      };
      // todo list 输出（摘要行固定以「待办 」开头）走结构化渲染，其余保持 pre
      const body = !isError && text.startsWith("待办 ")
        ? React.createElement(MlTodoListBody, { text, cardStyle })
        : React.createElement("pre", { style: cardStyle }, text === "" ? "（无输出）" : text);
      return React.createElement("div", null,
        React.createElement("div", { style: captionStyle }, header),
        body);
    }

    /* ---------------- /ml 快速打开（popupSelect 壳）----------------
       从命令菜单选中 /ml 时，不再直接占用输入框，而是在输入框上方弹出
       「快速打开」选择卡（官方 popupSelect 壳）：自带搜索框本地过滤，
       ↑↓ 移动高亮（默认第 1 项，紧贴搜索框），Enter 选中，Esc 关闭，
       点击卡外任意处关闭。选中即执行 /ml view <文件>（走正常命令面，
       零 token）。候选来自宿主 /api/memoryleak/files（按设置的 Vault
       定位，与命令同一根目录），新文件在前。Tab 补全由上游壳决定。
       候选拉取失败（如 Vault 未设置）一律返回空列表 —— 快速打开只是
       便利层，绝不能拦住命令本身：面板空着，用户手输 /ml 回车照常
       走 vault 引导。 */
    function mlQuickOpenSpec(ctx) {
      return {
        async options(_session, signal) {
          let body = {};
          let unreachable = false;
          try {
            const res = await fetch(`${API}/files?limit=50`, signal !== null && signal !== undefined ? { signal } : undefined)
            body = await res.json().catch(() => ({}))
            if (!res.ok || body.ok === false) unreachable = true;
          } catch {
            unreachable = true;
          }
          // Vault 未设置 / 服务不可达：给「初始化」条目，选中即执行
          // /ml init（唯一严格的目录设置入口）。
          if (unreachable) {
            return [{ id: "__ml_setup__", label: "初始化 Vault 目录…（/ml init）", detail: "尚未设置存放目录" }];
          }
          const files = Array.isArray(body.files) ? body.files : []
          if (files.length === 0) return []
          return files.map((file) => ({
            id: file.name,
            label: file.name,
            detail: `${Math.max(1, Math.round(file.bytes / 1024))} KB`,
          }))
        },
        async onSelect(option, session) {
          const sessionId = session !== null && typeof session === "object" ? session.sessionId : undefined
          if (typeof sessionId !== "string" || sessionId === "") throw new Error("无法定位当前会话")
          const line = option.id === "__ml_setup__" ? "/ml init" : `/ml view ${option.id}`
          const result = await ctx.remote.commands.execute(sessionId, line)
          if (!result.ok) throw new Error(`执行失败：${result.error?.message ?? result.error?.code ?? "未知错误"}`)
        },
      }
    }

    /* ---------------- /ml view 实时候选卡（combobox 模式）----------------
       官方 popupSelect 只在「从命令菜单选中 /ml」时触发；手动输入
       `/ml view <片段>` 不经过菜单。此卡监听输入草稿：一旦匹配
       /^\/ml\s+(view|v)\b/ 就在输入框上方弹出实时候选（焦点留在输入框，
       继续打字继续过滤）。键盘在 capture 阶段拦截：
         ↑↓ 切换高亮（默认第 1 项，紧贴提示行）
         Tab  把高亮文件名补全进草稿
         Enter 直接执行 /ml view <高亮文件>（成功后清空输入框）
         Esc  关闭（草稿变化后重新触发）
       候选来自宿主 /api/memoryleak/files（按会话缓存 5s），本地子序列
       过滤排序 —— 最终裁决仍在宿主（Enter 未拦截时走正常命令提交）。 */
    const QUICK_OPEN_RE = /^\/ml[ \t]+(?:view|v)(?:[ \t]+(\S*))?[ \t]*$/i;
    const QUICK_OPEN_CACHE = new Map(); // sessionId → { at, names }
    const QUICK_OPEN_TTL = 5000;
    const QUICK_OPEN_MAX_ROWS = 12;

    /** 轻量子序列评分（client 内联版；边界+3/连续+4/跳过-0.1，与宿主 core/fuzzy 同语义）。 */
    function quickScore(name, query) {
      const n = String(name ?? "").toLowerCase();
      const q = String(query ?? "").toLowerCase();
      if (q === "") return 0;
      if (q.length > n.length) return null;
      let best = -Infinity;
      // 单查询串的贪心前向对齐已足够排序提示用途；最优 DP 在宿主侧。
      let qi = 0;
      let score = 0;
      let prevHit = -2;
      for (let ni = 0; ni < n.length && qi < q.length; ni += 1) {
        if (n.charAt(ni) !== q.charAt(qi)) {
          score -= 0.1;
          continue;
        }
        score += 1;
        if (ni === 0 || "-_./".includes(n.charAt(ni - 1))) score += 3;
        if (ni === prevHit + 1) score += 4;
        prevHit = ni;
        qi += 1;
      }
      if (qi < q.length) return null;
      return score * 10 - n.length;
    }

    function QuickOpenOverlay({ shell, sessionId, execute }) {
      const state = React.useSyncExternalStore(
        (fn) => shell.state.subscribe(fn),
        () => shell.state.getSnapshot()
      );
      const draft = state !== null && typeof state === "object" && typeof state.draft === "string" ? state.draft : "";
      const match = QUICK_OPEN_RE.exec(draft);
      const fragment = match === null ? "" : (match[1] ?? "");
      const open = match !== null;

      const [names, setNames] = React.useState(null); // null = 加载中
      const [currentFile, setCurrentFile] = React.useState(null); // 当前日志/周志（空片段时置顶）
      const [error, setError] = React.useState(null);
      const [active, setActive] = React.useState(0);
      const [dismissedDraft, setDismissedDraft] = React.useState(null);
      const dismissed = dismissedDraft !== null && dismissedDraft === draft;
      const visible = open && !dismissed;

      React.useEffect(() => {
        if (!visible) return;
        let cancelled = false;
        const cached = QUICK_OPEN_CACHE.get(sessionId);
        if (cached !== undefined && Date.now() - cached.at < QUICK_OPEN_TTL) {
          setNames(cached.names);
          setCurrentFile(cached.current ?? null);
          setError(null);
          return undefined;
        }
        setNames(null);
        setCurrentFile(null);
        setError(null);
        fetch(`${API}/files?limit=50`)
          .then((res) => res.json())
          .then((body) => {
            if (cancelled) return;
            if (body.ok !== true) throw new Error(body.error || "HTTP " + res.status);
            const list = Array.isArray(body.files) ? body.files.map((file) => file.name) : [];
            const current = typeof body.current === "string" ? body.current : null;
            QUICK_OPEN_CACHE.set(sessionId, { at: Date.now(), names: list, current });
            setNames(list);
            setCurrentFile(current);
          })
          .catch((e) => {
            if (!cancelled) setError(e instanceof Error ? e.message : String(e));
          });
        return () => { cancelled = true; };
      }, [visible, sessionId]);

      const rows = React.useMemo(() => {
        if (names === null) return [];
        if (fragment === "") {
          // 空片段：当前日志/周志置顶（不存在也显示 —— 选中即经宿主按模板创建路径查看）
          const rest = names.filter((name) => name !== currentFile)
          const head = currentFile === null ? [] : [{ name: currentFile, score: 0, current: true }]
          return [...head, ...rest.slice(0, Math.max(0, QUICK_OPEN_MAX_ROWS - head.length))]
        }
        const scored = [];
        for (const name of names) {
          const score = quickScore(name, fragment);
          if (score !== null) scored.push({ name, score });
        }
        scored.sort((left, right) => (right.score - left.score) || (left.name < right.name ? -1 : 1));
        return scored.slice(0, QUICK_OPEN_MAX_ROWS);
      }, [names, fragment, currentFile]);

      React.useEffect(() => { setActive(0); }, [fragment]);

      const pick = React.useCallback((name) => {
        execute(sessionId, `/ml view ${name}`).then(() => {
          shell.setDraft("");
        }, (e) => {
          shell.notify("error", e instanceof Error ? e.message : String(e));
        });
      }, [sessionId, shell, execute]);

      React.useEffect(() => {
        if (!visible || rows.length === 0) return undefined;
        const onKey = (ev) => {
          if (ev.isComposing === true) return;
          const target = ev.target;
          const tag = target !== null && typeof target === "object" ? target.tagName : "";
          if (tag !== "TEXTAREA" && tag !== "INPUT") return;
          if (ev.key === "ArrowDown") {
            ev.preventDefault(); ev.stopPropagation();
            setActive((index) => Math.min(index + 1, rows.length - 1));
          } else if (ev.key === "ArrowUp") {
            ev.preventDefault(); ev.stopPropagation();
            setActive((index) => Math.max(index - 1, 0));
          } else if (ev.key === "Tab") {
            ev.preventDefault(); ev.stopPropagation();
            shell.setDraft(`/ml view ${rows[active].name}`);
          } else if (ev.key === "Enter") {
            ev.preventDefault(); ev.stopPropagation();
            pick(rows[active].name);
          } else if (ev.key === "Escape") {
            ev.preventDefault(); ev.stopPropagation();
            setDismissedDraft(draft);
          }
        };
        document.addEventListener("keydown", onKey, true);
        return () => document.removeEventListener("keydown", onKey, true);
      }, [visible, rows, active, shell, draft, pick]);

      if (!visible) return null;

      const hint = "↑↓ 选择 · Tab 补全 · Enter 打开 · Esc 关闭";
      // 定位对齐官方 MenuView：overlay 锚点是 display:contents，卡片必须
      // 绝对定位在 composer 容器内、从输入框下沿向上弹（bottom:100%）。
      const cardStyle = {
        position: "absolute",
        bottom: "calc(100% + 4px)",
        left: 0,
        right: 0,
        maxWidth: "min(537px, 100%)",
        zIndex: 100,
        border: "1px solid var(--dsw-alias-border-inverted)",
        background: "var(--dsw-specific-menu)",
        borderRadius: 12,
        maxHeight: 280,
        overflowY: "auto",
        boxShadow: "var(--dsw-shadow-lv3)",
        padding: 4,
        display: "flex",
        flexDirection: "column",
        "--dsh-scrollbar-thumb": "var(--dsw-alias-scrollbar-bg-l2)",
        "--dsh-scrollbar-thumb-hover": "var(--dsw-alias-scrollbar-hover-l2)",
      };
      const hintStyle = {
        color: "var(--dsw-alias-label-tertiary)",
        fontSize: 12,
        lineHeight: "16px",
        padding: "8px 10px 6px",
        borderBottom: "1px solid var(--dsw-alias-border-l1)",
        flex: "0 0 auto",
      };
      const rowStyle = (isActive) => ({
        display: "flex",
        justifyContent: "space-between",
        gap: 8,
        alignItems: "center",
        minHeight: 36,
        padding: "8px 10px",
        fontSize: 14,
        lineHeight: "22px",
        cursor: "pointer",
        width: "100%",
        textAlign: "left",
        background: isActive ? "var(--dsw-alias-interactive-bg-hover)" : "transparent",
        border: "none",
        borderRadius: 10,
        color: "var(--dsw-alias-label-primary)",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      });
      const metaStyle = { color: "var(--dsw-alias-label-tertiary)", fontSize: 12, lineHeight: "16px", flex: "0 0 auto" };

      const statusRow = (text, isError) => React.createElement("div", {
        style: {
          color: isError ? "var(--dsw-alias-state-error-primary)" : "var(--dsw-alias-label-dimmed)",
          fontSize: 14,
          lineHeight: "22px",
          minHeight: 40,
          display: "flex",
          alignItems: "center",
          padding: "8px 10px",
        },
      }, text);

      let body;
      if (error !== null) {
        body = statusRow(`候选加载失败：${error}`, true);
      } else if (names === null) {
        body = statusRow("正在加载候选…");
      } else if (rows.length === 0) {
        body = statusRow(`没有匹配「${fragment}」的文件（回车将按宿主解析执行）`);
      } else {
        body = rows.map((row, index) => React.createElement("div", {
          key: row.name,
          style: rowStyle(index === active),
          role: "option",
          "aria-selected": index === active,
          onMouseDown: (ev) => { ev.preventDefault(); pick(row.name); },
          onMouseEnter: () => { setActive(index); },
        },
          React.createElement("span", null,
            row.name,
            row.current === true ? React.createElement("span", {
              style: { color: "var(--dsw-alias-label-primary-bluish)", fontSize: 11, marginLeft: 8, flex: "0 0 auto" },
            }, "· 当前") : null),
          React.createElement("span", { style: metaStyle }, String(index + 1))));
      }
      return React.createElement("div", { style: cardStyle, "data-ml-quick-open": "1" },
        React.createElement("div", { style: hintStyle }, hint),
        body);
    }

    /* ---------------- /ml todo add 提问轮接管（composer chain）----------------
       宿主提问轮的问题 id 固定为 ml-type / ml-prio / ml-date（src/index.js
       的 ML_*_QUESTION_ID，两处必须同步改）。conversation.composer 是
       chain 槽：下面的 select 以更低 priority（更先试）认领，且只认领
       本插件形态的请求 ——
         · 首轮（ml-type + ml-prio 两问同批）→ MlTodoIntroComposer：两问
           同卡展示，各选一项，第二项选中的瞬间整批自动提交（省掉通用
           UI 最后那下「提交」点击）；deadline/sleep 提交后日期轮接管。
         · 日期轮（单问 ml-date）→ MlDateComposer：日历 + 快捷键。
       其余请求一律返回 null 放行给通用问题 UI。答案走与通用 UI 完全
       相同的 respond 协议（选项 selected、日期 custom: yyyy-mm-dd），
       裁决仍在宿主 —— 只是换皮，无此 UI 的环境（TUI/原生）依旧可用。
       快捷键语义（周一起始）：今天=当日；明天=+1 天；本周=本周日；
       本月=当月最后一天。按客户端本地时区解析，与手输一致。 */

    const ML_TYPE_QUESTION_ID = "ml-type";
    const ML_PRIO_QUESTION_ID = "ml-prio";
    const ML_DATE_QUESTION_ID = "ml-date";
    const ML_VAULT_QUESTION_ID = "ml-vault";
    const ML_WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

    // 悬停/禁用态用小样式表（内联样式做不了 :hover）；与 dsh 官方插件
    // 同款注入方式：幂等、随模块加载一次性挂上。日期选择器与首问组合卡
    // 共用这一份。
    if (typeof document !== "undefined" && document.querySelector("style[data-ml-date-picker]") === null) {
      const mlDateStyle = document.createElement("style");
      mlDateStyle.dataset.mlDatePicker = "1";
      mlDateStyle.textContent = [
        ".ml-date-shortcut,.ml-date-day,.ml-date-nav,.ml-date-cancel,.ml-intro-option,.ml-intro-cancel{transition:background .12s ease}",
        ".ml-date-shortcut:hover:not(:disabled),.ml-date-day:hover:not(:disabled),.ml-date-nav:hover:not(:disabled),.ml-date-cancel:hover:not(:disabled),.ml-intro-option:hover:not(:disabled),.ml-intro-cancel:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
        ".ml-date-shortcut:disabled,.ml-date-day:disabled,.ml-date-nav:disabled,.ml-date-cancel:disabled,.ml-intro-option:disabled,.ml-intro-cancel:disabled{cursor:default;opacity:.5}",
        ".ml-date-shortcut:focus-visible,.ml-date-day:focus-visible,.ml-date-nav:focus-visible,.ml-date-cancel:focus-visible,.ml-intro-option:focus-visible,.ml-intro-cancel:focus-visible{outline:1px solid var(--dsw-alias-label-primary-bluish);outline-offset:1px}",
      ].join("\n");
      document.head.appendChild(mlDateStyle);
    }

    /** 当日零点（本地时区）。 */
    function mlStartOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
    /** 加 n 天（跨月/跨年由 Date 自带进位处理）。 */
    function mlAddDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
    /** 本周最后一天（周一起始，止于周日）。 */
    function mlEndOfWeek(d) { return mlAddDays(d, 6 - ((d.getDay() + 6) % 7)); }
    /** 本月最后一天。 */
    function mlEndOfMonth(d) { return new Date(d.getFullYear(), d.getMonth() + 1, 0); }
    /** Date → 'yyyy-mm-dd'（本地时区，与宿主校验的格式一致）。 */
    function mlIsoDate(d) {
      return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    }
    /** Date → 'M-dd'（快捷键角标用）。 */
    function mlShortDate(d) { return (d.getMonth() + 1) + "-" + String(d.getDate()).padStart(2, "0"); }

    /* 接管卡共用壳样式：排版令牌对齐官方 QuestionComposer 的几何（同槽
       同款卡片），日期选择器与首问组合卡共用，主体各自定义。 */
    const ML_FRAME_STYLE = {
      padding: "6px calc(var(--dsh-composer-side-clearance) + 16px) 10px",
      display: "flex",
      justifyContent: "center",
    };
    const ML_CARD_STYLE = {
      width: "100%",
      maxWidth: "var(--dsh-chat-content-width)",
      border: "1px solid var(--dsw-alias-border-l2-darkmode-thin)",
      background: "var(--dsw-specific-input-major)",
      boxShadow: "var(--dsw-shadow-l2)",
      color: "var(--dsw-alias-label-primary)",
      borderRadius: 20,
      display: "flex",
      flexDirection: "column",
      overflow: "hidden",
      padding: "0 0 10px",
    };
    const ML_HEADER_STYLE = {
      flexShrink: 0,
      display: "flex",
      justifyContent: "space-between",
      alignItems: "flex-start",
      gap: 16,
      padding: "16px 16px 0 24px",
    };
    const ML_EYEBROW_STYLE = { color: "var(--dsw-alias-label-tertiary)", marginBottom: 5, fontSize: 11, lineHeight: "16px" };
    const ML_TITLE_STYLE = { margin: 0, fontSize: 16, fontWeight: 500, lineHeight: "22px" };
    const ML_CLOSE_BTN_STYLE = {
      width: 24, height: 24, display: "grid", placeItems: "center",
      color: "var(--dsw-alias-label-tertiary)", cursor: "pointer",
      background: "transparent", border: "none", borderRadius: 999, padding: 0,
      fontSize: 14, lineHeight: 1,
    };
    const ML_BODY_STYLE = {
      overscrollBehavior: "contain",
      display: "flex", flexDirection: "column",
      flex: "auto", minHeight: 0, overflowY: "auto",
      padding: "10px 16px 0",
    };
    const ML_FOOTER_STYLE = {
      flexShrink: 0, display: "flex", justifyContent: "space-between", alignItems: "center",
      gap: 12, padding: "8px 16px 2px 24px",
    };
    const ML_HINT_STYLE = { color: "var(--dsw-alias-label-tertiary)", fontSize: 12, lineHeight: "16px", minWidth: 0 };
    const ML_ERROR_STYLE = { color: "var(--dsw-alias-state-error-primary)", fontSize: 12, lineHeight: "16px", minWidth: 0 };
    const ML_CANCEL_BTN_STYLE = {
      flexShrink: 0, minHeight: 28, padding: "0 12px", cursor: "pointer",
      color: "var(--dsw-alias-label-secondary)", background: "transparent",
      border: "none", borderRadius: 8, fontSize: 13, lineHeight: "20px",
    };

    /** chain select：只认领「单问题且 id === ml-date」的 question 交互，其余放行。 */
    function mlSelectDateQuestion(owner) {
      const interactions = owner !== null && typeof owner === "object" && Array.isArray(owner.interactions) ? owner.interactions : [];
      for (const interaction of interactions) {
        if (interaction === null || typeof interaction !== "object" || interaction.kind !== "question") continue;
        const questions = interaction.payload !== null && typeof interaction.payload === "object" && Array.isArray(interaction.payload.questions)
          ? interaction.payload.questions
          : [];
        if (questions.length === 1 && questions[0] !== null && typeof questions[0] === "object" && questions[0].id === ML_DATE_QUESTION_ID) {
          return interaction;
        }
      }
      return null;
    }

    function MlDateComposer({ matched }) {
      const wait = matched;
      const questions = wait !== null && typeof wait === "object" && wait.payload !== null && typeof wait.payload === "object" && Array.isArray(wait.payload.questions)
        ? wait.payload.questions
        : [];
      const question = questions[0];
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);
      const today = React.useMemo(() => mlStartOfDay(new Date()), []);
      const [view, setView] = React.useState(() => {
        const now = new Date();
        return { year: now.getFullYear(), month: now.getMonth() };
      });

      // 与通用问题 UI（PendingQuestion）同一 respond 协议：成功送整批答案，
      // 取消送 cancelled 错误；回执被拒不吞，显示在页脚。
      const settle = (send) => {
        setBusy(true);
        setError(null);
        send().catch((cause) => {
          setBusy(false);
          setError(cause instanceof Error ? cause.message : String(cause));
        });
      };
      const answerWith = (date) => settle(async () => {
        const receipt = await wait.respond({
          ok: true,
          value: {
            sessionId: wait.sessionId,
            answer: { answers: [{ id: question.id, selected: [], custom: mlIsoDate(date) }] },
          },
        });
        if (receipt !== null && typeof receipt === "object" && receipt.accepted === false) {
          throw new Error("答案被宿主拒绝：" + String(receipt.reason ?? "未知原因"));
        }
      });
      const cancelWait = () => settle(async () => {
        const receipt = await wait.respond({
          ok: false,
          error: { code: "cancelled", message: "the user closed this question request", details: {} },
        });
        if (receipt !== null && typeof receipt === "object" && receipt.accepted === false) {
          throw new Error("取消被宿主拒绝：" + String(receipt.reason ?? "未知原因"));
        }
      });

      // Esc 取消（capture 拦截，与实时候选卡同款；IME 组合中不拦）。
      React.useEffect(() => {
        if (busy) return undefined;
        const onKey = (ev) => {
          if (ev.key !== "Escape" || ev.isComposing === true) return;
          ev.preventDefault();
          ev.stopPropagation();
          cancelWait();
        };
        document.addEventListener("keydown", onKey, true);
        return () => document.removeEventListener("keydown", onKey, true);
      });

      const shortcuts = [
        { key: "today", label: "今天", date: today },
        { key: "tomorrow", label: "明天", date: mlAddDays(today, 1) },
        { key: "week", label: "本周", date: mlEndOfWeek(today) },
        { key: "month", label: "本月", date: mlEndOfMonth(today) },
      ];

      // 兜底：载体形态不符（理论上 select 已拦）不渲染 —— 让位通用 UI
      // 兜底比渲染一个空壳更安全。放在全部 hook 之后，保证 hook 数稳定。
      if (wait === null || typeof wait !== "object" || question === null || typeof question !== "object") return null;

      const shiftMonth = (delta) => setView((current) => {
        const next = new Date(current.year, current.month + delta, 1);
        return { year: next.getFullYear(), month: next.getMonth() };
      });

      // 日历格：周一起始，含补位的天数（可点，免切月直接选邻月）。
      const firstOfMonth = new Date(view.year, view.month, 1);
      const leading = (firstOfMonth.getDay() + 6) % 7;
      const daysInMonth = new Date(view.year, view.month + 1, 0).getDate();
      const gridStart = mlAddDays(firstOfMonth, -leading);
      const cellCount = Math.ceil((leading + daysInMonth) / 7) * 7;
      const cells = [];
      for (let i = 0; i < cellCount; i += 1) cells.push(mlAddDays(gridStart, i));

      // 壳样式用共享的 ML_*（见上），这里只有日期主体自己的样式。
      const shortcutsStyle = { display: "flex", gap: 8, flexShrink: 0 };
      const shortcutStyle = {
        flex: "1 1 0", minHeight: 46, display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center", gap: 2,
        cursor: "pointer", background: "transparent",
        border: "1px solid var(--dsw-alias-border-l1)", borderRadius: 12,
        color: "var(--dsw-alias-label-primary)", padding: "5px 4px",
      };
      const shortcutSubStyle = { color: "var(--dsw-alias-label-tertiary)", fontSize: 11, lineHeight: "14px" };
      const calendarStyle = { flexShrink: 0, marginTop: 10 };
      const navStyle = { display: "flex", alignItems: "center", justifyContent: "center", gap: 12, padding: "2px 0 6px" };
      const navButtonStyle = {
        width: 26, height: 26, display: "grid", placeItems: "center",
        color: "var(--dsw-alias-label-tertiary)", cursor: "pointer",
        background: "transparent", border: "none", borderRadius: 999, padding: 0,
        fontSize: 14, lineHeight: 1,
      };
      const monthLabelStyle = { fontSize: 14, fontWeight: 500, minWidth: 96, textAlign: "center", lineHeight: "24px" };
      const weekdayStyle = {
        display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2,
        color: "var(--dsw-alias-label-tertiary)", fontSize: 12, lineHeight: "20px", textAlign: "center",
      };
      const gridStyle = { display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2 };
      const dayStyle = (inMonth, isToday) => ({
        height: 34, display: "grid", placeItems: "center",
        cursor: "pointer", background: "transparent", padding: 0,
        border: isToday ? "1px solid var(--dsw-alias-label-primary-bluish)" : "1px solid transparent",
        borderRadius: 10, fontSize: 13,
        color: isToday ? "var(--dsw-alias-label-primary-bluish)" : inMonth ? "var(--dsw-alias-label-primary)" : "var(--dsw-alias-label-tertiary)",
        fontWeight: isToday ? 600 : 400,
      });

      const title = question !== null && typeof question === "object" && typeof question.question === "string"
        ? question.question.replace(/（yyyy-mm-dd）\s*$/, "")
        : "日期是哪天？";

      return React.createElement("div", { style: ML_FRAME_STYLE, "data-ml-date-question": wait !== null && typeof wait === "object" ? wait.key : "" },
        React.createElement("section", { style: ML_CARD_STYLE, "aria-label": title },
          React.createElement("header", { style: ML_HEADER_STYLE },
            React.createElement("div", null,
              React.createElement("div", { style: ML_EYEBROW_STYLE },
                question !== null && typeof question === "object" && typeof question.header === "string" ? question.header : "MemoryLeak 待办"),
              React.createElement("h2", { style: ML_TITLE_STYLE }, title)),
            React.createElement("button", {
              type: "button", style: ML_CLOSE_BTN_STYLE, className: "ml-date-cancel",
              "aria-label": "取消", title: "取消（Esc）", disabled: busy, onClick: cancelWait,
            }, "✕")),
          React.createElement("div", { style: ML_BODY_STYLE, "data-ml-date-scroll": true },
            React.createElement("div", { style: shortcutsStyle, role: "group", "aria-label": "快捷日期" },
              shortcuts.map((shortcut) => React.createElement("button", {
                key: shortcut.key, type: "button", style: shortcutStyle, className: "ml-date-shortcut",
                disabled: busy, onClick: () => answerWith(shortcut.date),
                title: mlIsoDate(shortcut.date),
              },
                React.createElement("span", null, shortcut.label),
                React.createElement("span", { style: shortcutSubStyle }, mlShortDate(shortcut.date))))),
            React.createElement("div", { style: calendarStyle },
              React.createElement("div", { style: navStyle },
                React.createElement("button", {
                  type: "button", style: navButtonStyle, className: "ml-date-nav",
                  "aria-label": "上一月", disabled: busy, onClick: () => shiftMonth(-1),
                }, "‹"),
                React.createElement("span", { style: monthLabelStyle }, view.year + " 年 " + (view.month + 1) + " 月"),
                React.createElement("button", {
                  type: "button", style: navButtonStyle, className: "ml-date-nav",
                  "aria-label": "下一月", disabled: busy, onClick: () => shiftMonth(1),
                }, "›")),
              React.createElement("div", { style: weekdayStyle, "aria-hidden": "true" },
                ML_WEEKDAYS.map((label) => React.createElement("span", { key: label }, label))),
              React.createElement("div", { style: gridStyle, role: "grid", "aria-label": "选择日期" },
                cells.map((cell) => {
                  const inMonth = cell.getMonth() === view.month;
                  const isToday = cell.getTime() === today.getTime();
                  return React.createElement("button", {
                    key: mlIsoDate(cell), type: "button",
                    style: dayStyle(inMonth, isToday), className: "ml-date-day",
                    role: "gridcell", "aria-label": mlIsoDate(cell), "aria-current": isToday ? "date" : undefined,
                    disabled: busy, onClick: () => answerWith(cell),
                  }, String(cell.getDate()));
                })))),
          React.createElement("footer", { style: ML_FOOTER_STYLE },
            React.createElement("span", { style: error !== null ? ML_ERROR_STYLE : ML_HINT_STYLE, role: "status" },
              error !== null ? error : "点击日期即确认 · Esc 取消"),
            React.createElement("button", {
              type: "button", style: ML_CANCEL_BTN_STYLE, className: "ml-date-cancel",
              disabled: busy, onClick: cancelWait,
            }, busy ? "处理中…" : "取消"))));
    }

    /* ---------------- 首轮「类型 + 优先级」组合卡 ----------------
       认领宿主首批两问（ml-type + ml-prio）：两问同卡展示，点选项只做
       高亮，两组各有一项的瞬间整批自动提交 —— 通用 UI 里最后一题选完
       还要点一下「提交」的步骤在这里不存在。先选优先级再选类型同样
       成立（哪一下补全两组，哪一下提交）。改选在补全前随时可换。 */

    /** chain select：只认领「ml-type + ml-prio 两问同批」的 question 交互。 */
    function mlSelectTodoIntro(owner) {
      const interactions = owner !== null && typeof owner === "object" && Array.isArray(owner.interactions) ? owner.interactions : [];
      for (const interaction of interactions) {
        if (interaction === null || typeof interaction !== "object" || interaction.kind !== "question") continue;
        const questions = interaction.payload !== null && typeof interaction.payload === "object" && Array.isArray(interaction.payload.questions)
          ? interaction.payload.questions
          : [];
        if (questions.length !== 2) continue;
        let typeQ = null;
        let prioQ = null;
        for (const question of questions) {
          if (question === null || typeof question !== "object") continue;
          if (question.id === ML_TYPE_QUESTION_ID) typeQ = question;
          else if (question.id === ML_PRIO_QUESTION_ID) prioQ = question;
        }
        if (typeQ === null || prioQ === null) continue;
        if (typeQ.multiSelect === true || prioQ.multiSelect === true) continue;
        if (!Array.isArray(typeQ.options) || typeQ.options.length === 0) continue;
        if (!Array.isArray(prioQ.options) || prioQ.options.length === 0) continue;
        return interaction;
      }
      return null;
    }

    function MlTodoIntroComposer({ matched }) {
      const wait = matched;
      const questions = wait !== null && typeof wait === "object" && wait.payload !== null && typeof wait.payload === "object" && Array.isArray(wait.payload.questions)
        ? wait.payload.questions
        : [];
      const typeQ = questions.find((q) => q !== null && typeof q === "object" && q.id === ML_TYPE_QUESTION_ID) ?? null;
      const prioQ = questions.find((q) => q !== null && typeof q === "object" && q.id === ML_PRIO_QUESTION_ID) ?? null;
      const [typeLabel, setTypeLabel] = React.useState(null);
      const [prioLabel, setPrioLabel] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);

      // 与日期卡同款 settle：busy 期间全部禁用，失败回填页脚不吞错。
      const settle = (send) => {
        setBusy(true);
        setError(null);
        send().catch((cause) => {
          setBusy(false);
          setError(cause instanceof Error ? cause.message : String(cause));
        });
      };
      const submit = (t, p) => settle(async () => {
        const receipt = await wait.respond({
          ok: true,
          value: {
            sessionId: wait.sessionId,
            answer: {
              answers: [
                { id: typeQ.id, selected: [t] },
                { id: prioQ.id, selected: [p] },
              ],
            },
          },
        });
        if (receipt !== null && typeof receipt === "object" && receipt.accepted === false) {
          throw new Error("答案被宿主拒绝：" + String(receipt.reason ?? "未知原因"));
        }
      });
      const cancelWait = () => settle(async () => {
        const receipt = await wait.respond({
          ok: false,
          error: { code: "cancelled", message: "the user closed this question request", details: {} },
        });
        if (receipt !== null && typeof receipt === "object" && receipt.accepted === false) {
          throw new Error("取消被宿主拒绝：" + String(receipt.reason ?? "未知原因"));
        }
      });

      // Esc 取消（capture 拦截；IME 组合中不拦）。
      React.useEffect(() => {
        if (busy) return undefined;
        const onKey = (ev) => {
          if (ev.key !== "Escape" || ev.isComposing === true) return;
          ev.preventDefault();
          ev.stopPropagation();
          cancelWait();
        };
        document.addEventListener("keydown", onKey, true);
        return () => document.removeEventListener("keydown", onKey, true);
      });

      // 兜底：载体形态不符（理论上 select 已拦）不渲染。放在全部 hook
      // 之后，保证 hook 数稳定。
      if (wait === null || typeof wait !== "object" || typeQ === null || prioQ === null) return null;

      const chooseType = (label) => {
        if (busy) return;
        if (prioLabel !== null) submit(label, prioLabel);
        else { setTypeLabel(label); setError(null); }
      };
      const choosePrio = (label) => {
        if (busy) return;
        if (typeLabel !== null) submit(typeLabel, label);
        else { setPrioLabel(label); setError(null); }
      };

      const optionsOf = (q) => (Array.isArray(q.options) ? q.options.filter((o) => o !== null && typeof o === "object" && typeof o.label === "string") : []);
      const typeOptions = optionsOf(typeQ);
      const prioOptions = optionsOf(prioQ);
      if (typeOptions.length === 0 || prioOptions.length === 0) return null;

      const title = typeof typeQ.question === "string" && typeQ.question !== "" ? typeQ.question : "待办的类型？";
      const prioTitle = typeof prioQ.question === "string" && prioQ.question !== "" ? prioQ.question : "重要程度？";
      const eyebrow = typeof typeQ.header === "string" && typeQ.header !== "" ? typeQ.header : "MemoryLeak 待办";

      const rowsStyle = { display: "flex", flexDirection: "column", gap: 2 };
      const rowStyle = (selected) => ({
        width: "100%", minHeight: 40, display: "flex", alignItems: "center", gap: 10,
        cursor: "pointer", textAlign: "left",
        background: selected ? "var(--dsw-alias-interactive-bg-hover)" : "transparent",
        border: "1px solid " + (selected ? "var(--dsw-alias-label-primary-bluish)" : "transparent"),
        borderRadius: 10, padding: "6px 10px", color: "var(--dsw-alias-label-primary)",
      });
      const numberStyle = { flex: "0 0 auto", width: 18, color: "var(--dsw-alias-label-tertiary)", fontSize: 12, lineHeight: "16px", textAlign: "center", fontVariantNumeric: "tabular-nums" };
      const rowLabelStyle = { flex: "0 0 auto", fontSize: 14, lineHeight: "20px", fontWeight: 500 };
      const rowDescStyle = { flex: "1 1 auto", minWidth: 0, color: "var(--dsw-alias-label-tertiary)", fontSize: 12, lineHeight: "16px", textAlign: "right", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
      const groupLabelStyle = { color: "var(--dsw-alias-label-secondary)", fontSize: 13, fontWeight: 500, lineHeight: "18px", margin: "12px 2px 4px" };
      const chipsStyle = { display: "flex", gap: 8 };
      const chipStyle = (selected) => ({
        flex: "1 1 0", minHeight: 46, display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center", gap: 2,
        cursor: "pointer",
        background: selected ? "var(--dsw-alias-interactive-bg-hover)" : "transparent",
        border: "1px solid " + (selected ? "var(--dsw-alias-label-primary-bluish)" : "var(--dsw-alias-border-l1)"),
        borderRadius: 12, padding: "5px 4px", color: "var(--dsw-alias-label-primary)",
      });
      const chipDescStyle = { color: "var(--dsw-alias-label-tertiary)", fontSize: 11, lineHeight: "14px" };

      return React.createElement("div", { style: ML_FRAME_STYLE, "data-ml-intro-question": wait.key },
        React.createElement("section", { style: ML_CARD_STYLE, "aria-label": title },
          React.createElement("header", { style: ML_HEADER_STYLE },
            React.createElement("div", null,
              React.createElement("div", { style: ML_EYEBROW_STYLE }, eyebrow),
              React.createElement("h2", { style: ML_TITLE_STYLE }, title)),
            React.createElement("button", {
              type: "button", style: ML_CLOSE_BTN_STYLE, className: "ml-intro-cancel",
              "aria-label": "取消", title: "取消（Esc）", disabled: busy, onClick: cancelWait,
            }, "✕")),
          React.createElement("div", { style: ML_BODY_STYLE, "data-ml-intro-scroll": true },
            React.createElement("div", { style: rowsStyle, role: "radiogroup", "aria-label": title },
              typeOptions.map((option, index) => React.createElement("button", {
                key: option.label, type: "button", style: rowStyle(option.label === typeLabel), className: "ml-intro-option",
                role: "radio", "aria-checked": option.label === typeLabel, disabled: busy,
                onClick: () => chooseType(option.label),
              },
                React.createElement("span", { style: numberStyle }, String(index + 1)),
                React.createElement("span", { style: rowLabelStyle }, option.label),
                typeof option.description === "string" ? React.createElement("span", { style: rowDescStyle }, option.description) : null))),
            React.createElement("div", { style: groupLabelStyle }, prioTitle),
            React.createElement("div", { style: chipsStyle, role: "radiogroup", "aria-label": prioTitle },
              prioOptions.map((option) => React.createElement("button", {
                key: option.label, type: "button", style: chipStyle(option.label === prioLabel), className: "ml-intro-option",
                role: "radio", "aria-checked": option.label === prioLabel, disabled: busy,
                onClick: () => choosePrio(option.label),
              },
                React.createElement("span", { style: rowLabelStyle }, option.label),
                typeof option.description === "string" ? React.createElement("span", { style: chipDescStyle }, option.description) : null)))),
          React.createElement("footer", { style: ML_FOOTER_STYLE },
            React.createElement("span", { style: error !== null ? ML_ERROR_STYLE : ML_HINT_STYLE, role: "status" },
              error !== null ? error : "类型与重要程度各选一项，选完自动提交 · Esc 取消"),
            React.createElement("button", {
              type: "button", style: ML_CANCEL_BTN_STYLE, className: "ml-intro-cancel",
              disabled: busy, onClick: cancelWait,
            }, busy ? "处理中…" : "取消"))));
    }

    /* ---------------- Vault 引导卡（目录选择 + Tab 补全）----------------
       认领宿主的 ml-vault 单问题请求：路径输入框 + 实时候选列表（宿主
       /path/complete 列父目录下的子目录），Tab 补全 / ↑↓ 换高亮 /
       Enter 确认 / Esc 取消；问题自带的快捷选项（如「当前会话的工作区」）
       渲染成一行按钮，点选即答。手输完整路径 + Enter 也始终有效（目录
       不存在时由宿主自动创建）。 */

    /** chain select：只认领「单问题且 id === ml-vault」的 question 交互。 */
    function mlSelectVaultQuestion(owner) {
      const interactions = owner !== null && typeof owner === "object" && Array.isArray(owner.interactions) ? owner.interactions : [];
      for (const interaction of interactions) {
        if (interaction === null || typeof interaction !== "object" || interaction.kind !== "question") continue;
        const questions = interaction.payload !== null && typeof interaction.payload === "object" && Array.isArray(interaction.payload.questions)
          ? interaction.payload.questions
          : [];
        if (questions.length === 1 && questions[0] !== null && typeof questions[0] === "object" && questions[0].id === ML_VAULT_QUESTION_ID) {
          return interaction;
        }
      }
      return null;
    }

    /** base + 目录名 → 带尾分隔符的完整路径（盘符候选 name 自带尾分隔）。 */
    function mlJoinDir(base, name) {
      if (base === "") return /[\\/]$/.test(name) ? name : name + "\\";
      const sepChar = base.includes("\\") ? "\\" : "/";
      return base.replace(/[\\/]+$/, "") + sepChar + name + sepChar;
    }

    function MlVaultComposer({ matched, pickDirectory }) {
      const wait = matched;
      const questions = wait !== null && typeof wait === "object" && wait.payload !== null && typeof wait.payload === "object" && Array.isArray(wait.payload.questions)
        ? wait.payload.questions
        : [];
      const question = questions[0];
      const [value, setValue] = React.useState("");
      const [entries, setEntries] = React.useState(null); // null = 加载中
      const [base, setBase] = React.useState("");
      const [active, setActive] = React.useState(0);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);

      const settle = (send) => {
        setBusy(true);
        setError(null);
        send().catch((cause) => {
          setBusy(false);
          setError(cause instanceof Error ? cause.message : String(cause));
        });
      };
      const answerCustom = (path) => settle(async () => {
        const receipt = await wait.respond({
          ok: true,
          value: {
            sessionId: wait.sessionId,
            answer: { answers: [{ id: question.id, selected: [], custom: path }] },
          },
        });
        if (receipt !== null && typeof receipt === "object" && receipt.accepted === false) {
          throw new Error("答案被宿主拒绝：" + String(receipt.reason ?? "未知原因"));
        }
      });
      const answerOption = (label) => settle(async () => {
        const receipt = await wait.respond({
          ok: true,
          value: {
            sessionId: wait.sessionId,
            answer: { answers: [{ id: question.id, selected: [label] }] },
          },
        });
        if (receipt !== null && typeof receipt === "object" && receipt.accepted === false) {
          throw new Error("答案被宿主拒绝：" + String(receipt.reason ?? "未知原因"));
        }
      });
      const cancelWait = () => settle(async () => {
        const receipt = await wait.respond({
          ok: false,
          error: { code: "cancelled", message: "the user closed this question request", details: {} },
        });
        if (receipt !== null && typeof receipt === "object" && receipt.accepted === false) {
          throw new Error("取消被宿主拒绝：" + String(receipt.reason ?? "未知原因"));
        }
      });

      // Esc 取消（capture；IME 组合中不拦）。
      React.useEffect(() => {
        if (busy) return undefined;
        const onKey = (ev) => {
          if (ev.key !== "Escape" || ev.isComposing === true) return;
          ev.preventDefault();
          ev.stopPropagation();
          cancelWait();
        };
        document.addEventListener("keydown", onKey, true);
        return () => document.removeEventListener("keydown", onKey, true);
      });

      // 输入变化 → 120ms 去抖拉候选；过期响应按序号丢弃；失败静默为空。
      // 请求期间保留旧候选（弹层不闪不跳，新结果到了整体替换）。
      const fetchSeq = React.useRef(0);
      React.useEffect(() => {
        const seq = fetchSeq.current + 1;
        fetchSeq.current = seq;
        const timer = setTimeout(() => {
          fetch(`${API}/path/complete?prefix=${encodeURIComponent(value)}`)
            .then((res) => res.json())
            .then((body) => {
              if (seq !== fetchSeq.current) return;
              if (body.ok !== true) throw new Error(body.error || "HTTP " + res.status);
              setEntries(Array.isArray(body.entries) ? body.entries : []);
              setBase(typeof body.base === "string" ? body.base : "");
            })
            .catch(() => {
              if (seq === fetchSeq.current) setEntries([]);
            });
        }, 120);
        return () => clearTimeout(timer);
      }, [value]);
      React.useEffect(() => { setActive(0); }, [value]);

      // 兜底：载体形态不符不渲染（hook 之后返回，保证 hook 数稳定）。
      if (wait === null || typeof wait !== "object" || question === null || typeof question !== "object") return null;

      const list = entries ?? [];
      const applyEntry = (entry) => {
        if (entry === null || typeof entry !== "object" || typeof entry.name !== "string") return;
        setValue(mlJoinDir(base, entry.name));
      };
      const confirmValue = () => {
        if (busy) return;
        const path = value.trim();
        if (path === "") {
          setError("先输入（或用 Tab 补全 / 点「浏览…」）一个目录路径");
          return;
        }
        answerCustom(path);
      };
      // 官方目录选择：选中即填入输入框（不直接提交 —— 用户还能改）；
      // 取消静默，失败显示在页脚。
      const browse = () => {
        if (busy || typeof pickDirectory !== "function") return;
        setError(null);
        Promise.resolve()
          .then(() => pickDirectory())
          .then((path) => {
            if (typeof path === "string" && path !== "") setValue(path);
          })
          .catch((e) => setError("打开目录选择器失败：" + (e instanceof Error ? e.message : String(e))));
      };
      const onInputKey = (ev) => {
        if (ev.isComposing === true) return;
        if (ev.key === "ArrowDown" && list.length > 0) {
          ev.preventDefault();
          setActive((index) => Math.min(index + 1, list.length - 1));
        } else if (ev.key === "ArrowUp" && list.length > 0) {
          ev.preventDefault();
          setActive((index) => Math.max(index - 1, 0));
        } else if (ev.key === "Tab") {
          ev.preventDefault();
          if (list.length > 0) applyEntry(list[Math.min(active, list.length - 1)]);
        } else if (ev.key === "Enter") {
          ev.preventDefault();
          // Enter 语义：输入以分隔符结尾（或无候选）= 确认该目录；
          // 还在敲某一段（无尾分隔符）且有候选 = 先补全（同 Tab），
          // 补全后输入以分隔符结尾，下一次 Enter 即确认。
          const trimmed = value.trim();
          const endsWithSeparator = trimmed !== "" && /[\\/]$/.test(trimmed);
          if (!endsWithSeparator && trimmed !== "" && list.length > 0) {
            applyEntry(list[Math.min(active, list.length - 1)]);
          } else {
            confirmValue();
          }
        }
      };

      const quickOptions = question.options !== undefined && Array.isArray(question.options)
        ? question.options.filter((o) => o !== null && typeof o === "object" && typeof o.label === "string")
        : [];
      const title = typeof question.question === "string" && question.question !== "" ? question.question : "选择 Vault 目录";
      const eyebrow = typeof question.header === "string" && question.header !== "" ? question.header : "MemoryLeak 初始化";

      const inputStyle = {
        width: "100%", minHeight: 36, padding: "6px 12px",
        border: "1px solid var(--dsw-alias-border-l1)", borderRadius: 10,
        background: "var(--dsw-specific-input-major)", color: "var(--dsw-alias-label-primary)",
        fontSize: 14, lineHeight: "22px", fontVariantNumeric: "tabular-nums",
      };
      const quickRowStyle = { display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 };
      const quickBtnStyle = {
        display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 1,
        cursor: "pointer", background: "transparent",
        border: "1px solid var(--dsw-alias-border-l1)", borderRadius: 12,
        padding: "6px 12px", color: "var(--dsw-alias-label-primary)",
      };
      const quickDescStyle = { color: "var(--dsw-alias-label-tertiary)", fontSize: 11, lineHeight: "14px" };
      // 候选弹层：绝对定位悬浮在整卡上方（对齐 /ml view 候选卡的展开方向），
      // 输入区高度恒定 —— 候选多少、有无都不再引起卡片与视口的布局抖动。
      const popupStyle = {
        position: "absolute",
        bottom: "calc(100% + 4px)",
        left: "50%",
        transform: "translateX(-50%)",
        width: "100%",
        maxWidth: "var(--dsh-chat-content-width)",
        zIndex: 100,
        border: "1px solid var(--dsw-alias-border-inverted)",
        background: "var(--dsw-specific-menu)",
        borderRadius: 12,
        maxHeight: 280,
        overflowY: "auto",
        boxShadow: "var(--dsw-shadow-lv3)",
        padding: 4,
        "--dsh-scrollbar-thumb": "var(--dsw-alias-scrollbar-bg-l2)",
        "--dsh-scrollbar-thumb-hover": "var(--dsw-alias-scrollbar-hover-l2)",
      };
      const popupHintStyle = {
        color: "var(--dsw-alias-label-tertiary)",
        fontSize: 12, lineHeight: "16px",
        padding: "8px 10px 6px",
        borderBottom: "1px solid var(--dsw-alias-border-l1)",
        flex: "0 0 auto",
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
      };
      const rowItemStyle = (isActive) => ({
        width: "100%", minHeight: 34, display: "flex", alignItems: "center", gap: 8,
        cursor: "pointer", textAlign: "left", border: "none",
        background: isActive ? "var(--dsw-alias-interactive-bg-hover)" : "transparent",
        borderRadius: 8, padding: "5px 10px", color: "var(--dsw-alias-label-primary)",
        fontSize: 14, lineHeight: "20px",
      });
      const folderGlyphStyle = { flex: "0 0 auto", color: "var(--dsw-alias-label-primary-bluish)", fontSize: 13 };
      const statusStyle = (isError) => ({
        color: isError ? "var(--dsw-alias-state-error-primary)" : "var(--dsw-alias-label-tertiary)",
        fontSize: 12, lineHeight: "16px", minWidth: 0,
      });
      const primaryBtnStyle = {
        flexShrink: 0, minHeight: 28, padding: "0 14px", cursor: "pointer",
        background: "transparent", border: "1px solid var(--dsw-alias-border-l1)",
        borderRadius: 8, fontSize: 13, lineHeight: "20px", color: "var(--dsw-alias-label-primary)",
      };

      return React.createElement("div", { style: { ...ML_FRAME_STYLE, position: "relative" }, "data-ml-vault-question": wait.key },
        entries !== null && list.length > 0
          ? React.createElement("div", { style: popupStyle, role: "listbox", "aria-label": "候选目录", "data-ml-vault-popup": "1" },
              React.createElement("div", { style: popupHintStyle },
                (base === "" ? "候选目录" : "在 " + base + " 下") + " · ↑↓ 选择 · Tab 补全"),
              list.map((entry, index) => React.createElement("button", {
                key: entry.name, type: "button",
                style: rowItemStyle(index === active), className: "ml-vault-entry",
                role: "option", "aria-selected": index === active, disabled: busy,
                onMouseDown: (ev) => { ev.preventDefault(); applyEntry(entry); },
                onMouseEnter: () => setActive(index),
              },
                React.createElement("span", { style: folderGlyphStyle, "aria-hidden": "true" }, "▸"),
                React.createElement("span", null, entry.name))))
          : null,
        React.createElement("section", { style: ML_CARD_STYLE, "aria-label": title },
          React.createElement("header", { style: ML_HEADER_STYLE },
            React.createElement("div", null,
              React.createElement("div", { style: ML_EYEBROW_STYLE }, eyebrow),
              React.createElement("h2", { style: ML_TITLE_STYLE }, title)),
            React.createElement("button", {
              type: "button", style: ML_CLOSE_BTN_STYLE, className: "ml-vault-cancel",
              "aria-label": "取消", title: "取消（Esc）", disabled: busy, onClick: cancelWait,
            }, "✕")),
          React.createElement("div", { style: ML_BODY_STYLE, "data-ml-vault-scroll": true },
            quickOptions.length > 0
              ? React.createElement("div", { style: quickRowStyle },
                  quickOptions.map((option) => React.createElement("button", {
                    key: option.label, type: "button", style: quickBtnStyle, className: "ml-vault-quick",
                    disabled: busy, onClick: () => answerOption(option.label),
                  },
                    React.createElement("span", null, option.label),
                    typeof option.description === "string" ? React.createElement("span", { style: quickDescStyle }, option.description) : null)))
              : null,
            React.createElement("div", { style: { display: "flex", gap: 8, alignItems: "center" } },
              React.createElement("input", {
                type: "text", style: { ...inputStyle, flex: "1 1 auto", minWidth: 0 }, className: "ml-vault-input",
                value, autoFocus: true, spellCheck: false, disabled: busy,
                placeholder: "E:\\notes\\MLeak（Tab 补全，~ 开头为用户目录）",
                onChange: (event) => setValue(event.target.value),
                onKeyDown: onInputKey,
              }),
              typeof pickDirectory === "function"
                ? React.createElement("button", {
                    type: "button", style: primaryBtnStyle, className: "ml-vault-browse",
                    disabled: busy, onClick: browse,
                  }, "浏览…")
                : null)),
          React.createElement("footer", { style: ML_FOOTER_STYLE },
            React.createElement("span", { style: statusStyle(error !== null), role: "status" },
              error !== null ? error : "Tab 补全 · ↑↓ 选择 · Enter 确认 · Esc 取消"),
            React.createElement("button", {
              type: "button", style: primaryBtnStyle, className: "ml-vault-confirm",
              disabled: busy, onClick: confirmValue,
            }, busy ? "处理中…" : "选择此目录"))));
    }

    /* ---------------- 插件入口 ---------------- */
    // sessions/conversation 是槽位 inject 工厂里解析会话输入 shell 的硬依赖，
    // 必须声明，否则运行时报 cannot get property "sessions" without inject。
    // workspaces 是官方目录选择（ctx.workspaces.pickDirectory，跨平台由
    // 宿主组合的 directory-picker 后端处理 —— 我们自己不造平台脚本）。
    const inject = ["slots", "commandUi", "remote", "remote.commands", "sessions", "conversation", "workspaces"];

    function apply(ctx) {
      // 官方目录选择闭包：设置页「浏览…」与 Vault 引导卡共用。取消 = null，
      // 失败抛错（调用方各自展示）；不捕获平台细节。
      const pickDirectory = () => ctx.workspaces.pickDirectory();

      // 设置窗口：GUI 设置面板中的一个「MemoryLeak」分区（与字体设置页同款槽位）。
      ctx.slots.inject("settings.section", () => ctx.slots.register(
        { name: "settings.section", id: "memoryleak", order: 96, label: "MemoryLeak" },
        () => React.createElement(NotesSettingsPage, { pickDirectory })
      ));

      // /ml 命令卡片：默认展开的会话式视图（替换需点击展开的通用折叠卡）。
      // 曾因「空结果不显示」误撤（commit 5968400）——后确认那是 blank 会话
      // 无时间线的上游行为，与槽位无关；非 blank 会话本视图工作正常。
      ctx.slots.inject("conversation.chat.commandview", () => ctx.slots.register(
        { name: "conversation.chat.commandview", key: "ml" },
        (owner) => React.createElement(MlCommandView, { node: owner === null || owner === undefined ? null : owner.node })
      ));

      // /ml todo add 首轮（类型 + 优先级）：composer 接管渲染组合卡，选完
      // 两项即自动提交（通用 UI 最后一题还需点「提交」）。priority 负值先
      // 于通用问题 UI 尝试；select 只认领 ml-type + ml-prio 两问批次。
      ctx.slots.inject("conversation.composer", () => ctx.slots.register(
        { name: "conversation.composer", priority: -100, select: mlSelectTodoIntro },
        MlTodoIntroComposer
      ));

      // /ml todo add 日期轮：composer 接管渲染日期选择器（日历 + 快捷键）。
      // priority 负值先于通用问题 UI（dsh-client-ui-user-questions，默认 0）
      // 尝试；select 只认领 id 为 ml-date 的单问题请求，其余问题原样放行。
      ctx.slots.inject("conversation.composer", () => ctx.slots.register(
        { name: "conversation.composer", priority: -100, select: mlSelectDateQuestion },
        MlDateComposer
      ));

      // Vault 引导（vault 未设置时的 ml-vault 单问题）：接管渲染目录选择卡
      //（路径输入 + Tab 补全候选 + 官方目录选择按钮 + 当前工作区快捷项）。
      ctx.slots.inject("conversation.composer", () => ctx.slots.register(
        { name: "conversation.composer", priority: -100, select: mlSelectVaultQuestion },
        (props) => React.createElement(MlVaultComposer, { ...props, pickDirectory })
      ));

      // 命令菜单选中 /ml → 快速打开弹窗（VSCode Ctrl+P 风格查看文件）。
      ctx.effect(() => ctx.commandUi.decorate({
        name: "ml",
        available: () => true,
        ui: mlQuickOpenSpec(ctx),
      }), "memoryleak: /ml quick-open popup");

      // 手动输入 /ml view <片段> → 实时候选卡（combobox：焦点留在输入框）。
      const executeViaHost = async (sessionId, line) => {
        const result = await ctx.remote.commands.execute(sessionId, line);
        if (!result.ok) {
          throw new Error(`执行失败：${result.error?.message ?? result.error?.code ?? "未知错误"}`);
        }
      };
      ctx.slots.inject("conversation.input.overlay", () => ctx.slots.register(
        {
          name: "conversation.input.overlay",
          id: "memoryleak-quick-open",
          order: 2,
          inject: (sessionId) => {
            const actx = ctx.sessions.scope(sessionId);
            const shell = actx === undefined ? null : ctx.conversation.input.for(actx);
            return { shell, sessionId, execute: executeViaHost };
          },
        },
        (props) => props !== null && typeof props === "object" && props.shell != null
          ? React.createElement(QuickOpenOverlay, props)
          : null
      ));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
