<#
  REL-02 一键启动（A①）。由根目录 start.cmd 调用；也可手动：
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start.ps1 [-NoBrowser]
  只读 .env 里的 PORT / LLM_PROVIDER / LLM_BASE_URL 做检查，不改 .env，不改任何配置。
  子进程全部放进一个 Windows Job（KILL_ON_JOB_CLOSE）：关窗口或 Ctrl+C 都不留孤儿进程。
#>
param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
$Host.UI.RawUI.WindowTitle = 'Agent Chat（关闭此窗口即停止服务）'

function Say($msg, $color = 'Gray') { Write-Host $msg -ForegroundColor $color }
function Fail($msg) {
  Write-Host ''
  Write-Host $msg -ForegroundColor Red
  Write-Host ''
  Read-Host '按回车关闭窗口' | Out-Null
  exit 1
}

# ---- 读 .env（只读，不改） ----
$envMap = @{}
$envFile = Join-Path $Root '.env'
if (-not (Test-Path $envFile)) { Fail '没找到 .env。请把 .env.example 复制成 .env 并填好，再双击 start.cmd。' }
foreach ($line in Get-Content $envFile -Encoding UTF8) {
  if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') { $envMap[$Matches[1]] = $Matches[2].Trim().Trim('"') }
}
# 与后端一致：进程环境变量优先（dotenv 不覆盖已有变量），其次 .env，默认 8787
$ServerPort = 8787
if ($env:PORT -match '^\d+$') { $ServerPort = [int]$env:PORT }
elseif ($envMap['PORT'] -match '^\d+$') { $ServerPort = [int]$envMap['PORT'] }
$WebPort = 5173   # 与 apps/web 的 dev 脚本、vite.config.ts 一致

# ---- 1. Ollama 在线检查 ----
$provider = "$($envMap['LLM_PROVIDER'])".ToLower()
$baseUrl = "$($envMap['LLM_BASE_URL'])"
if ($provider -eq 'ollama' -or $baseUrl -match ':11434') {
  $origin = 'http://127.0.0.1:11434'
  if ($baseUrl -match '^(https?://[^/]+)') { $origin = $Matches[1] }
  $origin = $origin -replace '://localhost(?=[:/]|$)', '://127.0.0.1'   # Windows localhost may resolve to ::1
  Say "检查 Ollama（$origin）..."
  $ollamaOk = $true
  try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "$origin/api/tags" | Out-Null }
  catch { $ollamaOk = $false }
  if ($ollamaOk) { Say 'Ollama 在线。' 'Green' }
  else {
    # 产品口径：提示后继续起服，不卡死（语音、生图不依赖 Ollama，前端也能先打开）
    Say "注意：Ollama 没在运行（$origin 连不上），聊天会走失败提示。`n请先从开始菜单打开 Ollama，再关掉本窗口、重新双击 start.cmd。服务照常继续启动。" 'Yellow'
  }
}

# ---- 2. 端口占用检查 ----
function Test-PortBusy([int]$p) {
  $c = Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $c) { return $null }
  $name = (Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue).ProcessName
  return "端口 $p 已被占用（进程 $name，PID $($c.OwningProcess)）"
}
$busy = @((Test-PortBusy $ServerPort), (Test-PortBusy $WebPort)) | Where-Object { $_ }
if ($busy) {
  Fail (($busy -join "`n") + "`n可能是 Agent Chat 已经开着（看看有没有另一个 Agent Chat 窗口），或者别的程序占了端口。关掉它再双击 start.cmd。")
}

# ---- [REL-03 挂载点] 启动前备份：本刀不实现，REL-03 在这里调用备份脚本 ----

