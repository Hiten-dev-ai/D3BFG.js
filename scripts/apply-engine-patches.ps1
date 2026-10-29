param()

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$repoRoot = Split-Path -Parent $PSScriptRoot
$engineRoot = Join-Path $repoRoot 'engine/chocolate-doom3-bfg'
$completePortPatch = Join-Path $repoRoot 'patches/chocolate-doom3-bfg/browser-port-complete.patch'
if (Test-Path -LiteralPath $completePortPatch) {
    $completePortPresent = (Test-Path (Join-Path $engineRoot 'neo/d3xp/menus/MenuScreen_Shell_WebSettings.cpp')) -and
        (Select-String -LiteralPath (Join-Path $engineRoot 'neo/sys/sdl/sdl_glimp.cpp') -SimpleMatch -Pattern 'ReadBrowserDisplay' -Quiet) -and
        (Select-String -LiteralPath (Join-Path $engineRoot 'neo/framework/Common_load.cpp') -SimpleMatch -Pattern 'doom3-session-state' -Quiet)
    if ($completePortPresent) {
        Write-Output 'Complete browser engine adaptation is already present.'
        exit 0
    }
    & git -C $engineRoot apply --check $completePortPatch
    if ($LASTEXITCODE -ne 0) { throw 'The complete browser engine patch does not match this submodule revision. Preserve local edits and inspect the patch before continuing.' }
    & git -C $engineRoot apply $completePortPatch
    if ($LASTEXITCODE -ne 0) { throw 'Failed to apply the complete browser engine patch.' }
    Write-Output 'Applied the complete browser engine adaptation.'
    exit 0
}
$patchFile = Join-Path $repoRoot 'patches/chocolate-doom3-bfg/webgl2-emscripten.patch'
$webWorkerJobThreadsPatch = Join-Path $repoRoot 'patches/chocolate-doom3-bfg/web-worker-job-threads.patch'
$anisotropicFilterPatch = Join-Path $repoRoot 'patches/chocolate-doom3-bfg/webgl2-anisotropic-filtering.patch'
$rgb565UploadPatch = Join-Path $repoRoot 'patches/chocolate-doom3-bfg/webgl2-rgb565-upload.patch'
$s3tcFallbackPatch = Join-Path $repoRoot 'patches/chocolate-doom3-bfg/webgl2-s3tc-dimension-fallback.patch'
$textureCoordinateQueryPatch = Join-Path $repoRoot 'patches/chocolate-doom3-bfg/webgl2-max-texture-coordinate-query.patch'
$textureUnitCachePatch = Join-Path $repoRoot 'patches/chocolate-doom3-bfg/webgl2-texture-unit-cache.patch'
$activeTextureSyncPatch = Join-Path $repoRoot 'patches/chocolate-doom3-bfg/webgl2-active-texture-sync.patch'
$bufferMapTracePatch = Join-Path $repoRoot 'patches/chocolate-doom3-bfg/webgl2-buffer-map-trace.patch'
$renderPassTracePatch = Join-Path $repoRoot 'patches/chocolate-doom3-bfg/webgl2-render-pass-trace.patch'
$interactionTracePatch = Join-Path $repoRoot 'patches/chocolate-doom3-bfg/webgl2-interaction-trace.patch'
$flatSceneTracePatch = Join-Path $repoRoot 'patches/chocolate-doom3-bfg/webgl2-flat-scene-trace.patch'
$interactionStateTracePatch = Join-Path $repoRoot 'patches/chocolate-doom3-bfg/webgl2-interaction-state-trace.patch'
$interactionIsolationPatch = Join-Path $repoRoot 'patches/chocolate-doom3-bfg/webgl2-interaction-isolation.patch'
$interactionMatrixPatch = Join-Path $repoRoot 'patches/chocolate-doom3-bfg/webgl2-interaction-matrix.patch'
$ambientStageTracePatch = Join-Path $repoRoot 'patches/chocolate-doom3-bfg/webgl2-ambient-stage-trace.patch'
$renderPassCameraTracePatch = Join-Path $repoRoot 'patches/chocolate-doom3-bfg/webgl2-render-pass-camera-trace.patch'
$highpShaderPatch = Join-Path $repoRoot 'patches/chocolate-doom3-bfg/webgl2-highp-shaders.patch'
$mapStagingPatch = Join-Path $repoRoot 'patches/chocolate-doom3-bfg/on-demand-map-staging.patch'
$mapCompletionTracePatch = Join-Path $repoRoot 'patches/chocolate-doom3-bfg/web-map-completion-trace.patch'
$mapPreloadPatch = Join-Path $repoRoot 'patches/chocolate-doom3-bfg/web-map-preload.patch'
$vfsTracePatch = Join-Path $repoRoot 'patches/chocolate-doom3-bfg/web-vfs-trace.patch'
$hudBTracePatch = Join-Path $repoRoot 'patches/chocolate-doom3-bfg/web-hud-b-trace.patch'
$floorGrateTracePatch = Join-Path $repoRoot 'patches/chocolate-doom3-bfg/web-floorgrate-trace.patch'
$floorGrateResourceTracePatch = Join-Path $repoRoot 'patches/chocolate-doom3-bfg/web-floorgrate-resource-trace.patch'
$floorGrateBimageTracePatch = Join-Path $repoRoot 'patches/chocolate-doom3-bfg/web-floorgrate-bimage-trace.patch'
$skScan1ImageTracePatch = Join-Path $repoRoot 'patches/chocolate-doom3-bfg/web-skscan1-image-trace.patch'
$ps3SquareImageTracePatch = Join-Path $repoRoot 'patches/chocolate-doom3-bfg/web-ps3-square-image-trace.patch'
$sessionNetworkingPatch = Join-Path $repoRoot 'patches/chocolate-doom3-bfg/browser-session-networking.patch'
$saveDiagnosticsPatch = Join-Path $repoRoot 'patches/chocolate-doom3-bfg/browser-save-diagnostics.patch'
$cinematicSkipPatch = Join-Path $repoRoot 'patches/chocolate-doom3-bfg/cinematic-skip-shortcut.patch'
$cinematicInputConsumptionPatch = Join-Path $repoRoot 'patches/chocolate-doom3-bfg/cinematic-skip-input-consumption.patch'
$cinematicInputAddHandlerPatch = Join-Path $repoRoot 'patches/chocolate-doom3-bfg/cinematic-skip-input-add-handler.patch'
$startupTracePatch = Join-Path $repoRoot 'patches/chocolate-doom3-bfg/web-startup-trace.patch'
$viewportBackingPatch = Join-Path $repoRoot 'patches/chocolate-doom3-bfg/webgl2-viewport-backing-size.patch'
$wasmBinkDecPatch = Join-Path $repoRoot 'patches/chocolate-doom3-bfg/wasm-binkdec.patch'

