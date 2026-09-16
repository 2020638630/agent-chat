# Agent Chat — 多角色 AI 社交客户端

Agent Chat 是独立的多角色 AI 社交客户端（私聊 / 群聊 / 空间 / 主页）。不是 SillyTavern 插件，也不是跑团台子。ST 角色卡只当导入标准。桌面三栏：消息 / 通讯录 / 空间，另有角色主页。后端 Fastify + SQLite，LLM 走 OpenAI 兼容接口（默认 Ollama）。

## 环境要求

- Node.js 20+（推荐本机已装的 v24）
- npm 10+
- （可选）本机 Ollama，模型优先 `qwen3.5:9b-nothink`，备用 `qwen3.5:4b-nothink`
- （可选）DeepSeek API Key，写入本机 `.env`，勿提交仓库

## 快速启动

```powershell
cd D:\Agent-chat\agent-chat

# 首次：安装依赖
npm install

# 复制环境变量（按需改模型 / DeepSeek）
copy .env.example .env

# 同时启动后端(8787) + 前端(5173)
npm run dev
```

分开启动：

```powershell
# 终端 1 — 后端
cd D:\Agent-chat\agent-chat\apps\server
npm install
npm run dev
# 健康检查: GET http://127.0.0.1:8787/api/health

# 终端 2 — 前端
cd D:\Agent-chat\agent-chat\apps\web
npm install
npm run dev
# 浏览器打开 http://127.0.0.1:5173
```

若 8787 / 5173 被占用，可改 `apps/server` 的 `PORT`（`.env`）和 `apps/web/vite.config.ts` 的 `server.port`，并在本 README 备注。

## 功能概览

- **阶段 A**：桌面三栏空壳（消息 / 通讯录 / 空间）+ 健康检查
- **阶段 B**：导入角色卡（JSON / PNG tEXt）→ 私聊 → LLM 人设回复 → SQLite 持久化
- **阶段 C/D**：群聊 / 空间（页面与接口预留）

## 导入测试角色

`samples/characters/` 下有三张 JSON 角色卡：林深、小春、夜见。在通讯录页点击「导入角色」选择文件即可。

## 技术栈

| 部分 | 选型 |
|------|------|
| 前端 | Vite + Vue 3 + TypeScript |
| 后端 | Fastify + TypeScript + better-sqlite3 |
| LLM | OpenAI 兼容 `/v1/chat/completions` |

## 安全

- `.env`、数据库、`uploads/` 已在 `.gitignore`
- DeepSeek 密钥只放本机 `.env`
