# Agent Chat — ARCH-1 债清单

> 扫描日期：2026-10-10（Asia/Shanghai）  
> 仓库 tip：`f038f87`（`git fetch` 后与 `origin/main` 一致）  
> 扫描机：BF `D:\Program Files (x86)\agent-chat`（machineId `3fb204ac-adfc-4cf8-b8d9-6fbcb03ad601`）  
> HY 机：离线，双机对比仅能完成 BF 侧  
> 约束：**只扫不改业务源码**；本文件为新建产出；不评价历史决策；新功能需求不并入条目，见文末「二期池」  

---


## ARCH-2 收口（2026-10-10）

管道已交；**试跑线 2/3（2026-10-10）**：DeepSeek 通 / 硅基 VLM 通 / Gemini TTS 缺钥不通 → **真关单否**。试跑线=ARCH-2 验收标准，非独立刀；N-02 不动。

| 债 | 状态 | 说明 |
| ---- | ---- | ---- |
| **D-01** | **管道已收（关单待试跑）** | `apps/server/src/config/providers.ts` 统一 llm/vision/stt/tts/imageGen；业务经 Provider 取配置再调现有 OpenAI 兼容请求；**不做** N-02 动态路由 |
| **D-09** | **管道已收** | 优先 `IMAGE_GEN_API_KEY`；空时兼容回落 `STT_API_KEY` 并一次性 `console.warn`（兼容期）；`.env.example` 已写明 |
| **D-13** | **管道已收** | 消灭 services 内重复 `function env`；统一 `config/env.ts`；gate / index 读写亦走共享 helper |
| **D-05** | **可观测已交（纯日志）** | 见下「ARCH-2 三条验收」 |

### ARCH-2 三条验收（2026-10-10 20:30 CST，先不最终关单）

1. **D-05**：纯 `[memory.obs]` 结构化 console 日志（`logMemoryExtract` → `console.log`/`console.error`；status=start/ok/empty/fail_llm/fail_parse/fail_apply/fail_after_turn/confirm）。失败路径仅打日志后 `return`，**用户侧无失败信号**（无失败气泡、无耳语 notice、无对客户端的失败 API 字段）；仅成功写入记忆时 `enqueueMemoryNotice`。
2. **五入口核对**：均进 `apps/server/src/config/providers.ts`

| 入口 | providers API | 调用方 |
| ---- | ------------- | ------ |
| llm | `getLlmConfig` | `services/llm.ts` → `chatCompletion` |
| vision | `getVisionConfig` / `resolveVisionModel` | `llm.ts`；读图路径 `routes/conversations.ts` 经 `resolveVisionModel` |
| stt | `getSttConfig` | `services/audio.ts` → `transcribeAudio` |
| tts | `getTtsConfig` | `services/audio.ts` → `synthesizeSpeech` |
| imageGen | `getImageGenConfig` | `services/imageGen.ts` |

3. **X-01 最终 tip**：`0fce6d8`（能力 `ae4120d` → tip对齐 `9d5bde4` → 验证关单 `cac031c` → tip对齐 `0fce6d8`）；问题表本地/远程统一为 `0fce6d8`。

未做（确认）：N-02 动态路由、试跑线实跑（父代理另开）、换供应商实跑、ARCH-3、D-04 功能池项。读图 VLM 债 / B-04d 在试跑线还。


## 汇总

| 影响 | 数量 |
| ---- | ---- |
| 高 | 4 |
| 中 | 11 |
| 低 | 8 |
| **合计** | **23**（原 24；D-04 已挪出 ARCH 进功能池，不计入本表） |

**建议阶段映射（摘要）**