if (-not (Test-Path $engineRoot)) {
    throw "Engine submodule is missing: $engineRoot"
}
if (-not (Test-Path $patchFile)) {
    throw "Engine patch is missing: $patchFile"
}
if (-not (Test-Path $webWorkerJobThreadsPatch)) {
    throw "Web worker job-thread patch is missing: $webWorkerJobThreadsPatch"
}
if (-not (Test-Path $anisotropicFilterPatch)) {
    throw "WebGL2 anisotropic-filtering patch is missing: $anisotropicFilterPatch"
}
if (-not (Test-Path $rgb565UploadPatch)) {
    throw "WebGL2 RGB565 upload patch is missing: $rgb565UploadPatch"
}
if (-not (Test-Path $s3tcFallbackPatch)) {
    throw "WebGL2 S3TC dimension fallback patch is missing: $s3tcFallbackPatch"
}
if (-not (Test-Path $textureCoordinateQueryPatch)) {
    throw "WebGL2 texture-coordinate query patch is missing: $textureCoordinateQueryPatch"
}
if (-not (Test-Path $textureUnitCachePatch)) {
    throw "WebGL2 texture-unit cache patch is missing: $textureUnitCachePatch"
}
if (-not (Test-Path $activeTextureSyncPatch)) {
    throw "WebGL2 active-texture synchronization patch is missing: $activeTextureSyncPatch"
}
if (-not (Test-Path $bufferMapTracePatch)) {
    throw "WebGL buffer-map diagnostic patch is missing: $bufferMapTracePatch"
}
if (-not (Test-Path $renderPassTracePatch)) {
    throw "WebGL render-pass trace patch is missing: $renderPassTracePatch"
}
if (-not (Test-Path $interactionTracePatch)) {
    throw "WebGL interaction trace patch is missing: $interactionTracePatch"
}
if (-not (Test-Path $flatSceneTracePatch)) {
    throw "WebGL flat-scene trace patch is missing: $flatSceneTracePatch"
}
if (-not (Test-Path $interactionStateTracePatch)) {
    throw "WebGL interaction-state trace patch is missing: $interactionStateTracePatch"
}
if (-not (Test-Path $interactionIsolationPatch)) {
    throw "WebGL interaction-isolation patch is missing: $interactionIsolationPatch"
}
if (-not (Test-Path $interactionMatrixPatch)) {
    throw "WebGL interaction-matrix patch is missing: $interactionMatrixPatch"
}
if (-not (Test-Path $ambientStageTracePatch)) {
    throw "WebGL ambient-stage trace patch is missing: $ambientStageTracePatch"
}
if (-not (Test-Path $renderPassCameraTracePatch)) {
    throw "WebGL render-pass camera-trace patch is missing: $renderPassCameraTracePatch"
}
if (-not (Test-Path $highpShaderPatch)) {
    throw "WebGL2 shader precision patch is missing: $highpShaderPatch"
}
if (-not (Test-Path $mapStagingPatch)) {
    throw "Map staging patch is missing: $mapStagingPatch"
}
if (-not (Test-Path $mapCompletionTracePatch)) {
    throw "Map completion trace patch is missing: $mapCompletionTracePatch"
}
if (-not (Test-Path $mapPreloadPatch)) {
    throw "Map preload patch is missing: $mapPreloadPatch"
}
if (-not (Test-Path $vfsTracePatch)) {
    throw "Browser VFS trace patch is missing: $vfsTracePatch"
}
if (-not (Test-Path $hudBTracePatch)) {
    throw "HUD-b image trace patch is missing: $hudBTracePatch"
}
if (-not (Test-Path $floorGrateTracePatch)) {
    throw "Floor-grate image trace patch is missing: $floorGrateTracePatch"
}
if (-not (Test-Path $floorGrateResourceTracePatch)) {
    throw "Floor-grate resource trace patch is missing: $floorGrateResourceTracePatch"
}
if (-not (Test-Path $floorGrateBimageTracePatch)) {
    throw "Floor-grate generated-image trace patch is missing: $floorGrateBimageTracePatch"
}
if (-not (Test-Path $skScan1ImageTracePatch)) {
    throw "Medical scan image trace patch is missing: $skScan1ImageTracePatch"
}
if (-not (Test-Path $ps3SquareImageTracePatch)) {
    throw "PS3 square image trace patch is missing: $ps3SquareImageTracePatch"
}
if (-not (Test-Path $sessionNetworkingPatch)) {
    throw "Browser session networking patch is missing: $sessionNetworkingPatch"
}
if (-not (Test-Path $saveDiagnosticsPatch)) {
    throw "Browser save diagnostics patch is missing: $saveDiagnosticsPatch"
}
if (-not (Test-Path $cinematicSkipPatch)) {
    throw "Cinematic skip shortcut patch is missing: $cinematicSkipPatch"
}
if (-not (Test-Path $cinematicInputConsumptionPatch)) {
    throw "Cinematic skip input-consumption patch is missing: $cinematicInputConsumptionPatch"
}
if (-not (Test-Path $cinematicInputAddHandlerPatch)) {
    throw "Cinematic skip handler patch is missing: $cinematicInputAddHandlerPatch"
}
if (-not (Test-Path $startupTracePatch)) {
    throw "Web startup trace patch is missing: $startupTracePatch"
}
if (-not (Test-Path $viewportBackingPatch)) {
    throw "WebGL2 viewport backing-size patch is missing: $viewportBackingPatch"
}
if (-not (Test-Path $wasmBinkDecPatch)) {
    throw "Wasm Bink decoder patch is missing: $wasmBinkDecPatch"
}

$commonLoadFile = Join-Path $engineRoot 'neo/framework/Common_load.cpp'
$fileSystemFile = Join-Path $engineRoot 'neo/framework/FileSystem.cpp'
$resourceFile = Join-Path $engineRoot 'neo/framework/File_Resource.cpp'
$mapStagingApplied = Select-String -Path $commonLoadFile -Pattern 'WebStageMapResources' -Quiet
$nativeLoadingScreenPresentedBeforeStage = Select-String -Path $commonLoadFile -Pattern 'native loading screen presented before archive staging' -Quiet
$resourceInitDiagnosticsApplied = Select-String -Path $fileSystemFile -Pattern 'AddResourceFile init started' -Quiet
$resourceIndexDiagnosticsApplied = Select-String -Path $resourceFile -Pattern 'resource index parsed' -Quiet

if ($mapStagingApplied -and (-not $nativeLoadingScreenPresentedBeforeStage -or -not $resourceInitDiagnosticsApplied -or -not $resourceIndexDiagnosticsApplied)) {
    throw 'The on-demand map staging patch is outdated in the engine checkout. Recreate the engine checkout or apply the current maintained patch.'
}

if (-not $mapStagingApplied) {
    & git -C $engineRoot apply --check $mapStagingPatch
    if ($LASTEXITCODE -ne 0) {
        throw 'On-demand map staging patch does not apply cleanly to this submodule revision.'
    }
    & git -C $engineRoot apply $mapStagingPatch
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to apply the on-demand map staging patch.'
    }
    Write-Output 'Applied the on-demand map staging patch.'
} else {
    Write-Output 'On-demand map staging patch is already applied.'
}

$mapCompletionTraceApplied = Select-String -Path $commonLoadFile -SimpleMatch -Pattern '[web-port map] ExecuteMapChange reached mapSpawned map=%s' -Quiet
if ($mapCompletionTraceApplied) {
    Write-Output 'Map completion diagnostics are already applied.'
} else {
    & git -C $engineRoot apply --check $mapCompletionTracePatch
    if ($LASTEXITCODE -ne 0) {
        throw 'Map completion diagnostics patch does not apply after on-demand map staging.'
    }

    & git -C $engineRoot apply $mapCompletionTracePatch
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to apply map completion diagnostics.'
    }

    Write-Output 'Applied map completion diagnostics.'
}

$enginePatchCmakeApplied = Select-String -Path (Join-Path $engineRoot 'CMakeLists.txt') -SimpleMatch -Pattern 'DOOM3BFG_WEB_WORKER_PROFILE' -Quiet
$enginePatchSourceApplied = Select-String -Path (Join-Path $engineRoot 'neo/renderer/RenderSystem_init.cpp') -SimpleMatch -Pattern 'EMSCRIPTEN_WEBGL_CONTEXT_HANDLE webglContext' -Quiet
if ($enginePatchCmakeApplied -and $enginePatchSourceApplied) {
    Write-Output 'Emscripten/WebGL2 engine patch is already applied.'
} elseif ($enginePatchCmakeApplied) {
    & git -C $engineRoot apply --check --exclude=CMakeLists.txt $patchFile
    if ($LASTEXITCODE -ne 0) {
        throw 'Remaining Emscripten/WebGL2 source patches do not apply cleanly.'
    }

    & git -C $engineRoot apply --exclude=CMakeLists.txt $patchFile
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to apply the remaining Emscripten/WebGL2 source patches.'
    }

    Write-Output 'Applied remaining Emscripten/WebGL2 source patches.'
} elseif ($enginePatchSourceApplied) {
    & git -C $engineRoot apply --check --include=CMakeLists.txt $patchFile
    if ($LASTEXITCODE -ne 0) {
        throw 'Remaining Emscripten/WebGL2 CMake patch does not apply cleanly.'
    }

    & git -C $engineRoot apply --include=CMakeLists.txt $patchFile
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to apply the remaining Emscripten/WebGL2 CMake patch.'
    }

    Write-Output 'Applied remaining Emscripten/WebGL2 CMake changes.'
} else {
    & git -C $engineRoot apply --check $patchFile
    if ($LASTEXITCODE -ne 0) {
        throw 'Engine patch does not apply cleanly to this submodule revision.'
    }

    & git -C $engineRoot apply $patchFile
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to apply the Emscripten/WebGL2 engine patch.'
    }

    Write-Output 'Applied the Emscripten/WebGL2 engine patch.'
}

$parallelJobFile = Join-Path $engineRoot 'neo/idlib/ParallelJobList.cpp'
$threadFile = Join-Path $engineRoot 'neo/idlib/Thread.cpp'
$webJobThreadsCapped = Select-String -Path $parallelJobFile -SimpleMatch -Pattern '#if defined(__EMSCRIPTEN_PTHREADS__)' -Quiet
$webWorkerStartNonblocking = Select-String -Path $threadFile -SimpleMatch -Pattern '#if !defined(__EMSCRIPTEN_PTHREADS__)' -Quiet
$webWorkerPoolExpanded = Select-String -Path (Join-Path $engineRoot 'CMakeLists.txt') -SimpleMatch -Pattern '"-sPTHREAD_POOL_SIZE=8"' -Quiet
if ($webJobThreadsCapped -and (-not $webWorkerStartNonblocking) -and $webWorkerPoolExpanded) {
    Write-Output 'Web worker pthread pool tuning and startup barrier are already applied.'
} else {
    & git -C $engineRoot apply --check $webWorkerJobThreadsPatch
    if ($LASTEXITCODE -ne 0) {
        throw 'Web worker pthread startup patch does not apply cleanly.'
    }

    & git -C $engineRoot apply $webWorkerJobThreadsPatch
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to apply web worker pthread startup tuning.'
    }

    Write-Output 'Applied web worker pthread startup tuning.'
}

$renderSystemInitFile = Join-Path $engineRoot 'neo/renderer/RenderSystem_init.cpp'
$webAnisotropyEnableApplied = Select-String -Path $renderSystemInitFile -SimpleMatch -Pattern 'emscripten_webgl_enable_extension(anisotropyContext, "EXT_texture_filter_anisotropic")' -Quiet
if ($webAnisotropyEnableApplied) {
    Write-Output 'WebGL anisotropic filtering is already enabled when supported.'
} else {
    & git -C $engineRoot apply --check $anisotropicFilterPatch
    if ($LASTEXITCODE -ne 0) {
        throw 'WebGL anisotropic-filtering patch does not apply after the Emscripten/WebGL2 engine patch.'
    }

    & git -C $engineRoot apply $anisotropicFilterPatch
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to apply WebGL anisotropic-filtering support.'
    }

    Write-Output 'Applied WebGL anisotropic-filtering support.'
}

