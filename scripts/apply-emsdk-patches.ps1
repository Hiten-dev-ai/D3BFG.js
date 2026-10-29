param()

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'emsdk-env.ps1')

$emscriptenDir = Join-Path $env:EMSDK 'upstream/emscripten'
$versionFile = Join-Path $emscriptenDir 'emscripten-version.txt'

if (-not (Test-Path $versionFile)) {
    throw "Emscripten version file not found at $versionFile"
}

$version = (Get-Content -Path $versionFile -Raw).Trim().Trim('"')
if ($version -ne '6.0.13') {
    throw "Unsupported Emscripten version '$version'. This patch requires 6.0.13."
}

$libpthread = Join-Path $emscriptenDir 'src/lib/libpthread.js'
$libworkerfs = Join-Path $emscriptenDir 'src/lib/libworkerfs.js'
$libsyscall = Join-Path $emscriptenDir 'src/lib/libsyscall.js'
$libwasi = Join-Path $emscriptenDir 'src/lib/libwasi.js'
$libidbfs = Join-Path $emscriptenDir 'src/lib/libidbfs.js'
$libegl = Join-Path $emscriptenDir 'src/lib/libegl.js'
$libwebgl = Join-Path $emscriptenDir 'src/lib/libwebgl.js'
$runtimePthread = Join-Path $emscriptenDir 'src/runtime_pthread.js'
$libopenal = Join-Path $emscriptenDir 'src/lib/libopenal.js'
$sdl2Port = Join-Path $emscriptenDir 'tools/ports/sdl2.py'

# Preserve the original worker exception/wasm frames before the crash handler
# produces secondary proxy errors. Run before the general up-to-date exit.
$workerRuntime = Get-Content -LiteralPath $runtimePthread -Raw
$oldWorkerTrace = "      err('[BFG Engine Error] pthread exception: ' + String((ex && ex.stack) || ex).replace(/\r?\n/g, ' | '));"
$workerRuntimeClean = $workerRuntime.Replace($oldWorkerTrace + "`r`n", '').Replace($oldWorkerTrace + "`n", '')
if (-not $workerRuntimeClean.Contains("if (ex != 'unwind') err('[BFG Engine Error] pthread exception:") -and -not $workerRuntimeClean.Contains('webOriginalWorkerFatalReported')) {
    $workerCatch = '(?m)^    \} catch\(ex\) \{\r?$'
    $workerCatchWithTrace = @'
    } catch(ex) {
      if (ex != 'unwind') err('[BFG Engine Error] pthread exception: ' + String((ex && ex.stack) || ex).replace(/\r?\n/g, ' | '));
'@
    if (-not [regex]::IsMatch($workerRuntimeClean, $workerCatch)) { throw 'Could not locate pthread exception handler.' }
    $workerRuntimeClean = ([regex]::new($workerCatch)).Replace($workerRuntimeClean, [System.Text.RegularExpressions.MatchEvaluator]{ param($match) $workerCatchWithTrace }, 1)
}
if ($workerRuntimeClean -cne $workerRuntime) {
    Set-Content -LiteralPath $runtimePthread -Value $workerRuntimeClean -NoNewline
}

# A dying worker's proxy queue can fail before printErr reaches the page. Send
# the original exception directly, independently of that queue, once per worker.
if (-not $workerRuntimeClean.Contains('webOriginalWorkerFatalReported')) {
    $queuedTrace = "      if (ex != 'unwind') err('[BFG Engine Error] pthread exception: ' + String((ex && ex.stack) || ex).replace(/\r?\n/g, ' | '));"
    $directTrace = @'
      if (ex != 'unwind') {
        const originalWorkerFatal = '[BFG Engine Error] pthread exception: ' + String((ex && ex.stack) || ex).replace(/\r?\n/g, ' | ');
        if (!Module['webOriginalWorkerFatalReported'] && typeof fetch == 'function') {
          Module['webOriginalWorkerFatalReported'] = true;
          try {
            fetch('/__local_game/trace', { method: 'POST', credentials: 'same-origin', keepalive: true,
              headers: { 'Content-Type': 'text/plain' }, body: originalWorkerFatal.slice(0, 3500)
            }).catch(() => {});
          } catch (_) {}
        }
        err(originalWorkerFatal);
      }
'@
    if (-not $workerRuntimeClean.Contains($queuedTrace)) { throw 'Could not locate the original worker exception trace.' }
    $workerRuntimeClean = $workerRuntimeClean.Replace($queuedTrace, $directTrace)
    Set-Content -LiteralPath $runtimePthread -Value $workerRuntimeClean -NoNewline
}

# Async render callbacks can trap after handleMessage has returned. Capture the
# worker-local Error object there; the page's Worker ErrorEvent loses its stack.
if (-not $workerRuntimeClean.Contains('webAsyncWorkerFatalListener')) {
    $asyncWorkerFatal = @'
  // webAsyncWorkerFatalListener
  self.addEventListener('error', function(event) {
    if (Module['webAsyncWorkerFatalReported']) return;
    Module['webAsyncWorkerFatalReported'] = true;
    const error = event.error;
    const text = '[BFG Worker Async Fatal] ' + String((error && error.stack) || event.message || error) +
      ' | guestEntity=' + Module['webGuestThinkEntity'] + ' type=' + Module['webGuestThinkType'];
    try {
      fetch('/__local_game/trace', { method: 'POST', credentials: 'same-origin', keepalive: true,
        headers: { 'Content-Type': 'text/plain' }, body: text.replace(/\r?\n/g, ' | ').slice(0, 3500)
      }).catch(function() {});
    } catch (_) {}
  });
'@
    $workerRuntimeClean = $workerRuntimeClean.Replace('  var initializedJS = false;', "  var initializedJS = false;`n" + $asyncWorkerFatal)
    if (-not $workerRuntimeClean.Contains('webAsyncWorkerFatalListener')) { throw 'Could not install asynchronous worker fatal listener.' }
    Set-Content -LiteralPath $runtimePthread -Value $workerRuntimeClean -NoNewline
}

# SDL normally scales pointer-lock deltas into framebuffer pixels. That makes
# aiming change with render resolution. Patch the pinned port at fetch time,
# including fresh SDK installs, and use a separate archive from upstream SDL.
$sdl2Content = Get-Content -LiteralPath $sdl2Port -Raw
if (-not $sdl2Content.Contains('import tempfile')) {
    $updatedSdl2Content = [System.Text.RegularExpressions.Regex]::Replace($sdl2Content, '(?m)^import os\r?$', "import os`nimport tempfile", 1)
    if ($updatedSdl2Content -ceq $sdl2Content) { throw 'Unsupported SDL2 port imports.' }
    $sdl2Content = $updatedSdl2Content
    Set-Content -LiteralPath $sdl2Port -Value $sdl2Content -NoNewline
}
if (-not $sdl2Content.Contains('DOOM3_BROWSER_STABLE_POINTERLOCK')) {
    $sdl2Fetch = "  ports.fetch_project('sdl2', f'https://github.com/libsdl-org/SDL/archive/{TAG}.zip', sha512hash=HASH)"
    if (-not $sdl2Content.Contains($sdl2Fetch)) { throw 'Unsupported SDL2 port recipe.' }
    $sdl2Patch = @'

  def _doom3_write_if_changed(path, content):
    try:
      with open(path, encoding='utf-8') as current_file:
        if current_file.read() == content:
          return
    except FileNotFoundError:
      pass
    fd, temporary_path = tempfile.mkstemp(prefix='.doom3-sdl2-', dir=os.path.dirname(path))
    try:
      with os.fdopen(fd, 'w', encoding='utf-8', newline=chr(10)) as target:
        target.write(content)
      os.replace(temporary_path, path)
    finally:
      if os.path.exists(temporary_path):
        os.unlink(temporary_path)

  # DOOM3_BROWSER_STABLE_POINTERLOCK: keep camera input independent of CSS,
  # framebuffer size and lock-loss cursor relocation. Other SDL users opt out.
  events_path = os.path.join(ports.get_dir('sdl2', SUBDIR), 'src', 'video', 'emscripten', 'SDL_emscriptenevents.c')
  with open(events_path, encoding='utf-8') as events_file:
    events = events_file.read()
  if 'DOOM3_BROWSER_STABLE_POINTERLOCK' not in events:
    edits = {
      '    int mx, my;': '''    const SDL_bool stable_pointerlock = SDL_GetHintBoolean("DOOM3_BROWSER_STABLE_POINTERLOCK", SDL_FALSE);
    if (stable_pointerlock && SDL_GetRelativeMouseMode() && !isPointerLocked) {
        return 0; /* A free cursor/lock transition must not rotate the camera. */
    }
    int mx, my;''',
      'mouseEvent->movementX * xscale': 'mouseEvent->movementX * (stable_pointerlock ? 1.0 : xscale)',
      'mouseEvent->movementY * yscale': 'mouseEvent->movementY * (stable_pointerlock ? 1.0 : yscale)',
    }
    for original, replacement in edits.items():
      if events.count(original) != 1:
        raise RuntimeError('Unsupported SDL2 pointer input: ' + original)
      events = events.replace(original, replacement)
    _doom3_write_if_changed(events_path, events)
'@
    $sdl2Content = $sdl2Content.Replace($sdl2Fetch, $sdl2Fetch + "`n" + $sdl2Patch)
    $sdl2Content = $sdl2Content.Replace("'libSDL2' +", "'libSDL2-doom3-input-v1' +")
    Set-Content -LiteralPath $sdl2Port -Value $sdl2Content -NoNewline
}

# Keep one pointer-lock requester. This opt-in backend leaves requests to the
# DOM bridge, which can use the Resume click/key's transient user activation.
$sdl2Content = Get-Content -LiteralPath $sdl2Port -Raw
if (-not $sdl2Content.Contains('DOOM3_BROWSER_DOM_POINTERLOCK')) {
    $capturePatch = @'
  # DOOM3_BROWSER_DOM_POINTERLOCK: the web shell owns DOM capture requests.
  mouse_path = os.path.join(ports.get_dir('sdl2', SUBDIR), 'src', 'video', 'emscripten', 'SDL_emscriptenmouse.c')
  with open(mouse_path, encoding='utf-8') as source:
    mouse = source.read()
  # DOM capture uses the public SDL hints declaration.
  if '#include "SDL_hints.h"' not in mouse:
    mouse = mouse.replace('#include "../../SDL_internal.h"', '#include "../../SDL_internal.h"' + chr(10) + '#include "SDL_hints.h"')
  if 'DOOM3_BROWSER_DOM_POINTERLOCK' not in mouse:
    before = 'static int Emscripten_SetRelativeMouseMode(SDL_bool enabled)' + chr(10) + '{'
    after = before + chr(10) + '''    if (SDL_GetHintBoolean("DOOM3_BROWSER_DOM_POINTERLOCK", SDL_FALSE)) {
        return 0; /* The DOM bridge owns capture; SDL still tracks relative mode. */
    }'''
    if mouse.count(before) != 1:
      raise RuntimeError('Unsupported SDL2 relative mouse backend')
    mouse = mouse.replace(before, after)
  _doom3_write_if_changed(mouse_path, mouse)
  with open(events_path, encoding='utf-8') as source:
    events = source.read()
  if 'DOOM3_BROWSER_DOM_POINTERLOCK' not in events:
    before = 'if (SDL_GetMouse()->relative_mode && !window_data->has_pointer_lock) {'
    after = 'if (!SDL_GetHintBoolean("DOOM3_BROWSER_DOM_POINTERLOCK", SDL_FALSE) && SDL_GetMouse()->relative_mode && !window_data->has_pointer_lock) {'
    if events.count(before) != 1:
      raise RuntimeError('Unsupported SDL2 mouse-button capture path')
    events = events.replace(before, after)
    _doom3_write_if_changed(events_path, events)

'@
    $sdl2Content = $sdl2Content.Replace('  def create(final):', $capturePatch + '  def create(final):')
    $sdl2Content = $sdl2Content.Replace('libSDL2-doom3-input-v1', 'libSDL2-doom3-input-v2')
    Set-Content -LiteralPath $sdl2Port -Value $sdl2Content -NoNewline
}