| 阶段 | 应收债 |
| ---- | ------ |
| **ARCH-2** | D-01 模型/.env 入口封装；D-09 Key 串用；D-13 env 读取点收敛；D-05 记忆空泡可观测（与 N-02/API 试跑线相关；**保留高影响，ARCH-2 一并做可观测**） |
| **ARCH-3** | D-02 App.vue 拆分；D-03 路由上帝文件；D-06 wx 命名；D-07 表情双份；D-08 uploads/SQLite 增长策略；D-10～D-12 残留与 API 重复；D-14～D-24 工程杂项（**D-04 已挪出，见功能池**） |
| **UI-1（可并行）** | D-02 / D-06 的视觉与信息架构面（勿与 ARCH-2 抢模型封装） |

---

## 高影响

### D-01 模型入口与 `.env` 硬绑定、无统一 Provider 层
- **状态**：本刀已收（ARCH-2）
- **位置**：`apps/server/src/services/llm.ts`、`audio.ts`、`imageGen.ts`；`index.ts` dotenv；根目录 `.env` / `.env.example`
- **类型**：架构 / 配置
- **现象**：LLM / Vision / STT / TTS / ImageGen 各自 `process.env` + 本地 `env()`；无共享 client、无按能力切换注册表。BF 实机：`LLM_MODEL=qwen2.5:7b-fast`，`.env.example` 默认仍为 `qwen3.5:9b-nothink`。Vision 空则回落到文本模型。
- **影响**：二期 N-02 / ARCH-2「API 模型切换试跑」会四处改；易出现文档、example、实机三方漂移。
- **建议动作**：抽 `providers/`（或等价）统一读配置；能力枚举 `llm|vision|stt|tts|imageGen`；example 与实机约定写清；切换只改配置表。
- **建议阶段**：ARCH-2（对接 N-02）

### D-02 `App.vue` 单体与状态交叉
- **位置**：`apps/web/src/App.vue`（约 2471 行；`<script>` ~1536 行）
- **类型**：前端架构
- **现象**：无 Pinia/Vuex；会话/联系人/空间/资料/主动开关/记忆耳语/语音/TTS/主题等 80+ `ref`/`reactive` 与 ~114 个函数同文件；无 `stores/` / 页面组件目录。
- **影响**：UI-1、X 系列、空间与资料改动易互相踩；回归面大；难以单测。
- **建议动作**：按域拆面板组件 + composable/store（chat / contacts / moments / profile / proactive / memory-ui）；`App.vue` 降为壳。
- **建议阶段**：ARCH-3（UI-1 可先收时间/动效，避免与大拆并行冲突时先定边界）

### D-03 `conversations` 路由承载业务编排
- **位置**：`apps/server/src/routes/conversations.ts`（约 864 行）
- **类型**：后端架构 / 路由耦合
- **现象**：同一文件含会话 CRUD、`handleUserMessage`（文本/语音）、生图分支、读图多模态、TTS 静态缓存、记忆 schedule、主动 `onPrivateUserMessage`、表情后处理。读图路径与文本路径 prompt/历史拼装重复。
- **影响**：改一条链路易伤多能力；ARCH-2 换模型时改动点集中却难隔离。
- **建议动作**：路由只做校验与 I/O；编排下沉 `services/chatTurn.ts`（及 image/voice 子模块）。
- **建议阶段**：ARCH-3（可与 ARCH-2 模型封装前后衔接）

### D-04 主动 / 空间结算路径耦合不一致（C-05 / M-07 / C-06 / M-01） · **【已挪出 ARCH / 进功能池】**
- **位置**：`services/proactive.ts`；`services/momentReactions.ts`；`routes/moments.ts`；`index.ts` 定时 tick
- **类型**：业务耦合
- **现象**：
  - M-07 `settleMomentReactions`：**已按 C-06** 忽略 `daily_cap` / `sent_today`（总开关 + 静默期 + `c05_recent` 仍生效）。
  - M-01 `settleAuthorReplyToUserComment`：**仍检查** `sent_today >= daily_cap`。
  - 空间结算与私聊主动共用 `getProactiveSettings()`；M-07/M-01 定时器在进程内存（重启丢失）。