# ---- 3. Job Object：关窗 / Ctrl+C 时连同子进程一起结束 ----
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class AcJob {
  [StructLayout(LayoutKind.Sequential)] struct BASIC { public long a; public long b; public uint LimitFlags; public UIntPtr c; public UIntPtr d; public uint e; public UIntPtr f; public uint g; public uint h; }
  [StructLayout(LayoutKind.Sequential)] struct IOC { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] struct EXT { public BASIC Basic; public IOC Io; public UIntPtr p1; public UIntPtr p2; public UIntPtr p3; public UIntPtr p4; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr a, string n);
  [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr j, int c, ref EXT i, uint l);
  [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  public static IntPtr Handle;
  public static bool Init() {
    Handle = CreateJobObject(IntPtr.Zero, null);
    if (Handle == IntPtr.Zero) return false;
    EXT info = new EXT(); info.Basic.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if (!SetInformationJobObject(Handle, 9, ref info, (uint)Marshal.SizeOf(typeof(EXT)))) return false;
    return AssignProcessToJobObject(Handle, GetCurrentProcess());
  }
}
"@
$jobOk = $false
try { $jobOk = [AcJob]::Init() } catch {}
if (-not $jobOk) { Say '提示：无法建立进程组（Job），关窗时可能残留 node 进程；Ctrl+C 退出仍会清理。' 'Yellow' }

# ---- 4. 起前后端（不经 npm/cmd，避免「终止批处理」提示和孤儿进程） ----
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Fail '没找到 Node.js。请先安装 Node.js 20 以上版本。' }
$tsx = Join-Path $Root 'node_modules\tsx\dist\cli.mjs'
$vite = Join-Path $Root 'node_modules\vite\bin\vite.js'
if (-not (Test-Path $tsx) -or -not (Test-Path $vite)) { Fail '依赖没装好（node_modules 里缺 tsx 或 vite）。请在仓库根目录运行一次 npm ci。' }

$procs = @()
function Stop-All {
  foreach ($p in $script:procs) { if ($p -and -not $p.HasExited) { & taskkill.exe /T /F /PID $p.Id 2>$null | Out-Null } }
}
try {
  Say "启动后端（$ServerPort）和前端（$WebPort）..."
  $procs += Start-Process -FilePath $node -ArgumentList "`"$tsx`" watch src/index.ts" -WorkingDirectory (Join-Path $Root 'apps\server') -NoNewWindow -PassThru
  $procs += Start-Process -FilePath $node -ArgumentList "`"$vite`" --host 127.0.0.1 --port $WebPort --strictPort" -WorkingDirectory (Join-Path $Root 'apps\web') -NoNewWindow -PassThru

  # ---- 5. 等就绪 ----
  $deadline = (Get-Date).AddSeconds(90); $apiOk = $false; $webOk = $false
  while ((Get-Date) -lt $deadline -and -not ($apiOk -and $webOk)) {
    Start-Sleep -Milliseconds 800
    if ($procs | Where-Object { $_.HasExited }) { throw '有服务启动后马上退出了，请看上面的报错。' }
    if (-not $apiOk) { try { $apiOk = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://127.0.0.1:$ServerPort/api/conversations").StatusCode -eq 200 } catch {} }
    if (-not $webOk) { try { $webOk = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://127.0.0.1:$WebPort/").StatusCode -eq 200 } catch {} }
  }
  if (-not ($apiOk -and $webOk)) { throw "90 秒内没就绪（后端 $apiOk，前端 $webOk），请看上面的报错。" }
  Write-Host ''
  Say "Agent Chat 已就绪：http://127.0.0.1:$WebPort" 'Green'
  Say '关闭此窗口或按 Ctrl+C 即停止全部服务。' 'Green'
  if (-not $NoBrowser) { Start-Process "http://127.0.0.1:$WebPort" }

  while (-not ($procs | Where-Object { $_.HasExited })) { Start-Sleep -Seconds 1 }
  throw '有服务意外退出了，请看上面的报错。'
}
catch {
  Write-Host ''
  Write-Host $_.Exception.Message -ForegroundColor Red
  Stop-All
  Read-Host '按回车关闭窗口' | Out-Null
}
finally {
  Stop-All
}