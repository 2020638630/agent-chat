# ARCH-2 试跑线收口（续：2026-10-11 API 切换试跑）

## 结论
- **ARCH-2**：此前已关单（管道 Provider+.env+D-05）。本刀是验收试跑线复跑，非重开 ARCH-2。
- **N-02**：仍不动。
- **DeepSeek 官方文本+识图**：**已通**（2026-10-13 BF；`api.deepseek.com` / `deepseek-flash`；超出原仅文本计划）。
- **Gemini TTS**：仍缺 GEMINI_API_KEY，挂债不阻塞（B-04d / API 试跑线续债）。

## 环境
- 机器：HY（D:\Agent-chat\agent-chat）
- tip 基线：dca268（试跑前）；问题表更新 commit 另计
- Key 观测（只报有无，不入库）：DEEPSEEK_API_KEY 空；GEMINI_API_KEY/GOOGLE_API_KEY 空；硅基 STT_API_KEY 有；本地 Ollama 有 qwen2.5vl:7b

## 三条试跑（scripts/arch2-tryrun.py + 补云端大图）
| 条 | 结果 | 说明 |
| -- | ---- | ---- |
| DeepSeek 文本 | **通** | 硅基 DeepSeek-V4-Flash（本机官方 DEEPSEEK_API_KEY 空，回落 STT Key） |
| 官方 VLM 读图 | **本地通 / 官方 Key 未配** | 本地 Ollama qwen2.5vl:7b 通（主证据）；独立官方 VLM Key 未配。硅基 Qwen3-VL 大图补跑通（非严格「官方」） |
| Gemini TTS | **挂债** | 缺 GEMINI_API_KEY，未实跑 |

## 备注
- 密钥只进本机 .env，不入库不进表。
- D-02 定「部分收口」；新建 D-02b 壳层/辅助清理；不再继续抽 App.vue。

---

## 续跑（2026-10-13 BF）

- 机器：BF（D:\\Program Files (x86)\\agent-chat）；HY 离线
- tip：续跑前已 ff 至 origin/main（1825c30）
- Key：系统环境变量 DEEPSEEK_API_KEY 已配置（不写仓库 .env）；GEMINI/GOOGLE 仍空
- 代码：providers.ts 在 LLM_PROVIDER=deepseek（或 baseUrl 含 deepseek.com）且 LLM_API_KEY 为空时，回落读取进程环境 DEEPSEEK_API_KEY
- 试跑：scripts/arch2-tryrun.py 增加官方 DeepSeek 识图；smoke 关闭 thinking（避免 reasoning 吃光 max_tokens）

| 项 | 结果 | 说明 |
| -- | ---- | ---- |
| DeepSeek 官方文本 | **通** | model=deepseek-flash，source=official+DEEPSEEK_API_KEY |
| DeepSeek 官方识图 | **通** | 同 model 原生多模态；不再用 SiliconFlow 顶替 |
| Gemini TTS | **挂债** | 仍缺 GEMINI_API_KEY（N-02 不动） |

## 备注（续）
- 密钥优先 OS 环境变量；勿提交 `.env` 真值
- **拍板同步（2026-10-13）**：DeepSeek 官方试跑线由挂债改为 **已通**——文本 + 识图均走 `api.deepseek.com`（`deepseek-flash` 原生多模态；官方识图超出原「仅文本」计划）。Gemini TTS 仍缺 `GEMINI_API_KEY` 挂债；**N-02 不动**。
- 后续已关：X05-D1（`b851189`，口径=本次新做）、D-02b（`ecc0910`）。本文件只记账试跑口径，不重开 ARCH-2。
