export const PC_LLAMA_TAG = 'b11739';
export const PC_LLAMA_PORT = 8090;
export const PC_BIG_MODEL_MIN_MB = 11000;
export const PC_TWO_SLOTS_MIN_MB = 16000;
export const FIREWALL_RULE = 'Free Research LLM model server';

export function pcSetupScript({ tag = PC_LLAMA_TAG, port = PC_LLAMA_PORT } = {}) {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    `$tag = '${tag}'`,
    "$dir = Join-Path $env:LOCALAPPDATA 'frl-llama'",
    'New-Item -ItemType Directory -Force -Path $dir | Out-Null',
    "$gpus = (Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name }) -join ', '",
    '$vramMB = 0',
    '$smi = Get-Command nvidia-smi -ErrorAction SilentlyContinue',
    "if ($smi) { $vramMB = [int]((& nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | Select-Object -First 1).Trim()) }",
    "if ($smi) { $assets = @(\"llama-$tag-bin-win-cuda-12.4-x64.zip\", 'cudart-llama-bin-win-cuda-12.4-x64.zip') } else { $assets = @(\"llama-$tag-bin-win-vulkan-x64.zip\") }",
    'foreach ($asset in $assets) {',
    '  $zip = Join-Path $dir $asset',
    '  if (-not (Test-Path $zip)) { Write-Host "Downloading $asset ..."; Invoke-WebRequest -Uri "https://github.com/ggml-org/llama.cpp/releases/download/$tag/$asset" -OutFile $zip -UseBasicParsing }',
    '  Expand-Archive -Path $zip -DestinationPath $dir -Force',
    '}',
    "$server = Get-ChildItem -Path $dir -Recurse -Filter 'llama-server.exe' | Select-Object -First 1",
    "if (-not $server) { throw 'llama-server.exe was not found after unpacking' }",
    "$devices = (& $server.FullName --list-devices 2>&1 | Out-String)",
    "Write-Host \"Devices llama.cpp can use:`n$devices\"",
    "if ($devices -notmatch 'Vulkan|CUDA|SYCL|ROCm|HIP') { Write-Host 'WARNING: llama.cpp found no usable graphics card on this PC, so the model runs on the CPU, far too slowly for research. The research app measures its speed and will not send it research calls. Update the graphics driver (NVIDIA, AMD or Intel) and run this command again.' -ForegroundColor Yellow }",
    `if ($vramMB -ge ${PC_BIG_MODEL_MIN_MB}) { $model = 'ggml-org/Qwen3-14B-GGUF:Q4_K_M' } else { $model = 'ggml-org/Qwen3-4B-GGUF:Q4_K_M' }`,
    `if ($vramMB -ge ${PC_TWO_SLOTS_MIN_MB}) { $slots = 2 } else { $slots = 1 }`,
    '$ctx = 16384 * $slots',
    'Get-Process llama-server -ErrorAction SilentlyContinue | Stop-Process -Force',
    'Write-Host "Graphics: $gpus ($vramMB MB reported). Model: $model. The first start downloads it once."',
    `$serverArgs = @('-hf', $model, '-ngl', '99', '-c', "$ctx", '-np', "$slots", '-fa', 'on', '-ctk', 'q8_0', '-ctv', 'q8_0', '--cache-ram', '0', '--sleep-idle-seconds', '300', '--host', '0.0.0.0', '--port', '${port}', '-a', 'pc-model')`,
    'Start-Process -FilePath $server.FullName -ArgumentList $serverArgs -WorkingDirectory $server.DirectoryName -WindowStyle Minimized',
    "$startup = Join-Path ([Environment]::GetFolderPath('Startup')) 'frl-llama.cmd'",
    `Set-Content -Path $startup -Encoding ASCII -Value @('@echo off', ('cd /d "{0}"' -f $server.DirectoryName), ('start "frl-llama" /min "{0}" {1}' -f $server.FullName, ($serverArgs -join ' ')))`,
    "Write-Host \"Starts again by itself after a restart: $startup\"",
    '$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
    `$rule = '${FIREWALL_RULE}'`,
    `if ($admin) { if (-not (Get-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue)) { New-NetFirewallRule -DisplayName $rule -Direction Inbound -Protocol TCP -LocalPort ${port} -Action Allow -Profile Private,Domain | Out-Null }; Write-Host "Firewall: port ${port} open on private networks." } else { Write-Host "Firewall: if the research app still cannot reach this PC, open PowerShell as administrator once and run: New-NetFirewallRule -DisplayName '$rule' -Direction Inbound -Protocol TCP -LocalPort ${port} -Action Allow -Profile Private,Domain" -ForegroundColor Yellow }`,
    "$public = @(Get-NetConnectionProfile -ErrorAction SilentlyContinue | Where-Object { $_.NetworkCategory -eq 'Public' })",
    "if ($public.Count) { Write-Host \"This Wi-Fi is set to Public, which blocks other computers. As administrator run: Set-NetConnectionProfile -InterfaceIndex $($public[0].InterfaceIndex) -NetworkCategory Private\" -ForegroundColor Yellow }",
    '$up = $false',
    `for ($i = 0; $i -lt 120 -and -not $up; $i++) { try { Invoke-RestMethod -Uri 'http://127.0.0.1:${port}/v1/models' -TimeoutSec 3 | Out-Null; $up = $true } catch { Start-Sleep -Seconds 5 } }`,
    `if ($up) { Write-Host 'Model server answers on port ${port}. The research app connects within a minute; keep this PC awake while it helps.' -ForegroundColor Green } else { Write-Host 'The model server did not answer within 10 minutes (the first model download can take longer). Check the minimized frl-llama window.' -ForegroundColor Yellow }`,
    '',
  ].join('\r\n');
}

export function pcSetupCommand(base, token) {
  return `irm "${base}/pc-setup.ps1?share=${encodeURIComponent(token)}" | iex`;
}
