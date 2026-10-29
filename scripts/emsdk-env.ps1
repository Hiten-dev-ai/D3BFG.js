# Use the activated official SDK rather than assuming its Node/Python versions.
$sdkRoot = if ($env:EMSDK) { $env:EMSDK } else { Join-Path $PSScriptRoot '../.tools/emsdk' }
$sdkRoot = [System.IO.Path]::GetFullPath($sdkRoot)
$sdkConfigPath = Join-Path $sdkRoot '.emscripten'
if (-not (Test-Path -LiteralPath $sdkConfigPath)) {
    throw 'Install/activate Emscripten 6.0.13 in .tools/emsdk, or set EMSDK to an activated official SDK.'
}
$sdkConfigText = Get-Content -LiteralPath $sdkConfigPath -Raw
function Read-SdkPath([string]$key, [string]$fallback = '') {
    # Read only literal path settings, never execute Python configuration or a
    # generated PowerShell environment file containing the user's quoted PATH.
    $match = [regex]::Match($sdkConfigText, ('(?m)^' + $key + '\s*=\s*(?:\[\s*)?[''"]([^''"]+)[''"]'))
    if ($match.Success) { return $match.Groups[1].Value.Replace('$CFGDIR', $sdkRoot) }
    return $fallback
}
$env:EMSDK = $sdkRoot
$env:EMSDK_NODE = Read-SdkPath 'NODE_JS'
$env:EMSDK_PYTHON = Read-SdkPath 'PYTHON' ((Get-Command python -ErrorAction Stop).Source)
$emscripten = Read-SdkPath 'EMSCRIPTEN_ROOT' (Join-Path $sdkRoot 'upstream/emscripten')
$llvm = Read-SdkPath 'LLVM_ROOT' (Join-Path $sdkRoot 'upstream/bin')
if (-not (Test-Path -LiteralPath $env:EMSDK_NODE) -or -not (Test-Path -LiteralPath $env:EMSDK_PYTHON)) {
    throw 'The activated SDK has missing Node/Python tools; run emsdk install and activate first.'
}
$ninja = Get-ChildItem -LiteralPath (Join-Path $sdkRoot 'ninja') -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -in @('ninja', 'ninja.exe') } | Select-Object -First 1
$paths = @($sdkRoot, $emscripten, $llvm, (Split-Path $env:EMSDK_NODE), (Split-Path $env:EMSDK_PYTHON))
if ($ninja) { $paths += $ninja.DirectoryName }
$env:PATH = ($paths -join [IO.Path]::PathSeparator) + [IO.Path]::PathSeparator + $env:PATH
if (-not (Get-Command emcc -ErrorAction SilentlyContinue)) { throw 'The activated SDK did not provide emcc.' }
Write-Host "Project Emscripten SDK enabled from $sdkRoot"
