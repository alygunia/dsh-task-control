# dsh-task-control

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

[English](README.en.md) | 中文

<p align="center">
  <img src="fig/dsh-task-control-hero-v2.png" alt="dsh-task-control 鲸鱼娘宣传图" width="720">
</p>

为 DSH Web 增加任务**暂停、恢复和取消**能力。支持安全暂停与强制暂停，恢复时从暂停点继续，不重复已完成的工作。

当前适配 DSH v0.1.5-rc.2（`@deepseek-ai/dsh` CLI 0.1.5-rc.1，内核包 0.1.5-rc.2）。

## 安装

```bash
dsh plugin --profile web add github:p2coder/dsh-task-control
```

安装后请**完整重启 dsh web**，然后刷新浏览器页面。

## 快速使用

任务运行时，输入框旁会显示三个常驻按钮：

| 按钮 | 作用 | 可用状态 |
|---|---|---|
| ⏸ 暂停 | 按默认粒度暂停任务 | 运行中 |
| ▶ 恢复 | 从暂停点继续 | 已暂停 |
| ⏹ 取消 | 立即终止当前回合 | 运行中或已暂停 |

灰色按钮表示当前不可用，黑色按钮表示可点击。

![暂停、恢复、取消按钮的位置与状态](fig/button%20illustrate.png)

## 暂停模式

| 模式 | 行为 | 适合场景 |
|---|---|---|
| `safe wait`（默认） | 等待推理和工具自然完成后暂停 | 长任务、迁移、测试 |
| `safe stop` | 工具完成后暂停；可中断当前推理 | 希望更快暂停 |
| `force` | 立即中断推理及在途工具 | 紧急停止 |

在「设置 → 任务控制」中修改默认模式，保存后立即生效：

![任务暂停粒度配置步骤](fig/Task%20pause%20granularity%20configuration.png)

## 命令

| 命令 | 说明 |
|---|---|
| `/pause` | 按设置中的默认模式暂停 |
| `/pause force` | 强制暂停 |
| `/pause safe wait` | 安全暂停，不中断推理 |
| `/pause safe stop` | 安全暂停，可中断推理 |
| `/resume` | 恢复任务 |
| `/resume confirm rerun` | 重新执行被中断或未派发的工具后恢复 |
| `/resume confirm skip` | 跳过该工具后恢复 |
| `/cancel` | 取消当前回合 |

![通过斜杠命令调用任务控制](fig/commond%20illustrate.png)

## 供其他插件调用

通过 `ctx.get("taskControl")` 获取服务：

| API | 作用 |
|---|---|
| `pause(sessionId, options?)` | 暂停任务 |
| `resume(sessionId, options?)` | 恢复任务 |
| `cancel(sessionId)` | 取消任务 |
| `state(sessionId)` | 查询 `idle`、`running` 或 `offline` 状态及暂停信息 |

暂停状态保存在 `~/.dsh/task-control/`，重启后不会丢失。测试时可用 `DSH_TASK_CONTROL_STATE_DIR` 修改存储目录。

## 注意事项

| 情况 | 说明 |
|---|---|
| 强制暂停 | 工具可能已产生部分副作用；恢复前可选择重新执行、跳过或保持暂停 |
| `safe wait` 的未派发工具 | 恢复时需要选择重新执行或跳过 |
| 暂停期间发送新消息 | 会开启新回合；暂停只控制当前回合 |
| 定时提醒 | `dsh-schedule` 到期后仍会唤醒 |
| 子代理 | 已派发的子代理不会被父任务暂停 |
| 状态同步 | 浏览器在“运行中或已暂停”时每 2 秒轮询一次（空闲且未暂停时不轮询，页面隐藏时暂停轮询）；修改插件后需重启 dsh web |

## 测试

```bash
node test/run.mjs
```

本仓库**不自带** `@deepseek-ai/*` 依赖（插件在运行时由 DSH 宿主提供），所以 runner 会先定位已安装的 profile 依赖，再在子进程里用一个 ESM resolve hook 把 `@deepseek-ai/*` 指过去：

| 环境变量 | 作用 |
|---|---|
| `DSH_PROFILE_MODULES` | 直接指定 `profiles/node_modules` 路径；不设时自动探测 `$DSH_HOME/profiles/*/node_modules`、`$DSH_HOME/profiles/node_modules`、仓库自身 `node_modules` |

随后依次运行：

| 用例 | 覆盖 |
|---|---|
| `test/host-smoke.mjs` | 命令、服务、路由、durable 状态、暂停粒度设置的完整行为（契约保真的 session 替身） |
| `test/host-real-session.mjs` | 直接对**真实内核 `Session`** 跑 `/pause`、`/resume confirm rerun\|skip`，防止 session 读取 API 再次漂移 |

> 两个用例都会把 `DSH_TASK_CONTROL_STATE_DIR` 指向临时目录，不会写你的 `~/.dsh/task-control/`。

## 本地开发部署

`dsh plugin` 把参数转发给 profile 目录下的 pnpm，之后按**已安装状态**自动维护 `dsh.profile.bundles`：只要包声明了 `dsh.bundle.patch` 就会被加进 layer 列表。因此 `cordis.patch.yml` 与 profile 的 `package.json` 都不需要手改。

