# Phase-1 smoke scripts (D-22)

前置：本机 API 已起在 `http://127.0.0.1:8787`。

运行（在仓库根目录）：

```bash
python scripts/smoke/smoke_list.py
python scripts/smoke/smoke_setup.py
python scripts/smoke/smoke_run.py
python scripts/smoke/smoke_retry.py
```

产物写在 `scripts/smoke/_out/`（已 gitignore），不入库。