$textureCoordinateQueryApplied = Select-String -Path $renderSystemInitFile -SimpleMatch -Pattern 'glConfig.maxTextureCoords = 0;' -Quiet
if ($textureCoordinateQueryApplied) {
    Write-Output 'WebGL2 legacy texture-coordinate query handling is already applied.'
} else {
    & git -C $engineRoot apply --check $textureCoordinateQueryPatch
    if ($LASTEXITCODE -ne 0) {
        throw 'WebGL2 texture-coordinate query patch does not apply after the Emscripten/WebGL2 engine patch.'
    }

    & git -C $engineRoot apply $textureCoordinateQueryPatch
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to apply WebGL2 texture-coordinate query handling.'
    }

    Write-Output 'Applied WebGL2 texture-coordinate query handling.'
}

$webGlImageFile = Join-Path $engineRoot 'neo/renderer/OpenGL/gl_Image.cpp'
$rgb565UploadApplied = Select-String -Path $webGlImageFile -SimpleMatch -Pattern 'const bool webSwapRGB565 = opts.format == FMT_RGB565 && !webExpandTexture;' -Quiet
if ($rgb565UploadApplied) {
    Write-Output 'WebGL2 RGB565 byte-order handling is already applied.'
} else {
    & git -C $engineRoot apply --check $rgb565UploadPatch
    if ($LASTEXITCODE -ne 0) {
        throw 'WebGL2 RGB565 byte-order patch does not apply after the Emscripten/WebGL2 engine patch.'
    }

    & git -C $engineRoot apply $rgb565UploadPatch
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to apply WebGL2 RGB565 byte-order handling.'
    }

    Write-Output 'Applied WebGL2 RGB565 byte-order handling.'
}

$s3tcFallbackApplied = Select-String -Path $webGlImageFile -SimpleMatch -Pattern 'const bool s3tcDimensionFallback =' -Quiet
$s3tcPaddedDecodeApplied = Select-String -Path $webGlImageFile -SimpleMatch -Pattern 'const int decodedWidth = (sourceWidth + 3) & ~3;' -Quiet
if ($s3tcFallbackApplied -and $s3tcPaddedDecodeApplied) {
    Write-Output 'WebGL2 non-block-aligned S3TC fallback is already applied.'
} elseif ($s3tcFallbackApplied -or $s3tcPaddedDecodeApplied) {
    throw 'WebGL2 S3TC dimension fallback is only partially applied. Recreate the engine checkout or apply the current maintained patch.'
} else {
    & git -C $engineRoot apply --check $s3tcFallbackPatch
    if ($LASTEXITCODE -ne 0) {
        throw 'WebGL2 S3TC dimension fallback patch does not apply after the RGB565 upload patch.'
    }

    & git -C $engineRoot apply $s3tcFallbackPatch
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to apply WebGL2 S3TC dimension fallback.'
    }

    Write-Output 'Applied WebGL2 non-block-aligned S3TC fallback.'
}

$bufferObjectFile = Join-Path $engineRoot 'neo/renderer/BufferObject.cpp'
$bufferMapTraceCvarApplied = Select-String -Path $bufferObjectFile -SimpleMatch -Pattern 'r_webPortBufferTrace("r_webPortBufferTrace"' -Quiet
$bufferMapTraceHelperApplied = Select-String -Path $bufferObjectFile -SimpleMatch -Pattern 'static void WebPortTraceBuffer' -Quiet
$bufferMapTraceEndApplied = Select-String -Path $bufferObjectFile -SimpleMatch -Pattern '"joint", "unmap-result"' -Quiet
$bufferMapTraceApplied = $bufferMapTraceCvarApplied -and $bufferMapTraceHelperApplied -and $bufferMapTraceEndApplied
$bufferMapTracePartiallyApplied = $bufferMapTraceCvarApplied -or $bufferMapTraceHelperApplied -or $bufferMapTraceEndApplied
if ($bufferMapTraceApplied) {
    Write-Output 'WebGL streaming-buffer diagnostics are already applied.'
} elseif ($bufferMapTracePartiallyApplied) {
    throw 'WebGL streaming-buffer diagnostics are only partially applied. Recreate the engine checkout or apply the current maintained patch.'
} else {
    & git -C $engineRoot apply --check $bufferMapTracePatch
    if ($LASTEXITCODE -ne 0) {
        throw 'WebGL streaming-buffer diagnostics do not apply after the Emscripten/WebGL2 engine patch.'
    }

    & git -C $engineRoot apply $bufferMapTracePatch
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to apply WebGL streaming-buffer diagnostics.'
    }

    Write-Output 'Applied WebGL streaming-buffer diagnostics.'
}

$renderPassTraceFile = Join-Path $engineRoot 'neo/renderer/tr_backend_draw.cpp'
$renderPassTraceCvarApplied = Select-String -Path $renderPassTraceFile -SimpleMatch -Pattern 'r_webPortPassTrace("r_webPortPassTrace"' -Quiet
$renderPassTraceHelperApplied = Select-String -Path $renderPassTraceFile -SimpleMatch -Pattern 'static void RB_WebPortTracePassPixels' -Quiet
$renderPassTraceDepthApplied = Select-String -Path $renderPassTraceFile -SimpleMatch -Pattern 'RB_WebPortTracePassPixels("depth", numDrawSurfs)' -Quiet
$renderPassTraceInteractionsApplied = Select-String -Path $renderPassTraceFile -SimpleMatch -Pattern 'RB_WebPortTracePassPixels("interactions", numDrawSurfs)' -Quiet
$renderPassTraceShaderApplied = Select-String -Path $renderPassTraceFile -SimpleMatch -Pattern 'RB_WebPortTracePassPixels("shader", numDrawSurfs)' -Quiet
$renderPassTraceApplied = $renderPassTraceCvarApplied -and $renderPassTraceHelperApplied -and $renderPassTraceDepthApplied -and $renderPassTraceInteractionsApplied -and $renderPassTraceShaderApplied
$renderPassTracePartiallyApplied = $renderPassTraceCvarApplied -or $renderPassTraceHelperApplied -or $renderPassTraceDepthApplied -or $renderPassTraceInteractionsApplied -or $renderPassTraceShaderApplied
if ($renderPassTraceApplied) {
    Write-Output 'WebGL render-pass pixel diagnostics are already applied.'
} elseif ($renderPassTracePartiallyApplied) {
    throw 'WebGL render-pass pixel diagnostics are only partially applied. Recreate the engine checkout or apply the current maintained patch.'
} else {
    & git -C $engineRoot apply --check $renderPassTracePatch
    if ($LASTEXITCODE -ne 0) {
        throw 'WebGL render-pass pixel diagnostics do not apply after the Emscripten/WebGL2 engine patch.'
    }

    & git -C $engineRoot apply $renderPassTracePatch
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to apply WebGL render-pass pixel diagnostics.'
    }

    Write-Output 'Applied WebGL render-pass pixel diagnostics.'
}

$interactionTraceDrawApplied = Select-String -Path $renderPassTraceFile -SimpleMatch -Pattern '[web-port lighting] draw=' -Quiet
$interactionTraceCountApplied = Select-String -Path $renderPassTraceFile -SimpleMatch -Pattern 'RB_WebPortCountInteractionSurfaces' -Quiet
$interactionTraceSummaryApplied = Select-String -Path $renderPassTraceFile -SimpleMatch -Pattern '[web-port lighting] summary' -Quiet
$interactionTraceApplied = $interactionTraceDrawApplied -and $interactionTraceCountApplied -and $interactionTraceSummaryApplied
$interactionTracePartiallyApplied = $interactionTraceDrawApplied -or $interactionTraceCountApplied -or $interactionTraceSummaryApplied
if ($interactionTraceApplied) {
    Write-Output 'WebGL light-interaction diagnostics are already applied.'
} elseif ($interactionTracePartiallyApplied) {
    throw 'WebGL light-interaction diagnostics are only partially applied. Recreate the engine checkout or apply the current maintained patch.'
} else {
    & git -C $engineRoot apply --check $interactionTracePatch
    if ($LASTEXITCODE -ne 0) {
        throw 'WebGL light-interaction diagnostics do not apply after the render-pass trace patch.'
    }

    & git -C $engineRoot apply $interactionTracePatch
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to apply WebGL light-interaction diagnostics.'
    }

    Write-Output 'Applied WebGL light-interaction diagnostics.'
}

$flatSceneTraceCvarApplied = Select-String -Path $renderPassTraceFile -SimpleMatch -Pattern 'r_webPortFlatTrace("r_webPortFlatTrace"' -Quiet
$flatSceneTraceDrawApplied = Select-String -Path $renderPassTraceFile -SimpleMatch -Pattern 'flatTraceColor[4] = { 1.0f, 0.0f, 1.0f, 1.0f }' -Quiet
$flatSceneTraceApplied = $flatSceneTraceCvarApplied -and $flatSceneTraceDrawApplied
$flatSceneTracePartiallyApplied = $flatSceneTraceCvarApplied -or $flatSceneTraceDrawApplied
if ($flatSceneTraceApplied) {
    Write-Output 'WebGL flat opaque-surface diagnostic is already applied.'
} elseif ($flatSceneTracePartiallyApplied) {
    throw 'WebGL flat-scene diagnostics are only partially applied. Recreate the engine checkout or apply the current maintained patch.'
} else {
    & git -C $engineRoot apply --check $flatSceneTracePatch
    if ($LASTEXITCODE -ne 0) {
        throw 'WebGL flat-scene diagnostic does not apply after the interaction trace patch.'
    }

    & git -C $engineRoot apply $flatSceneTracePatch
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to apply the WebGL flat-scene diagnostic.'
    }

    Write-Output 'Applied WebGL flat opaque-surface diagnostic.'
}

