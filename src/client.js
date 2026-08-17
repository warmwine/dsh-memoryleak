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

    function NotesSettingsPage() {
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

      const save = () => {
        let section;
        try {
          section = sectionOf(draft);
        } catch (error) {
          setMessage({ kind: "error", text: error.message });
          return;
        }
        setBusy(true);
        const expected = revision === null ? undefined : { expectedRevision: revision };
        apiPost("/settings", Object.assign({ section }, expected))
          .then((body) => {
            setDraft(draftOf(body.section));
            setRevision(Number.isInteger(body.revision) ? body.revision : revision);
            setMessage({ kind: "ok", text: "已保存" });
          })
          .catch((error) => {
            if (error.status === 409) {
              setMessage({ kind: "error", text: "设置已被其他窗口修改，正在重新加载…" });
              load();
              return;
            }
            setMessage({ kind: "error", text: "保存失败：" + error.message });
          })
          .then(() => setBusy(false));
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
       零 token）。候选来自宿主 /api/memoryleak/files（按会话定位工作区），
       新文件在前。Tab 补全由上游壳决定（当前版本未绑定 Tab）。 */
    function mlQuickOpenSpec(ctx) {
      return {
        async options(session, signal) {
          const sessionId = session !== null && typeof session === "object" ? session.sessionId : undefined
          if (typeof sessionId !== "string" || sessionId === "") throw new Error("无法定位当前会话")
          const url = `${API}/files?session=${encodeURIComponent(sessionId)}&limit=50`
          const res = await fetch(url, signal !== null && signal !== undefined ? { signal } : undefined)
          const body = await res.json().catch(() => ({}))
          if (!res.ok || body.ok === false) throw new Error(body.error || "HTTP " + res.status)
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
          const result = await ctx.remote.commands.execute(sessionId, `/ml view ${option.id}`)
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
        fetch(`${API}/files?session=${encodeURIComponent(sessionId)}&limit=50`)
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

    /* ---------------- 插件入口 ---------------- */
    // sessions/conversation 是槽位 inject 工厂里解析会话输入 shell 的硬依赖，
    // 必须声明，否则运行时报 cannot get property "sessions" without inject。
    const inject = ["slots", "commandUi", "remote", "remote.commands", "sessions", "conversation"];

    function apply(ctx) {
      // 设置窗口：GUI 设置面板中的一个「MemoryLeak」分区（与字体设置页同款槽位）。
      ctx.slots.inject("settings.section", () => ctx.slots.register(
        { name: "settings.section", id: "memoryleak", order: 96, label: "MemoryLeak" },
        () => React.createElement(NotesSettingsPage)
      ));

      // /ml 命令卡片：默认展开的会话式视图（替换需点击展开的通用折叠卡）。
      // 曾因「空结果不显示」误撤（commit 5968400）——后确认那是 blank 会话
      // 无时间线的上游行为，与槽位无关；非 blank 会话本视图工作正常。
      ctx.slots.inject("conversation.chat.commandview", () => ctx.slots.register(
        { name: "conversation.chat.commandview", key: "ml" },
        (owner) => React.createElement(MlCommandView, { node: owner === null || owner === undefined ? null : owner.node })
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
