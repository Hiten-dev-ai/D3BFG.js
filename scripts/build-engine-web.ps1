param(
    [ValidateSet('Debug', 'Release')]
    [string]$Configuration = 'Release',
    [switch]$WorkerProfile,
    [ValidateRange(1, 8)]
    [int]$ParallelJobs = 2
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$sourceDir = Join-Path $repoRoot 'engine/chocolate-doom3-bfg'
if ($WorkerProfile) {
    $buildDir = Join-Path $repoRoot "build/engine-wasm-worker-$Configuration"
    $publicOutputDir = Join-Path $repoRoot 'web/public/engine-worker'
} else {
    $buildDir = Join-Path $repoRoot "build/engine-wasm-$Configuration"
    $publicOutputDir = Join-Path $repoRoot 'web/public/engine'
}
$outputDir = Join-Path $buildDir 'artifacts'

. (Join-Path $PSScriptRoot 'emsdk-env.ps1')
& (Join-Path $PSScriptRoot 'apply-emsdk-patches.ps1')
& (Join-Path $PSScriptRoot 'apply-engine-patches.ps1')

function Get-EngineSourceFingerprint {
    if (-not (Test-Path -LiteralPath (Join-Path $sourceDir '.git'))) {
        # Corresponding-source archives contain the adapted tree, not Git
        # metadata. They must remain buildable without inventing a repository.
        $sourceLines = @(Get-ChildItem -LiteralPath $sourceDir -Recurse -File |
            Where-Object { $_.Extension -notin @('.gch', '.o', '.obj', '.log') } |
            Sort-Object FullName | ForEach-Object {
                $_.FullName.Substring($sourceDir.Length) + ' ' + (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
            })
        $hasher = [System.Security.Cryptography.SHA256]::Create()
        try { return [Convert]::ToBase64String($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes(($sourceLines -join "`n")))) }
        finally { $hasher.Dispose() }
    }
    $patchText = (& git -C $sourceDir diff --no-ext-diff --binary HEAD -- . | Out-String)
    if ($LASTEXITCODE -ne 0) { throw 'Could not fingerprint engine source changes.' }
    $newFiles = @(& git -C $sourceDir ls-files --others --exclude-standard)
    if ($LASTEXITCODE -ne 0) { throw 'Could not inventory new engine sources.' }
    foreach ($relativePath in ($newFiles | Sort-Object)) {
        $filePath = Join-Path $sourceDir $relativePath
        if (Test-Path -LiteralPath $filePath -PathType Leaf) {
            $patchText += "$relativePath $((Get-FileHash -LiteralPath $filePath -Algorithm SHA256).Hash)`n"
        }
    }
    $hasher = [System.Security.Cryptography.SHA256]::Create()
    try { return [Convert]::ToBase64String($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($patchText))) }
    finally { $hasher.Dispose() }
}
$sourceFingerprint = Get-EngineSourceFingerprint

$toolchain = Join-Path $env:EMSDK 'upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake'
$cmakeCommand = (Get-Command cmake -ErrorAction Stop).Source
& $cmakeCommand -S $sourceDir -B $buildDir -G Ninja `
    "-DCMAKE_BUILD_TYPE=$Configuration" `
    "-DCMAKE_TOOLCHAIN_FILE=$toolchain" `
    -DUSE_OPENGL_ES=ON -DOPENAL=ON -DMONOLITH=ON `
    "-DDOOM3BFG_WEB_WORKER_PROFILE=$($WorkerProfile.IsPresent)" `
    "-DDOOM3BFG_WEB_OUTPUT_DIR=$outputDir"
if ($LASTEXITCODE -ne 0) {
    throw 'Engine CMake configuration failed.'
}

& $cmakeCommand --build $buildDir --parallel $ParallelJobs
if ($LASTEXITCODE -ne 0) {
    throw 'Engine WebAssembly build failed.'
}
if ((Get-EngineSourceFingerprint) -ne $sourceFingerprint) {
    throw 'Engine sources changed during the build. The previous published build is retained; rebuild after edits finish.'
}

# Publish a complete immutable JS/Wasm pair before changing the active manifest.
# A reload during linking must keep using the last successful engine build.
$jsArtifact = Join-Path $outputDir 'doom3_bfg_web.js'
$wasmArtifact = Join-Path $outputDir 'doom3_bfg_web.wasm'
if (-not (Test-Path $jsArtifact) -or -not (Test-Path $wasmArtifact)) {
    throw 'The engine build did not produce both JavaScript and Wasm artifacts.'
}
$version = ((Get-FileHash $jsArtifact -Algorithm SHA256).Hash.Substring(0, 12) +
    (Get-FileHash $wasmArtifact -Algorithm SHA256).Hash.Substring(0, 12)).ToLowerInvariant()
$versionDir = Join-Path $publicOutputDir $version
New-Item -ItemType Directory -Path $versionDir -Force | Out-Null
Get-ChildItem -LiteralPath $outputDir -File | Copy-Item -Destination $versionDir -Force
$buildInfo = @{
    format = 1
    version = $version
    modulePath = "$version/doom3_bfg_web.js"
    wasmPath = "$version/doom3_bfg_web.wasm"
    workerReadySignal = [bool](Select-String -LiteralPath $jsArtifact -SimpleMatch -Pattern 'onGameWorkerReady' -Quiet)
}
$pendingManifest = Join-Path $publicOutputDir 'build-info.pending.json'
$buildInfo | ConvertTo-Json | Set-Content -LiteralPath $pendingManifest -Encoding UTF8
Move-Item -LiteralPath $pendingManifest -Destination (Join-Path $publicOutputDir 'build-info.json') -Force
Write-Output "Published engine build $version."
exit 0