$interactionStateTraceCvarApplied = Select-String -Path $renderPassTraceFile -SimpleMatch -Pattern 'r_webPortBypassInteractionDepthStencil("r_webPortBypassInteractionDepthStencil"' -Quiet
$interactionStateTraceFuncApplied = Select-String -Path $renderPassTraceFile -SimpleMatch -Pattern 'const bool bypassInteractionDepthStencil = r_webPortBypassInteractionDepthStencil.GetBool();' -Quiet
$interactionStateTraceApplied = $interactionStateTraceCvarApplied -and $interactionStateTraceFuncApplied
$interactionStateTracePartiallyApplied = $interactionStateTraceCvarApplied -or $interactionStateTraceFuncApplied
if ($interactionStateTraceApplied) {
    Write-Output 'WebGL interaction depth/stencil diagnostic is already applied.'
} elseif ($interactionStateTracePartiallyApplied) {
    throw 'WebGL interaction-state diagnostics are only partially applied. Recreate the engine checkout or apply the current maintained patch.'
} else {
    & git -C $engineRoot apply --check $interactionStateTracePatch
    if ($LASTEXITCODE -ne 0) {
        throw 'WebGL interaction-state diagnostic does not apply after the flat-scene trace patch.'
    }

    & git -C $engineRoot apply $interactionStateTracePatch
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to apply the WebGL interaction-state diagnostic.'
    }

    Write-Output 'Applied WebGL interaction depth/stencil diagnostic.'
}

$interactionIsolationCvarApplied = Select-String -Path $renderPassTraceFile -SimpleMatch -Pattern 'r_webPortInteractionIsolationMode("r_webPortInteractionIsolationMode"' -Quiet
$interactionIsolationDepthApplied = Select-String -Path $renderPassTraceFile -SimpleMatch -Pattern 'interactionIsolationMode == 4 ? GLS_DEPTHFUNC_LESS' -Quiet
$interactionIsolationSummaryApplied = Select-String -Path $renderPassTraceFile -SimpleMatch -Pattern 'summary isolation=%d' -Quiet
$interactionIsolationApplied = $interactionIsolationCvarApplied -and $interactionIsolationDepthApplied -and $interactionIsolationSummaryApplied
$interactionIsolationPartiallyApplied = $interactionIsolationCvarApplied -or $interactionIsolationDepthApplied -or $interactionIsolationSummaryApplied
if ($interactionIsolationApplied) {
    Write-Output 'WebGL interaction isolation diagnostics are already applied.'
} elseif ($interactionIsolationPartiallyApplied) {
    throw 'WebGL interaction isolation diagnostics are only partially applied. Recreate the engine checkout or apply the current maintained patch.'
} else {
    & git -C $engineRoot apply --check $interactionIsolationPatch
    if ($LASTEXITCODE -ne 0) {
        throw 'WebGL interaction isolation patch does not apply after the interaction-state diagnostic.'
    }

    & git -C $engineRoot apply $interactionIsolationPatch
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to apply WebGL interaction isolation diagnostics.'
    }

    Write-Output 'Applied WebGL interaction isolation diagnostics.'
}

$interactionMatrixFrameLimitApplied = (Select-String -Path $renderPassTraceFile -SimpleMatch -Pattern 'tracedFrames >= 5' -Quiet) -or (Select-String -Path $renderPassTraceFile -SimpleMatch -Pattern 'static int lastTracedGameSecond = -1;' -Quiet)
$interactionMatrixTraceLimitApplied = Select-String -Path $renderPassTraceFile -SimpleMatch -Pattern 'webPortInteractionTraceFrames < 5' -Quiet
$interactionMatrixCycleApplied = Select-String -Path $renderPassTraceFile -SimpleMatch -Pattern 'static int webPortAutoIsolationFrame = 0;' -Quiet
$interactionMatrixModeApplied = Select-String -Path $renderPassTraceFile -SimpleMatch -Pattern 'if (interactionIsolationMode < 0)' -Quiet
$interactionMatrixApplied = $interactionMatrixFrameLimitApplied -and $interactionMatrixTraceLimitApplied -and $interactionMatrixCycleApplied -and $interactionMatrixModeApplied
$interactionMatrixPartiallyApplied = $interactionMatrixFrameLimitApplied -or $interactionMatrixTraceLimitApplied -or $interactionMatrixCycleApplied -or $interactionMatrixModeApplied
if ($interactionMatrixApplied) {
    Write-Output 'WebGL five-frame interaction matrix is already applied.'
} elseif ($interactionMatrixPartiallyApplied) {
    throw 'WebGL interaction matrix is only partially applied. Recreate the engine checkout or apply the current maintained patch.'
} else {
    & git -C $engineRoot apply --check $interactionMatrixPatch
    if ($LASTEXITCODE -ne 0) {
        throw 'WebGL interaction matrix patch does not apply after the interaction-isolation patch.'
    }

    & git -C $engineRoot apply $interactionMatrixPatch
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to apply WebGL five-frame interaction matrix.'
    }

    Write-Output 'Applied WebGL five-frame interaction matrix.'
}

$ambientStageTraceHelperApplied = Select-String -Path $renderPassTraceFile -SimpleMatch -Pattern 'static void RB_WebPortTraceAmbientStage(' -Quiet
$ambientStageTraceOldCallApplied = Select-String -Path $renderPassTraceFile -SimpleMatch -Pattern 'RB_WebPortTraceAmbientStage("old"' -Quiet
$ambientStageTraceNewCallApplied = Select-String -Path $renderPassTraceFile -SimpleMatch -Pattern 'RB_WebPortTraceAmbientStage("new"' -Quiet
$ambientStageTraceApplied = $ambientStageTraceHelperApplied -and $ambientStageTraceOldCallApplied -and $ambientStageTraceNewCallApplied
$ambientStageTracePartiallyApplied = $ambientStageTraceHelperApplied -or $ambientStageTraceOldCallApplied -or $ambientStageTraceNewCallApplied
if ($ambientStageTraceApplied) {
    Write-Output 'WebGL ambient material-stage tracing is already applied.'
} elseif ($ambientStageTracePartiallyApplied) {
    throw 'WebGL ambient stage tracing is only partially applied. Recreate the engine checkout or apply the current maintained patch.'
} else {
    & git -C $engineRoot apply --check $ambientStageTracePatch
    if ($LASTEXITCODE -ne 0) {
        throw 'WebGL ambient stage trace patch does not apply after interaction diagnostics.'
    }

    & git -C $engineRoot apply $ambientStageTracePatch
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to apply WebGL ambient material-stage tracing.'
    }

    Write-Output 'Applied WebGL ambient material-stage tracing.'
}

$renderPassCameraTraceFrameApplied = Select-String -Path $renderPassTraceFile -SimpleMatch -Pattern 'static int lastTracedGameSecond = -1;' -Quiet
$renderPassCameraTraceCameraApplied = Select-String -Path $renderPassTraceFile -SimpleMatch -Pattern 'camera=%.2f,%.2f,%.2f forward=%.3f,%.3f,%.3f' -Quiet
$renderPassCameraTraceApplied = $renderPassCameraTraceFrameApplied -and $renderPassCameraTraceCameraApplied
$renderPassCameraTracePartiallyApplied = $renderPassCameraTraceFrameApplied -or $renderPassCameraTraceCameraApplied
if ($renderPassCameraTraceApplied) {
    Write-Output 'WebGL periodic camera and render-pass tracing is already applied.'
} elseif ($renderPassCameraTracePartiallyApplied) {
    throw 'WebGL render-pass camera tracing is only partially applied. Recreate the engine checkout or apply the current maintained patch.'
} else {
    & git -C $engineRoot apply --check $renderPassCameraTracePatch
    if ($LASTEXITCODE -ne 0) {
        throw 'WebGL render-pass camera-trace patch does not apply after ambient-stage diagnostics.'
    }

    & git -C $engineRoot apply $renderPassCameraTracePatch
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to apply WebGL periodic camera and render-pass tracing.'
    }

    Write-Output 'Applied WebGL periodic camera and render-pass tracing.'
}

