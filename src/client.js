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
      ["cancelled", "已取消"],
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
        mailAuth: section.mailAuth === "xoauth2" ? "xoauth2" : "password",
        mailHost: typeof section.mailHost === "string" ? section.mailHost : "",
        mailPort: section.mailPort,
        mailSecure: section.mailSecure !== false,
        mailUser: typeof section.mailUser === "string" ? section.mailUser : "",
        mailPassword: typeof section.mailPassword === "string" ? section.mailPassword : "",
        mailToken: typeof section.mailToken === "string" ? section.mailToken : "",
        mailFolder: typeof section.mailFolder === "string" && section.mailFolder !== "" ? section.mailFolder : "INBOX",
        mailMaxEmails: section.mailMaxEmails,
        mailCaPem: typeof section.mailCaPem === "string" ? section.mailCaPem : "",
        mailTlsInsecure: section.mailTlsInsecure === true,
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
      // —— /ml mail（可整体留空 = 未配置）——
      const mailAuth = draft.mailAuth === "xoauth2" ? "xoauth2" : "password";
      const mailHost = draft.mailHost.trim().toLowerCase();
      const mailUser = draft.mailUser.trim();
      const mailPassword = draft.mailPassword;
      const mailToken = draft.mailToken;
      const mailFolder = draft.mailFolder.trim() || "INBOX";
      const mailPort = Number(draft.mailPort);
      const mailMaxEmails = Number(draft.mailMaxEmails);
      if (mailHost !== "" && !/^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/.test(mailHost)) {
        throw new Error("IMAP 服务器只填主机名或 IP（不带 imaps:// 前缀与端口），如 imap.example.com");
      }
      if (mailHost.length > 255) throw new Error("IMAP 服务器地址过长");
      if (mailUser.length > 255) throw new Error("邮箱账号过长");
      if (mailPassword.length > 1024) throw new Error("密码/授权码过长");
      if (mailToken.length > 4096) throw new Error("OAuth2 token 过长");
      if (mailFolder.length > 255 || /\s/.test(mailFolder)) throw new Error("邮件目录名不能含空白且不超过 255 字符");
      if (!Number.isInteger(mailPort) || mailPort < 1 || mailPort > 65535) throw new Error("IMAP 端口必须是 1..65535 的整数");
      if (!Number.isInteger(mailMaxEmails) || mailMaxEmails < 1 || mailMaxEmails > 200) throw new Error("单次最多下载封数必须是 1..200 的整数");
      const mailCaPem = typeof draft.mailCaPem === "string" ? draft.mailCaPem : "";
      if (mailCaPem.length > 16384) throw new Error("信任的证书内容过长（最多 16384 字符）");
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
        mailAuth,
        mailHost,
        mailPort,
        mailSecure: draft.mailSecure === true,
        mailUser,
        mailPassword,
        mailToken,
        mailFolder,
        mailMaxEmails,
        mailCaPem,
        mailTlsInsecure: draft.mailTlsInsecure === true,
      };
    }

    function NotesSettingsPage({ pickDirectory }) {
      const [draft, setDraft] = React.useState(null);
      const [formats, setFormats] = React.useState([]);
      const [status, setStatus] = React.useState(null); // { kind: 'ok'|'error', text }
      const [busy, setBusy] = React.useState(false);
      // —— 自动保存机制 ——
      // draftRef 永远持最新草稿；editsRef 是编辑计数（防止「保存返回时把
      // 用户保存期间的继续输入顶掉」——只有计数没变才回填服务端值）；
      // 600ms 防抖 + 链式串行 POST（整段替换），与上次已存内容相同则跳过；
      // 非法输入不落盘，红色「未保存：原因」就地提示，改到合法即自动续存。
      const draftRef = React.useRef(null);
      const revisionRef = React.useRef(null);
      const editsRef = React.useRef(0);
      const saveTimer = React.useRef(null);
      const chainRef = React.useRef(Promise.resolve());
      const lastSavedRef = React.useRef(null);

      const applyDraft = (next) => {
        draftRef.current = next;
        setDraft(next);
      };
      const timeNow = () => {
        const d = new Date();
        return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0") + ":" + String(d.getSeconds()).padStart(2, "0");
      };

      const doSave = (section, okText) => {
        const snapshot = JSON.stringify(section);
        if (snapshot === lastSavedRef.current) return;
        const editAt = editsRef.current;
        chainRef.current = chainRef.current
          .then(() => {
            if (JSON.stringify(section) === lastSavedRef.current) return undefined;
            const submit = (rev) => apiPost("/settings", rev === null || rev === undefined ? { section } : Object.assign({ section }, { expectedRevision: rev }));
            return submit(revisionRef.current)
              .catch((error) => {
                if (error.status !== 409) throw error;
                // 版本冲突（别的窗口/引导存过）：拉最新 revision 重试一次——
                // 整段替换语义下覆盖即用户意图，不能把表单刷回旧值。
                return apiGet("/settings").then((fresh) => {
                  revisionRef.current = Number.isInteger(fresh.revision) ? fresh.revision : null;
                  return submit(revisionRef.current);
                });
              })
              .then((body) => {
                revisionRef.current = Number.isInteger(body.revision) ? body.revision : revisionRef.current;
                lastSavedRef.current = snapshot;
                if (editsRef.current === editAt) applyDraft(draftOf(body.section));
                setStatus({ kind: "ok", text: (okText ?? "已自动保存") + " · " + timeNow() });
              });
          })
          .catch((error) => {
            setStatus({ kind: "error", text: "自动保存失败：" + (error instanceof Error ? error.message : String(error)) });
          });
      };

      const flushSave = () => {
        const current = draftRef.current;
        if (current === null) return;
        let section;
        try {
          section = sectionOf(current);
        } catch (error) {
          setStatus({ kind: "error", text: "未保存：" + error.message });
          return;
        }
        doSave(section);
      };

      const scheduleSave = () => {
        if (saveTimer.current !== null) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => {
          saveTimer.current = null;
          flushSave();
        }, 600);
      };
      // 卸载时把还在防抖里的改动立即落盘（fire-and-forget）。
      React.useEffect(
        () => () => {
          if (saveTimer.current !== null) {
            clearTimeout(saveTimer.current);
            saveTimer.current = null;
            flushSave();
          }
        },
        [],
      );

      const load = React.useCallback(() => {
        setBusy(true);
        Promise.all([apiGet("/settings"), apiGet("/formats")])
          .then((results) => {
            const settings = results[0];
            if (!isPlainObject(settings.section)) throw new Error("宿主返回的设置段格式错误");
            applyDraft(draftOf(settings.section));
            revisionRef.current = Number.isInteger(settings.revision) ? settings.revision : null;
            try {
              lastSavedRef.current = JSON.stringify(sectionOf(draftOf(settings.section)));
            } catch {
              lastSavedRef.current = null;
            }
            setFormats(Array.isArray(results[1].formats) ? results[1].formats : []);
            setStatus(null);
          })
          .catch((error) => setStatus({ kind: "error", text: "加载设置失败：" + error.message }))
          .then(() => setBusy(false));
      }, []);
      React.useEffect(() => { load(); }, [load]);

      const update = (patch) => {
        setDraft((prev) => {
          const next = Object.assign({}, prev, patch);
          draftRef.current = next;
          editsRef.current += 1;
          scheduleSave();
          return next;
        });
      };

      const clearVault = () => {
        let section;
        try {
          section = sectionOf(Object.assign({}, draftRef.current, { vault: "" }));
        } catch (error) {
          setStatus({ kind: "error", text: "其他字段尚未合法，无法清除：" + error.message });
          return;
        }
        doSave(section, "Vault 已清除（全局与 Vault 内设置文件已同步）");
      };

      const reset = () => {
        setBusy(true);
        apiPost("/settings/reset", {})
          .then((body) => {
            applyDraft(draftOf(body.section));
            revisionRef.current = Number.isInteger(body.revision) ? body.revision : revisionRef.current;
            lastSavedRef.current = null;
            setStatus({ kind: "ok", text: "已恢复默认" });
          })
          .catch((error) => setStatus({ kind: "error", text: "重置失败：" + error.message }))
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
              setStatus(null);
            }
          })
          .catch((e) => setStatus({ kind: "error", text: "打开目录选择器失败：" + (e instanceof Error ? e.message : String(e)) }))
          .then(() => setPicking(false));
      };

      // 清除邮箱 = 立即生效：账号四项与证书/开关清空回默认，自动落盘。
      const clearMail = () => {
        let section;
        try {
          section = sectionOf(Object.assign({}, draftRef.current, { mailAuth: "password", mailHost: "", mailUser: "", mailPassword: "", mailToken: "", mailFolder: "INBOX", mailCaPem: "", mailTlsInsecure: false }));
        } catch (error) {
          setStatus({ kind: "error", text: "其他字段尚未合法，无法清除：" + error.message });
          return;
        }
        doSave(section, "邮箱配置已清除（/ml mail 将重新进入设置引导）");
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
          React.createElement("p", null, status === null ? "正在加载设置…" : status.text));
      }

      return React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
        React.createElement("h3", { style: { margin: "4px 0 8px" } }, "MemoryLeak"),
        React.createElement("div", { key: "Vault 目录", style: { padding: "8px 0", borderBottom: "1px solid rgba(128,128,128,.15)" } },
          React.createElement("span", null, "Vault 目录"),
          React.createElement("p", { style: hintStyle },
            "日志与待办的存放根目录；「浏览…」打开系统目录选择对话框，「清除」立即生效（之后命令会提示先 /ml init）。改动会自动保存并同步到该目录下的 .memoryleak.yaml（vault 路径除外）"),
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
        React.createElement("div", { key: "邮箱（/ml mail）", style: { padding: "10px 0 4px", borderBottom: "1px solid rgba(128,128,128,.15)" } },
          React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 } },
            React.createElement("span", null, "邮箱（/ml mail）"),
            React.createElement("button", {
              onClick: clearMail,
              disabled: busy || (draft.mailHost.trim() === "" && draft.mailUser.trim() === "" && draft.mailPassword === "" && draft.mailToken === "" && draft.mailCaPem === "" && draft.mailTlsInsecure !== true),
              style: { flex: "0 0 auto" },
            }, "清除邮箱配置")),
          React.createElement("p", { style: hintStyle },
            "工作邮件（IMAP），供 /ml mail read 增量阅读。服务器/账号/密码留空 = 未配置（/ml mail 会弹引导）。QQ/163/126 等要在网页版开启 IMAP 并使用「授权码」；密码明文只存 ~/.dsh/settings.yaml（本机），绝不写进 Vault。"),
          row("登陆方式",
            React.createElement("select", {
              value: draft.mailAuth,
              onChange: (event) => update({ mailAuth: event.target.value }),
              style: { minWidth: 180 },
            },
              React.createElement("option", { key: "password", value: "password" }, "密码 / 授权码"),
              React.createElement("option", { key: "xoauth2", value: "xoauth2" }, "OAuth2 access token")),
            "xoauth2 时用 token 代替密码（IMAP XOAUTH2）"),
          row("IMAP 服务器",
            React.createElement("input", {
              value: draft.mailHost,
              onChange: (event) => update({ mailHost: event.target.value }),
              placeholder: "imap.example.com",
              spellCheck: false,
              style: { minWidth: 220 },
            }),
            "只填主机名或 IP（端口另填），如 imap.qq.com / outlook.office365.com"),
          row("端口",
            React.createElement("input", {
              type: "number", min: 1, max: 65535, step: 1,
              value: draft.mailPort,
              onChange: (event) => update({ mailPort: event.target.value === "" ? 0 : Number(event.target.value) }),
              style: inputStyle,
            }),
            "993（TLS）为常规值"),
          row("使用 TLS",
            React.createElement("input", {
              type: "checkbox",
              checked: draft.mailSecure === true,
              onChange: (event) => update({ mailSecure: event.target.checked }),
            }),
            "993 开、143 关"),
          row("邮箱账号",
            React.createElement("input", {
              value: draft.mailUser,
              onChange: (event) => update({ mailUser: event.target.value }),
              placeholder: "me@example.com",
              spellCheck: false,
              style: { minWidth: 220 },
            }),
            "IMAP 登陆用户名（通常为邮箱地址）"),
          draft.mailAuth === "xoauth2"
            ? row("OAuth2 token",
                React.createElement("input", {
                  type: "password",
                  value: draft.mailToken,
                  onChange: (event) => update({ mailToken: event.target.value }),
                  placeholder: "access token",
                  spellCheck: false,
                  style: { minWidth: 220 },
                }),
                "mailAuth=xoauth2 时的访问令牌（代替密码）")
            : row("密码 / 授权码",
                React.createElement("input", {
                  type: "password",
                  value: draft.mailPassword,
                  onChange: (event) => update({ mailPassword: event.target.value }),
                  placeholder: "••••••••",
                  spellCheck: false,
                  autoComplete: "new-password",
                  style: { minWidth: 220 },
                }),
                "授权码 = 网页版邮箱设置里生成的 IMAP 专用码"),
          row("信任的证书",
            React.createElement("textarea", {
              value: draft.mailCaPem,
              onChange: (event) => update({ mailCaPem: event.target.value }),
              rows: 3,
              spellCheck: false,
              style: { minWidth: 240, fontVariantNumeric: "tabular-nums", fontFamily: "monospace", fontSize: 11 },
            }),
            "PEM 格式，可多张；setup 引导选「信任并保存」时自动写入，一般无需手改"),
          row("跳过证书校验",
            React.createElement("input", {
              type: "checkbox",
              checked: draft.mailTlsInsecure === true,
              onChange: (event) => update({ mailTlsInsecure: event.target.checked }),
            }),
            "兜底：不再验证服务器身份（连接仍加密）。一般用不着——setup 引导里就有「跳过证书校验并保存」，此处勾选同样自动保存"),
          row("邮件目录",
            React.createElement("input", {
              value: draft.mailFolder,
              onChange: (event) => update({ mailFolder: event.target.value }),
              placeholder: "INBOX",
              spellCheck: false,
              style: { minWidth: 160 },
            }),
            "IMAP mailbox 名，默认收件箱 INBOX"),
          row("单次最多封数",
            React.createElement("input", {
              type: "number", min: 1, max: 200, step: 1,
              value: draft.mailMaxEmails,
              onChange: (event) => update({ mailMaxEmails: event.target.value === "" ? 0 : Number(event.target.value) }),
              style: inputStyle,
            }),
            "一次 /ml mail read 下载分析的上限，超出保留最新")),
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
            style: status === null ? { color: "rgba(128,128,128,.9)", fontSize: 12 } : {
              color: status.kind === "ok" ? "rgba(46,125,50,.95)" : "rgba(198,40,40,.95)",
              fontSize: 12,
            },
          }, status === null ? "改动自动保存（全局与本 Vault 同步）" : status.text),
          React.createElement("button", { onClick: reset, disabled: busy }, "恢复默认")),
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
    const TODO_ITEM_LINE = /^\s*(\d+)\.\s*([☐☑☒])(?:\s+(\[[^\]]+\]))?\s*(.*)$/;

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
        // 已完成（☑）与已取消（☒）都置灰；完成的加删除线，取消的只置灰
        const done = glyph === "☑";
        const cancelled = glyph === "☒";
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
              color: done || cancelled ? "var(--dsw-alias-label-tertiary)" : "var(--dsw-alias-label-primary)",
              textDecoration: done ? "line-through" : "none",
            },
          }, content === "" ? " " : content));
      }));
    }

    function MlCommandView({ node }) {
      const outcome = node !== null && typeof node === "object" && node.outcome !== undefined ? node.outcome : null;
      const rootRef = React.useRef(null);
      // 命令完成时自动把会话滚到底：官方的滚动跟随只认「用户消息 /
      // steering / 读者本就在底部」，命令结果不在其列 —— /ml view 出内容
      // 后常停在原位，要手点一下才下去。只在本组件存活期间观察到
      // 「运行中 → 完成」的跃迁时触发一次；挂载时已完成的（翻历史被
      // 虚拟化重挂载）不触发，避免把正在回看的用户拽到底部。scrollTop
      // 赋值会触发官方 onScroll 监听，自动完成「钉到底」状态的重算。
      const settledRef = React.useRef(outcome !== null);
      React.useEffect(() => {
        if (outcome === null || settledRef.current) return;
        settledRef.current = true;
        const root = rootRef.current;
        const scroller = root !== null
          ? root.closest("[data-conversation-scroll]")
          : document.querySelector("[data-conversation-scroll]");
        if (scroller === null || scroller === undefined) return;
        scroller.scrollTop = scroller.scrollHeight;
      }, [outcome]);
      const header = "/ml" + (typeof node?.args === "string" && node.args !== "" ? node.args : "");
      const captionStyle = {
        color: "var(--dsw-alias-label-tertiary)",
        fontSize: 12,
        margin: "0 0 2px 4px",
      };
      if (outcome === null) {
        return React.createElement("div", { ref: rootRef },
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
      return React.createElement("div", { ref: rootRef },
        React.createElement("div", { style: captionStyle }, header),
        body);
    }

    /* ---------------- MemoryLeak 工具卡片（tool.call.toolview）----------------
       /ml note·ask·mail 的真实模型工具（memory_*）在会话里用统一的紧凑行
       展示：「MemoryLeak 邮件工具 · 增量读取新邮件」这样的形态，替代通用
       卡的「Tool call + 原始 JSON」。与官方 ui-skill 的 SkillRow 同款契约：
       按工具名注册 keyed toolview，行模型只从冻结的调用/结果切片派生
       （running 无 kind，settled 有 kind），展开看结果全文。样式自包含，
       不依赖 primitives 包。 */
    const ML_TOOL_STYLE_ID = "dsh-memoryleak/tool-row";
    if (typeof document !== "undefined" && document.querySelector('style[data-ml-style="' + ML_TOOL_STYLE_ID + '"]') === null) {
      const style = document.createElement("style");
      style.dataset.mlStyle = ML_TOOL_STYLE_ID;
      style.textContent = [
        ".ml-tool-card{display:flex;flex-direction:column}",
        ".ml-tool-row{position:relative;display:flex;align-items:center;overflow:hidden;height:24px;min-width:0}",
        ".ml-tool-row[data-expandable]{cursor:pointer}",
        ".ml-tool-card[data-state=running] .ml-tool-row:after{content:'';position:absolute;inset:0 auto 0 0;width:300px;pointer-events:none;background:linear-gradient(90deg,transparent 0%,color-mix(in srgb,var(--dsw-alias-bg-base) 60%,transparent) 55%,transparent 100%);animation:ml-tool-row-sweep 2.6s ease-out infinite}",
        "@keyframes ml-tool-row-sweep{0%{left:-300px}90%,100%{left:100%}}",
        ".ml-tool-leading{position:relative;display:inline-flex;align-items:center;justify-content:center;flex:none;width:16px;height:16px;margin-right:6px;color:var(--dsw-alias-label-tertiary)}",
        ".ml-tool-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-caption)}",
        ".ml-tool-dot[data-state=error]{background:var(--dsw-alias-state-error-primary)}",
        ".ml-tool-dot[data-state=stopped]{background:var(--dsw-alias-state-warning-primary,var(--dsw-alias-state-error-primary))}",
        ".ml-tool-title{flex:none;color:var(--dsw-alias-label-secondary);font-size:14px;line-height:24px}",
        ".ml-tool-sep{flex:none;width:2px;height:2px;margin:0 8px;border-radius:1px;background:var(--dsw-alias-label-caption)}",
        ".ml-tool-summary{flex:auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:14px;line-height:24px}",
        ".ml-tool-summary[data-error]{color:var(--dsw-alias-state-error-primary)}",
        ".ml-tool-visually-hidden{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}",
        ".ml-tool-body{display:flex;flex-direction:column}",
        ".ml-tool-output-card{display:flex;flex-direction:column;max-height:260px;margin:4px 0 4px 4px;overflow:hidden;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-markdown-code-block)}",
        ".ml-tool-output-header{padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-markdown-code-block-banner);color:var(--dsw-alias-label-caption);font-size:12px}",
        ".ml-tool-output{margin:0;padding:8px 10px;overflow:auto;color:var(--dsw-alias-label-primary);font-family:var(--dsw-alias-font-mono,monospace);font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-word}",
        ".ml-tool-inspect{display:inline-flex;align-items:center;gap:4px;align-self:flex-end;margin:0 4px 4px;padding:2px 8px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer}",
        ".ml-tool-inspect:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ].join("\n");
      document.head.appendChild(style);
    }

    /** 各工具的卡片标题与收起摘要（摘要优先取调用参数里的对应字段）。 */
    const ML_TOOL_META = {
      memory_note_context: { title: "MemoryLeak 笔记工具", summary: "读取存量登记与记录约定" },
      memory_note_write: { title: "MemoryLeak 笔记工具", summary: "提交整理结果", summaryArg: "summary" },
      memory_ask_gather: { title: "MemoryLeak 问答工具", summary: "汇集 Vault 资料", summaryArg: "question" },
      memory_mail_fetch: { title: "MemoryLeak 邮件工具", summary: "增量读取新邮件" },
      memory_mail_commit: { title: "MemoryLeak 邮件工具", summary: "推进读信进度" },
    };

    function mlFirstLine(text) {
      const index = String(text).indexOf("\n");
      return index === -1 ? String(text) : String(text).slice(0, index);
    }

    /** 展平结果块为展示文本（与官方 ui-tool 的 resultText 契约一致）。 */
    function mlToolResultText(block) {
      if (typeof block !== "object" || block === null || !("kind" in block)) return null;
      const parts = [];
      const content = Array.isArray(block.content) ? block.content : [];
      for (const item of content) parts.push(item && item.type === "text" ? item.text : JSON.stringify(item, null, 2));
      if (parts.length === 0 && block.error !== undefined) parts.push(block.error.name + ": " + block.error.code);
      return parts.join("\n") || null;
    }

    /** 行模型：只从冻结的调用/结果切片派生（running 无 kind；settled 有 kind）。 */
    function mlToolRowModel(toolName, block) {
      const meta = ML_TOOL_META[toolName] || { title: "MemoryLeak 工具", summary: "" };
      const settled = typeof block === "object" && block !== null && "kind" in block;
      const argsRaw = (settled ? (block.call && block.call.argsRaw) : block && block.argsRaw) || "";
      const state = !settled
        ? "running"
        : block.error && block.error.code === "interrupted"
          ? "stopped"
          : block.isError ? "error" : "ok";
      const output = settled ? mlToolResultText(block) : null;
      let argSummary = null;
      if (meta.summaryArg && argsRaw !== "") {
        try {
          const parsed = JSON.parse(argsRaw);
          if (parsed !== null && typeof parsed === "object" && typeof parsed[meta.summaryArg] === "string" && parsed[meta.summaryArg] !== "") {
            argSummary = mlFirstLine(parsed[meta.summaryArg]);
          }
        } catch { /* 参数不是 JSON：退回静态摘要 */ }
      }
      return {
        title: meta.title,
        summary: argSummary || meta.summary,
        output,
        state,
        errorSummary: state === "error" && output !== null ? mlFirstLine(output) : null,
      };
    }

    /**
     * MemoryLeak 工具的紧凑卡片行：收起 = 标题 · 摘要（错误时摘要替换为
     * 错误首行）；运行中带扫光与「正在调用 …」隐藏播报；结果可展开看全文。
     */
    function MemoryLeakToolRow(props) {
      const model = mlToolRowModel(props.toolName, props.block);
      const expanded = React.useState(false);
      const setExpanded = expanded[1];
      const expandable = model.output !== null;
      const open = expanded[0] && expandable;
      const toggle = () => setExpanded((value) => !value);
      const toggleFromKeyboard = (event) => {
        if (!expandable || (event.key !== "Enter" && event.key !== " ")) return;
        event.preventDefault();
        toggle();
      };
      const status = model.state === "running"
        ? "正在调用 " + model.title
        : model.state === "error" ? "MemoryLeak 工具调用失败"
        : model.state === "stopped" ? "MemoryLeak 工具调用已中止"
        : null;
      const summaryText = model.errorSummary !== null ? model.errorSummary : model.summary;
      const disclosureProps = expandable
        ? {
            role: "button",
            tabIndex: 0,
            "aria-expanded": open,
            onClick: toggle,
            onKeyDown: toggleFromKeyboard,
          }
        : {};
      const children = [
        React.createElement("span", { key: "lead", className: "ml-tool-leading" },
          React.createElement("span", { className: "ml-tool-dot", "data-state": model.state })),
        status !== null
          ? React.createElement("span", { key: "status", className: "ml-tool-visually-hidden" }, status)
          : null,
        React.createElement("span", { key: "title", className: "ml-tool-title" }, model.title),
        React.createElement("span", { key: "sep", className: "ml-tool-sep", "aria-hidden": "true" }),
        React.createElement("span", {
          key: "summary",
          className: "ml-tool-summary",
          "data-error": model.errorSummary !== null || undefined,
        }, summaryText),
      ];
      const body = open
        ? React.createElement("div", { key: "body", className: "ml-tool-body" },
            React.createElement("section", { className: "ml-tool-output-card", "aria-label": model.title },
              React.createElement("div", { className: "ml-tool-output-header" }, "工具输出"),
              React.createElement("pre", {
                className: "ml-tool-output",
                "data-error": model.state === "error" || undefined,
              }, model.output)),
            typeof props.inspect === "function"
              ? React.createElement("button", { type: "button", className: "ml-tool-inspect", onClick: props.inspect }, "Inspect")
              : null)
        : null;
      return React.createElement("div",
        {
          className: "ml-tool-card",
          "data-tool": props.toolName,
          "data-state": model.state,
        },
        React.createElement("div", {
          className: "ml-tool-row",
          "data-expandable": expandable || undefined,
          ...disclosureProps,
        }, children.filter((child) => child !== null)),
        body);
    }

    function mlRegisterToolViews(ctx) {
      for (const toolName of Object.keys(ML_TOOL_META)) {
        ctx.slots.inject("tool.call.toolview", () => ctx.slots.register(
          { name: "tool.call.toolview", key: toolName },
          (props) => React.createElement(MemoryLeakToolRow, props),
        ));
      }
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
        fontSize: 11,
        lineHeight: "16px",
        padding: "5px 10px 4px",
        borderBottom: "1px solid var(--dsw-alias-border-l1)",
        flex: "0 0 auto",
      };
      const rowStyle = (isActive) => ({
        display: "flex",
        justifyContent: "space-between",
        gap: 8,
        alignItems: "center",
        minHeight: 26,
        padding: "3px 10px",
        fontSize: 13,
        lineHeight: "20px",
        cursor: "pointer",
        width: "100%",
        textAlign: "left",
        background: isActive ? "var(--dsw-alias-interactive-bg-hover)" : "transparent",
        border: "none",
        borderRadius: 7,
        color: "var(--dsw-alias-label-primary)",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      });
      const metaStyle = { color: "var(--dsw-alias-label-tertiary)", fontSize: 11, lineHeight: "16px", flex: "0 0 auto" };

      const statusRow = (text, isError) => React.createElement("div", {
        style: {
          color: isError ? "var(--dsw-alias-state-error-primary)" : "var(--dsw-alias-label-dimmed)",
          fontSize: 13,
          lineHeight: "20px",
          minHeight: 26,
          display: "flex",
          alignItems: "center",
          padding: "3px 10px",
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

    /** 交互流程（todo 新增等）结束后把焦点还给主输入框：选日期/点选项会把
     *  焦点带进卡片，流程一结束用户的下一动作几乎总是继续打字。
     *  textarea[data-phase] 是官方输入框的稳定锚点；卡片卸载与输入区恢复
     *  存在时序差，rAF + 两段兜底重试（只在元素可用时聚焦，不抢禁用态）。 */
    function mlFocusMainInput() {
      const focus = () => {
        const area = document.querySelector("textarea[data-phase]");
        if (area !== null && area.disabled !== true) area.focus();
      };
      requestAnimationFrame(focus);
      setTimeout(focus, 80);
      setTimeout(focus, 300);
    }

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
        // 日期轮是 todo 新增的最后一问：流程结束，焦点还给输入框。
        mlFocusMainInput();
      });
      const cancelWait = () => settle(async () => {
        const receipt = await wait.respond({
          ok: false,
          error: { code: "cancelled", message: "the user closed this question request", details: {} },
        });
        if (receipt !== null && typeof receipt === "object" && receipt.accepted === false) {
          throw new Error("取消被宿主拒绝：" + String(receipt.reason ?? "未知原因"));
        }
        mlFocusMainInput();
      });

      const shortcuts = [
        { key: "today", label: "今天", date: today },
        { key: "tomorrow", label: "明天", date: mlAddDays(today, 1) },
        { key: "week", label: "本周", date: mlEndOfWeek(today) },
        { key: "month", label: "本月", date: mlEndOfMonth(today) },
      ];

      const shiftMonth = (delta) => setView((current) => {
        const next = new Date(current.year, current.month + delta, 1);
        return { year: next.getFullYear(), month: next.getMonth() };
      });

      // 键盘：Esc 取消（capture 拦截；IME 组合中不拦）；数字 1-4 选快捷
      // 日期（今天/明天/本周/本月）、←/→ 切月。焦点在文本输入类元素上时
      // 只保留 Esc（不吞打字）。
      React.useEffect(() => {
        if (busy) return undefined;
        const onKey = (ev) => {
          if (ev.isComposing === true) return;
          if (ev.key === "Escape") {
            ev.preventDefault();
            ev.stopPropagation();
            cancelWait();
            return;
          }
          const target = ev.target;
          if (target !== null && typeof target === "object" && (
            target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable === true
          )) return;
          if (/^[1-9]$/.test(ev.key)) {
            const shortcut = shortcuts[Number(ev.key) - 1];
            if (shortcut !== undefined) { ev.preventDefault(); answerWith(shortcut.date); }
            return;
          }
          if (ev.key === "ArrowLeft") { ev.preventDefault(); shiftMonth(-1); return; }
          if (ev.key === "ArrowRight") { ev.preventDefault(); shiftMonth(1); }
        };
        document.addEventListener("keydown", onKey, true);
        return () => document.removeEventListener("keydown", onKey, true);
      });

      // 兜底：载体形态不符（理论上 select 已拦）不渲染 —— 让位通用 UI
      // 兜底比渲染一个空壳更安全。放在全部 hook 之后，保证 hook 数稳定。
      if (wait === null || typeof wait !== "object" || question === null || typeof question !== "object") return null;

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
              shortcuts.map((shortcut, index) => React.createElement("button", {
                key: shortcut.key, type: "button", style: shortcutStyle, className: "ml-date-shortcut",
                disabled: busy, onClick: () => answerWith(shortcut.date),
                title: mlIsoDate(shortcut.date) + "（快捷键 " + (index + 1) + "）",
              },
                React.createElement("span", null, (index + 1) + " · " + shortcut.label),
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
              error !== null ? error : "数字键选快捷日期 · ←→ 切月 · 点击日历选日 · Esc 取消"),
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
        // anytime 到此流程结束 → 焦点还给输入框；deadline/sleep 还有日期轮，
        // 焦点保持游离（日期卡的键盘监听在 document 上，不依赖焦点，
        // 且聚焦输入框反而会让数字键打进草稿、被输入守卫跳过）。
        if (t === "anytime") mlFocusMainInput();
      });
      const cancelWait = () => settle(async () => {
        const receipt = await wait.respond({
          ok: false,
          error: { code: "cancelled", message: "the user closed this question request", details: {} },
        });
        if (receipt !== null && typeof receipt === "object" && receipt.accepted === false) {
          throw new Error("取消被宿主拒绝：" + String(receipt.reason ?? "未知原因"));
        }
        mlFocusMainInput();
      });

      // 选项与选择函数先于键盘 effect（effect 每次渲染重挂，闭包取最新值）。
      const optionsOf = (q) => (Array.isArray(q.options) ? q.options.filter((o) => o !== null && typeof o === "object" && typeof o.label === "string") : []);
      const typeOptions = typeQ === null ? [] : optionsOf(typeQ);
      const prioOptions = prioQ === null ? [] : optionsOf(prioQ);
      // 字母快捷键（label 首字母派生：deadline→d / sleep→s / anytime→a、
      // urgent→u / medium→m / low→l；两组字母天然不冲突）。
      const labelKeyOf = (label) => {
        const first = String(label).toLowerCase().charAt(0);
        return /^[a-z]$/.test(first) ? first : "";
      };
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

      // 键盘：Esc 取消（capture 拦截；IME 组合中不拦）；数字 1-9 或字母
      // （首字母，先匹配类型、再匹配优先级）选类型，字母选重要程度；
      // 焦点在文本输入类元素上时只保留 Esc（不吞打字）。
      React.useEffect(() => {
        if (busy) return undefined;
        const onKey = (ev) => {
          if (ev.isComposing === true) return;
          if (ev.key === "Escape") {
            ev.preventDefault();
            ev.stopPropagation();
            cancelWait();
            return;
          }
          const target = ev.target;
          if (target !== null && typeof target === "object" && (
            target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable === true
          )) return;
          const key = ev.key.toLowerCase();
          if (key.length !== 1) return;
          if (/^[1-9]$/.test(key)) {
            const option = typeOptions[Number(key) - 1];
            if (option !== undefined) { ev.preventDefault(); chooseType(option.label); }
            return;
          }
          if (/^[a-z]$/.test(key)) {
            const type = typeOptions.find((o) => labelKeyOf(o.label) === key);
            if (type !== undefined) { ev.preventDefault(); chooseType(type.label); return; }
            const prio = prioOptions.find((o) => labelKeyOf(o.label) === key);
            if (prio !== undefined) { ev.preventDefault(); choosePrio(prio.label); }
          }
        };
        document.addEventListener("keydown", onKey, true);
        return () => document.removeEventListener("keydown", onKey, true);
      });

      // 兜底：载体形态不符（理论上 select 已拦）不渲染。放在全部 hook
      // 之后，保证 hook 数稳定。
      if (wait === null || typeof wait !== "object" || typeQ === null || prioQ === null) return null;
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
      // 字母快捷键角标样式（类型行与优先级 chip 共用）
      const keyHintStyle = { color: "var(--dsw-alias-label-tertiary)", fontWeight: 400, marginRight: 4 };

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
              typeOptions.map((option, index) => {
                const keyHint = labelKeyOf(option.label);
                return React.createElement("button", {
                  key: option.label, type: "button", style: rowStyle(option.label === typeLabel), className: "ml-intro-option",
                  role: "radio", "aria-checked": option.label === typeLabel, disabled: busy,
                  onClick: () => chooseType(option.label),
                  title: keyHint !== "" ? "快捷键 " + (index + 1) + " 或 " + keyHint : undefined,
                },
                  React.createElement("span", { style: numberStyle }, String(index + 1)),
                  React.createElement("span", { style: rowLabelStyle },
                    keyHint !== "" ? React.createElement("span", { style: keyHintStyle }, keyHint) : null,
                    option.label),
                  typeof option.description === "string" ? React.createElement("span", { style: rowDescStyle }, option.description) : null);
              })),
            React.createElement("div", { style: groupLabelStyle }, prioTitle),
            React.createElement("div", { style: chipsStyle, role: "radiogroup", "aria-label": prioTitle },
              prioOptions.map((option) => {
                const keyHint = labelKeyOf(option.label);
                return React.createElement("button", {
                  key: option.label, type: "button", style: chipStyle(option.label === prioLabel), className: "ml-intro-option",
                  role: "radio", "aria-checked": option.label === prioLabel, disabled: busy,
                  onClick: () => choosePrio(option.label),
                  title: keyHint !== "" ? "快捷键 " + keyHint : undefined,
                },
                  React.createElement("span", { style: rowLabelStyle },
                    keyHint !== "" ? React.createElement("span", { style: keyHintStyle }, keyHint) : null,
                    option.label),
                  typeof option.description === "string" ? React.createElement("span", { style: chipDescStyle }, option.description) : null);
              }))),
          React.createElement("footer", { style: ML_FOOTER_STYLE },
            React.createElement("span", { style: error !== null ? ML_ERROR_STYLE : ML_HINT_STYLE, role: "status" },
              error !== null ? error : "数字 1/2/3 或字母 d/s/a 选类型 · 字母 u/m/l 选重要程度 · 选完自动提交 · Esc 取消"),
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
        fontSize: 11, lineHeight: "16px",
        padding: "5px 10px 4px",
        borderBottom: "1px solid var(--dsw-alias-border-l1)",
        flex: "0 0 auto",
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
      };
      const rowItemStyle = (isActive) => ({
        width: "100%", minHeight: 26, display: "flex", alignItems: "center", gap: 8,
        cursor: "pointer", textAlign: "left", border: "none",
        background: isActive ? "var(--dsw-alias-interactive-bg-hover)" : "transparent",
        borderRadius: 7, padding: "3px 10px", color: "var(--dsw-alias-label-primary)",
        fontSize: 13, lineHeight: "20px",
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

    /* ---------------- /ml mail 设置引导卡 ----------------
       宿主在邮箱未配置（或 /ml mail setup）时发出三问批次（id 固定为
       ml-mail-host / ml-mail-user / ml-mail-secret，src/mail.js 的
       ML_MAIL_*_ID，两处必须同步改）。这里认领渲染成一张表单卡：
       服务器 / 账号 / 密码或授权码三个输入（密码框遮蔽），Enter 在末
       字段直接提交。答案走通用 respond 协议（三项 custom）；留空提交
       = 宿主侧「沿用当前值」。其余环境（TUI/原生）走通用逐题问答。 */
    const ML_MAIL_HOST_ID = "ml-mail-host";
    const ML_MAIL_USER_ID = "ml-mail-user";
    const ML_MAIL_SECRET_ID = "ml-mail-secret";
    const ML_MAIL_LABELS = {};
    ML_MAIL_LABELS[ML_MAIL_HOST_ID] = "IMAP 服务器";
    ML_MAIL_LABELS[ML_MAIL_USER_ID] = "邮箱账号";
    ML_MAIL_LABELS[ML_MAIL_SECRET_ID] = "密码 / 授权码";

    /** chain select：只认领「ml-mail-host + ml-mail-user + ml-mail-secret 三问同批」。 */
    function mlSelectMailSetup(owner) {
      const interactions = owner !== null && typeof owner === "object" && Array.isArray(owner.interactions) ? owner.interactions : [];
      for (const interaction of interactions) {
        if (interaction === null || typeof interaction !== "object" || interaction.kind !== "question") continue;
        const questions = interaction.payload !== null && typeof interaction.payload === "object" && Array.isArray(interaction.payload.questions)
          ? interaction.payload.questions
          : [];
        if (questions.length !== 3) continue;
        const ids = questions.map((q) => (q !== null && typeof q === "object" ? q.id : ""));
        if (ids.includes(ML_MAIL_HOST_ID) && ids.includes(ML_MAIL_USER_ID) && ids.includes(ML_MAIL_SECRET_ID)) {
          return interaction;
        }
      }
      return null;
    }

    function MlMailSetupComposer({ matched }) {
      const wait = matched;
      const questions = wait !== null && typeof wait === "object" && wait.payload !== null && typeof wait.payload === "object" && Array.isArray(wait.payload.questions)
        ? wait.payload.questions.filter((q) => q !== null && typeof q === "object")
        : [];
      const [values, setValues] = React.useState({});
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);

      const fields = questions.map((question) => ({
        id: question.id,
        label: ML_MAIL_LABELS[question.id] || (typeof question.question === "string" ? question.question : question.id),
        secret: question.id === ML_MAIL_SECRET_ID,
      }));

      const setValue = (id, text) => setValues((prev) => Object.assign({}, prev, { [id]: text }));

      const settle = (send) => {
        setBusy(true);
        setError(null);
        send().catch((cause) => {
          setBusy(false);
          setError(cause instanceof Error ? cause.message : String(cause));
        });
      };
      const submit = () => settle(async () => {
        const missing = fields.filter((field) => String(values[field.id] ?? "").trim() === "").map((field) => field.label);
        // 首次配置三项都必填；沿用当前值的「留空」语义只在已有配置时成立
        // ——宿主会裁决（留空且无当前值 → 报错），这里只在全空时提示。
        if (fields.length > 0 && missing.length === fields.length) {
          throw new Error("先填一下（服务器 / 账号 / 密码或授权码）再提交");
        }
        const receipt = await wait.respond({
          ok: true,
          value: {
            sessionId: wait.sessionId,
            answer: { answers: fields.map((field) => ({ id: field.id, selected: [], custom: String(values[field.id] ?? "").trim() })) },
          },
        });
        if (receipt !== null && typeof receipt === "object" && receipt.accepted === false) {
          throw new Error("答案被宿主拒绝：" + String(receipt.reason ?? "未知原因"));
        }
        mlFocusMainInput();
      });
      const cancelWait = () => settle(async () => {
        const receipt = await wait.respond({
          ok: false,
          error: { code: "cancelled", message: "the user closed this question request", details: {} },
        });
        if (receipt !== null && typeof receipt === "object" && receipt.accepted === false) {
          throw new Error("取消被宿主拒绝：" + String(receipt.reason ?? "未知原因"));
        }
        mlFocusMainInput();
      });

      // Esc 取消（capture 拦截；IME 组合中不拦）。
      React.useEffect(() => {
        if (busy) return undefined;
        const onKey = (ev) => {
          if (ev.isComposing === true) return;
          if (ev.key === "Escape") {
            ev.preventDefault();
            ev.stopPropagation();
            cancelWait();
          }
        };
        document.addEventListener("keydown", onKey, true);
        return () => document.removeEventListener("keydown", onKey, true);
      });

      // 兜底：载体形态不符不渲染（hook 之后 return，保证 hook 数稳定）。
      if (wait === null || typeof wait !== "object" || fields.length !== 3) return null;

      const inputStyle = {
        width: "100%", minHeight: 34, padding: "5px 12px",
        border: "1px solid var(--dsw-alias-border-l1)", borderRadius: 10,
        background: "var(--dsw-specific-input-major)", color: "var(--dsw-alias-label-primary)",
        fontSize: 14, lineHeight: "21px",
      };
      const fieldStyle = { display: "flex", flexDirection: "column", gap: 4, marginBottom: 10 };
      const labelStyle = { color: "var(--dsw-alias-label-secondary)", fontSize: 12, lineHeight: "16px" };
      const primaryBtnStyle = {
        flexShrink: 0, minHeight: 28, padding: "0 14px", cursor: "pointer",
        background: "transparent", border: "1px solid var(--dsw-alias-border-l1)",
        borderRadius: 8, fontSize: 13, lineHeight: "20px", color: "var(--dsw-alias-label-primary)",
      };
      const onFieldKey = (ev, index) => {
        if (ev.isComposing === true) return;
        if (ev.key === "Enter") {
          ev.preventDefault();
          if (index === fields.length - 1) submit();
        }
      };

      return React.createElement("div", { style: ML_FRAME_STYLE, "data-ml-mail-question": wait.key },
        React.createElement("section", { style: ML_CARD_STYLE, "aria-label": "配置邮箱" },
          React.createElement("header", { style: ML_HEADER_STYLE },
            React.createElement("div", null,
              React.createElement("div", { style: ML_EYEBROW_STYLE }, "MemoryLeak 邮箱"),
              React.createElement("h2", { style: ML_TITLE_STYLE }, "配置工作邮箱（IMAP）")),
            React.createElement("button", {
              type: "button", style: ML_CLOSE_BTN_STYLE, className: "ml-mail-cancel",
              "aria-label": "取消", title: "取消（Esc）", disabled: busy, onClick: cancelWait,
            }, "✕")),
          React.createElement("div", { style: ML_BODY_STYLE, "data-ml-mail-scroll": true },
            fields.map((field, index) => React.createElement("div", { key: field.id, style: fieldStyle },
              React.createElement("label", { style: labelStyle, htmlFor: "ml-mail-" + field.id }, field.label),
              React.createElement("input", {
                id: "ml-mail-" + field.id,
                type: field.secret ? "password" : "text",
                style: inputStyle,
                className: "ml-mail-input",
                value: String(values[field.id] ?? ""),
                autoFocus: index === 0,
                spellCheck: false,
                autoComplete: field.secret ? "new-password" : "off",
                disabled: busy,
                placeholder: field.id === ML_MAIL_HOST_ID ? "imap.example.com" : field.id === ML_MAIL_USER_ID ? "me@example.com" : "••••••••",
                onChange: (event) => setValue(field.id, event.target.value),
                onKeyDown: (ev) => onFieldKey(ev, index),
              }))),
            React.createElement("p", { style: ML_HINT_STYLE },
              "QQ / 163 / 126 等邮箱：先在网页版设置里开启 IMAP，密码处填生成的「授权码」。端口 / TLS / 邮件目录 / OAuth2 在 GUI 设置 → MemoryLeak 里改。")),
          React.createElement("footer", { style: ML_FOOTER_STYLE },
            React.createElement("span", { style: error !== null ? ML_ERROR_STYLE : ML_HINT_STYLE, role: "status" },
              error !== null ? error : "Enter 提交（末字段）· 已有配置留空 = 沿用当前值 · Esc 取消"),
            React.createElement("div", { style: { display: "flex", gap: 8 } },
              React.createElement("button", {
                type: "button", style: ML_CANCEL_BTN_STYLE, className: "ml-mail-cancel",
                disabled: busy, onClick: cancelWait,
              }, busy ? "处理中…" : "取消"),
              React.createElement("button", {
                type: "button", style: primaryBtnStyle, className: "ml-mail-confirm",
                disabled: busy, onClick: submit,
              }, busy ? "验证中…" : "保存并试登陆")))));
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

      // /ml mail 设置引导（ml-mail-host + ml-mail-user + ml-mail-secret 三问
      // 批次）：接管渲染成一张表单卡（密码遮蔽输入，Enter 末字段直接提交）。
      ctx.slots.inject("conversation.composer", () => ctx.slots.register(
        { name: "conversation.composer", priority: -100, select: mlSelectMailSetup },
        MlMailSetupComposer
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

      // memory_* 真实模型工具的统一紧凑卡片（替代通用卡的「Tool call」行）。
      mlRegisterToolViews(ctx);
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