- **影响**：私聊主动达 cap 后，角色朋友圈作者回复可能被静默跳过，与「空间不受私聊 cap」产品语义不一致。
- **建议动作**：明确产品规则后对齐 M-01 与 M-07；考虑把「空间闸」与「私聊主动闸」配置拆字段或显式注释契约测试。
- **建议阶段**：**已挪出 ARCH** → 功能池（与 **C-06 同组，P2**；C-06 遗留：M-01 仍吃私聊 `daily_cap`）。不再进 ARCH-2/ARCH-3。

### D-05 记忆链路失败与空泡（extract→filter→pending→honor）
- **状态**：ARCH-2 可观测已交（**纯日志**；用户侧无失败信号）；关单随 ARCH-2 试跑线
- **位置**：`services/memory.ts`（`extractMemoriesAfterTurn` / `scheduleMemoryExtractAfterTurn`）；`memoryGate.ts`；`routes/conversations.ts` 调用点；前端 `scheduleMemoryWhisper`
- **类型**：可靠性 / 可观测性
- **现象**：LLM 提取失败仅 `console.error` 后 `return`；parse 失败变空 ops；`extract empty` 只打日志；成功才 `enqueueMemoryNotice`。前端耳语依赖 notice，失败/空结果用户侧无区分。Gate 默认 `MEMORY_GATE_BACKEND=off`，Laya 路径失败再静默回退。
- **影响**：用户感知「说了没记住」或偶发空泡；排障只能翻服务端日志；二期加强记忆时缺少失败信号。
- **建议动作**：结构化日志 + 可选 debug 计数；区分 empty / fail；必要时轻量 UI 提示（非新功能则可先指标）。Honor/sticky 与 pending 确认路径保持读写分离约定。
- **建议阶段**：ARCH-2（**保留高影响**；可观测与模型封装一并做）；ARCH-3（若只做日志 / notice 补强）

---

## 中影响

### D-06 `wx-*` / `wechat.css` 遗留命名
- **位置**：`apps/web/src/styles/wechat.css`（约 2257 行）；`App.vue` 大量 `wx-*` class
- **类型**：前端遗留
- **现象**：文件头已写 V2 Discord 风格，但类名与文件名仍 wechat/wx。
- **影响**：UI-1/主题与新人认知成本高；全局重命名风险大。
- **建议动作**：分步重命名（先文件别名再 class），或建立 `wx → ac` 映射表分批改。
- **建议阶段**：ARCH-3 / UI-1

### D-07 表情白名单前后端双份
- **位置**：`apps/web/src/constants/emojiWhitelist.ts`；`apps/server/src/constants/emojiWhitelist.ts`
- **类型**：重复 / 同步债
- **现象**：注释要求保持一致；server 另含 `sanitizeAssistantEmoji` / prompt 约束。列表靠人工同步。
- **影响**：一端增删后行为漂移（前端可选 vs 后端裁剪不一致）。
- **建议动作**：单源生成或共享包；CI 比对数组。
- **建议阶段**：ARCH-3

### D-08 uploads / SQLite 增长无策略
- **位置**：`uploads/`；`data/agent-chat.db`；`services/uploadImage.ts`；TTS 写入 `conversations` TTS 路由；`proactive.countProactiveToday`
- **类型**：运维 / 存储
- **现象**：BF 实机 uploads≈1.7MB（含单张 gen-img≈1.6MB）；db 文件 128KB + WAL。删消息会清 image/TTS 缓存，但无总量配额、无 TTL、无孤儿扫描。`countProactiveToday` 拉取全部 `source='proactive'` 再过滤当日。multipart 上限 20MB，图片业务上限 5MB。
- **影响**：长期使用磁盘膨胀；cap 计数随消息表变慢。
- **建议动作**：按前缀配额/清理任务；SQL 按日聚合 `sent_today`；文档化保留策略。
- **建议阶段**：ARCH-3