$gameInterfaceFile = Join-Path $engineRoot 'neo/d3xp/Game.h'
$gameLocalFile = Join-Path $engineRoot 'neo/d3xp/Game_local.h'
$commonFile = Join-Path $engineRoot 'neo/framework/Common.cpp'
$cinematicApiApplied = Select-String -Path $gameInterfaceFile -SimpleMatch -Pattern 'SkipCinematicScene()' -Quiet
$cinematicStateApplied = Select-String -Path $gameLocalFile -SimpleMatch -Pattern 'cinematicSkipTime' -Quiet
$cinematicInputShortcutApplied = Select-String -Path $commonFile -SimpleMatch -Pattern 'game->SkipCinematicScene()' -Quiet
$cinematicInputConsumptionApplied = Select-String -Path $commonFile -SimpleMatch -Pattern 'consumedCinematicSkipKeys' -Quiet
$cinematicInputBaselinePresent = Select-String -Path $commonFile -SimpleMatch -Pattern '// hitting escape anywhere brings up the menu' -Quiet
$cinematicSkipCoreApplied = $cinematicApiApplied -and $cinematicStateApplied
$cinematicSkipApplied = $cinematicSkipCoreApplied -and $cinematicInputConsumptionApplied
$cinematicSkipPartiallyApplied = $cinematicApiApplied -or $cinematicStateApplied -or $cinematicInputShortcutApplied -or $cinematicInputConsumptionApplied
if ($cinematicSkipApplied) {
    Write-Output 'Keyboard cinematic skip shortcut is already applied.'
} elseif ($cinematicSkipCoreApplied -and $cinematicInputShortcutApplied) {
    & git -C $engineRoot apply --check $cinematicInputConsumptionPatch
    if ($LASTEXITCODE -ne 0) {
        throw 'The cinematic skip keydown handler is present, but the keyup-consumption repair does not apply.'
    }

    & git -C $engineRoot apply $cinematicInputConsumptionPatch
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to apply the cinematic skip keyup-consumption repair.'
    }

    Write-Output 'Applied cinematic skip keyup consumption.'
} elseif ($cinematicSkipCoreApplied -and $cinematicInputBaselinePresent) {
    & git -C $engineRoot apply --check $cinematicInputAddHandlerPatch
    if ($LASTEXITCODE -ne 0) {
        throw 'The cinematic skip API is present, but the key-consumption handler patch does not apply.'
    }

    & git -C $engineRoot apply $cinematicInputAddHandlerPatch
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to add the cinematic skip key-consumption handler.'
    }

    Write-Output 'Applied the cinematic skip key-consumption handler.'
} elseif ($cinematicSkipPartiallyApplied) {
    throw 'The cinematic skip shortcut patch is only partially applied. Recreate the engine checkout or apply the current maintained patch.'
} else {
    & git -C $engineRoot apply --check $cinematicSkipPatch
    if ($LASTEXITCODE -ne 0) {
        throw 'Cinematic skip shortcut patch does not apply cleanly after the Emscripten/WebGL2 patch.'
    }

    & git -C $engineRoot apply $cinematicSkipPatch
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to apply the cinematic skip shortcut patch.'
    }

    Write-Output 'Applied the keyboard cinematic skip shortcut patch.'
}

$imageManagerFile = Join-Path $engineRoot 'neo/renderer/ImageManager.cpp'
$renderSystemInitFile = Join-Path $engineRoot 'neo/renderer/RenderSystem_init.cpp'
$webglImageFile = Join-Path $engineRoot 'neo/renderer/OpenGL/gl_Image.cpp'
$posixMainFile = Join-Path $engineRoot 'neo/sys/posix/posix_main.cpp'
$webS3tcProbeApplied = Select-String -Path $renderSystemInitFile -SimpleMatch -Pattern 'WEBGL_compressed_texture_s3tc' -Quiet
$webAnisotropyEnableApplied = Select-String -Path $renderSystemInitFile -SimpleMatch -Pattern 'emscripten_webgl_enable_extension(anisotropyContext, "EXT_texture_filter_anisotropic")' -Quiet
$webS3tcFallbackApplied = Select-String -Path $webglImageFile -SimpleMatch -Pattern '!glConfig.textureCompressionAvailable' -Quiet
$webThreadClockApplied = Select-String -Path $posixMainFile -SimpleMatch -Pattern 'return static_cast<uint64>(emscripten_get_now() * 1000.0);' -Quiet
if (-not ($webS3tcProbeApplied -and $webAnisotropyEnableApplied -and $webS3tcFallbackApplied -and $webThreadClockApplied)) {
    throw 'The Emscripten/WebGL2 patch is outdated in the engine checkout; it must enable optional S3TC uploads and anisotropic filtering with safe fallbacks and a cross-thread microsecond clock.'
}

$renderProgsGlslFile = Join-Path $engineRoot 'neo/renderer/RenderProgs_GLSL.cpp'
$highpShaderBranches = @(Select-String -Path $renderProgsGlslFile -SimpleMatch -Pattern '#if defined(__EMSCRIPTEN__)').Count
if ($highpShaderBranches -ge 2) {
    Write-Output 'WebGL2 high-precision vertex and fragment shaders are already applied.'
} elseif ($highpShaderBranches -gt 0) {
    throw 'The WebGL2 high-precision shader patch is only partially applied. Recreate the engine checkout or apply the current maintained patch.'
} else {
    & git -C $engineRoot apply --check $highpShaderPatch
    if ($LASTEXITCODE -ne 0) {
        throw 'WebGL2 high-precision shader patch does not apply cleanly to this submodule revision.'
    }

    & git -C $engineRoot apply $highpShaderPatch
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to apply the WebGL2 high-precision shader patch.'
    }

    Write-Output 'Applied WebGL2 high-precision vertex and fragment shaders.'
}

$modelManagerFile = Join-Path $engineRoot 'neo/renderer/ModelManager.cpp'
$imageLoadFile = Join-Path $engineRoot 'neo/renderer/Image_load.cpp'
$imagePreloadDiagnosticsApplied = Select-String -Path $imageManagerFile -SimpleMatch -Pattern 'image preload item started' -Quiet
$imagePreloadPumpApplied = Select-String -Path $imageManagerFile -SimpleMatch -Pattern 'preloadImageIndex % 8 == 0' -Quiet
$rendererPreloadPhasesApplied = Select-String -Path $renderSystemInitFile -SimpleMatch -Pattern 'renderer image preload started' -Quiet
$modelPreloadDiagnosticsApplied = Select-String -Path $modelManagerFile -SimpleMatch -Pattern 'model preload cache scan started' -Quiet
$eyeLeftLoadDiagnosticsApplied = Select-String -Path $imageLoadFile -SimpleMatch -Pattern 'eye_left ActuallyLoadImage started' -Quiet
if ($imagePreloadDiagnosticsApplied -and $imagePreloadPumpApplied -and $rendererPreloadPhasesApplied -and $modelPreloadDiagnosticsApplied -and $eyeLeftLoadDiagnosticsApplied) {
    Write-Output 'Web map preload diagnostics and native load-screen pump are already applied.'
} elseif ($imagePreloadDiagnosticsApplied -or $imagePreloadPumpApplied -or $rendererPreloadPhasesApplied -or $modelPreloadDiagnosticsApplied -or $eyeLeftLoadDiagnosticsApplied) {
    throw 'The web map preload patch is only partially applied. Recreate the engine checkout or apply the current maintained patch.'
} else {
    & git -C $engineRoot apply --check $mapPreloadPatch
    if ($LASTEXITCODE -ne 0) {
        throw 'Web map preload patch does not apply cleanly to this submodule revision.'
    }

    & git -C $engineRoot apply $mapPreloadPatch
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to apply the web map preload patch.'
    }

    Write-Output 'Applied the web map preload patch.'
}

$fileSystemFile = Join-Path $engineRoot 'neo/framework/FileSystem.cpp'
$innerResourceFile = Join-Path $engineRoot 'neo/framework/File.cpp'
$eyeLeftOpenTraceApplied = Select-String -Path $fileSystemFile -SimpleMatch -Pattern 'eye_left OpenFileRead started' -Quiet
$eyeLeftResourceTraceApplied = Select-String -Path $fileSystemFile -SimpleMatch -Pattern 'eye_left resource bytes read started' -Quiet
$eyeLeftArchiveTraceApplied = Select-String -Path $innerResourceFile -SimpleMatch -Pattern 'eye_left archive read started' -Quiet
if ($eyeLeftOpenTraceApplied -and $eyeLeftResourceTraceApplied -and $eyeLeftArchiveTraceApplied) {
    Write-Output 'Eye-left VFS read diagnostics are already applied.'
} elseif ($eyeLeftOpenTraceApplied -or $eyeLeftResourceTraceApplied -or $eyeLeftArchiveTraceApplied) {
    throw 'The eye-left VFS trace patch is only partially applied. Recreate the engine checkout or apply the current maintained patch.'
} else {
    & git -C $engineRoot apply --check $vfsTracePatch
    if ($LASTEXITCODE -ne 0) {
        throw 'Eye-left VFS trace patch does not apply cleanly to this submodule revision.'
    }

    & git -C $engineRoot apply $vfsTracePatch
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to apply the eye-left VFS trace patch.'
    }

    Write-Output 'Applied the eye-left VFS read diagnostics patch.'
}

