export const PC_LLAMA_TAG = 'b11739';
export const PC_LLAMA_PORT = 8090;
export const PC_BIG_MODEL_MIN_MB = 11000;

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
    'Get-Process llama-server -ErrorAction SilentlyContinue | Stop-Process -Force',
    'Write-Host "Graphics: $gpus ($vramMB MB reported). Model: $model. The first start downloads it once."',
    "Write-Host 'If Windows Firewall asks, allow llama-server on private networks.'",
    `Start-Process -FilePath $server.FullName -ArgumentList @('-hf', $model, '-ngl', '99', '-c', '16384', '-np', '1', '--host', '0.0.0.0', '--port', '${port}', '-a', 'pc-model') -WorkingDirectory $server.DirectoryName`,
    "Write-Host 'llama-server is starting in its own window. Keep that window open; the research app finds this PC within a minute.'",
    '',
  ].join('\r\n');
}

export function pcSetupCommand(base, token) {
  return `irm "${base}/pc-setup.ps1?share=${encodeURIComponent(token)}" | iex`;
}