### D-09 ImageGen Key 回落到 STT Key
- **状态**：本刀已收（ARCH-2）
- **位置**：`services/imageGen.ts`（`IMAGE_GEN_API_KEY || STT_API_KEY`）；`.env.example` 已注明
- **类型**：配置耦合
- **现象**：生图与语音共用密钥族，权限与轮换边界模糊。
- **影响**：换 STT 供应商或撤销 Key 时误伤生图；审计不清。
- **建议动作**：ARCH-2 配置表要求显式 `IMAGE_GEN_API_KEY`；回落仅兼容期并告警。
- **建议阶段**：ARCH-2

### D-10 未 push / stash / 未跟踪残留（BF）
- **位置**：git stash×2；未跟踪 `.env.bak-20261010-135801`、`smoke_*.py`×4
- **类型**：工程卫生
- **现象**：
  - `stash@{0}`：问题记录 xlsx 二进制 WIP（rebase 前）
  - `stash@{1}`：`apps/web/package.json`、`vite.config.ts`、`package-lock.json`（M-01 前）
  - 冒烟脚本与 env 备份在工作区未跟踪
- **影响**：易误用旧 stash；备份含环境形态差（见 D-11）。
- **建议动作**：确认后丢弃/入库脚本到 `scripts/`；bak 不入库；勿 commit 密钥。**stash 分类（2026-10-10）**：`stash@{0}` 问题表 WIP 已被 tip 表覆盖 → **临时丢**；`stash@{1}` vite `0.0.0.0` / lock libc 本地 WIP → **临时丢**（若需局域网监听可再开独立改动）。smoke 见 D-22。
- **建议阶段**：ARCH-3（或随时清理）
- **收口备注（2026-10-10 17:12 CST）**：用户拍板丢弃；内容简述见文末「收口修订」；两条均已 `git stash drop`。

### D-11 双机 `.env` 漂移（BF 可扫部分；HY 离线）
- **位置**：BF `.env` vs `.env.bak-20261010-135801` vs `.env.example`
- **类型**：配置漂移
- **现象**：bak 仅含 PORT/HOST/LLM_*；当前 BF 另有完整 STT/TTS/IMAGE/MEMORY_GATE。HY 离线，无法比对 `D:\Agent-chat\agent-chat`。
- **影响**：换机/恢复 bak 会丢多媒体能力配置；双机模型名可能不一致。
- **建议动作**：HY 上线后做「键名清单」diff（禁止贴密钥）；维护 example 键全集。
- **建议阶段**：**挂 HY 上线时做**（HY 当前离线；上线后做双机 `.env` 键名 diff。属 ARCH-2/3 边界，清单项挂起不阻塞 ARCH-2 开干）


### D-11 双机 `.env` 键名 diff（HY 上线补记 · 2026-10-10 21:30 CST）
- **BF**：当时 `ListMachines` 显示 BF 不可达，未能直接读 BF `.env` 键集合。
- **HY vs `.env.example`（ARCH-2 后 tip `f092de0`）**：example 全部键 HY 已具备；HY 多出 `LAYA_MODEL` / `LAYA_PYTHON` / `OLLAMA_MODELS`（R-04x spike 可选，保留）。
- **对齐动作**：HY 补空键 `DEEPSEEK_API_KEY` / `GEMINI_API_KEY` / `GOOGLE_API_KEY`（仅键名，值为空；不入库）；`.env.example` 同步列出上述可选空键。
- **密钥**：未拷贝 BF 密钥；未把任何 Key 写入 git。
- **状态**：键名对齐（对 example）完成；BF 机上线后可再做一次纯键名复核。

### D-12 前端 API 客户端重复与死方法
- **位置**：`apps/web/src/api/client.ts`
- **类型**：死代码 / 重复
- **现象**：`dissolveConversation` 与 `deleteConversation` 同 DELETE；`tickProactive` 无 UI 调用（仅服务端定时 + 手动 API）。
- **影响**：调用方困惑；测试面虚增。
- **建议动作**：删并或标注 debug-only；UI 不需要则移出 client 或加注释。
- **建议阶段**：ARCH-3