$imageLoadFile = Join-Path $engineRoot 'neo/renderer/Image_load.cpp'
$fileSystemFile = Join-Path $engineRoot 'neo/framework/FileSystem.cpp'
$innerResourceFile = Join-Path $engineRoot 'neo/framework/File.cpp'
$hudBImageEntryApplied = Select-String -Path $imageLoadFile -SimpleMatch -Pattern 'hud_b ActuallyLoadImage started' -Quiet
$hudBGeneratedReadApplied = Select-String -Path $imageLoadFile -SimpleMatch -Pattern 'hud_b generated cache read started generated=%s' -Quiet
$hudBPixelReadApplied = Select-String -Path $imageLoadFile -SimpleMatch -Pattern 'hud_b source pixels read started name=%s' -Quiet
$hudBPixelReturnApplied = Select-String -Path $imageLoadFile -SimpleMatch -Pattern 'hud_b source pixels read returned data=%d' -Quiet
$hudBOpenReadApplied = Select-String -Path $fileSystemFile -SimpleMatch -Pattern 'hud_b OpenFileRead started' -Quiet
$hudBOpenReturnApplied = Select-String -Path $fileSystemFile -SimpleMatch -Pattern 'hud_b OpenFileRead returned found=%d' -Quiet
$hudBResourceReadApplied = Select-String -Path $fileSystemFile -SimpleMatch -Pattern 'hud_b resource bytes read started' -Quiet
$hudBResourceReturnApplied = Select-String -Path $fileSystemFile -SimpleMatch -Pattern 'hud_b resource bytes read returned' -Quiet
$hudBArchiveReadApplied = Select-String -Path $innerResourceFile -SimpleMatch -Pattern 'hud_b archive read started' -Quiet
$hudBArchiveReturnApplied = Select-String -Path $innerResourceFile -SimpleMatch -Pattern 'hud_b archive read returned bytes=%d' -Quiet
$hudBTraceApplied = $hudBImageEntryApplied -and $hudBGeneratedReadApplied -and $hudBPixelReadApplied -and $hudBPixelReturnApplied -and $hudBOpenReadApplied -and $hudBOpenReturnApplied -and $hudBResourceReadApplied -and $hudBResourceReturnApplied -and $hudBArchiveReadApplied -and $hudBArchiveReturnApplied
$hudBTracePartiallyApplied = $hudBImageEntryApplied -or $hudBGeneratedReadApplied -or $hudBPixelReadApplied -or $hudBPixelReturnApplied -or $hudBOpenReadApplied -or $hudBOpenReturnApplied -or $hudBResourceReadApplied -or $hudBResourceReturnApplied -or $hudBArchiveReadApplied -or $hudBArchiveReturnApplied
if ($hudBTraceApplied) {
    Write-Output 'HUD-b image diagnostics are already applied.'
} elseif ($hudBTracePartiallyApplied) {
    throw 'The HUD-b image trace patch is only partially applied. Recreate the engine checkout or apply the current maintained patch.'
} else {
    & git -C $engineRoot apply --check $hudBTracePatch
    if ($LASTEXITCODE -ne 0) {
        throw 'HUD-b image trace patch does not apply cleanly after the eye-left VFS trace patch.'
    }

    & git -C $engineRoot apply $hudBTracePatch
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to apply the HUD-b image trace patch.'
    }

    Write-Output 'Applied the HUD-b image diagnostics patch.'
}

$imageManagerFile = Join-Path $engineRoot 'neo/renderer/ImageManager.cpp'
$imageLoadFile = Join-Path $engineRoot 'neo/renderer/Image_load.cpp'
$floorGratePreloadApplied = Select-String -Path $imageManagerFile -SimpleMatch -Pattern 'floorgrate preload call index=' -Quiet
$floorGrateLookupApplied = Select-String -Path $imageManagerFile -SimpleMatch -Pattern 'floorgrate ImageFromFile enter' -Quiet
$floorGrateImageLoadApplied = Select-String -Path $imageLoadFile -SimpleMatch -Pattern 'floorgrate ActuallyLoadImage enter' -Quiet
$floorGrateUploadApplied = Select-String -Path $imageLoadFile -SimpleMatch -Pattern 'floorgrate GPU upload returned' -Quiet
$floorGrateTraceApplied = $floorGratePreloadApplied -and $floorGrateLookupApplied -and $floorGrateImageLoadApplied -and $floorGrateUploadApplied
$floorGrateTracePartiallyApplied = $floorGratePreloadApplied -or $floorGrateLookupApplied -or $floorGrateImageLoadApplied -or $floorGrateUploadApplied
if ($floorGrateTraceApplied) {
    Write-Output 'Floor-grate image diagnostics are already applied.'
} elseif ($floorGrateTracePartiallyApplied) {
    throw 'The floor-grate image trace patch is only partially applied. Recreate the engine checkout or apply the current maintained patch.'
} else {
    & git -C $engineRoot apply --check $floorGrateTracePatch
    if ($LASTEXITCODE -ne 0) {
        throw 'Floor-grate image trace patch does not apply cleanly after the HUD-b image trace patch.'
    }

    & git -C $engineRoot apply $floorGrateTracePatch
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to apply the floor-grate image diagnostics patch.'
    }

    Write-Output 'Applied the floor-grate image diagnostics patch.'
}

$imageFilesFile = Join-Path $engineRoot 'neo/renderer/Image_files.cpp'
$floorGrateTgaReadDiagnosticsApplied = Select-String -Path $imageFilesFile -SimpleMatch -Pattern 'floorgrate TGA pixel ReadFile started' -Quiet
$floorGrateFilesystemReadDiagnosticsApplied = Select-String -Path $fileSystemFile -SimpleMatch -Pattern 'floorgrate ordinary file read returned' -Quiet
$floorGrateResourceReadDiagnosticsApplied = Select-String -Path $fileSystemFile -SimpleMatch -Pattern 'floorgrate resource bytes read returned' -Quiet
$floorGrateResourceTraceApplied = $floorGrateTgaReadDiagnosticsApplied -and $floorGrateFilesystemReadDiagnosticsApplied -and $floorGrateResourceReadDiagnosticsApplied
$floorGrateResourceTracePartiallyApplied = $floorGrateTgaReadDiagnosticsApplied -or $floorGrateFilesystemReadDiagnosticsApplied -or $floorGrateResourceReadDiagnosticsApplied
if ($floorGrateResourceTraceApplied) {
    Write-Output 'Floor-grate source image and resource-file diagnostics are already applied.'
} elseif ($floorGrateResourceTracePartiallyApplied) {
    throw 'The floor-grate resource trace patch is only partially applied. Recreate the engine checkout or apply the current maintained patch.'
} else {
    & git -C $engineRoot apply --check $floorGrateResourceTracePatch
    if ($LASTEXITCODE -ne 0) {
        throw 'Floor-grate resource trace patch does not apply cleanly after the floor-grate image trace patch.'
    }

    & git -C $engineRoot apply $floorGrateResourceTracePatch
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to apply the floor-grate source image and resource-file diagnostics patch.'
    }

    Write-Output 'Applied the floor-grate source image and resource-file diagnostics patch.'
}

$binaryImageFile = Join-Path $engineRoot 'neo/renderer/BinaryImage.cpp'
$floorGrateBimageOpenApplied = Select-String -Path $binaryImageFile -SimpleMatch -Pattern 'floorgrate binary image open started path=%s' -Quiet
$floorGrateBimageParseApplied = Select-String -Path $binaryImageFile -SimpleMatch -Pattern 'floorgrate binary image parse returned valid=1' -Quiet
$floorGrateBimageVfsApplied = Select-String -Path $fileSystemFile -SimpleMatch -Pattern 'floorgrate resource lookup started path=%s' -Quiet
$floorGrateBimageTraceApplied = $floorGrateBimageOpenApplied -and $floorGrateBimageParseApplied -and $floorGrateBimageVfsApplied
$floorGrateBimageTracePartiallyApplied = $floorGrateBimageOpenApplied -or $floorGrateBimageParseApplied -or $floorGrateBimageVfsApplied
if ($floorGrateBimageTraceApplied) {
    Write-Output 'Floor-grate generated-image diagnostics are already applied.'
} elseif ($floorGrateBimageTracePartiallyApplied) {
    throw 'The floor-grate generated-image trace patch is only partially applied. Recreate the engine checkout or apply the current maintained patch.'
} else {
    & git -C $engineRoot apply --check $floorGrateBimageTracePatch
    if ($LASTEXITCODE -ne 0) {
        throw 'Floor-grate generated-image trace patch does not apply cleanly after the floor-grate resource trace patch.'
    }

    & git -C $engineRoot apply $floorGrateBimageTracePatch
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to apply the floor-grate generated-image diagnostics patch.'
    }

    Write-Output 'Applied the floor-grate generated-image diagnostics patch.'
}

$skScan1ImageLoadApplied = Select-String -Path $imageLoadFile -SimpleMatch -Pattern 'skscan1 ActuallyLoadImage enter' -Quiet
$skScan1BimageOpenApplied = Select-String -Path $binaryImageFile -SimpleMatch -Pattern 'skscan1 binary image open started path=%s' -Quiet
$skScan1BimageParseApplied = Select-String -Path $binaryImageFile -SimpleMatch -Pattern 'skscan1 binary image parse returned valid=1' -Quiet
$skScan1ResourceReadApplied = Select-String -Path $fileSystemFile -SimpleMatch -Pattern 'skscan1 resource bytes read returned' -Quiet
$skScan1ImageTraceApplied = $skScan1ImageLoadApplied -and $skScan1BimageOpenApplied -and $skScan1BimageParseApplied -and $skScan1ResourceReadApplied
$skScan1ImageTracePartiallyApplied = $skScan1ImageLoadApplied -or $skScan1BimageOpenApplied -or $skScan1BimageParseApplied -or $skScan1ResourceReadApplied
if ($skScan1ImageTraceApplied) {
    Write-Output 'Medical scan image diagnostics are already applied.'
} elseif ($skScan1ImageTracePartiallyApplied) {
    throw 'The medical scan image trace patch is only partially applied. Recreate the engine checkout or apply the current maintained patch.'
} else {
    & git -C $engineRoot apply --check $skScan1ImageTracePatch
    if ($LASTEXITCODE -ne 0) {
        Write-Warning 'Skipped optional medical scan image diagnostics because the trace patch does not apply cleanly.'
    } else {
        & git -C $engineRoot apply $skScan1ImageTracePatch
        if ($LASTEXITCODE -ne 0) {
            throw 'Failed to apply the medical scan image diagnostics patch.'
        }

        Write-Output 'Applied the medical scan image diagnostics patch.'
    }
}