# Upgrade recipes installed before the DOM capture hints include was added.
$sdl2Content = Get-Content -LiteralPath $sdl2Port -Raw
if ($sdl2Content.Contains('DOOM3_BROWSER_DOM_POINTERLOCK') -and -not $sdl2Content.Contains('DOM capture uses the public SDL hints declaration')) {
    $hintInclude = @'
  # DOM capture uses the public SDL hints declaration.
  if '#include "SDL_hints.h"' not in mouse:
    mouse = mouse.replace('#include "../../SDL_internal.h"', '#include "../../SDL_internal.h"\n#include "SDL_hints.h"')
'@
    $sdl2Content = $sdl2Content.Replace("    mouse = source.read()", "    mouse = source.read()`n$hintInclude")
    Set-Content -LiteralPath $sdl2Port -Value $sdl2Content -NoNewline
}

# Repair cached recipes produced by an older PowerShell pass that doubled the
# Python newline escapes inside the raw DOM-capture patch block.
$sdl2Content = Get-Content -LiteralPath $sdl2Port -Raw
$domPatchStart = $sdl2Content.IndexOf('  # DOOM3_BROWSER_DOM_POINTERLOCK:')
$domPatchEnd = if ($domPatchStart -ge 0) { $sdl2Content.IndexOf('  def create(final):', $domPatchStart) } else { -1 }
if ($domPatchStart -ge 0 -and $domPatchEnd -gt $domPatchStart) {
    $domPatch = $sdl2Content.Substring($domPatchStart, $domPatchEnd - $domPatchStart)
    $fixedDomPatch = $domPatch.Replace('\\n', '\n')
    $fixedDomPatch = $fixedDomPatch.Replace("    before = 'static int Emscripten_SetRelativeMouseMode(SDL_bool enabled)\n{'",
        "    before = 'static int Emscripten_SetRelativeMouseMode(SDL_bool enabled)' + chr(10) + '{'")
    $fixedDomPatch = $fixedDomPatch.Replace("newline='\n'", 'newline=chr(10)')
    if ($fixedDomPatch -cne $domPatch) {
        $sdl2Content = $sdl2Content.Remove($domPatchStart, $domPatchEnd - $domPatchStart).Insert($domPatchStart, $fixedDomPatch)
        Set-Content -LiteralPath $sdl2Port -Value $sdl2Content -NoNewline
    }
}
$sdl2Content = Get-Content -LiteralPath $sdl2Port -Raw
$sdl2Content = $sdl2Content.Replace("`r`n", "`n")
$stablePatchStart = $sdl2Content.IndexOf('  # DOOM3_BROWSER_STABLE_POINTERLOCK:')
$stablePatchEnd = if ($stablePatchStart -ge 0) { $sdl2Content.IndexOf('  def create(final):', $stablePatchStart) } else { -1 }
if ($stablePatchStart -ge 0 -and $stablePatchEnd -gt $stablePatchStart) {
    $stablePatch = $sdl2Content.Substring($stablePatchStart, $stablePatchEnd - $stablePatchStart)
    $fixedStablePatch = $stablePatch.Replace('\\n', '\n')
    $fixedStablePatch = $fixedStablePatch.Replace("    with open(events_path, 'w', encoding='utf-8', newline='\n') as events_file:`n      events_file.write(events)",
        '    _doom3_write_if_changed(events_path, events)')
    $fixedStablePatch = $fixedStablePatch.Replace("  with open(mouse_path, 'w', encoding='utf-8', newline='\n') as target:`n    target.write(mouse)",
        '  _doom3_write_if_changed(mouse_path, mouse)')
    $fixedStablePatch = $fixedStablePatch.Replace("    with open(events_path, 'w', encoding='utf-8', newline='\n') as target:`n      target.write(events)",
        '    _doom3_write_if_changed(events_path, events)')
    $fixedStablePatch = $fixedStablePatch.Replace("  with open(mouse_path, 'w', encoding='utf-8', newline=chr(10)) as target:`n    target.write(mouse)",
        '  _doom3_write_if_changed(mouse_path, mouse)')
    $fixedStablePatch = $fixedStablePatch.Replace("    with open(events_path, 'w', encoding='utf-8', newline=chr(10)) as target:`n      target.write(events)",
        '    _doom3_write_if_changed(events_path, events)')
    if ($fixedStablePatch -cne $stablePatch) {
        $sdl2Content = $sdl2Content.Remove($stablePatchStart, $stablePatchEnd - $stablePatchStart).Insert($stablePatchStart, $fixedStablePatch)
        Set-Content -LiteralPath $sdl2Port -Value $sdl2Content -NoNewline
    }
}
$writeHelper = @'
  def _doom3_write_if_changed(path, content):
    try:
      with open(path, encoding='utf-8') as current_file:
        if current_file.read() == content:
          return
    except FileNotFoundError:
      pass
    fd, temporary_path = tempfile.mkstemp(prefix='.doom3-sdl2-', dir=os.path.dirname(path))
    try:
      with os.fdopen(fd, 'w', encoding='utf-8', newline=chr(10)) as target:
        target.write(content)
      os.replace(temporary_path, path)
    finally:
      if os.path.exists(temporary_path):
        os.unlink(temporary_path)

'@
$helperStart = $sdl2Content.IndexOf('  def _doom3_write_if_changed(')
$stableMarker = $sdl2Content.IndexOf('  # DOOM3_BROWSER_STABLE_POINTERLOCK:')
if ($stableMarker -ge 0) {
    if ($helperStart -ge 0 -and $helperStart -lt $stableMarker) {
        $sdl2Content = $sdl2Content.Remove($helperStart, $stableMarker - $helperStart).Insert($helperStart, $writeHelper)
    } else {
        $sdl2Content = $sdl2Content.Insert($stableMarker, $writeHelper)
    }
}
$sdl2Content = $sdl2Content.Replace("    with open(mouse_path, 'w', encoding='utf-8', newline='\n') as target:`n      target.write(mouse)",
    "  with open(mouse_path, 'w', encoding='utf-8', newline='\n') as target:`n    target.write(mouse)")
if ($sdl2Content.Contains("with open(mouse_path, 'w'") -or $sdl2Content.Contains("with open(events_path, 'w'")) {
    throw 'SDL source writes must use the atomic write-if-changed helper.'
}
if (-not $sdl2Content.Contains('_doom3_write_if_changed(mouse_path, mouse)')) {
    throw 'SDL DOM capture recipe must persist its hints include on cached sources.'
}
Set-Content -LiteralPath $sdl2Port -Value $sdl2Content -NoNewline

