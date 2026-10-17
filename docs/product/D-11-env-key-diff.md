# D-11 双机 .env 键名 diff（仅键名，无密钥）

记录日：2026-10-13（HY 节补全）  
来源：BF / HY 本机 `.env`（键名）、仓库 `.env.example`、云侧 example 与仓库一致。  
**禁止**在本文写任何密钥值。

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

## 2. HY `.env` vs `.env.example`

| 键 | HY .env | .env.example | 说明 |
|---|---|---|---|
| `DEEPSEEK_API_KEY` | Y | Y |  |
| `GEMINI_API_KEY` | Y | Y |  |
| `GOOGLE_API_KEY` | Y | Y |  |
| `IMAGE_GEN_API_KEY` | Y | Y |  |
| `IMAGE_GEN_BASE_URL` | Y | Y |  |
| `IMAGE_GEN_MODEL` | Y | Y |  |
| `LAYA_MODEL` | Y | — | HY 实机有（Ollama 模型目录 / Laya）；example 仅注释可选 |
| `LAYA_PYTHON` | Y | — | HY 实机有（Ollama 模型目录 / Laya）；example 仅注释可选 |
| `LLM_API_KEY` | Y | Y |  |
| `LLM_BASE_URL` | Y | Y |  |
| `LLM_MODEL` | Y | Y |  |
| `LLM_PROVIDER` | Y | Y |  |
| `LLM_VISION_MODEL` | Y | Y |  |
| `MEMORY_GATE_BACKEND` | Y | Y |  |
| `OLLAMA_MODELS` | Y | — | HY 实机有（Ollama 模型目录 / Laya）；example 仅注释可选 |
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

## 3. BF vs HY（实机键名）

| 键 | BF | HY | 说明 |
|---|---|---|---|
| `DEEPSEEK_API_KEY` | — | Y | 仅 HY 写了空键占位；BF 可补或不写 |
| `GEMINI_API_KEY` | — | Y | 仅 HY 写了空键占位；BF 可补或不写 |
| `GOOGLE_API_KEY` | — | Y | 仅 HY 写了空键占位；BF 可补或不写 |
| `HOST` | Y | — | 仅 BF |
| `IMAGE_GEN_API_KEY` | Y | Y |  |
| `IMAGE_GEN_BASE_URL` | Y | Y |  |
| `IMAGE_GEN_MODEL` | Y | Y |  |
| `LAYA_MODEL` | — | Y | 仅 HY（视觉/Laya 本机配置） |
| `LAYA_PYTHON` | — | Y | 仅 HY（视觉/Laya 本机配置） |
| `LLM_API_KEY` | Y | Y |  |
| `LLM_BASE_URL` | Y | Y |  |
| `LLM_MODEL` | Y | Y |  |
| `LLM_PROVIDER` | Y | Y |  |
| `LLM_VISION_MODEL` | Y | Y |  |
| `MEMORY_GATE_BACKEND` | Y | Y |  |
| `OLLAMA_MODELS` | — | Y | 仅 HY（视觉/Laya 本机配置） |
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

## 4. 对齐意图

- `.env.example` 已标 D-11 可选注释键（`HOST` / `PROACTIVE_INTERVAL_MS` / `MEMORY_*` / `LAYA_*`）；不写密钥。
- HY 多出的 `OLLAMA_MODELS` / `LAYA_PYTHON` / `LAYA_MODEL` 属本机可选，保持注释说明即可，不强行写入 example 必填键。
- BF 可按需补 `DEEPSEEK_API_KEY` 等空键或继续用系统环境；`HOST` 按需。
- 实机 `.env` 永不入库。

## 5. 关闭

- BF 节：此前 tip `bccadb9`
- HY 节：本 commit 补全后 **D-11 全关**

## .env.bak-20261010-135801 键名清单（10-17 删前留档，仅键名，不含值）

共 6 个键：

- `PORT`
- `HOST`
- `LLM_PROVIDER`
- `LLM_BASE_URL`
- `LLM_API_KEY`
- `LLM_MODEL`

与当前 .env 对比：备份独有 0 个, 当前独有 15 个：`LLM_VISION_MODEL`、`STT_BASE_URL`、`STT_API_KEY`、`STT_MODEL`、`TTS_BASE_URL`、`TTS_API_KEY`、`TTS_MODEL`、`TTS_VOICE`、`TTS_VOICE_MALE`、`TTS_VOICE_FEMALE`、`TTS_VOICE_USER`、`IMAGE_GEN_BASE_URL`、`IMAGE_GEN_API_KEY`、`IMAGE_GEN_MODEL`、`MEMORY_GATE_BACKEND`。