$imageManagerFile = Join-Path $engineRoot 'neo/renderer/ImageManager.cpp'
$imageLoadFile = Join-Path $engineRoot 'neo/renderer/Image_load.cpp'
$ps3SquareEntryApplied = Select-String -Path $imageManagerFile -SimpleMatch -Pattern 'ps3_square ImageFromFile enter' -Quiet
$ps3SquareMatchApplied = Select-String -Path $imageManagerFile -SimpleMatch -Pattern 'ps3_square image match index=' -Quiet
$ps3SquareLoadApplied = Select-String -Path $imageManagerFile -SimpleMatch -Pattern 'ps3_square new image load started' -Quiet
$ps3SquarePreloadApplied = Select-String -Path $imageManagerFile -SimpleMatch -Pattern 'ps3_square preload call index=' -Quiet
$ps3SquarePreloadReturnApplied = Select-String -Path $imageManagerFile -SimpleMatch -Pattern 'ps3_square preload call returned' -Quiet
$ps3SquareMemoryApplied = Select-String -Path $imageManagerFile -SimpleMatch -Pattern 'image preload item started index=%d/%d wasm_linear_bytes=%llu wasm_max_bytes=%llu' -Quiet
$ps3SquareActuallyLoadApplied = Select-String -Path $imageLoadFile -SimpleMatch -Pattern 'ps3_square ActuallyLoadImage enter' -Quiet
$ps3SquareSourceMetadataApplied = Select-String -Path $imageLoadFile -SimpleMatch -Pattern 'ps3_square source metadata read started' -Quiet
$ps3SquareGeneratedReadApplied = Select-String -Path $imageLoadFile -SimpleMatch -Pattern 'ps3_square generated cache read returned' -Quiet
$ps3SquareSourcePixelsApplied = Select-String -Path $imageLoadFile -SimpleMatch -Pattern 'ps3_square source pixels read started' -Quiet
$ps3SquareBimageBuildApplied = Select-String -Path $imageLoadFile -SimpleMatch -Pattern 'ps3_square bimage build started' -Quiet
$ps3SquareGpuAllocationApplied = Select-String -Path $imageLoadFile -SimpleMatch -Pattern 'ps3_square GPU image allocation started' -Quiet
$ps3SquareGpuUploadApplied = Select-String -Path $imageLoadFile -SimpleMatch -Pattern 'ps3_square GPU upload started' -Quiet
$ps3SquareLoadReturnApplied = Select-String -Path $imageLoadFile -SimpleMatch -Pattern 'ps3_square ActuallyLoadImage returned' -Quiet
$ps3SquareImageTraceApplied = $ps3SquareEntryApplied -and $ps3SquareMatchApplied -and $ps3SquareLoadApplied -and $ps3SquarePreloadApplied -and $ps3SquarePreloadReturnApplied -and $ps3SquareMemoryApplied -and $ps3SquareActuallyLoadApplied -and $ps3SquareSourceMetadataApplied -and $ps3SquareGeneratedReadApplied -and $ps3SquareSourcePixelsApplied -and $ps3SquareBimageBuildApplied -and $ps3SquareGpuAllocationApplied -and $ps3SquareGpuUploadApplied -and $ps3SquareLoadReturnApplied
$ps3SquareImageTracePartiallyApplied = $ps3SquareEntryApplied -or $ps3SquareMatchApplied -or $ps3SquareLoadApplied -or $ps3SquarePreloadApplied -or $ps3SquarePreloadReturnApplied -or $ps3SquareMemoryApplied -or $ps3SquareActuallyLoadApplied -or $ps3SquareSourceMetadataApplied -or $ps3SquareGeneratedReadApplied -or $ps3SquareSourcePixelsApplied -or $ps3SquareBimageBuildApplied -or $ps3SquareGpuAllocationApplied -or $ps3SquareGpuUploadApplied -or $ps3SquareLoadReturnApplied
if ($ps3SquareImageTraceApplied) {
    Write-Output 'PS3 square image and Wasm memory diagnostics are already applied.'
} elseif ($ps3SquareImageTracePartiallyApplied) {
    throw 'The PS3 square image trace patch is only partially applied. Recreate the engine checkout or apply the current maintained patch.'
} else {
    & git -C $engineRoot apply --check $ps3SquareImageTracePatch
    if ($LASTEXITCODE -ne 0) {
        Write-Warning 'Skipped optional PS3 square image diagnostics because the trace patch does not apply cleanly.'
    } else {
        & git -C $engineRoot apply $ps3SquareImageTracePatch
        if ($LASTEXITCODE -ne 0) {
            throw 'Failed to apply the PS3 square image and Wasm memory diagnostics patch.'
        }

        Write-Output 'Applied the PS3 square image and Wasm memory diagnostics patch.'
    }
}

$sessionLocalFile = Join-Path $engineRoot 'neo/sys/common/session_local.cpp'
if (Select-String -Path $sessionLocalFile -Pattern 'Browsers do not expose raw UDP sockets' -Quiet) {
    Write-Output 'Browser session networking patch is already applied.'
} else {
    & git -C $engineRoot apply --check $sessionNetworkingPatch
    if ($LASTEXITCODE -ne 0) {
        throw 'Browser session networking patch does not apply cleanly to this submodule revision.'
    }

    & git -C $engineRoot apply $sessionNetworkingPatch
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to apply the browser session networking patch.'
    }

    Write-Output 'Applied the browser session networking patch.'
}

$saveGameFile = Join-Path $engineRoot 'neo/sys/common/savegame.cpp'
$profileFile = Join-Path $engineRoot 'neo/sys/sys_profile.cpp'
if ((Select-String -Path $saveGameFile -Pattern 'Savegame could not resolve a local user' -Quiet) -and
    (Select-String -Path $profileFile -Pattern 'Profile save failed \(error=' -Quiet)) {
    Write-Output 'Browser save diagnostics patch is already applied.'
} else {
    & git -C $engineRoot apply --check $saveDiagnosticsPatch
    if ($LASTEXITCODE -ne 0) {
        throw 'Browser save diagnostics patch does not apply cleanly to this submodule revision.'
    }

    & git -C $engineRoot apply $saveDiagnosticsPatch
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to apply the browser save diagnostics patch.'
    }

    Write-Output 'Applied the browser save diagnostics patch.'
}

$graphicsWrapperFile = Join-Path $engineRoot 'neo/renderer/OpenGL/gl_GraphicsAPIWrapper.cpp'
$graphicsWrapperHeader = Join-Path $engineRoot 'neo/renderer/GraphicsAPIWrapper.h'
$qglHeader = Join-Path $engineRoot 'neo/renderer/OpenGL/qgl.h'
$webGlImageFile = Join-Path $engineRoot 'neo/renderer/OpenGL/gl_Image.cpp'
$imageLoadFile = Join-Path $engineRoot 'neo/renderer/Image_load.cpp'
$textureBindingHelperApplied = (Select-String -Path $graphicsWrapperFile -SimpleMatch -Pattern 'void GL_BindTextureToCurrentUnit(GLenum target, GLuint texture)' -Quiet) -and
    (Select-String -Path $graphicsWrapperHeader -SimpleMatch -Pattern 'void GL_BindTextureToCurrentUnit(GLenum target, GLuint texture);' -Quiet)
$textureBindingUploadsApplied = (Select-String -Path $webGlImageFile -SimpleMatch -Pattern 'GL_BindTextureToCurrentUnit(target, texnum);' | Measure-Object).Count -ge 2
$textureBindingImageOpsApplied = (Select-String -Path $imageLoadFile -SimpleMatch -Pattern 'GL_BindTextureToCurrentUnit((opts.textureType == TT_CUBIC)' | Measure-Object).Count -ge 3
$textureBindingApplied = $textureBindingHelperApplied -and $textureBindingUploadsApplied -and $textureBindingImageOpsApplied
$textureBindingPartiallyApplied = $textureBindingHelperApplied -or $textureBindingUploadsApplied -or $textureBindingImageOpsApplied
if ($textureBindingApplied) {
    Write-Output 'Renderer texture-unit cache handling is already applied.'
} elseif ($textureBindingPartiallyApplied) {
    throw 'Renderer texture-unit cache handling is only partially applied. Recreate the engine checkout or apply the current maintained patch.'
} else {
    & git -C $engineRoot apply --check $textureUnitCachePatch
    if ($LASTEXITCODE -ne 0) {
        throw 'Renderer texture-unit cache patch does not apply cleanly after the existing engine patches.'
    }

    & git -C $engineRoot apply $textureUnitCachePatch
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to apply renderer texture-unit cache handling.'
    }

    Write-Output 'Applied renderer texture-unit cache handling.'
}