```bash
# 1) 备份（pnpm 会重写 profile 的 package.json / pnpm-lock.yaml）
cd ~/.dsh/profiles/web
cp package.json package.json.bak && cp pnpm-lock.yaml pnpm-lock.yaml.bak

# 2) 安装本分支（file: 走本地路径，无需推送）
dsh plugin --profile web add file:/path/to/dsh-task-control
#    或走远端分支：
dsh plugin --profile web add github:<owner>/dsh-task-control#<branch>

# 3) 自检（都应看到 dsh-task-control）
node -e "const p=require(process.env.HOME+'/.dsh/profiles/web/package.json');console.log(p.dependencies['dsh-task-control'],p.dsh.profile.bundles)"
dsh --profile web --dump-config | grep -A2 dsh-task-control

# 4) 重启 dsh web（用新打印的 URL 打开页面，并刷新浏览器）
```

注意：`--profile web` 必须写在 `add` 前面，写在后面会被转发给 pnpm 并报 `required option '--profile <name>' not specified`。

几个实测要点：

- **`file:` 是拷贝而非软链**。`node_modules/dsh-task-control/` 是真实目录，所以每次改完 `lib/` 都必须重跑第 2 步再重启；需要反复迭代时改用 `github:` 规范、或自行把该目录软链到工作副本。
- **插件运行时不走 profile 自己的 `node_modules`**。内核包在上一级的扁平 store（`~/.dsh/profiles/node_modules`），Node 从 `profiles/web/node_modules/dsh-task-control/lib/` 向上解析即可命中，所以 pnpm 打印的 `missing peer @deepseek-ai/...` / `react` 警告是这台机器一贯的噪音，不影响运行。
- **安装会写 profile 目录**：`dsh web` 启动时也会重写 `~/.dsh/profiles/web/cordis.yml`（组合后的树）。若该目录不可写，`dsh web` / `--dump-config` 会直接 `EACCES` 失败。
- **必须重启 `dsh web`**。宿主在启动时一次性组合并加载 profile，不热重载插件；只刷新浏览器不够，还要重启宿主才会重新下发 `client.js`。

## 回滚

```bash
cd ~/.dsh/profiles/web
cp package.json.bak package.json && cp pnpm-lock.yaml.bak pnpm-lock.yaml
rm -rf node_modules/dsh-task-control
dsh plugin --profile web install     # 按还原后的 manifest 重新收敛依赖
# 再重启 dsh web
```

若只是不想让它生效、但保留安装，把 profile `cordis.patch.yml` 里对应的 `task-control` 行 `disabled: true`，或直接用上面的 `dsh plugin --profile web remove dsh-task-control`。

---

## 已知问题与限制

| 项 | 说明 | 状态 |
|---|---|---|
| **内核 API 漂移**（`Session.events` 被移除） | DSH ≤ 0.1.1-rc.2 的 `Session` 有公开 getter `events`；0.1.5-rc.2 改为 `snapshotEvents()` / `ownEvents()` / `eventAt(seq)`。插件原先在两处读 `agent.session.events`，升级后该值为 `undefined`，导致**每次 `/pause`（含输入区暂停按钮）和 `/resume` 都抛 `TypeError`**，且异常发生在 `clearPaused()` 之前，浏览器轮询看到的状态仍是 `paused: true`，恢复菜单反复弹出且每次都失败。 | 已修复：统一走 `sessionEvents()` helper（优先 `ownEvents()`，回退 `snapshotEvents()`，再回退遗留 `events`），并将 `test/host-real-session.mjs` 作为回归护栏 |
| **插件路由不受 Web 鉴权保护** | 插件用 `ctx.webServer.register({kind:'prefix'})` 自挂的 `/task-control/*` 位于 DSH 鉴权门之外（鉴权门只包住索引与 `/api`）。实测未带 cookie 时 `/`、`/index.html`、`/api/session/list` 均返回 401，而 `/task-control/settings` 返回 200。因此本机任意进程无需 token 即可读写暂停粒度设置，并用任意 session id 查询 `paused` / `forced` / `interruptedTool` / `resumeContent`（其中 `resumeContent` 是**最后一条用户提示词的内容**）。 | 未处理（沿用现有实现）。单机可信环境风险低；若把端口暴露到局域网/容器外，应改为校验请求 cookie/authority，或把状态通道并入 `/api` 侧的 remote 面 |
| **`dsh.client.inject` 曾含不可解析的包名** | 原先列出 `@deepseek-ai/dsh-client-runtime`，但 client 半边从未 import 它，且它在 0.1.5 里不是可加载的 client 插件包。0.1.5 的 `inject` 仅为 preflight/HMR 展示用的信息性元数据（真正的模块边来自 `dsh.client.external` + shell 静态表），故不会导致加载失败，但属误导。 | 已移除该条目 |
| **peerDependencies 曾形同虚设** | 原先写 `^0.1.0-rc.6`。按 semver 该范围只允许 `0.1.0-*` 预发布，**匹配不到 `0.1.5-rc.2`**，而 `dsh plugin add` 只转发 pnpm、不做宿主版本校验，等于没有任何版本闸门。 | 已收敛为 `^0.1.5-rc.2`，并补上真正 import 的内核包 |
| **仓库内 `node_modules` 曾是坏软链** | 指向另一台机器的 `/Users/wx/.dsh/profiles/node_modules`，导致 `node test/host-smoke.mjs` 直接 `ERR_MODULE_NOT_FOUND`。 | 已删除；改由 `test/run.mjs` 动态解析（见「测试」） |
| **`file:` 安装不会自动跟进代码改动** | 见「本地开发部署」。 | 设计如此，需重装 |
| **未在真实浏览器中回归** | 宿主半边有 HTTP 级实测证据；浏览器半边的挂载（`conversation.input.right` / `settings.section`）仅做了静态核对，未在真实浏览器中断言。 | 待人工确认 |