# Display dimensions are published atomically by the DOM thread and consumed
# by the canvas-owning engine pthread; browser audio stays on the UI thread.
$displayHandoff = "      msg.browserDisplayState = Module['browserDisplayState'];"
$displayPthread = Get-Content -LiteralPath $libpthread -Raw
if (-not $displayPthread.Contains($displayHandoff)) {
    $displayPthread = $displayPthread.Replace('    worker.postMessage(msg, threadParams.transferList);',
        "    if (Module['browserDisplayState']) {`n$displayHandoff`n    }`n    worker.postMessage(msg, threadParams.transferList);")
    Set-Content -LiteralPath $libpthread -Value $displayPthread -NoNewline
}
$openalContent = Get-Content -LiteralPath $libopenal -Raw
if (-not $openalContent.Contains('doom3-audio-context')) {
    $openalContent = $openalContent.Replace('      ac = new AudioContext(options);', @'
      ac = new AudioContext(options);
      if (typeof document !== 'undefined') {
        Module['browserAudioContext'] = ac;
        document.dispatchEvent(new CustomEvent('doom3-audio-context', { detail: { context: ac } }));
      }
'@)
    Set-Content -LiteralPath $libopenal -Value $openalContent -NoNewline
}

# Collapse a duplicate stagedFiles handoff left by older patch runs before
# checking/applying the current single-block pthread handoff.
$contentPthread = Get-Content -Path $libpthread -Raw
$stagedFilesHandoffPattern = "    if \(typeof Module !== 'undefined' && Module\['stagedFiles'\]\) \{\r?\n      msg\.stagedFiles = Module\['stagedFiles'\];\r?\n    \}"
$stagedFilesHandoffs = [System.Text.RegularExpressions.Regex]::Matches($contentPthread, $stagedFilesHandoffPattern)
if ($stagedFilesHandoffs.Count -gt 1) {
    $firstHandoff = $stagedFilesHandoffs[0]
    $contentPthread = $contentPthread.Remove($firstHandoff.Index, $firstHandoff.Length)
    Set-Content -Path $libpthread -Value $contentPthread -NoNewline
}

# Repair the missing line break left by earlier PowerShell regex replacements.
$contentWorkerfs = Get-Content -Path $libworkerfs -Raw
$badWorkerfsLine = 'file.lastModifiedDate);      }'
if ($contentWorkerfs.Contains($badWorkerfsLine)) {
    $contentWorkerfs = $contentWorkerfs.Replace($badWorkerfsLine, "file.lastModifiedDate);$([Environment]::NewLine)      }")
    Set-Content -Path $libworkerfs -Value $contentWorkerfs -NoNewline
}

$currentMountBlock = @"
        if (msgData.stagedFiles && typeof FS !== 'undefined' && typeof WORKERFS !== 'undefined') {
          try {
            if (typeof Module !== 'undefined') {
              Module['stagedFiles'] = msgData.stagedFiles;
              Module['browserDisplayState'] = msgData.browserDisplayState;
            }
            if (!FS.initialized) {
              FS.init();
            }
            var mountPoint = '/doom3_game_data';
            var configPath = mountPoint + '/base/default.cfg';
            if (!FS.analyzePath(configPath).exists) {
              try {
                FS.mkdirTree(mountPoint);
              } catch (ignore) {}
              var filesToMount = [];
              for (var sf of msgData.stagedFiles) {
                var fileObj = sf && (sf.file || sf);
                if (!fileObj) {
                  throw new Error('A staged game data entry has no File object.');
                }
                var relPath = (sf && sf.relativePath) || fileObj.relativePath || fileObj.name;
                if (!relPath) {
                  throw new Error('A staged game data entry has no relative path.');
                }
                filesToMount.push({ file: fileObj, relativePath: relPath });
              }
              FS.mount(WORKERFS, { files: filesToMount }, mountPoint);
            }
            var saveMountPoint = '/doom3_save_data';
            // Only the very first pthread (the proxied engine main thread) owns the
            // IndexedDB-backed save volume. Additional engine pthreads get a private
            // in-memory save directory: mounting IDBFS on every pthread makes workers
            // queue IndexedDB transactions behind each other, and the engine's startup
            // barrier (Atomics.wait in the main pthread) then blocks the worker whose
            // syncfs is waiting for that transaction -> permanent startup deadlock.
            var ownsSaveVolume = !!msgData.initialThread;
            var persistSaves = msgData.persistSaves !== false && (!msgData.mapStaging || msgData.mapStaging.persistSaves !== false);
            var mountIdbfs = ownsSaveVolume && persistSaves;
            Module['persistSaves'] = persistSaves;
            Module['idbfsMountComplete'] = !mountIdbfs;
            Module['idbfsMountError'] = null;
            Module['idbfsMountPending'] = mountIdbfs;
            FS.mkdirTree(saveMountPoint);
            if (mountIdbfs) {
              if (typeof IDBFS === 'undefined') {
                throw new Error('IDBFS is unavailable; refusing to start without writable saves.');
              }
              FS.mount(IDBFS, { autoPersist: true }, saveMountPoint);
            } else if (ownsSaveVolume) {
              out('Persistent saves are disabled; save files remain in volatile worker memory.');
            }
            if (!FS.analyzePath(configPath).exists) {
              var basePath = mountPoint + '/base';
              var baseEntries = FS.analyzePath(basePath).exists
                ? FS.readdir(basePath).slice(0, 24).join(', ')
                : '<missing>';
              throw new Error('Mounted game data is missing ' + configPath + '. Entries in base: ' + baseEntries);
            }
            var baseEntries = FS.readdir(mountPoint + '/base');
            var basePath = mountPoint + '/base';
            var baseDirectory = FS.open(basePath, 65536 | 524288);
            FS.close(baseDirectory);
            var baseMode = FS.stat(basePath).mode;
            out('Staged game data mount verified on pthread ' + msgData.pthread_ptr + ': ' + baseEntries.length + ' base entries; default.cfg present; directory mode 0x' + baseMode.toString(16) + '; O_DIRECTORY open passed.');
          } catch (e) {
            var errDetail = (e && (e.stack || (e.name ? e.name + ': ' + e.message : null) || (e.errno ? 'errno ' + e.errno : null))) || String(e);
            Module['idbfsMountError'] = 'Staged game data mount failed: ' + errDetail;
            if (typeof abort === 'function') abort(Module['idbfsMountError']);
            else throw new Error(Module['idbfsMountError']);
          }
        }
"@

$mapStagingRuntimeBlock = @"
        if (msgData.mapStaging && typeof FS !== 'undefined' && typeof WORKERFS !== 'undefined') {
          // The menu runs in a child worker and stages its own preview image.
          Module['mapStaging'] = msgData.mapStaging;
          var stagedMapFiles = Object.create(null);
          var stagingPromises = Object.create(null);
          var mapManifestPromise = null;
          var mapManifestController = null;
          var mapApi = msgData.mapStaging;
          var requestedCacheMode = Number(mapApi.cacheMode);
          var mapCacheMode = Number.isInteger(requestedCacheMode) && requestedCacheMode >= 0 && requestedCacheMode <= 3 ? requestedCacheMode : 1;
          var traceMapStage = function(message) {
            if (!mapApi.diagnosticsUrl) return;
            try {
              fetch(mapApi.diagnosticsUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'text/plain' },
                body: String(message)
              }).catch(function() {});
            } catch (_) {}
          };
          var mapOut = function(message) { out(message); traceMapStage(message); };
          var mapErr = function(message) { err(message); traceMapStage(message); };
          var mapEnsureDirectory = function(relativePath) {
            var node = FS.lookupPath('/doom3_game_data').node;
            for (var part of relativePath.split('/').filter(Boolean)) {
              try { node = FS.lookupNode(node, part); }
              catch (e) { node = WORKERFS.createNode(node, part, WORKERFS.DIR_MODE, 0); }
            }
            return node;
          };
          var stagedMapLoadingImages = Object.create(null);
          var mapLoadingImagePromises = Object.create(null);
          Module['stageMapLoadingImage'] = async function(mapName) {
            var normalized = String(mapName || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
            if (!normalized || normalized.split('/').some(function(part) { return !part || part === '.' || part === '..' || !/^[A-Za-z0-9_.-]+$/.test(part); })) return false;
            var basename = normalized.split('/').pop().replace(/\.map$/i, '').toLowerCase();
            if (!basename || basename === '.' || basename === '..') return false;
            // Boot-cached menu thumbnails are already mounted and must never
            // be replaced or removed by the temporary map-image lifecycle.
            try {
              var installedImage = FS.lookupPath('/doom3_game_data/base/generated/images/guis/assets/loadscreens/' + basename + '#__0200.bimage').node;
              if (installedImage && installedImage.size > 0) return true;
            } catch (_) {}
            if (stagedMapLoadingImages[basename]) return true;
            if (mapLoadingImagePromises[basename]) return mapLoadingImagePromises[basename];
            var pendingImage = (async function() {
              var controller = null;
              var reader = null;
              var imageBytes = null;
              var imageNode = null;
              var deadline = Date.now() + 45000;
              var cancelImage = function() {
                if (controller) try { controller.abort(); } catch (_) {}
                if (reader) try { Promise.resolve(reader.cancel()).catch(function() {}); } catch (_) {}
              };
              var awaitImage = function(operation, stage, onTimeout) {
                var remaining = deadline - Date.now();
                var timeoutError = function() {
                  cancelImage();
                  if (onTimeout) try { onTimeout(); } catch (_) {}
                  return new Error('Loading image staging timed out during ' + stage + ': ' + basename);
                };
                if (remaining <= 0) {
                  Promise.resolve(operation).catch(function() {});
                  throw timeoutError();
                }
                var timer;
                return Promise.race([Promise.resolve(operation), new Promise(function(_, reject) {
                  timer = setTimeout(function() { reject(timeoutError()); }, remaining);
                })]).finally(function() { clearTimeout(timer); });
              };
              try {
                if (!mapManifestPromise) {
                  var manifestController = new AbortController();
                  mapManifestController = manifestController;
                  var cachedManifestPromise;
                  cachedManifestPromise = fetch(mapApi.manifestUrl, { signal: manifestController.signal, cache: 'no-store' }).then(function(response) {
                    if (!response.ok) throw new Error('Loading image manifest request failed: ' + response.status);
                    return response.json();
                  }).then(function(manifest) {
                    if (mapManifestController === manifestController) mapManifestController = null;
                    return manifest;
                  }).catch(function(error) {
                    if (mapManifestPromise === cachedManifestPromise) {
                      mapManifestPromise = null;
                      mapManifestController = null;
                    }
                    throw error;
                  });
                  mapManifestPromise = cachedManifestPromise;
                }
                var manifestPromise = mapManifestPromise;
                var manifest = await awaitImage(manifestPromise, 'manifest fetch', function() {
                  if (mapManifestController) try { mapManifestController.abort(); } catch (_) {}
                  if (mapManifestPromise === manifestPromise) {
                    mapManifestPromise = null;
                    mapManifestController = null;
                  }
                });
                var archiveName = basename + '.resources';
                var candidates = (manifest.files || []).filter(function(entry) {
                  var path = String(entry.path || '').replace(/\\/g, '/');
                  return /^(?:base|d3xp|d3le)\/maps\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.resources$/i.test(path) && path.slice(path.lastIndexOf('/') + 1).toLowerCase() === archiveName;
                });
                if (candidates.length !== 1) throw new Error(candidates.length ? 'Ambiguous map archive for loading image: ' + basename : 'Map archive is missing for loading image: ' + basename);
                var fileEntry = candidates[0];
                var filePath = String(fileEntry.path).replace(/\\/g, '/');
                if (!Number.isSafeInteger(fileEntry.size) || fileEntry.size < 12) throw new Error('Invalid loading image archive size: ' + filePath);
                mapOut('[DOOM 3 BFG Web] Loading image archive selected: ' + filePath + ' (' + fileEntry.size + ' bytes)');
                var readRange = async function(start, length, label) {
                  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length <= 0 || length > 8388608 || start > fileEntry.size - length) throw new Error('Invalid bounded range for ' + label + ': ' + filePath);
                  var end = start + length - 1;
                  controller = new AbortController();
                  var response = await awaitImage(fetch(mapApi.fileUrl + '?path=' + encodeURIComponent(filePath), {
                    method: 'GET',
                    headers: { Range: 'bytes=' + start + '-' + end },
                    signal: controller.signal,
                    cache: 'no-store'
                  }), label + ' response');
                  var contentRange = response.headers.get('Content-Range') || '';
                  var rangeMatch = /^bytes (\d+)-(\d+)\/(\d+)$/i.exec(contentRange);
                  if (response.status !== 206 || !rangeMatch || Number(rangeMatch[1]) !== start || Number(rangeMatch[2]) !== end || Number(rangeMatch[3]) !== fileEntry.size || !response.body) {
                    cancelImage();
                    throw new Error('Server did not return the exact requested range for ' + label + ' (status=' + response.status + ', Content-Range=' + contentRange + ').');
                  }
                  reader = response.body.getReader();
                  var bytes = new Uint8Array(length);
                  var total = 0;
                  while (true) {
                    var chunk = await awaitImage(reader.read(), label + ' stream');
                    if (chunk.done) break;
                    if (!chunk.value) continue;
                    if (chunk.value.byteLength > length - total) throw new Error('Server exceeded the requested range for ' + label + '.');
                    bytes.set(chunk.value, total);
                    total += chunk.value.byteLength;
                  }
                  reader = null;
                  controller = null;
                  if (total !== length) throw new Error('Short response for ' + label + ': ' + total + '/' + length + ' bytes.');
                  return bytes;
                };
                var header = await readRange(0, 12, 'resource header');
                var headerView = new DataView(header.buffer, header.byteOffset, header.byteLength);
                if (headerView.getUint32(0, false) !== 0xD000000D) throw new Error('Invalid resource archive magic: ' + filePath);
                var tableOffset = headerView.getUint32(4, false);
                var tableLength = headerView.getUint32(8, false);
                if (tableOffset < 12 || tableLength < 4 || tableLength > 1048576 || tableOffset > fileEntry.size - tableLength) throw new Error('Resource table bounds are invalid: ' + filePath);
                var table = await readRange(tableOffset, tableLength, 'resource table');
                var tableView = new DataView(table.buffer, table.byteOffset, table.byteLength);
                var entryCount = tableView.getInt32(0, false);
                if (entryCount < 0 || entryCount > 50000 || entryCount > Math.floor((tableLength - 4) / 12)) throw new Error('Resource table entry count is invalid: ' + entryCount);
                var targetName = ('generated/images/guis/assets/loadscreens/' + basename + '#__0200.bimage').toLowerCase();
                var targetEntry = null;
                var cursor = 4;
                var decoder = new TextDecoder('utf-8');
                for (var index = 0; index < entryCount; index++) {
                  if (cursor > tableLength - 4) throw new Error('Resource table ended before entry ' + index + '.');
                  var nameLength = tableView.getInt32(cursor, true);
                  cursor += 4;
                  if (nameLength <= 0 || nameLength > 4096 || cursor > tableLength - nameLength - 8) throw new Error('Resource name length is invalid at entry ' + index + '.');
                  var resourceName = decoder.decode(table.subarray(cursor, cursor + nameLength)).replace(/\\/g, '/').toLowerCase();
                  cursor += nameLength;
                  var resourceOffset = tableView.getUint32(cursor, false);
                  var resourceLength = tableView.getUint32(cursor + 4, false);
                  cursor += 8;
                  if (resourceOffset > fileEntry.size || resourceLength > fileEntry.size - resourceOffset) throw new Error('Resource payload bounds are invalid at entry ' + index + '.');
                  if (resourceName === targetName) {
                    if (targetEntry) throw new Error('Duplicate loading image entry in ' + filePath);
                    if (resourceLength <= 0 || resourceLength > 8388608) throw new Error('Loading image payload size is invalid: ' + resourceLength);
                    targetEntry = { offset: resourceOffset, length: resourceLength };
                  }
                }
                if (!targetEntry) throw new Error('Map loading image is not in the resource archive: ' + targetName);
                imageBytes = await readRange(targetEntry.offset, targetEntry.length, 'loading image payload');
                var relativePath = 'base/' + targetName;
                var parts = relativePath.split('/');
                var leaf = parts.pop();
                var parent = mapEnsureDirectory(parts.join('/'));
                imageNode = WORKERFS.createNode(parent, leaf, WORKERFS.FILE_MODE, 0, { size: imageBytes.byteLength }, new Date());
                imageNode.contents = imageBytes;
                imageNode.size = imageBytes.byteLength;
                imageNode.stream_ops = Object.assign({}, WORKERFS.stream_ops, {
                  read: function(stream, buffer, offset, length, position) {
                    var bytes = stream.node.contents;
                    var size = stream.node.size;
                    if (!Number.isSafeInteger(position) || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || position < 0 || offset < 0 || length < 0 || position >= size || offset >= buffer.byteLength) return 0;
                    var count = Math.min(length, size - position, buffer.byteLength - offset);
                    if (count <= 0) return 0;
                    buffer.set(bytes.subarray(position, position + count), offset);
                    return count;
                  }
                });
                stagedMapLoadingImages[basename] = { bytes: imageBytes, node: imageNode, path: relativePath };
                mapOut('[DOOM 3 BFG Web] Map loading image mounted: ' + relativePath + ' (' + imageBytes.byteLength + ' bytes, bounded Range reads)');
                return true;
              } catch (error) {
                cancelImage();
                if (imageNode && imageNode.parent) {
                  delete imageNode.parent.contents[imageNode.name];
                  FS.destroyNode(imageNode);
                  imageNode.contents = null;
                }
                if (imageBytes) imageBytes.fill(0);
                mapErr('[DOOM 3 BFG Web] Map loading image staging failed for ' + basename + ': ' + String(error && error.message || error));
                return false;
              }
            })();
            mapLoadingImagePromises[basename] = pendingImage;
            try { return await pendingImage; }
            finally { if (mapLoadingImagePromises[basename] === pendingImage) delete mapLoadingImagePromises[basename]; }
          };
          Module['releaseMapLoadingImage'] = function(mapName) {
            var normalized = String(mapName || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
            var basename = normalized.split('/').pop().replace(/\.map$/i, '').toLowerCase();
            var staged = stagedMapLoadingImages[basename];
            if (!staged) return 0;
            if (staged.node && staged.node.parent) {
              delete staged.node.parent.contents[staged.node.name];
              FS.destroyNode(staged.node);
              staged.node.contents = null;
            }
            var released = staged.bytes.byteLength;
            staged.bytes.fill(0);
            delete stagedMapLoadingImages[basename];
            mapOut('[DOOM 3 BFG Web] Released map loading image: ' + staged.path + ' (' + released + ' bytes)');
            return released;
          };
          Module['stageMapResources'] = async function(mapName) {
            var mapStageToken = (Module['webMapProgressToken'] || 0) + 1;
            Module['webMapProgressToken'] = mapStageToken;
            Module['webMapDownloadProgress'] = 0;
            var reportMapProgress = function(value) {
              if (Module['webMapProgressToken'] === mapStageToken) Module['webMapDownloadProgress'] = Math.max(Module['webMapDownloadProgress'], Math.min(1, value));
            };
            var normalized = String(mapName || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
            if (!normalized || normalized.split('/').some(function(part) { return !part || part === '.' || part === '..'; })) throw new Error('Invalid map resource name.');
            mapOut('[DOOM 3 BFG Web] Map staging started: ' + normalized);
            var mapStageDeadline = Date.now() + 180000;
            var awaitMapStage = function(operation, stage, onTimeout) {
              var pending = Promise.resolve(operation);
              var timeoutError = function() {
                if (onTimeout) try { onTimeout(); } catch (_) {}
                return new Error('Map staging timed out during ' + stage + ' after 180 seconds: ' + normalized + '.');
              };
              var remaining = mapStageDeadline - Date.now();
              if (remaining <= 0) {
                pending.catch(function() {});
                return Promise.reject(timeoutError());
              }
              var timer;
              return Promise.race([pending, new Promise(function(_, reject) {
                timer = setTimeout(function() { reject(timeoutError()); }, remaining);
              })]).finally(function() { clearTimeout(timer); });
            };
            var cacheLockName = 'doom3-bfg-asset-cache-v1';
            var openMapCacheRoot = async function() {
              if (typeof navigator === 'undefined' || !navigator.storage || !navigator.storage.getDirectory) throw new Error('OPFS map cache is unavailable.');
              var root = await navigator.storage.getDirectory();
              return await root.getDirectoryHandle('map-cache', { create: true });
            };
            var readCachedMapArchive = async function(cacheRoot, entry, path) {
              var metaHandle = await cacheRoot.getFileHandle('.bfg_meta.json');
              var metadata = JSON.parse(await (await metaHandle.getFile()).text());
              var stored = metadata && metadata.files && metadata.files[path];
              if (!stored || stored.etag !== entry.etag || stored.size !== entry.size) return null;
              var parts = path.split('/');
              var leaf = parts.pop();
              var directory = cacheRoot;
              for (var part of parts) directory = await directory.getDirectoryHandle(part);
              var file = await (await directory.getFileHandle(leaf)).getFile();
              if (file.size !== entry.size) return null;
              var bytes = new Uint8Array(await file.arrayBuffer());
              return bytes.byteLength === entry.size ? bytes : null;
            };
            var getMapCacheFileHandle = async function(cacheRoot, path) {
              var parts = path.split('/');
              var leaf = parts.pop();
              var directory = cacheRoot;
              for (var part of parts) directory = await directory.getDirectoryHandle(part, { create: true });
              return await directory.getFileHandle(leaf, { create: true });
            };
            var writeMapCacheMetadata = async function(cacheRoot, entry, path) {
              var metadata = { manifestEtag: '', files: {} };
              try { metadata = JSON.parse(await (await cacheRoot.getFileHandle('.bfg_meta.json')).getFile().then(function(file) { return file.text(); })); } catch (_) {}
              if (!metadata || typeof metadata !== 'object' || !metadata.files || typeof metadata.files !== 'object') metadata = { manifestEtag: '', files: {} };
              metadata.files[path] = { etag: entry.etag, size: entry.size };
              var handle = await cacheRoot.getFileHandle('.bfg_meta.json', { create: true });
              var writable = await handle.createWritable();
              await writable.write(JSON.stringify(metadata));
              await writable.close();
            };
            var downloadMapArchive = async function(entry, path, cacheRoot) {
              var controller = new AbortController();
              var reader = null;
              var writer = null;
              var writerOpen = false;
              var cancelled = false;
              var cancelTransfer = function() {
                if (cancelled) return;
                cancelled = true;
                try { controller.abort(); } catch (_) {}
                if (reader) try { Promise.resolve(reader.cancel()).catch(function() {}); } catch (_) {}
                if (writer) try { Promise.resolve(writer.abort()).catch(function() {}); } catch (_) {}
              };
              var awaitTransfer = function(operation, stage) {
                return awaitMapStage(operation, 'archive ' + stage + ': ' + path, cancelTransfer);
              };
              var archiveBytes = null;
              try {
                mapOut('[DOOM 3 BFG Web] Map archive download started: ' + path + ' (' + entry.size + ' bytes, ' + (cacheRoot ? 'persistent cache' : 'memory only') + ')');
                var response = await awaitTransfer(fetch(mapApi.fileUrl + '?path=' + encodeURIComponent(path), { signal: controller.signal, cache: 'no-store' }), 'response');
                mapOut('[DOOM 3 BFG Web] Map archive response: ' + path + ' status=' + response.status + ' body=' + !!response.body);
                if (!response.ok || !response.body) throw new Error('Map archive download failed: ' + path + ' (' + response.status + ').');
                if (cacheRoot) {
                  try {
                    var cacheHandle = await getMapCacheFileHandle(cacheRoot, path);
                    writer = await cacheHandle.createWritable();
                    writerOpen = true;
                  } catch (cacheOpenError) {
                    mapErr('[DOOM 3 BFG Web] Persistent map cache write unavailable for ' + path + ': ' + String(cacheOpenError));
                  }
                }
                reader = response.body.getReader();
                archiveBytes = new Uint8Array(entry.size);
                var total = 0;
                while (true) {
                  var chunk = await awaitTransfer(reader.read(), 'stream read');
                  if (chunk.done) break;
                  if (!chunk.value) continue;
                  if (chunk.value.byteLength > entry.size - total) throw new Error('Map archive exceeds manifest size: ' + path + '.');
                  archiveBytes.set(chunk.value, total);
                  total += chunk.value.byteLength;
                  reportMapProgress((mapStageCompletedBytes + total) / mapStageTotalBytes);
                  if (writer) {
                    try { await awaitTransfer(writer.write(chunk.value), 'cache write'); }
                    catch (cacheWriteError) {
                      try { await writer.abort(); } catch (_) {}
                      writer = null;
                      writerOpen = false;
                      mapErr('[DOOM 3 BFG Web] Persistent map cache write failed for ' + path + ': ' + String(cacheWriteError));
                    }
                  }
                }
                reader = null;
                if (total !== entry.size) throw new Error('Map archive size mismatch: ' + path + ' (' + total + '/' + entry.size + ').');
                if (writer) {
                  try {
                    await awaitTransfer(writer.close(), 'cache finalize');
                    writer = null;
                    writerOpen = false;
                    await writeMapCacheMetadata(cacheRoot, entry, path);
                  } catch (cacheFinalizeError) {
                    if (writerOpen && writer) try { await writer.abort(); } catch (_) {}
                    writer = null;
                    writerOpen = false;
                    mapErr('[DOOM 3 BFG Web] Persistent map cache finalize failed for ' + path + ': ' + String(cacheFinalizeError));
                  }
                }
                return archiveBytes;
              } catch (error) {
                cancelTransfer();
                if (archiveBytes) archiveBytes.fill(0);
                throw error;
              } finally {
                if (writerOpen && writer) try { await writer.abort(); } catch (_) {}
              }
            };
            if (!mapManifestPromise) {
              var manifestController = new AbortController();
              mapManifestController = manifestController;
              var cachedManifestPromise;
              cachedManifestPromise = fetch(mapApi.manifestUrl, { signal: manifestController.signal, cache: 'no-store' }).then(function(response) {
                if (!response.ok) throw new Error('Map manifest request failed: ' + response.status);
                return response.json();
              }).then(function(manifest) {
                if (mapManifestController === manifestController) mapManifestController = null;
                return manifest;
              }).catch(function(error) {
                if (mapManifestPromise === cachedManifestPromise) {
                  mapManifestPromise = null;
                  mapManifestController = null;
                }
                throw error;
              });
              mapManifestPromise = cachedManifestPromise;
            }
            var manifestPromise = mapManifestPromise;
            var manifest = await awaitMapStage(manifestPromise, 'manifest request and parse', function() {
              if (mapManifestController) try { mapManifestController.abort(); } catch (_) {}
              if (mapManifestPromise === manifestPromise) {
                mapManifestPromise = null;
                mapManifestController = null;
              }
            });
            // BeginLevelLoad strips game/mp path prefixes before AddResourceFile.
            var archiveName = normalized.split('/').pop();
            var suffix = '/maps/' + archiveName.toLowerCase() + '.resources';
            var candidates = (manifest.files || []).filter(function(entry) {
              var path = String(entry.path || '').replace(/\\/g, '/').toLowerCase();
              return /^(base|d3xp|d3le)\/maps\//.test(path) && path.endsWith(suffix);
            });
            if (!candidates.length) throw new Error('No installed map archive matches ' + normalized + '.');
            var mapStageTotalBytes = candidates.reduce(function(sum, entry) {
              if (!Number.isSafeInteger(entry.size) || entry.size <= 0 || !Number.isSafeInteger(sum + entry.size)) throw new Error('Invalid map archive size.');
              return sum + entry.size;
            }, 0);
            var mapStageCompletedBytes = 0;
            mapOut('[DOOM 3 BFG Web] Map archive matches: ' + candidates.map(function(entry) { return entry.path + ' (' + entry.size + ' bytes)'; }).join(', '));
            for (var entry of candidates) {
              var relativePath = String(entry.path || '').replace(/\\/g, '/');
              if (!/^(base|d3xp|d3le)\/maps\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.resources$/.test(relativePath) || !Number.isSafeInteger(entry.size) || entry.size <= 0) throw new Error('Invalid map archive manifest entry.');
              var cacheKey = relativePath.toLowerCase();
              if (stagedMapFiles[cacheKey]) {
                mapStageCompletedBytes += entry.size;
                reportMapProgress(mapStageCompletedBytes / mapStageTotalBytes);
                continue;
              }
              if (!stagingPromises[cacheKey]) {
                stagingPromises[cacheKey] = (async function(fileEntry, path, key) {
                  var archiveBytes = null;
                  if (mapCacheMode >= 2 && typeof navigator !== 'undefined' && navigator.locks && navigator.storage && navigator.storage.getDirectory) {
                    var networkStarted = false;
                    var lockController = new AbortController();
                    try {
                      archiveBytes = await awaitMapStage(navigator.locks.request(cacheLockName, { mode: 'exclusive', signal: lockController.signal }, async function() {
                        var cacheRoot = await openMapCacheRoot();
                        try {
                          var cachedBytes = await readCachedMapArchive(cacheRoot, fileEntry, path);
                          if (cachedBytes) {
                            mapOut('[DOOM 3 BFG Web] Reused persistent map archive: ' + path + ' (' + cachedBytes.byteLength + ' bytes)');
                            return cachedBytes;
                          }
                        } catch (cacheReadError) {
                          mapOut('[DOOM 3 BFG Web] Persistent map cache miss for ' + path + ': ' + String(cacheReadError));
                        }
                        networkStarted = true;
                        return await downloadMapArchive(fileEntry, path, cacheRoot);
                      }), 'persistent map cache lock', function() { try { lockController.abort(); } catch (_) {} });
                    } catch (cacheOrNetworkError) {
                      if (networkStarted) throw cacheOrNetworkError;
                      mapErr('[DOOM 3 BFG Web] Persistent map cache unavailable; staging volatile copy: ' + String(cacheOrNetworkError));
                      archiveBytes = await downloadMapArchive(fileEntry, path, null);
                    }
                  } else {
                    archiveBytes = await downloadMapArchive(fileEntry, path, null);
                    if (mapCacheMode >= 2) mapOut('[DOOM 3 BFG Web] Persistent map cache APIs unavailable; archive remains volatile: ' + path);
                  }
                  var parts = path.split('/');
                  var leaf = parts.pop();
                  var parent = mapEnsureDirectory(parts.join('/'));
                  var node = WORKERFS.createNode(parent, leaf, WORKERFS.FILE_MODE, 0, { size: archiveBytes.byteLength }, new Date());
                  node.contents = archiveBytes;
                  node.size = archiveBytes.byteLength;
                  node.stream_ops = Object.assign({}, WORKERFS.stream_ops, {
                    read: function(stream, buffer, offset, length, position) {
                      var bytes = stream.node.contents;
                      var size = stream.node.size;
                      if (!Number.isSafeInteger(position) || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || position < 0 || offset < 0 || length < 0 || position >= size || offset >= buffer.byteLength) return 0;
                      var count = Math.min(length, size - position, buffer.byteLength - offset);
                      if (count <= 0) return 0;
                      buffer.set(bytes.subarray(position, position + count), offset);
                      return count;
                    }
                  });
                  stagedMapFiles[key] = { bytes: archiveBytes, node: node };
                  mapOut('[DOOM 3 BFG Web] Map archive mounted: ' + path + ' (' + archiveBytes.byteLength + ' bytes, ArrayBuffer-backed)');
                })(entry, relativePath, cacheKey);
              }
              try { await awaitMapStage(stagingPromises[cacheKey], 'archive staging: ' + relativePath); }
              catch (error) { delete stagingPromises[cacheKey]; throw error; }
              mapStageCompletedBytes += entry.size;
              reportMapProgress(mapStageCompletedBytes / mapStageTotalBytes);
            }
            reportMapProgress(1);
            mapOut('[DOOM 3 BFG Web] Map staging finished: ' + normalized);
            return true;
          };
          var stagedVideoFiles = Object.create(null);
          var videoStagingPromises = Object.create(null);
          Module['stageVideoResource'] = async function(resourceName) {
            var normalized = String(resourceName || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
            if (!/^(?:video|sound\/VO\/video)\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.bik$/i.test(normalized)) {
              mapErr('[DOOM 3 BFG Web] Invalid Bink video resource path: ' + normalized);
              return false;
            }
            var key = normalized.toLowerCase();
            if (stagedVideoFiles[key]) {
              ++stagedVideoFiles[key].references;
              return true;
            }
            if (videoStagingPromises[key]) {
              var reusedVideo = await videoStagingPromises[key];
              if (reusedVideo && stagedVideoFiles[key]) ++stagedVideoFiles[key].references;
              return reusedVideo;
            }
            var pendingVideo = (async function() {
              var controller = new AbortController();
              var reader = null;
              var videoBytes = null;
              var node = null;
              var cancelled = false;
              var cancelVideo = function() {
                if (cancelled) return;
                cancelled = true;
                try { controller.abort(); } catch (_) {}
                if (reader) try { Promise.resolve(reader.cancel()).catch(function() {}); } catch (_) {}
              };
              var videoDeadline = Date.now() + 120000;
              var awaitVideo = function(operation, stage, onTimeout) {
                var remaining = videoDeadline - Date.now();
                var timeoutError = function() {
                  cancelVideo();
                  if (onTimeout) try { onTimeout(); } catch (_) {}
                  return new Error('Bink staging timed out during ' + stage + ': ' + normalized);
                };
                if (remaining <= 0) {
                  Promise.resolve(operation).catch(function() {});
                  throw timeoutError();
                }
                var timer;
                return Promise.race([Promise.resolve(operation), new Promise(function(_, reject) {
                  timer = setTimeout(function() { reject(timeoutError()); }, remaining);
                })]).finally(function() { clearTimeout(timer); });
              };
              try {
                if (!mapManifestPromise) {
                  var manifestController = new AbortController();
                  mapManifestController = manifestController;
                  var cachedManifestPromise;
                  cachedManifestPromise = fetch(mapApi.manifestUrl, { signal: manifestController.signal, cache: 'no-store' }).then(function(response) {
                    if (!response.ok) throw new Error('Video manifest request failed: ' + response.status);
                    return response.json();
                  }).then(function(manifest) {
                    if (mapManifestController === manifestController) mapManifestController = null;
                    return manifest;
                  }).catch(function(error) {
                    if (mapManifestPromise === cachedManifestPromise) {
                      mapManifestPromise = null;
                      mapManifestController = null;
                    }
                    throw error;
                  });
                  mapManifestPromise = cachedManifestPromise;
                }
                var manifestPromise = mapManifestPromise;
                var manifest = await awaitVideo(manifestPromise, 'manifest fetch', function() {
                  if (mapManifestController) try { mapManifestController.abort(); } catch (_) {}
                  if (mapManifestPromise === manifestPromise) {
                    mapManifestPromise = null;
                    mapManifestController = null;
                  }
                });
                var requestedPath = normalized.toLowerCase();
                var candidates = (manifest.files || []).filter(function(entry) {
                  var path = String(entry.path || '').replace(/\\/g, '/');
                  var lowerPath = path.toLowerCase();
                  return /^(?:base|d3xp|d3le)\/(?:video|sound\/vo\/video)\//.test(lowerPath) && lowerPath.slice(lowerPath.indexOf('/') + 1) === requestedPath;
                });
                if (candidates.length !== 1) throw new Error(candidates.length ? 'Ambiguous Bink video manifest path: ' + normalized : 'Bink video is missing from the installed manifest: ' + normalized);
                var fileEntry = candidates[0];
                var filePath = String(fileEntry.path).replace(/\\/g, '/');
                if (!/^(?:base|d3xp|d3le)\/(?:video|sound\/VO\/video)\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.bik$/i.test(filePath) || !Number.isSafeInteger(fileEntry.size) || fileEntry.size <= 0) {
                  throw new Error('Invalid Bink video manifest entry: ' + filePath);
                }
                if (mapCacheMode === 3) {
                  var permanentVideoPath = '/doom3_game_data/' + filePath;
                  try {
                    if (FS.analyzePath(permanentVideoPath).exists && FS.stat(permanentVideoPath).size === fileEntry.size) {
                      mapOut('[DOOM 3 BFG Web] Reused full-cache Bink video: ' + filePath + ' (' + fileEntry.size + ' bytes)');
                      return true;
                    }
                  } catch (_) {}
                }
                mapOut('[DOOM 3 BFG Web] Bink video staging started: ' + filePath + ' (' + fileEntry.size + ' bytes, memory only)');
                var response = await awaitVideo(fetch(mapApi.fileUrl + '?path=' + encodeURIComponent(filePath), { signal: controller.signal, cache: 'no-store' }), 'response');
                if (!response.ok || !response.body) throw new Error('Bink video download failed: ' + filePath + ' (' + response.status + ').');
                reader = response.body.getReader();
                videoBytes = new Uint8Array(fileEntry.size);
                var total = 0;
                while (true) {
                  var chunk = await awaitVideo(reader.read(), 'stream read');
                  if (chunk.done) break;
                  if (!chunk.value) continue;
                  if (chunk.value.byteLength > fileEntry.size - total) throw new Error('Bink video exceeds manifest size: ' + filePath);
                  videoBytes.set(chunk.value, total);
                  total += chunk.value.byteLength;
                }
                if (total !== fileEntry.size) throw new Error('Bink video size mismatch: ' + filePath + ' (' + total + '/' + fileEntry.size + ').');
                var parts = filePath.split('/');
                var leaf = parts.pop();
                var parent = mapEnsureDirectory(parts.join('/'));
                node = WORKERFS.createNode(parent, leaf, WORKERFS.FILE_MODE, 0, { size: videoBytes.byteLength }, new Date());
                node.contents = videoBytes;
                node.size = videoBytes.byteLength;
                node.stream_ops = Object.assign({}, WORKERFS.stream_ops, {
                  read: function(stream, buffer, offset, length, position) {
                    var bytes = stream.node.contents;
                    var size = stream.node.size;
                    if (!Number.isSafeInteger(position) || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || position < 0 || offset < 0 || length < 0 || position >= size || offset >= buffer.byteLength) return 0;
                    var count = Math.min(length, size - position, buffer.byteLength - offset);
                    if (count <= 0) return 0;
                    buffer.set(bytes.subarray(position, position + count), offset);
                    return count;
                  }
                });
                stagedVideoFiles[key] = { bytes: videoBytes, node: node, path: filePath, references: 1 };
                mapOut('[DOOM 3 BFG Web] Bink video mounted: ' + filePath + ' (' + videoBytes.byteLength + ' bytes, ArrayBuffer-backed)');
                return true;
              } catch (error) {
                cancelVideo();
                if (node && node.parent) {
                  delete node.parent.contents[node.name];
                  FS.destroyNode(node);
                  node.contents = null;
                }
                if (videoBytes) videoBytes.fill(0);
                mapErr('[DOOM 3 BFG Web] Bink video staging failed for ' + normalized + ': ' + String(error && error.message || error));
                return false;
              }
            })();
            videoStagingPromises[key] = pendingVideo;
            try { return await pendingVideo; }
            finally { if (videoStagingPromises[key] === pendingVideo) delete videoStagingPromises[key]; }
          };
          Module['releaseVideoResource'] = function(resourceName) {
            var normalized = String(resourceName || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
            var key = normalized.toLowerCase();
            var staged = stagedVideoFiles[key];
            if (!staged) return 0;
            // A video may be shared by multiple native cinematic instances.
            if (--staged.references > 0) return 0;
            if (staged.node && staged.node.parent) {
              delete staged.node.parent.contents[staged.node.name];
              FS.destroyNode(staged.node);
              staged.node.contents = null;
            }
            var released = staged.bytes.byteLength;
            staged.bytes.fill(0);
            delete stagedVideoFiles[key];
            mapOut('[DOOM 3 BFG Web] Released Bink video memory: ' + staged.path + ' (' + released + ' bytes)');
            return released;
          };
          Module['releaseMapResourcesExcept'] = function(mapName) {
            var activeName = String(mapName || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').split('/').pop().toLowerCase();
            var suffix = activeName ? '/maps/' + activeName + '.resources' : null;
            var released = 0;
            for (var key of Object.keys(stagedMapFiles)) {
              if (suffix && key.endsWith(suffix)) continue;
              var staged = stagedMapFiles[key];
              var mapNode = staged.node;
              if (mapNode && mapNode.parent) {
                delete mapNode.parent.contents[mapNode.name];
                FS.destroyNode(mapNode);
                mapNode.contents = null;
              }
              released += staged.bytes.byteLength || 0;
              if (staged.bytes && typeof staged.bytes.fill === 'function') staged.bytes.fill(0);
              delete stagedMapFiles[key];
              delete stagingPromises[key];
            }
            mapOut('[DOOM 3 BFG Web] Released old map archive references: ' + released + ' bytes');
            return released;
          };
        }
"@

$releaseMapResourcesBlock = @"
          Module['releaseMapResourcesExcept'] = function(mapName) {
            var activeName = String(mapName || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').split('/').pop().toLowerCase();
            var suffix = activeName ? '/maps/' + activeName + '.resources' : null;
            var released = 0;
            for (var key of Object.keys(stagedMapFiles)) {
              if (suffix && key.endsWith(suffix)) continue;
              var staged = stagedMapFiles[key];
              var mapNode = staged.node;
              if (mapNode && mapNode.parent) {
                delete mapNode.parent.contents[mapNode.name];
                FS.destroyNode(mapNode);
                mapNode.contents = null;
              } else {
                try { FS.unlink('/doom3_game_data/' + key); } catch (_) {}
              }
              released += staged.bytes.byteLength || 0;
              if (staged.bytes && typeof staged.bytes.fill === 'function') staged.bytes.fill(0);
              delete stagedMapFiles[key];
              delete stagingPromises[key];
            }
            mapOut('[DOOM 3 BFG Web] Released old map archive references: ' + released + ' bytes');
            return released;
          };
"@

$startupGateBlock = @'
        var runPthreadEntryPoint = function() {
          // Await mailbox notifications with `Atomics.waitAsync` so we can start
          // using the fast `Atomics.notify` notification path.
          __emscripten_thread_mailbox_await(msgData.pthread_ptr);

          if (!initializedJS) {
#if EMBIND
#if PTHREADS_DEBUG
            dbg(`worker: Pthread 0x${_pthread_self().toString(16)} initializing embind.`);
#endif
            // Embind must initialize itself on all threads, as it generates support JS.
            // We only do this once per worker since they get reused
            __embind_initialize_bindings();
#endif // EMBIND
            initializedJS = true;
          }

          try {
            {{{ awaitIf(ASYNCIFY == 2) }}}invokeEntryPoint(msgData.start_routine, msgData.arg);
          } catch(ex) {
            if (ex != 'unwind') {
              // The pthread "crashed". Do not call `_emscripten_thread_exit`; allow the
              // top-level worker handler to propagate the exception to the main thread.
              throw ex;
            }
#if RUNTIME_DEBUG
            dbg(`worker: Pthread 0x${_pthread_self().toString(16)} completed its main entry point with an 'unwind', keeping the worker alive for asynchronous operation.`);
#endif
          }
        };

        if (msgData.initialThread && Module['idbfsMountComplete'] !== true && !Module['idbfsMountPending']) {
          var missingSaveMount = Module['idbfsMountError'] || 'Initial pthread did not finish IDBFS save mount setup.';
          err('Engine worker startup failed before readiness: ' + missingSaveMount);
          if (typeof abort === 'function') abort(missingSaveMount);
          else throw new Error(missingSaveMount);
        }

        if (Module['idbfsMountPending']) {
          FS.syncfs(true, function(syncErr) {
            if (syncErr) {
              var syncDetail = String(syncErr);
              Module['idbfsMountError'] = syncDetail;
              Module['idbfsMountPending'] = false;
              err('IDBFS initial populate failed; engine entry point will not run: ' + syncDetail);
              if (typeof abort === 'function') abort('IDBFS initial populate failed: ' + syncDetail);
              else if (runtimeInitialized) __emscripten_thread_crashed();
              return;
            }
            try {
              FS.mkdirTree('/doom3_save_data/base/savegame');
              Module['idbfsMountComplete'] = true;
              Module['idbfsMountError'] = null;
              Module['idbfsMountPending'] = false;
              out('IDBFS save directory mounted and populated at /doom3_save_data; savegame directory is writable.');
              if (typeof Module['onGameWorkerReady'] === 'function') {
                Module['onGameWorkerReady']({ type: 'ready', pthreadId: msgData.pthread_ptr });
              }
              runPthreadEntryPoint();
            } catch (saveReadyErr) {
              var saveReadyDetail = String(saveReadyErr);
              Module['idbfsMountError'] = saveReadyDetail;
              Module['idbfsMountPending'] = false;
              err('IDBFS savegame directory setup failed; engine entry point will not run: ' + saveReadyDetail);
              if (typeof abort === 'function') abort('IDBFS savegame directory setup failed: ' + saveReadyDetail);
              else if (runtimeInitialized) __emscripten_thread_crashed();
            }
          });
        } else {
          if (msgData.initialThread) {
            try {
              FS.mkdirTree('/doom3_save_data/base/savegame');
              if (Module['idbfsMountComplete'] !== true) throw new Error('Initial save volume setup did not complete.');
              if (typeof Module['onGameWorkerReady'] === 'function') {
                Module['onGameWorkerReady']({ type: 'ready', pthreadId: msgData.pthread_ptr });
              }
            } catch (volatileSaveError) {
              var volatileSaveDetail = String(volatileSaveError);
              Module['idbfsMountError'] = volatileSaveDetail;
              err('Initial save directory setup failed; engine entry point will not run: ' + volatileSaveDetail);
              if (typeof abort === 'function') abort('Initial save directory setup failed: ' + volatileSaveDetail);
              else if (runtimeInitialized) __emscripten_thread_crashed();
              return;
            }
          } else {
            try { FS.mkdirTree('/doom3_save_data/base/savegame'); } catch (ignore) {}
          }
          runPthreadEntryPoint();
        }
      } else if (cmd == {{{ CMD_CHECK_MAILBOX }}}) {
'@

# Check if patch is already applied in current desired state
$appliedInPthread = (Select-String -Path $libpthread -Pattern 'stagedFiles' -Quiet) -and (Select-String -Path $libpthread -Pattern 'mapStaging' -Quiet)
$appliedInReadyHandler = Select-String -Path $libpthread -SimpleMatch -Pattern "        'onGameWorkerReady'," -Quiet
$appliedInWorkerfs = Select-String -Path $libworkerfs -Pattern 'for \(var stagedFile of' -Quiet
$contentRuntime = Get-Content -Path $runtimePthread -Raw
$appliedInMount = $contentRuntime.Contains("var mountPoint = '/doom3_game_data';") -and $contentRuntime.Contains('FS.mount(WORKERFS, { files: filesToMount }, mountPoint);') -and $contentRuntime.Contains('Staged game data mount verified on pthread ') -and $contentRuntime.Contains('var ownsSaveVolume = !!msgData.initialThread;') -and $contentRuntime.Contains('var persistSaves = msgData.persistSaves !== false') -and $contentRuntime.Contains('var mountIdbfs = ownsSaveVolume && persistSaves;') -and $contentRuntime.Contains("throw new Error('IDBFS is unavailable; refusing to start without writable saves.')") -and $contentRuntime.Contains("if (typeof abort === 'function') abort(Module['idbfsMountError']);")
$appliedInRuntime = $contentRuntime.Contains("Module['stagedFiles'] = msgData.stagedFiles;") -and $contentRuntime.Contains('idbfsMountComplete') -and $contentRuntime.Contains('var ownsSaveVolume = !!msgData.initialThread;') -and $contentRuntime.Contains("Module['onGameWorkerReady']({ type: 'ready', pthreadId: msgData.pthread_ptr });") -and $contentRuntime.Contains('Initial pthread did not finish IDBFS save mount setup.') -and $contentRuntime.Contains("Module['stageMapResources'] = async function(mapName)") -and $contentRuntime.Contains("Module['releaseMapResourcesExcept'] = function(mapName)") -and $contentRuntime.Contains("Module['stageMapLoadingImage'] = async function(mapName)") -and $contentRuntime.Contains("Module['releaseMapLoadingImage'] = function(mapName)") -and $contentRuntime.Contains("Module['stageVideoResource'] = async function(resourceName)") -and $contentRuntime.Contains("Module['releaseVideoResource'] = function(resourceName)") -and $contentRuntime.Contains('stagedVideoFiles[key] = { bytes: videoBytes, node: node, path: filePath, references: 1 };') -and $contentRuntime.Contains('stagedMapLoadingImages[basename] = { bytes: imageBytes, node: imageNode, path: relativePath };') -and $contentRuntime.Contains("headers: { Range: 'bytes=' + start + '-' + end }") -and $contentRuntime.Contains('response.status !== 206') -and $contentRuntime.Contains('FS.destroyNode(mapNode);') -and $contentRuntime.Contains('delete stagingPromises[cacheKey]') -and $contentRuntime.Contains('mapManifestPromise = null;') -and $contentRuntime.Contains("replace(/^\/+|\/+$/g") -and $contentRuntime.Contains('var traceMapStage = function(message)') -and $contentRuntime.Contains('var mapOut = function(message)') -and $contentRuntime.Contains("mapOut('[DOOM 3 BFG Web] Map staging started: ' + normalized)") -and $contentRuntime.Contains('Map archive response:') -and $contentRuntime.Contains('ArrayBuffer-backed') -and $contentRuntime.Contains('new Uint8Array(fileEntry.size)') -and $contentRuntime.Contains('node.stream_ops = Object.assign({}, WORKERFS.stream_ops') -and $contentRuntime.Contains('buffer.set(bytes.subarray(position, position + count), offset);') -and $contentRuntime.Contains("cache: 'no-store'") -and $contentRuntime.Contains('var awaitMapStage = function(operation, stage, onTimeout)') -and $contentRuntime.Contains('manifest request and parse') -and $contentRuntime.Contains('Map staging timed out during ')
$appliedInRuntime = $appliedInRuntime -and $contentRuntime.Contains("Module['persistSaves'] = persistSaves;") -and $contentRuntime.Contains('Initial save directory setup failed; engine entry point will not run:') -and $contentRuntime.Contains('Persistent saves are disabled; save files remain in volatile worker memory.')
$appliedInRuntime = $appliedInRuntime -and $contentRuntime.Contains("Module['browserDisplayState'] = msgData.browserDisplayState;") -and $contentRuntime.Contains('path: filePath, references: 1')
$appliedInMapStaging = $contentRuntime.Contains("Module['releaseMapResourcesExcept'] = function(mapName)") -and $contentRuntime.Contains("Module['stageMapLoadingImage'] = async function(mapName)") -and $contentRuntime.Contains("Module['releaseMapLoadingImage'] = function(mapName)") -and $contentRuntime.Contains("Module['stageVideoResource'] = async function(resourceName)") -and $contentRuntime.Contains("Module['releaseVideoResource'] = function(resourceName)") -and $contentRuntime.Contains('new Uint8Array(fileEntry.size)') -and $contentRuntime.Contains('staged.bytes.byteLength')
$appliedInMapStaging = $appliedInMapStaging -and $contentRuntime.Contains("var suffix = activeName ? '/maps/' + activeName + '.resources' : null;") -and $contentRuntime.Contains('if (suffix && key.endsWith(suffix)) continue;') -and -not $contentRuntime.Contains("if (!activeName) throw new Error('Invalid retained map name.');")
$appliedInMapStaging = $appliedInMapStaging -and $contentRuntime.Contains('var mapCacheMode = Number.isInteger(requestedCacheMode)') -and $contentRuntime.Contains('var readCachedMapArchive = async function(cacheRoot, entry, path)') -and $contentRuntime.Contains('var downloadMapArchive = async function(entry, path, cacheRoot)') -and $contentRuntime.Contains('var networkStarted = false;') -and $contentRuntime.Contains('Persistent map cache finalize failed for ') -and $contentRuntime.Contains('if (mapCacheMode === 3)')
$appliedInMapStaging = $appliedInMapStaging -and $contentRuntime.Contains('mapStageTotalBytes') -and $contentRuntime.Contains("Module['webMapProgressToken'] === mapStageToken")
$runtimeHelperPatterns = [ordered]@{
    stageMapResources = "Module\['stageMapResources'\] = async function\(mapName\)"
    stageVideoResource = "Module\['stageVideoResource'\] = async function\(resourceName\)"
    stageMapLoadingImage = "Module\['stageMapLoadingImage'\] = async function\(mapName\)"
    releaseMapResourcesExcept = "Module\['releaseMapResourcesExcept'\] = function\(mapName\)"
    releaseMapLoadingImage = "Module\['releaseMapLoadingImage'\] = function\(mapName\)"
    releaseVideoResource = "Module\['releaseVideoResource'\] = function\(resourceName\)"
    runPthreadEntryPoint = "var runPthreadEntryPoint = function\(\)"
}
$runtimeHelpersUnique = $true
foreach ($definition in $runtimeHelperPatterns.GetEnumerator()) {
    if ([System.Text.RegularExpressions.Regex]::Matches($contentRuntime, $definition.Value).Count -ne 1) {
        $runtimeHelpersUnique = $false
        break
    }
}
$appliedInRuntime = $appliedInRuntime -and $contentRuntime.Contains("var runPthreadEntryPoint = function() {") -and $contentRuntime.Contains("if (Module['idbfsMountPending'])") -and $contentRuntime.Contains('IDBFS initial populate failed; engine entry point will not run') -and $contentRuntime.Contains("if (typeof abort === 'function') abort(Module['idbfsMountError']);")
$contentIdbfs = Get-Content -Path $libidbfs -Raw
$appliedInIdbfs = $contentIdbfs.Contains('IDBFS auto-persist failed at ') -and $contentIdbfs.Contains("function onPersistComplete(persistError)")
$contentSyscall = Get-Content -Path $libsyscall -Raw
$fsSyscalls = @('openat', 'getdents64', 'fstat64', 'newfstatat', 'stat64', 'lstat64', 'faccessat', 'readlinkat', 'rmdir', 'mkdirat', 'unlinkat', 'renameat')
$appliedInSyscall = $true
foreach ($syscallName in $fsSyscalls) {
    if (-not $contentSyscall.Contains("  __syscall_${syscallName}__proxy: 'none',")) {
        $appliedInSyscall = $false
        break
    }
}
$contentWasi = Get-Content -Path $libwasi -Raw
$wasiFileOps = @('fd_close', 'fd_read', 'fd_pread', 'fd_seek', 'fd_filestat_get', 'fd_fdstat_get', 'fd_write')
$appliedInWasi = $true
foreach ($wasiOp in $wasiFileOps) {
    if (-not $contentWasi.Contains("  ${wasiOp}__proxy: 'none',")) {
        $appliedInWasi = $false
        break
    }
}
$appliedInMapStaging = $appliedInMapStaging -and $contentRuntime.Contains("Module['mapStaging'] = msgData.mapStaging;")
$appliedInMapStaging = $appliedInMapStaging -and $contentRuntime.Contains('var installedImage = FS.lookupPath(')
$contentEgl = Get-Content -Path $libegl -Raw
$appliedInEgl = -not [System.Text.RegularExpressions.Regex]::IsMatch($contentEgl, "(?m)^\s*egl[A-Za-z0-9_]+__proxy: 'sync',")
$contentWebgl = Get-Content -Path $libwebgl -Raw
$appliedWebglFlushSubrange = $contentWebgl.Contains('webglBufferSubData(target, mapping.offset + offset, length, mapping.mem + offset);')

if ($appliedInPthread -and $appliedInReadyHandler -and $appliedInWorkerfs -and $appliedInRuntime -and $appliedInMapStaging -and $runtimeHelpersUnique -and $appliedInIdbfs -and $appliedInSyscall -and $appliedInWasi -and $appliedInEgl -and $appliedWebglFlushSubrange -and $contentRuntime.Contains('var ownsSaveVolume') -and $contentRuntime.Contains("try {") -and $contentRuntime.Contains("FS.mkdirTree('/doom3_save_data/base/savegame');") -and (Get-Content -Path $libpthread -Raw).Contains('var isInitialThread') -and (Get-Content -Path $libpthread -Raw).Contains('msg.initialThread = true;')) {
    Write-Output "Emscripten 6.0.13 workerfs/pthread patch is already up to date."
    exit 0
}

# Apply 1: libpthread.js
$contentPthread = Get-Content -Path $libpthread -Raw
if (-not $appliedInPthread) {
    $targetPthread = "    worker.postMessage(msg, threadParams.transferList);"
    $patchPthread = @"
    if (typeof Module !== 'undefined' && Module['stagedFiles']) {
      msg.stagedFiles = Module['stagedFiles'];
    }
    if (typeof Module !== 'undefined' && Module['mapStaging']) {
      msg.mapStaging = Module['mapStaging'];
    }
    worker.postMessage(msg, threadParams.transferList);
"@
    if (-not $contentPthread.Contains($targetPthread)) {
        throw "Could not find insertion target in $libpthread"
    }
    $contentPthread = $contentPthread.Replace($targetPthread, $patchPthread)
    Set-Content -Path $libpthread -Value $contentPthread -NoNewline
}

# Apply the map-staging configuration handoff independently so existing boot
# handoff installations can be upgraded without duplicating their stagedFiles block.
$contentPthread = Get-Content -Path $libpthread -Raw
if (-not (Select-String -Path $libpthread -Pattern 'mapStaging' -Quiet)) {
    $targetPthread = "    worker.postMessage(msg, threadParams.transferList);"
    $patchPthread = @"
    if (typeof Module !== 'undefined' && Module['mapStaging']) {
      msg.mapStaging = Module['mapStaging'];
    }
$targetPthread
"@
    if (-not $contentPthread.Contains($targetPthread)) { throw "Could not find map staging handoff target in $libpthread" }
    $contentPthread = $contentPthread.Replace($targetPthread, $patchPthread)
    Set-Content -Path $libpthread -Value $contentPthread -NoNewline
}

# Tag the first pthread that is spawned so runtime_pthread.js knows which worker
# owns the shared IDBFS save volume (see the startup-deadlock note there).
$contentPthread = Get-Content -Path $libpthread -Raw
if (-not $contentPthread.Contains('msg.initialThread = true;')) {
    $mapPattern = "(?m)^    // Add to pthreads map\r?\n    PThread\.pthreads\[threadParams\.pthread_ptr\] = worker;"
    $mapReplacement = @'
    // Add to pthreads map
    var isInitialThread = Object.keys(PThread.pthreads).length === 0;
    PThread.pthreads[threadParams.pthread_ptr] = worker;
'@
    $updatedPthread = [System.Text.RegularExpressions.Regex]::Replace($contentPthread, $mapPattern, $mapReplacement, 1)
    if ($updatedPthread -ceq $contentPthread) {
        throw "Could not find the pthread spawn map in $libpthread"
    }
    $msgPattern = "(?m)^    \};\r?\n(?=#if OFFSCREENCANVAS_SUPPORT\r?\n    // Note that we do not need to quote these names)"
    $msgReplacement = @'
    };
    if (isInitialThread) {
      msg.initialThread = true;
    }
'@
    $updatedPthread2 = [System.Text.RegularExpressions.Regex]::Replace($updatedPthread, $msgPattern, $msgReplacement, 1)
    if ($updatedPthread2 -ceq $updatedPthread) {
        throw "Could not find the pthread spawn message in $libpthread"
    }
    Set-Content -Path $libpthread -Value $updatedPthread2 -NoNewline
}

# Proxy an optional named readiness callback to the owning page module. The
# generic main-thread handler dispatch already transports this callback's args.
$contentPthread = Get-Content -Path $libpthread -Raw
if (-not $contentPthread.Contains("        'onGameWorkerReady',")) {
    $readyHandlerBoundary = "(?m)^#endif\r?\n(?=#if expectToReceiveOnModule\('print'\))"
    $readyHandlerEvaluator = [System.Text.RegularExpressions.MatchEvaluator] {
        param($match)
        if ($match.Value.Contains("`r`n")) { return $match.Value + "        'onGameWorkerReady',`r`n" }
        return $match.Value + "        'onGameWorkerReady',`n"
    }
    $updatedPthread = [System.Text.RegularExpressions.Regex]::Replace($contentPthread, $readyHandlerBoundary, $readyHandlerEvaluator, 1)
    if ($updatedPthread -ceq $contentPthread) {
        throw "Could not find the onAbort/print handler boundary in $libpthread"
    }
    Set-Content -Path $libpthread -Value $updatedPthread -NoNewline
}

# Apply 2: libworkerfs.js
$contentWorkerfs = Get-Content -Path $libworkerfs -Raw
if (-not $appliedInWorkerfs) {
    $workerfsPattern = "(?m)^([ \t]*)for \(var file of \(mount\.opts\['files'\] \|\| \[\]\)\) \{\r?\n(?:[ \t]*var relPath = file\.relativePath \|\| file\.name;\r?\n)?[ \t]*WORKERFS\.createNode\(ensureParent\((?:file\.name|relPath)\), base\((?:file\.name|relPath)\), WORKERFS\.FILE_MODE, 0, file, file\.lastModifiedDate\);\r?\n"
    $patchWorkerfs = @'
$1for (var stagedFile of (mount.opts['files'] || [])) {
$1  var file = stagedFile.file || stagedFile;
$1  var relPath = stagedFile.relativePath || file.relativePath || file.name;
$1  WORKERFS.createNode(ensureParent(relPath), base(relPath), WORKERFS.FILE_MODE, 0, file, file.lastModifiedDate);
'@
    $patchWorkerfs += [Environment]::NewLine
    $updatedWorkerfs = [System.Text.RegularExpressions.Regex]::Replace($contentWorkerfs, $workerfsPattern, $patchWorkerfs, 1)
    if ($updatedWorkerfs -ceq $contentWorkerfs) {
        throw "Could not find the standard or relative-path WORKERFS file loop in $libworkerfs"
    }
    $contentWorkerfs = $updatedWorkerfs
    Set-Content -Path $libworkerfs -Value $contentWorkerfs -NoNewline
}

# Run game-data syscalls in the pthread that owns its WORKERFS mount. By default,
# Emscripten proxies these syscalls to the browser main thread, whose FS cannot
# see the per-pthread WORKERFS mount.
$syscallChanged = $false
foreach ($syscallName in $fsSyscalls) {
    $proxyProperty = "  __syscall_${syscallName}__proxy: 'none',"
    if ($contentSyscall.Contains($proxyProperty)) {
        continue
    }
    $oldProxyProperty = "  __syscall_${syscallName}__proxy: false,"
    if ($contentSyscall.Contains($oldProxyProperty)) {
        $contentSyscall = $contentSyscall.Replace($oldProxyProperty, $proxyProperty)
        $syscallChanged = $true
        continue
    }
    $targetProperty = "  __syscall_${syscallName}:"
    if (-not $contentSyscall.Contains($targetProperty)) {
        throw "Could not find syscall $syscallName in $libsyscall"
    }
    $contentSyscall = $contentSyscall.Replace($targetProperty, "$proxyProperty`r`n$targetProperty")
    $syscallChanged = $true
}
if ($syscallChanged) {
    Set-Content -Path $libsyscall -Value $contentSyscall -NoNewline
}
$wasiChanged = $false
foreach ($wasiOp in $wasiFileOps) {
    $proxyProperty = "  ${wasiOp}__proxy: 'none',"
    if ($contentWasi.Contains($proxyProperty)) {
        continue
    }
    $targetProperty = "  ${wasiOp}:"
    if (-not $contentWasi.Contains($targetProperty)) {
        throw "Could not find WASI file operation $wasiOp in $libwasi"
    }
    $contentWasi = $contentWasi.Replace($targetProperty, "$proxyProperty`r`n$targetProperty")
    $wasiChanged = $true
}
if ($wasiChanged) {
    Set-Content -Path $libwasi -Value $contentWasi -NoNewline
}
$updatedEgl = [System.Text.RegularExpressions.Regex]::Replace($contentEgl, "(?m)^(\s*egl[A-Za-z0-9_]+__proxy:) 'sync',", "`$1 'none',")
if ($updatedEgl -cne $contentEgl) {
    Set-Content -Path $libegl -Value $updatedEgl -NoNewline
}

# Apply 3: runtime_pthread.js (handles clean install, upgrade from root mount '/', or upgrade from old logger)
$contentRuntime = Get-Content -Path $runtimePthread -Raw

if (-not $appliedInMount) {
if ($contentRuntime.Contains("var mountPoint = '/doom3_game_data';") -and $contentRuntime.Contains('idbfsMountComplete')) {
    # Upgrade the existing boot mount in place so fixes to its readiness and
    # error reporting also reach already-patched SDK checkouts.
    $mountStart = $contentRuntime.IndexOf("        if (msgData.stagedFiles && typeof FS !== 'undefined' && typeof WORKERFS !== 'undefined') {")
    $mountEnd = $contentRuntime.IndexOf("        if (msgData.mapStaging && typeof FS !== 'undefined' && typeof WORKERFS !== 'undefined') {", $mountStart)
    if ($mountStart -lt 0 -or $mountEnd -le $mountStart) { throw 'Could not locate the bounded pthread mount section.' }
    $updatedRuntime = $contentRuntime.Substring(0, $mountStart) + $currentMountBlock.TrimEnd() + "`n" + $contentRuntime.Substring($mountEnd)
    if ($updatedRuntime -ceq $contentRuntime) {
        throw "Could not upgrade the existing game-data mount block in $runtimePthread"
    }
    $contentRuntime = $updatedRuntime
    Set-Content -Path $runtimePthread -Value $contentRuntime -NoNewline
} elseif ($contentRuntime.Contains("FS.mount(WORKERFS, { files: filesToMount }, '/');")) {
    # Replace old mount at '/' with dedicated mountPoint and detailed error reporting
    $oldMountRegex = "(?s)if \(msgData\.stagedFiles && typeof FS !== 'undefined' && typeof WORKERFS !== 'undefined'\) \{.*?FS\.mount\(WORKERFS, \{ files: filesToMount \}, '/'\);.*?throw new Error\('Staged game data mount failed: ' \+ e\);\s*\}\s*\}"
    $updatedRuntime = [System.Text.RegularExpressions.Regex]::Replace($contentRuntime, $oldMountRegex, $currentMountBlock.Trim())
    if ($updatedRuntime -ceq $contentRuntime) {
        throw "Could not upgrade the existing root WORKERFS mount in $runtimePthread"
    }
    $contentRuntime = $updatedRuntime
    Set-Content -Path $runtimePthread -Value $contentRuntime -NoNewline
} elseif ($contentRuntime.Contains("err('Failed to mount stagedFiles into pthread WORKERFS: ' + e);")) {
    $oldLoggerRegex = "(?s)if \(msgData\.stagedFiles && typeof FS !== 'undefined' && typeof WORKERFS !== 'undefined'\) \{.*?err\('Failed to mount stagedFiles into pthread WORKERFS: ' \+ e\);\s*\}\s*\}"
    $updatedRuntime = [System.Text.RegularExpressions.Regex]::Replace($contentRuntime, $oldLoggerRegex, $currentMountBlock.Trim())
    if ($updatedRuntime -ceq $contentRuntime) {
        throw "Could not upgrade the existing WORKERFS error handler in $runtimePthread"
    }
    $contentRuntime = $updatedRuntime
    Set-Content -Path $runtimePthread -Value $contentRuntime -NoNewline
} elseif ($contentRuntime.Contains("var mountPoint = '/doom3_game_data';")) {
    $oldMountPointRegex = "(?s)if \(msgData\.stagedFiles && typeof FS !== 'undefined' && typeof WORKERFS !== 'undefined'\) \{.*?throw new Error\('Staged game data mount failed: '[^\r\n]*\);\s*\}\s*\}"
    $updatedRuntime = [System.Text.RegularExpressions.Regex]::Replace($contentRuntime, $oldMountPointRegex, $currentMountBlock.Trim())
    if ($updatedRuntime -ceq $contentRuntime) {
        throw "Could not upgrade the existing game-data mount block in $runtimePthread"
    }
    $contentRuntime = $updatedRuntime
    Set-Content -Path $runtimePthread -Value $contentRuntime -NoNewline
} elseif (-not $appliedInRuntime) {
    $targetRuntime = "        PThread.threadInitTLS();"
    $patchRuntime = @"
        PThread.threadInitTLS();

$currentMountBlock
"@
    if (-not $contentRuntime.Contains($targetRuntime)) {
        throw "Could not find insertion target in $runtimePthread"
    }
    $contentRuntime = $contentRuntime.Replace($targetRuntime, $patchRuntime)
    Set-Content -Path $runtimePthread -Value $contentRuntime -NoNewline
}
}

$contentRuntime = Get-Content -Path $runtimePthread -Raw
$mapCallbackPattern = "(?s)        if \(msgData\.mapStaging && typeof FS !== 'undefined' && typeof WORKERFS !== 'undefined'\) \{.*?(?=        var runPthreadEntryPoint = function\(\))"
if ([System.Text.RegularExpressions.Regex]::IsMatch($contentRuntime, $mapCallbackPattern)) {
    $contentRuntime = [System.Text.RegularExpressions.Regex]::Replace($contentRuntime, $mapCallbackPattern, "$mapStagingRuntimeBlock`r`n")
} else {
    $mailboxAnchor = '        // Await mailbox notifications with `Atomics.waitAsync` so we can start'
    if (-not $contentRuntime.Contains($mailboxAnchor)) { throw "Could not find map staging insertion target in $runtimePthread" }
    $contentRuntime = $contentRuntime.Replace($mailboxAnchor, "$mapStagingRuntimeBlock`r`n$mailboxAnchor")
}
$releaseMapApiPattern = "(?s)          Module\['releaseMapResourcesExcept'\] = function\(mapName\) \{.*?          \};"
$releaseMapApiEvaluator = [System.Text.RegularExpressions.MatchEvaluator] { param($match) $releaseMapResourcesBlock.TrimEnd() }
$contentRuntime = [System.Text.RegularExpressions.Regex]::Replace($contentRuntime, $releaseMapApiPattern, $releaseMapApiEvaluator)
$gateStart = $contentRuntime.IndexOf('        var runPthreadEntryPoint = function() {')
if ($gateStart -lt 0) { $gateStart = $contentRuntime.IndexOf('        // Await mailbox notifications with `Atomics.waitAsync` so we can start') }
$gateBoundary = '      } else if (cmd == {{{ CMD_CHECK_MAILBOX }}}) {'
$gateEnd = $contentRuntime.IndexOf($gateBoundary, $gateStart)
if ($gateStart -lt 0 -or $gateEnd -le $gateStart) { throw "Could not locate the bounded pthread entry-point gate in $runtimePthread" }
$contentRuntime = $contentRuntime.Substring(0, $gateStart) + $startupGateBlock.TrimEnd() +
    $contentRuntime.Substring($gateEnd + $gateBoundary.Length)
Set-Content -Path $runtimePthread -Value $contentRuntime -NoNewline
$contentRuntime = Get-Content -Path $runtimePthread -Raw
foreach ($definition in $runtimeHelperPatterns.GetEnumerator()) {
    $definitionCount = [System.Text.RegularExpressions.Regex]::Matches($contentRuntime, $definition.Value).Count
    if ($definitionCount -ne 1) {
        throw "Expected exactly one $($definition.Key) definition in $runtimePthread; found $definitionCount."
    }
}

$contentIdbfs = Get-Content -Path $libidbfs -Raw
if (-not $contentIdbfs.Contains('IDBFS auto-persist failed at ')) {
    $persistCallback = "      function onPersistComplete() {"
    $persistCallbackWithDiagnostics = @"
      function onPersistComplete(persistError) {
        if (persistError) {
          var detail = String(persistError);
          console.error('[DOOM 3 BFG Web] IDBFS auto-persist failed at ' + mount.mountpoint + ': ' + detail);
          if (typeof Module !== 'undefined') Module['idbfsLastPersistError'] = detail;
        } else if (typeof Module !== 'undefined') {
          Module['idbfsLastPersistError'] = null;
        }
"@
    $updatedIdbfs = $contentIdbfs.Replace($persistCallback, $persistCallbackWithDiagnostics)
    if ($updatedIdbfs -ceq $contentIdbfs) {
        throw "Could not locate the IDBFS auto-persist completion callback in $libidbfs"
    }
    Set-Content -Path $libidbfs -Value $updatedIdbfs -NoNewline
}

$contentWebgl = Get-Content -Path $libwebgl -Raw
$flushMappedRangeTarget = 'webglBufferSubData(target, mapping.offset, length, mapping.mem + offset);'
$flushMappedRangeCorrected = 'webglBufferSubData(target, mapping.offset + offset, length, mapping.mem + offset);'
if (-not $contentWebgl.Contains($flushMappedRangeCorrected)) {
    if (-not $contentWebgl.Contains($flushMappedRangeTarget)) {
        throw "Could not find the explicit mapped-buffer flush upload in $libwebgl"
    }
    $contentWebgl = $contentWebgl.Replace($flushMappedRangeTarget, $flushMappedRangeCorrected)
    Set-Content -Path $libwebgl -Value $contentWebgl -NoNewline
}

Write-Output "Successfully applied Emscripten 6.0.13 workerfs/pthread patch."
