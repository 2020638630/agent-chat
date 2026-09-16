你是本机工程代理。在 Windows 上落地「多角色 AI 社交客户端」MVP。

不要改需求，不要引入 SillyTavern 运行时。



【路径，必须用这个】

GitHub：https://github.com/2020638630/agent-chat（私有）

本机：D:\\Agent-chat\\agent-chat

目录里可能只有 .git，从这里建项目，不要另开文件夹。



【本机已有】

Git 2.55、Node v24.21.0、npm 11.19.0

Ollama：Qwen3.5 9B / 4B

DeepSeek 已充值（密钥只写本机 .env，禁止进仓库）



【硬性约束】

1\. 代码只写在 D:\\Agent-chat\\agent-chat

2\. 不安装、不启动 SillyTavern

3\. 不提交 .env、密钥、角色卡原件、聊天记录、数据库

4\. 不上云、不用 Docker、不用 Electron/Tauri

5\. 不用 Prisma/Nest/Next 等重框架

6\. UI 中文；布局必须是桌面三栏，不是手机单栏，也不是管理后台

7\. 先做最小能跑闭环



【技术选型，不要自行更换】

apps/web：Vite + Vue 3 + TypeScript

apps/server：Fastify + TypeScript + better-sqlite3

前端代理到 http://127.0.0.1:8787

前端必须对照这个效果图实现，不要自己发挥成后台或手机单栏：

D:\\Agent-chat\\agent-chat\\docs\\ui-mockup.html

用浏览器打开看：桌面三栏布局、配色、单聊/群聊/空间/通讯录/主页。

先还原布局和视觉，功能按任务书阶段做。

LLM 走 OpenAI 兼容 /v1/chat/completions

默认 Ollama：http://127.0.0.1:11434/v1 ，模型以 `ollama list` 实际名称为准（优先 9B，4B 备用）

备用 DeepSeek：https://api.deepseek.com ，模型 deepseek-chat

配置用 .env；提供 .env.example

.gitignore 必须包含：node\_modules / dist / .env / data/ / \*.db / uploads/



【界面】

最左深色导航（聊天/通讯录/空间）+ 中栏会话列表 + 右侧主区

主色 #07C160，自己气泡 #95EC69，对方白气泡，聊天背景 #EDEDED，导航 #1E1E1E

第一期：私聊文字、群聊（带角色名和@）、通讯录、角色主页、空间最小版



【后端 API】

POST /api/characters/import

GET  /api/characters

POST /api/conversations

GET  /api/conversations/:id/messages

POST /api/conversations/:id/messages   （先存用户消息，再调 LLM 存角色回复）

GET  /api/moments

POST /api/moments/generate

角色卡 PNG 读 tEXt：优先 ccv3，否则 chara；JSON 支持 V1/V2/V3

私聊用角色人设拼 system；群聊若 @ 某人则只让该角色回一条，未 @ 则轮询只回一条



【本次按顺序做】

阶段 A（必须完成）：建目录、健康检查、桌面三栏空壳、README。

提交：chore: bootstrap web and server

不要 git push，除非我明确说可以。SSH 失败就停，改用 HTTPS 并告诉我。



阶段 B（必须完成）：导入角色卡 + 私聊文字闭环 + SQLite 持久化。

验收：导入一张卡 → 发「你好」→ 收到人设回复 → 重启后端记录还在。



阶段 C（尽量完成）：多选建群、气泡带角色名、@指定只让一人回、右侧成员列表。



阶段 D（有时间再做）：空间时间线 +「让 TA 发一条」。做不完就留页面和接口。



【测试角色】

若没有现成卡，在仓库里放 3 张 JSON：林深（话少古风）、小春（活泼）、夜见（冷静）。



【不要做】

登录注册、语音/TTS、空间定时、完整世界书引擎、移动端、暗色完整版、CI 部署、自动 push。



【工作方式】

先检查目录，不要删除 .git。

先运行 ollama list，把真实模型名写入配置。

每完成一阶段先跑通再进入下一阶段。

端口占用则后端 8787、前端 5173。

不要改其他磁盘目录。



完成后用中文按这个格式回报：

已完成：

未完成：

如何启动：

Ollama 模型实际名称：

请你本地确认的两件事：