### D-13 环境变量读取点分散且 example 不全
- **状态**：本刀已收（ARCH-2）
- **位置**：`llm.ts` / `audio.ts` / `imageGen.ts` / `memoryGate.ts` / `index.ts`（`PORT`/`HOST`/`PROACTIVE_INTERVAL_MS`）；`.env.example` 缺 `HOST`、`PROACTIVE_INTERVAL_MS`、部分 LAYA_*
- **类型**：配置
- **现象**：三处复制 `function env()`；部分键只在代码默认值出现。
- **影响**：运维漏配；与 D-01 叠加。
- **建议动作**：单一 `config.ts` 导出类型化配置；example 与之同步。
- **建议阶段**：ARCH-2

### D-14 角色名硬编码策略（音色 / 主动档位 / 表情）
- **位置**：`audio.ts` `NAME_GENDER`；`db/schema.ts` `defaultInitiativeTier`；`emojiWhitelist` prompt 文案
- **类型**：数据 / 可扩展性
- **现象**：林深/夜见/小春等写死在代码。
- **影响**：新角色依赖改代码；与卡片字段不同步。
- **建议动作**：以卡片字段 + DB 列为准，硬编码仅作迁移期 fallback。
- **建议阶段**：ARCH-3（或随 X/角色编辑）

### D-15 空间/主动结算仅内存定时器
- **位置**：`momentReactions.ts` `pendingTimers` / `authorReplyTimers`
- **类型**：可靠性
- **现象**：进程重启后未结算任务丢失；无持久化队列。
- **影响**：发动态后立刻重启则无点赞评论；与产品「约 45s 结算」预期不符。
- **建议动作**：轻量表记录 due_at + 启动时回收；或接受并文档化。
- **建议阶段**：ARCH-3

### D-16 `better-sqlite3` 声明与 lock/allowScripts 版本表述不一
- **位置**：根 `package.json` `allowScripts.better-sqlite3@12.11.1`；`apps/server/package.json` `^12.10.0`；lock 解析为 12.11.1
- **类型**：依赖
- **现象**：范围与 allowScripts 钉死版本需心智对齐。
- **影响**：干净安装/换机原生模块脚本策略易踩坑。
- **建议动作**：统一钉版本与 allowScripts。
- **建议阶段**：ARCH-3

---

## 低影响

### D-17 重复小工具函数（`nowIso` / `env`）
- **位置**：`proactive.ts`、`momentReactions.ts`、`memory.ts`、各 provider
- **类型**：重复
- **现象**：多处私有拷贝。
- **影响**：行为微差风险低，但增加噪音。
- **建议动作**：收入 `utils/time.ts` / `config.ts`。
- **建议阶段**：ARCH-3

### D-18 Schema 迁移为堆叠式 `ALTER IF NOT EXISTS`
- **位置**：`apps/server/src/db/schema.ts`（约 353 行）
- **类型**：工程
- **现象**：列探测 + ALTER 列表持续增长。
- **影响**：可读性下降；长期难回放。
- **建议动作**：版本号迁移表（仍可无 Prisma）。
- **建议阶段**：ARCH-3

### D-19 `apps/web/node_modules` 嵌套
- **位置**：`apps/web/node_modules`（workspace 根亦有 `node_modules`）
- **类型**：依赖布局
- **现象**：Vite 缓存目录存在于 web 包下。
- **影响**：安装体积与幽灵依赖风险。
- **建议动作**：确认 npm workspaces 提升策略；清理多余嵌套。
- **建议阶段**：ARCH-3

