# ARCH-2 试跑线收口（续：2026-10-11 API 切换试跑）

## 结论
- **ARCH-2**：此前已关单（管道 Provider+.env+D-05）。本刀是验收试跑线复跑，非重开 ARCH-2。
- **N-02**：仍不动。
- **DeepSeek 官方文本+识图**：**已通**（2026-10-13 BF；`api.deepseek.com` / `deepseek-flash`；超出原仅文本计划）。 **10-17 复测确认**（识图走 `DeepSeek-V4.1-Flash`，链路通，识图质量未测；见文末）。
- **Gemini TTS**：仍缺 GEMINI_API_KEY，挂债不阻塞（B-04d / API 试跑线续债）。

## 环境
- 机器：HY（D:\Agent-chat\agent-chat）
- tip 基线：dca268（试跑前）；问题表更新 commit 另计
- Key 观测（只报有无，不入库）：DEEPSEEK_API_KEY 空；GEMINI_API_KEY/GOOGLE_API_KEY 空；硅基 STT_API_KEY 有；本地 Ollama 有 qwen2.5vl:7b

## 三条试跑（scripts/arch2-tryrun.py + 补云端大图）
| 条 | 结果 | 说明 |
| -- | ---- | ---- |
| DeepSeek 文本 | **通** | 硅基 DeepSeek-V4-Flash（本机官方 DEEPSEEK_API_KEY 空，回落 STT Key） |
| 官方 VLM 读图 | **本地通 / 官方 Key 已配（10-17）** | 本地 Ollama qwen2.5vl:7b 通（主证据）；DeepSeek 官方 Key 已配，仅用于实测和上线后的文本首选（10-17 更正）。硅基 Qwen3-VL 大图补跑通（非严格「官方」） |
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

## B-04d（2026-10-13 BF）

- **结论**：已关。坏 `IMAGE_GEN_API_KEY` 实打上游 401；聊天气泡人话，无上游 JSON。
- **补丁**：`formatImageGenUserError`；HTTP 失败 throw 仅 `生图失败 <status>`，body 只进服务端 log。
- Gemini TTS 仍挂 Key；N-02 不动。

## 10-17 复测（DeepSeek 官方识图）

- **结论**：官方 DeepSeek 文本和识图都通（10-17 实测）。识图走 `DeepSeek-V4.1-Flash`；`DeepSeek-V4-Pro` 只收文本。识图链路通，识图质量未测。
- **别名**：请求写 `deepseek-chat`，返回 `model` 字段是 `deepseek-flash`（`/models` 里名为 `DeepSeek-V4.1-Flash`，input_modalities 含 text、image）。这是观察到的映射，不是官方保证；以后变了以 `/models` 返回为准。
- **实测**：云电脑运维用官方 Key 调一次，10-17 约 10:57（北京时间）；64×64 纯红图，HTTP 200，回答「红色」，finish_reason=stop，198 tokens，无报错。.env 未改。
- **澄清前面的冲突**：10-16 的读图云验是在云端用 Gemini（`gemini-3.1-flash-lite`）跑的；BF 本机读不了图是因为缺 vl 模型。两件事都和 DeepSeek 无关。
- **Key 口径**：DeepSeek 官方 Key 已配，仅用于实测和上线后的文本首选。
- **开发期口径不变**：文本和识图都走本机 Ollama，不切 DeepSeek。BF 已拉 `qwen2.5vl:7b`，进程级 `LLM_VISION_MODEL` 实测通（21.5s）；写不写入 .env 待 kama 定。
- **后续可选**：要比较 V4.1-Flash 和 Gemini 的读图质量，用 B-04f 旧书店图跑一次，视觉Bot 看回答准不准。
