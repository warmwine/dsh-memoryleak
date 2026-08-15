// dsh-notes —— 浏览器半：设置窗口（GUI 设置面板里的「记事本」分区）。
//
// 与 dsh-ui-font 的字体设置页同款模式：settings.section 槽位注册一个分区。
// 页面通过同源 /api/notes/* 读写宿主侧的 `notes` 设置命名空间（持久化在
// ~/.dsh/settings.yaml），带乐观并发（expectedRevision / 409 重载提示）。
// 所有异步失败都显式渲染在页面上 —— 不吞错、不静默。
window.__ModuleLoader__.load({
  id: "dsh-notes",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require("react");

    const API = "/api/notes";
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
      return {
        extensions,
        excludeDirs,
        maxFiles,
        maxFileBytes: maxFileKb * 1024,
        maxItems,
        defaultStatus: draft.defaultStatus,
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
          React.createElement("h3", { style: { margin: "4px 0 8px" } }, "记事本"),
          React.createElement("p", null, message === null ? "正在加载设置…" : message.text));
      }

      return React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
        React.createElement("h3", { style: { margin: "4px 0 8px" } }, "记事本 · /todo"),
        row("默认过滤",
          React.createElement("select", {
            value: draft.defaultStatus,
            onChange: (event) => update({ defaultStatus: event.target.value }),
            style: { minWidth: 140 },
          }, STATUS_OPTIONS.map((option) => React.createElement("option", { key: option[0], value: option[0] }, option[1]))),
          "/todo list 未指定状态时使用的过滤"),
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

    /* ---------------- 插件入口 ---------------- */
    const inject = ["slots"];

    function apply(ctx) {
      // 设置窗口：GUI 设置面板中的一个「记事本」分区（与字体设置页同款槽位）。
      ctx.slots.inject("settings.section", () => ctx.slots.register(
        { name: "settings.section", id: "notes", order: 96, label: "记事本" },
        () => React.createElement(NotesSettingsPage)
      ));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
