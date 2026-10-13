# D-11 双机 .env 键名 diff（仅键名，无密钥）
记录日：2026-10-13  
来源：BF `D:\\Program Files (x86)\\agent-chat\\.env`（键名）、仓库 `.env.example`、`apps/server/src` 读取的 `process.env` / `env*`。  
HY：待运维Bot回填键名（本机曾离线）。云侧 `.env.example` 与仓库 example 一致（tip 同轨）。

## 1. BF `.env` vs `.env.example`
| 键 | BF .env | .env.example | 说明 |
|---|---|---|---|
| `DEEPSEEK_API_KEY` | — | Y | example 有空键；BF 实机未写（可用系统环境） |
| `GEMINI_API_KEY` | — | Y | example 有空键；BF 实机未写（可用系统环境） |
| `GOOGLE_API_KEY` | — | Y | example 有空键；BF 实机未写（可用系统环境） |
| `HOST` | Y | — | example 仅注释 `# HOST=`；BF 实机有键 |
| `IMAGE_GEN_API_KEY` | Y | Y |  |
| `IMAGE_GEN_BASE_URL` | Y | Y |  |
| `IMAGE_GEN_MODEL` | Y | Y |  |
| `LLM_API_KEY` | Y | Y |  |
| `LLM_BASE_URL` | Y | Y |  |
| `LLM_MODEL` | Y | Y |  |
| `LLM_PROVIDER` | Y | Y |  |
| `LLM_VISION_MODEL` | Y | Y |  |
| `MEMORY_GATE_BACKEND` | Y | Y |  |
| `PORT` | Y | Y |  |
| `STT_API_KEY` | Y | Y |  |
| `STT_BASE_URL` | Y | Y |  |
| `STT_MODEL` | Y | Y |  |
| `TTS_API_KEY` | Y | Y |  |
| `TTS_BASE_URL` | Y | Y |  |
| `TTS_MODEL` | Y | Y |  |
| `TTS_VOICE` | Y | Y |  |
| `TTS_VOICE_FEMALE` | Y | Y |  |
| `TTS_VOICE_MALE` | Y | Y |  |
| `TTS_VOICE_USER` | Y | Y |  |

## 2. 代码会读、但 example/BF 未齐的键
| 键 | 代码 | BF .env | example | 建议 |
|---|---|---|---|---|
| `DEEPSEEK_API_KEY` | Y | — | Y |  |
| `HOST` | Y | Y | — | 保持注释可选 |
| `IMAGE_GEN_API_KEY` | Y | Y | Y |  |
| `IMAGE_GEN_BASE_URL` | Y | Y | Y |  |
| `IMAGE_GEN_MODEL` | Y | Y | Y |  |
| `LAYA_GATE_SCRIPT` | Y | — | — | 保持注释可选 |
| `LAYA_PYTHON` | Y | — | — | 保持注释可选 |
| `LLM_API_KEY` | Y | Y | Y |  |
| `LLM_BASE_URL` | Y | Y | Y |  |
| `LLM_MODEL` | Y | Y | Y |  |
| `LLM_PROVIDER` | Y | Y | Y |  |
| `LLM_VISION_MODEL` | Y | Y | Y |  |
| `MEMORY_EXTRACT_DEBUG` | Y | — | — | 保持注释可选 |
| `MEMORY_GATE_BACKEND` | Y | Y | Y |  |
| `MEMORY_PENDING_TTL_DAYS` | Y | — | — | 保持注释可选 |
| `PORT` | Y | Y | Y |  |
| `PROACTIVE_INTERVAL_MS` | Y | — | — | 保持注释可选 |
| `PYTHON` | Y | — | — | 保持注释可选 |
| `STT_API_KEY` | Y | Y | Y |  |
| `STT_BASE_URL` | Y | Y | Y |  |
| `STT_MODEL` | Y | Y | Y |  |
| `TTS_API_KEY` | Y | Y | Y |  |
| `TTS_BASE_URL` | Y | Y | Y |  |
| `TTS_MODEL` | Y | Y | Y |  |
| `TTS_VOICE` | Y | Y | Y |  |
| `TTS_VOICE_FEMALE` | Y | Y | Y |  |
| `TTS_VOICE_MALE` | Y | Y | Y |  |
| `TTS_VOICE_USER` | Y | Y | Y |  |

## 3. 对齐意图（本次）
- `.env.example` 补全注释项：`HOST`、`PROACTIVE_INTERVAL_MS`、`MEMORY_PENDING_TTL_DAYS`、`MEMORY_EXTRACT_DEBUG`、`LAYA_*`（不写密钥）。
- 实机 `.env` 不入库；BF 缺的 `DEEPSEEK_API_KEY` 等可按需补空键或用系统环境。
- HY 键名到位后追加一节「HY vs example」，不贴明文。

## 4. HY（待填）
_运维Bot 回报后补表。_