### D-20 前端无统一状态管理方案（已选「全在 App」）
- **位置**：`apps/web/src/`（仅 `App.vue` + `api` + 一 composable）
- **类型**：前端架构（D-02 的子集表述）
- **现象**：除 `useHoldToTalk` 外无共享状态层。
- **影响**：同 D-02；单列便于排期「先定 store 边界」。
- **建议动作**：先定域边界文档再搬迁。
- **建议阶段**：ARCH-3

### D-21 未使用 / 冗余 API 表面（服务端 tick 暴露）
- **位置**：`routes/proactive.ts` `POST /api/proactive/tick`
- **类型**：API 表面
- **现象**：供手动/调试触发；UI 未用。
- **影响**：低；本地工具有用。
- **建议动作**：保留但标注 debug；或仅开发环境注册。
- **建议阶段**：ARCH-3

### D-22 冒烟脚本未入仓
- **位置**：根目录 `smoke_list.py` / `smoke_run.py` / `smoke_retry.py` / `smoke_setup.py`（未跟踪）
- **类型**：工程
- **现象**：一期冒烟资产仅在 BF 工作区。
- **影响**：换机无法复跑；与产品页「七类冒烟」记录脱节。
- **建议动作**：**建议入库**（与本债清单同 commit）；路径保持仓库根 `smoke_list.py` / `smoke_setup.py` / `smoke_run.py` / `smoke_retry.py`（一期冒烟工具）。
- **建议阶段**：ARCH-3 / 工程杂项

### D-23 multipart 20MB 与图片 5MB 双上限
- **位置**：`index.ts` multipart；`uploadImage.ts` / moments 校验
- **类型**：一致性
- **现象**：语音等可更大，图片业务再限 5MB。
- **影响**：错误信息可能先撞 multipart 再撞业务限（少见）。
- **建议动作**：文档写清；或按路由分别配置。
- **建议阶段**：ARCH-3

### D-24 记忆 Gate 尖峰代码常驻（默认 off）
- **位置**：`services/memoryGate.ts`；`scripts/laya_memory_gate.py`（若存在）
- **类型**：复杂度
- **现象**：R-04x 默认 off，但 extract 路径仍调用 `gateExtractOps`。
- **影响**：阅读成本；误开 Laya 有环境依赖。
- **建议动作**：保持默认 off；文档标明；ARCH-2 配配置表时一并登记。
- **建议阶段**：ARCH-3（或随 R-04）

---

## 扫描覆盖对照

| 范围项 | 结果 |
| ------ | ---- |
| 模型入口 llm/vision/stt/tts/imageGen 与 `.env` | D-01 / D-09 / D-13 |
| 主动/空间结算 C-05/M-07/C-06/M-01 耦合 | D-04（已进功能池）/ D-15 |
| 记忆 extract→filter→pending→honor 失败与空泡 | D-05 / D-24 |
| uploads/SQLite 增长 | D-08 |
| 未 push/stash、双机 `.env` | D-10 / D-11（HY 离线已注明） |
| App.vue 体量与状态交叉 | D-02 / D-20 |
| 状态管理是否统一 | D-20（未统一，集中于 App） |
| 重复工具函数 | D-07 / D-12 / D-17 |
| 未使用 import/变量/文件 | D-12 / D-21 / D-22（未做全量 TS unused 报告；以 API/文件级为主） |
| `wx-*` / `wechat.css` | D-06 |
| 路由与业务耦合 | D-03 |
| 环境变量读取点 | D-13 |
| 依赖重复或过时 | D-16 / D-19 |

---

## 二期池（非债，不入库排期为「修债」）

以下为产品页已列能力，**不作为本清单债条**：

- M-05a 动态配图（本地上传）、M-05b 生图  
- X-01 资料编辑及 X-02～X-07  
- UI-1～UI-6  
- N-01 图床素材库、N-02 动态模型路由、N-03 账单  
- B-05 着色/移动端、R-04 双通道、daily_cap / 静默 UI  
- 读图多模态质量（一期冒烟已知债，挂 API 线）

---

## 产出与 Git 状态（扫描结束时）

