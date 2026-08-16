发布材料就绪。以下是发布到 dsh-market 的完整步骤（分三步：推 GitHub → 提交收录 PR → 可选发 npm）。

## ✅ 已完成的发布准备（提交 0492326，240 测试全绿）

| 收录要求 | 状态 |
| --- | --- |
| `dsh.bundle` manifest + cordis.patch.yml | ✅ 一直就有 |
| 真实可用代码 | ✅ 26 提交、240 测试、全功能 |
| 仓库 ≥1 天 + ≥10 提交 | ✅ 26 个提交，仓库已满一天 |
| repository.url 真实 | ✅ 已从 example 占位改为 `github.com/warmwine/dsh-memoryleak` |
| schemastery → peerDependencies | ✅ 已改（收录指南建议，官方包同款） |
| files 白名单 | ✅ npm pack 验证：27 文件 / 55KB，test 与杂物排除 |
| 干净安装验证 | ✅ 空目录全新 `pnpm add` 成功，关键文件全在位 |

## 你需要做的三步

### 第 1 步：推送 + 加 topic（必需）

```bash
cd E:\workspace\nodejs\dsh-memoryleak
git push origin main          # 若上次强推没做，这次普通 push 即可
```

然后到 https://github.com/warmwine/dsh-memoryleak 页面右侧 ⚙ About → **Topics 添加 `dsh-plugin`**（CI 会检查这个 topic）。

### 第 2 步：提交收录 PR（必需）

到 https://github.com/awesome-dsh-plugin/awesome-dsh-plugin **Fork 后新建文件** `data/plugins/warmwine__dsh-memoryleak.yml`，内容：

```yaml
url: https://github.com/warmwine/dsh-memoryleak
name: warmwine/dsh-memoryleak
category: memory
description:
  en: 'Local journal and structured todos as plain Markdown in your workspace: /ml quick-notes, deadline/sleep/anytime todos with auto-wakeup, and fuzzy quick-open — all zero-token slash commands.'
  zh: '本地日志与结构化待办，纯 Markdown 落在工作区：/ml 随手记、deadline/sleep/anytime 待办（到日自动唤醒）、模糊快速打开——全部零 token 斜杠命令。'
```

> 分类说明：`memory` 语义上是"记忆/上下文管理"（现有条目如 dsh-auto-memory）。若你更倾向工具增强，把 `category` 改成 `tools` 也合规——二选一。

然后按仓库要求在本地跑生成脚本并一并提交（或者 PR 描述里注明 maintainer 代跑——CI 失败时它会在 PR 里提示你跑）：

```bash
npm ci
node scripts/generate-readme.mjs
```

CI 会自动检查：manifest ✅ / 提交数 ✅ / 双语描述 ✅。合并后通常一天内上架市场。

### 第 3 步（推荐）：发 npm

市场对 npm 包走预构建安装（秒装、免构建授权）。发布前最后确认 npm 名字可用：

```bash
npm whoami          # 确认已登录
npm publish         # 在仓库根目录执行；files 白名单已验证
```

发布后 PR 里可补 `npm: dsh-memoryleak` 字段（或它会被 registry 自动识别）。如果不想发 npm，也可以在 GitHub Release 挂 tarball 并加 `tarball:` 字段——但直接 `github:warmwine/dsh-memoryleak` 源码安装对无构建的本插件同样成立（link: 验证已通过同构路径）。

## 市场详情页截图（可选加分项）

在 awesome-dsh-plugin 仓库的 `data/screenshots.json` 加：

```json
"https://github.com/warmwine/dsh-memoryleak": [
  "https://raw.githubusercontent.com/warmwine/dsh-memoryleak/main/assets/screenshot-1.png"
]
```

需要先在你的仓库建 `assets/` 放截图（比如设置窗口、实时候选卡、TUI 列表三张）——不提交也没关系，市场会自动从 README 抽图。

需要我帮你把 PR 的 YAML、生成脚本输出或截图素材再打磨一版，随时说。
