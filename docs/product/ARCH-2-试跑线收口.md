# ARCH-2 试跑线收口（2026-10-10 21:30 CST）

## 结论
- **ARCH-2：已关单**（拍板条件：文本通 + 本地 VLM 通 + Gemini TTS 挂债）
- N-02：不动
- ARCH-3：未在本收口开实现

## 环境
- 机器：HY（`D:\Agent-chat\agent-chat`）
- tip 基线：`f092de0`（随后关单 commit）
- D-11：BF 当时离线；HY 键名对齐 `.env.example`；补空可选键 `DEEPSEEK_API_KEY` / `GEMINI_API_KEY` / `GOOGLE_API_KEY`（不入库值）

## 试跑结果（`scripts/arch2-tryrun.py`，密钥不入库）
| 项 | 结果 | 说明 |
| -- | ---- | ---- |
| DeepSeek 文本 | 通 | HY 经硅基 DeepSeek-V4-Flash（无独立 DEEPSEEK_API_KEY 时回落） |
| 本地 VLM 读图 | 通 | `local-ollama+qwen2.5vl:7b`，替代硅基 Qwen3-VL 作为主证据 |
| Gemini TTS | 挂债 | 缺 `GEMINI_API_KEY`，未实跑 → B-04d / API 试跑线续债 |

## 脚本变更
- `run_vlm` 优先本地 Ollama（`LLM_PROVIDER=ollama` / `11434` + `LLM_VISION_MODEL`）；云 VLM 仅回落。
- 退出码：核心两项通且 Gemini 为「缺 Key 挂债」时视为验收通过（exit 0）。