if (Select-String -Path $qglHeader -SimpleMatch -Pattern 'extern PFNGLACTIVETEXTUREPROC qglActiveTextureARB;' -Quiet) {
    Write-Output 'Renderer active-texture procedure declaration is already applied.'
} else {
    & git -C $engineRoot apply --check --include=neo/renderer/OpenGL/qgl.h $textureUnitCachePatch
    if ($LASTEXITCODE -ne 0) {
        throw 'Renderer active-texture procedure declaration patch does not apply cleanly.'
    }

    & git -C $engineRoot apply --include=neo/renderer/OpenGL/qgl.h $textureUnitCachePatch
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to declare the renderer active-texture procedure.'
    }

    Write-Output 'Applied renderer active-texture procedure declaration.'
}

$activeTextureSyncMarker = "Keep WebGL's physical active unit aligned even when the logical unit is unchanged."
if (Select-String -Path $graphicsWrapperFile -SimpleMatch -Pattern $activeTextureSyncMarker -Quiet) {
    Write-Output 'Renderer logical and physical texture-unit synchronization is already applied.'
} else {
    & git -C $engineRoot apply --check $activeTextureSyncPatch
    if ($LASTEXITCODE -ne 0) {
        throw 'WebGL active-texture synchronization patch does not apply cleanly after texture-unit cache handling.'
    }

    & git -C $engineRoot apply $activeTextureSyncPatch
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to synchronize WebGL active-texture state.'
    }

    Write-Output 'Applied WebGL logical/physical texture-unit synchronization.'
}

$sdlGlimpFile = Join-Path $engineRoot 'neo/sys/sdl/sdl_glimp.cpp'
$sdlEventsFile = Join-Path $engineRoot 'neo/sys/sdl/sdl_events.cpp'
$viewportBackingApplied = (Select-String -Path $sdlGlimpFile -SimpleMatch -Pattern '[web-port viewport]' -Quiet) -and
    (Select-String -Path $sdlEventsFile -SimpleMatch -Pattern 'emscripten_get_canvas_element_size' -Quiet)
if ($viewportBackingApplied) {
    Write-Output 'Renderer viewport and backing-size handling is already applied.'
} else {
    & git -C $engineRoot apply --check $viewportBackingPatch
    if ($LASTEXITCODE -ne 0) {
        throw 'Renderer viewport and backing-size patch does not apply cleanly after existing engine patches.'
    }

    & git -C $engineRoot apply $viewportBackingPatch
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to apply renderer viewport and backing-size patch.'
    }

    Write-Output 'Applied renderer viewport and backing-size handling.'
}

$startupTraceCommonMarkers = @(
    'phase=startup-commands-queued',
    'phase=common-init-begin',
    'phase=game-thread-start',
    'phase=game-thread-ready',
    'phase=common-init-complete'
)
$startupTraceCommonApplied = $true
foreach ($marker in $startupTraceCommonMarkers) {
    if (-not (Select-String -Path $commonFile -SimpleMatch -Pattern $marker -Quiet)) {
        $startupTraceCommonApplied = $false
        break
    }
}
$startupTraceMapMarkers = @(
    'phase=execute-map-change-begin',
    'phase=dispatch-map',
    'phase=dispatch-devmap'
)
$startupTraceMapApplied = $true
foreach ($marker in $startupTraceMapMarkers) {
    if (-not (Select-String -Path $commonLoadFile -SimpleMatch -Pattern $marker -Quiet)) {
        $startupTraceMapApplied = $false
        break
    }
}
$startupTraceApplied = $startupTraceCommonApplied -and $startupTraceMapApplied
$startupTraceAnyApplied = (Select-String -Path $commonFile -SimpleMatch -Pattern '[web-port startup]' -Quiet) -or
    (Select-String -Path $commonLoadFile -SimpleMatch -Pattern '[web-port startup]' -Quiet)
if ($startupTraceApplied) {
    Write-Output 'Web startup trace markers are already applied.'
} elseif ($startupTraceAnyApplied) {
    Write-Warning 'Skipped optional Web startup tracing because an incomplete trace set is already present.'
} else {
    & git -C $engineRoot apply --check $startupTracePatch
    if ($LASTEXITCODE -ne 0) {
        Write-Warning 'Skipped optional Web startup tracing because its patch does not apply cleanly.'
    } else {
        & git -C $engineRoot apply $startupTracePatch
        if ($LASTEXITCODE -ne 0) {
            throw 'Failed to apply Web startup trace markers.'
        }

        Write-Output 'Applied Web startup trace markers.'
    }
}

$cinematicFile = Join-Path $engineRoot 'neo/renderer/Cinematic.cpp'
$cmakeListsFile = Join-Path $engineRoot 'CMakeLists.txt'
$binkDecCinematicApplied = Select-String -Path $cinematicFile -SimpleMatch -Pattern 'InitFromBinkDecFile' -Quiet
$binkDecCMakeApplied = Select-String -Path $cmakeListsFile -SimpleMatch -Pattern 'USE_BINKDEC' -Quiet
$binkDecApplied = $binkDecCinematicApplied -and $binkDecCMakeApplied
$binkDecAnyApplied = $binkDecCinematicApplied -or $binkDecCMakeApplied

if ($binkDecApplied) {
    Write-Output 'Wasm Bink decoder integration is already applied.'
} elseif ($binkDecAnyApplied) {
    Write-Warning 'Wasm Bink decoder integration is partial; continuing the startup diagnostic build without changing it.'
} else {
    & git -C $engineRoot apply --check $wasmBinkDecPatch
    if ($LASTEXITCODE -ne 0) {
        throw 'Wasm Bink decoder patch does not apply cleanly after the existing engine patches.'
    }

    & git -C $engineRoot apply $wasmBinkDecPatch
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to apply Wasm Bink decoder integration.'
    }

    Write-Output 'Applied Wasm Bink decoder integration.'
}

# Keep the browser integration reproducible after updating or resetting the
# engine submodule. Check a feature's final marker before applying its delta;
# optional diagnostic patches above are not substitutes for these fixes.
function Apply-BrowserParityPatch {
    param([string]$Name, [string]$RelativeSource, [string]$Marker)
    $sourcePath = Join-Path $engineRoot $RelativeSource
    if (Select-String -Path $sourcePath -SimpleMatch -Pattern $Marker -Quiet) {
        Write-Output "$Name is already applied."
        return
    }
    $browserPatch = Join-Path $repoRoot "patches/chocolate-doom3-bfg/$Name.patch"
    & git -C $engineRoot apply --check $browserPatch
    if ($LASTEXITCODE -ne 0) { throw "Required browser patch does not apply: $Name" }
    & git -C $engineRoot apply $browserPatch
    if ($LASTEXITCODE -ne 0) { throw "Could not apply required browser patch: $Name" }
    if (-not (Select-String -Path $sourcePath -SimpleMatch -Pattern $Marker -Quiet)) {
        throw "Required browser patch is missing its postcondition: $Name"
    }
    Write-Output "Applied $Name."
}

Apply-BrowserParityPatch 'browser-controls-settings' 'neo/sys/sdl/sdl_events.cpp' 'static int GameControllerKey('
Apply-BrowserParityPatch 'browser-wheel-keyup-priority' 'neo/sys/sdl/sdl_events.cpp' 'A wheel notch is a tap, not a held key.'
Apply-BrowserParityPatch 'sdl-controller-native-poll' 'neo/sys/sdl/sdl_events.cpp' 'static const int SDL_MAX_GAME_CONTROLLERS = 4;'
Apply-BrowserParityPatch 'browser-relative-mouse-resume' 'neo/sys/sdl/sdl_glimp.cpp' 'doom3-relative-mouse'
Apply-BrowserParityPatch 'browser-startup-splash-duration' 'neo/framework/Common.cpp' 'Start the visible-time interval only after startup work has finished.'
Apply-BrowserParityPatch 'browser-map-resource-release' 'neo/framework/Common_load.cpp' "Module['releaseMapResourcesExcept']"
if (-not (Select-String -Path $commonLoadFile -SimpleMatch -Pattern 'EM_ASYNC_JS(int, WebStageMapLoadingImage' -Quiet)) {
    Apply-BrowserParityPatch 'browser-native-loading-transition' 'neo/framework/Common_load.cpp' 'loading GUI is already visible while the browser stages the resources.'
}
Apply-BrowserParityPatch 'browser-map-loading-backdrop' 'neo/framework/Common_load.cpp' 'EM_ASYNC_JS(int, WebStageMapLoadingImage'
Apply-BrowserParityPatch 'browser-map-memory-lifecycle' 'neo/framework/Common_load.cpp' 'renderWorld->InitFromMap(NULL);'
Apply-BrowserParityPatch 'browser-save-persist-barrier' 'neo/sys/common/savegame.cpp' 'EM_ASYNC_JS(int, WebFlushBrowserSaveData'
Apply-BrowserParityPatch 'browser-save-delete-persistence' 'neo/sys/common/savegame.cpp' 'const int browserMutatingSaveModes ='
Apply-BrowserParityPatch 'browser-trace-opt-in' 'neo/framework/Common_printf.cpp' 'idCVar com_webDiagnostics('
Apply-BrowserParityPatch 'browser-game-exit' 'neo/sys/posix/posix_main.cpp' 'doom3-game-exit'
Apply-BrowserParityPatch 'browser-bink-cinematic' 'neo/renderer/Cinematic.cpp' 'EM_JS(int, WebReleaseBinkResource'