- **产出物路径（BF）**：`D:\Program Files (x86)\agent-chat\docs\product\ARCH-1-债清单.md`（写入后为未跟踪或新文件，**本任务不 commit/push**）  
- **工作区另有未跟踪**：`.env.bak-20261010-135801`、`smoke_*.py`  
- **stash**：2 条仍在  
- **分支**：`main` 与 `origin/main` 同 tip `f038f87`

---


---

## 功能池旁注（ARCH-1 收口 2026-10-10）

- **功能池：D-04 → 与 C-06 同组，P2**（C-06 遗留不一致：M-01 作者回复仍吃私聊 `daily_cap`，与 M-07「空间不受 cap」不一致）。已从 ARCH 汇总与 ARCH-2/3 映射移除；问题表 C-06 维护备注已补一行指向本项。
- **D-05**：保留高影响；ARCH-2 一并做可观测。
- **D-11**：挂 HY 上线时做双机 `.env` diff。
**stash×2（2026-10-10 用户拍板已丢）**：
- 丢前简述（2026-10-10 17:12 CST）：
  - `stash@{0}`「wip: bf issue tracker before rebase」：仅改 `docs/product/AgentChat-问题记录.xlsx`（二进制 25832→27876），旧问题表 WIP，已被 tip 表覆盖 → **临时丢**。
  - `stash@{1}`「wip: bf local before M-01」：`apps/web/package.json` + `vite.config.ts` 把 vite host `127.0.0.1`→`0.0.0.0`（局域网监听）、`package-lock.json` 去掉若干 optional `libc` 字段 → **临时丢**（若以后要局域网监听另开独立改动）。
- 已按 list 顺序 `git stash drop` 两条；工作区无 stash。
- **smoke_*.py**：建议入库（本收口 commit 一并纳入）。
- **`.env.bak-*`**：保持未跟踪，不入库。


*ARCH-1 收口调整完成（债清单 + smoke 入库）。2026-10-10 17:12 CST：stash×2 已记简述并 drop；M-05a 已做 multipart 实际上墙验证。*

---

## 阶段顺序修订（2026-10-10 20:30 CST）

下一顺序**补 Gemini 钥再跑试跑线 → ARCH-3 → UI-1**。
试跑线 2026-10-10：DeepSeek 通 / 硅基 VLM 通 / Gemini TTS 不通（缺钥）；ARCH-2 真关单否（2/3）。N-02 不动；B-04d 仍暂缓。
O-03 stash 已 drop → 已处理。ARCH-2 / ARCH-3 问题表改为「待处理」（ARCH-2：管道已交，关单待试跑线）。


## ARCH-2 试跑线（2026-10-10 20:40 CST）

脚本：`scripts/arch2-tryrun.py`（无密钥；结果目录 `scripts/_tryrun_out/` 默认不入库）

| 项 | 结果 | 说明 |
|---|---|---|
| DeepSeek 文本 | **通** | 官方 `api.deepseek.com` + 进程环境 `DEEPSEEK_API_KEY`，模型 `deepseek-flash`，约 0.8s |
| 官方/云 VLM 读图 | **通（硅基）** | 本机无 OpenAI/厂商官网 VLM Key；用硅基 `Qwen/Qwen3-VL-8B-Instruct` 读图验证管道（本地 7b 假多模态债可对照） |
| Gemini TTS | **不通** | 未配置 `GEMINI_API_KEY` / `GOOGLE_API_KEY`；端点见 `.env.example` |
| B-04d | **仍暂缓** | 坏 Key 上游返回 HTTP 401 `Token is invalid`；产品侧失败回流人话路径未在本刀改代码实打 |

**ARCH-2 真关单：否（2/3）。** 管道债 D-01/D-09/D-13/D-05 仍保持已收；真关单阻塞项=补 `GEMINI_API_KEY` 后再跑通 Gemini TTS。N-02 不动。

