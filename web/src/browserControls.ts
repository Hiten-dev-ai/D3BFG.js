/** Browser-side input policy for the transferred SDL canvas.
 *
 * DOM keyboard and wheel events use the SDL/Emscripten path. One Escape tap is
 * recovered when a browser consumes it while releasing pointer lock.
 */
export interface BrowserControlsOptions {
  requireFullscreen?: boolean | (() => boolean);
  onError?: (message: string) => void;
}

export function installBrowserControls(
  canvas: HTMLCanvasElement,
  options: BrowserControlsOptions = {},
): () => void {
  const needsFullscreen = (): boolean => typeof options.requireFullscreen === 'function'
    ? options.requireFullscreen() : Boolean(options.requireFullscreen);
  const fullscreenGate = document.getElementById('fullscreen-gate');
  const fullscreenButton = document.getElementById('fullscreen-enter');
  const windowedButton = document.getElementById('fullscreen-windowed');
  const fullscreenMessage = document.getElementById('fullscreen-message');
  const keyboard = (navigator as Navigator & {
    keyboard?: { lock?: (keys?: string[]) => Promise<void>; unlock?: () => void };
  }).keyboard;

  let escapeHeldTimer: number | undefined;
  let escapeLockRequested = false;
  let escapeLockAcquired = false;
  let escapeLockRevision = 0;
  let escapeExitAwaitingKeyUp = false;
  let lastEscapePress = -Infinity;
  let ignoreUnlockUntil = 0;
  const onDisplayTransition = (): void => {
    ignoreUnlockUntil = performance.now() + 1200;
    if (unlockFallbackTimer !== undefined) window.clearTimeout(unlockFallbackTimer);
    unlockFallbackTimer = undefined;
    cancelEscapeHold();
  };
  let pointerWasLocked = document.pointerLockElement === canvas;
  let unlockFallbackTimer: number | undefined;
  let relativeMouseWanted = document.documentElement.dataset.doom3RelativeMouse === '1';
  let pointerLockRetryPending = false;
  let pointerLockRetryTimer: number | undefined;
  let pointerLockRequestGeneration = 0;
  let pointerLockRequestReturnsPromise = false;
  let restoreCanvasFocus = false;
  const focusGameCanvas = (): void => {
    if (document.hasFocus() && !isFullscreenGateVisible() &&
        document.documentElement.dataset.doom3Exited !== '1') {
      canvas.focus({ preventScroll: true });
    }
  };

  const requestEscapeLock = (): void => {
    if (!document.fullscreenElement || !keyboard?.lock || escapeLockRequested) return;
    escapeLockRequested = true;
    const revision = ++escapeLockRevision;
    void keyboard.lock(['Escape', 'Tab']).catch(() => keyboard.lock?.(['Escape'])).then(() => {
      // Some browsers permit locking Escape but reject the optional Tab lock.
      if (revision === escapeLockRevision && document.fullscreenElement) escapeLockAcquired = true;
    }).catch(() => {
      // Keyboard lock requires browser support and a fullscreen user gesture.
      if (revision !== escapeLockRevision) return;
      escapeLockRequested = false;
      escapeLockAcquired = false;
      options.onError?.('This browser could not lock keyboard Escape while fullscreen.');
    });
  };

  const scrollKeys = new Set([
    'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
    'PageUp', 'PageDown', 'Home', 'End',
  ]);
  const browserShortcutKeys = new Set(['F1', 'F5', 'F11', 'F12', 'Backspace', 'BrowserBack', 'BrowserForward']);

  const isFullscreenGateVisible = (): boolean =>
    Boolean(fullscreenGate && !fullscreenGate.hidden);

  const isFullscreenButtonTarget = (target: EventTarget | null): boolean =>
    target instanceof Node && Boolean(fullscreenButton?.contains(target));

  const blockGameplayInputBehindGate = (event: KeyboardEvent): void => {
    if (!isFullscreenGateVisible()) return;
    if (!needsFullscreen() && event.key === 'Escape') {
      if (fullscreenGate) fullscreenGate.hidden = true;
      canvas.focus({ preventScroll: true });
      event.preventDefault(); event.stopImmediatePropagation(); return;
    }
    if (event.key === 'Escape' && event.type === 'keyup' && escapeExitAwaitingKeyUp) return;
    if (isFullscreenButtonTarget(event.target) && (event.key === 'Enter' || event.key === ' ')) {
      // Keep the button's native activation default, but don't pass its keys to SDL.
      event.stopPropagation();
      event.stopImmediatePropagation();
      return;
    }
    if (browserShortcutKeys.has(event.key) || (event.shiftKey && event.key === 'F10')) return;
    if (event.ctrlKey || event.metaKey || event.altKey) {
      event.stopPropagation();
      event.stopImmediatePropagation();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  };

  const blockWheelBehindGate = (event: WheelEvent): void => {
    if (!isFullscreenGateVisible()) return;
    if (!event.ctrlKey && !event.metaKey && !event.altKey) event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (needsFullscreen() && fullscreenGate && !fullscreenGate.hidden) return;
    if (document.activeElement !== canvas && document.pointerLockElement !== canvas) return;

    if (scrollKeys.has(event.key)) event.preventDefault();
    if (event.isTrusted && !event.repeat && event.key !== 'Escape' && !browserShortcutKeys.has(event.key) &&
        !event.ctrlKey && !event.altKey && !event.metaKey) requestCanvasCapture(false);

    if (event.key === 'Escape') {
      if (event.repeat) {
        event.stopPropagation();
        event.stopImmediatePropagation();
        return;
      }
      lastEscapePress = performance.now();
    }
    if (event.key === 'Escape' && escapeLockAcquired) {
      // Keep the native Escape key event available to SDL while pointer-locked.
      // A deliberate hold is the browser exit path for a locked Escape key.
      event.preventDefault();
      if (escapeHeldTimer === undefined) {
        escapeHeldTimer = window.setTimeout(() => {
          escapeHeldTimer = undefined;
          escapeExitAwaitingKeyUp = true;
          keyboard?.unlock?.();
          escapeLockRequested = false;
          escapeLockAcquired = false;
          ++escapeLockRevision;
          if (document.pointerLockElement === canvas) document.exitPointerLock();
          if (document.fullscreenElement) void document.exitFullscreen();
        }, 2000);
      }
    }
  };

  const onKeyUp = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && escapeExitAwaitingKeyUp) {
      escapeExitAwaitingKeyUp = false;
      if (isFullscreenGateVisible()) fullscreenButton?.focus();
      return;
    }
    if (event.key === 'Escape' && escapeHeldTimer !== undefined) {
      window.clearTimeout(escapeHeldTimer);
      escapeHeldTimer = undefined;
    }
  };

  const onWheel = (event: WheelEvent): void => {
    // Never scroll/overscroll the page behind the native game, even when focus
    // momentarily moves during a fullscreen/menu transition. DOM dialogs may
    // scroll their own content, but must not chain into the document.
    if (event.target instanceof Element && event.target.closest('dialog[open]')) return;
    event.preventDefault();
  };

  const onRelativeMouseIntent = (event: Event): void => {
    const detail = (event as CustomEvent<{ enabled?: boolean }>).detail;
    relativeMouseWanted = detail?.enabled === true;
    document.documentElement.dataset.doom3RelativeMouse = relativeMouseWanted ? '1' : '0';
    if (!relativeMouseWanted) {
      clearPointerLockRetry();
      if (unlockFallbackTimer !== undefined) window.clearTimeout(unlockFallbackTimer);
      unlockFallbackTimer = undefined;
      if (document.pointerLockElement === canvas) document.exitPointerLock();
    } else {
      // Worker intent can arrive after the click. Try retained fullscreen
      // permission once; browser rejection leaves retry to the next gesture.
      requestCanvasCapture(!document.fullscreenElement);
    }
  };

  const requestCanvasCapture = (requireActiveGesture: boolean): void => {
    if (document.documentElement.dataset.doom3DomPointerLockReady !== '1' ||
        !relativeMouseWanted || pointerLockRetryPending || document.pointerLockElement === canvas ||
        document.documentElement.dataset.doom3InputReady !== '1' ||
        document.documentElement.dataset.doom3Exited === '1' || !document.hasFocus() ||
        document.activeElement !== canvas || isFullscreenGateVisible() ||
        (needsFullscreen() && !document.fullscreenElement)) return;
    if (requireActiveGesture && navigator.userActivation?.isActive !== true) return;
    const requestGeneration = ++pointerLockRequestGeneration;
    pointerLockRetryPending = true;
    pointerLockRetryTimer = window.setTimeout(() => {
      clearPointerLockRetry(requestGeneration);
    }, 2000);
    try {
      const request = canvas.requestPointerLock();
      if (request && typeof request.catch === 'function') {
        pointerLockRequestReturnsPromise = true;
        void request.catch(() => {
          // Escape can impose a browser cooldown. The next real game key/click
          // retries; do not steal capture or schedule automatic retry loops.
          clearPointerLockRetry(requestGeneration);
        });
      }
    } catch {
      clearPointerLockRetry(requestGeneration);
    }
  };

  const onCanvasPointerDown = (event: PointerEvent): void => {
    if (!event.isTrusted || !relativeMouseWanted || (needsFullscreen() && !document.fullscreenElement) ||
        isFullscreenGateVisible() || document.pointerLockElement === canvas) return;
    if (pointerLockRetryPending) return;
    if (document.documentElement.dataset.doom3DomPointerLockReady === '1') {
      focusGameCanvas();
      requestCanvasCapture(false);
      return;
    }

    // SDL 2.32 already retries pointer lock from its trusted canvas mousedown
    // handler when relative mode is active. Don't issue a second DOM request here.
    pointerLockRetryPending = true;
    pointerLockRetryTimer = window.setTimeout(() => {
      pointerLockRetryPending = false;
      pointerLockRetryTimer = undefined;
      if (relativeMouseWanted && document.pointerLockElement !== canvas) {
        options.onError?.('SDL did not regain pointer lock after the click. Click the game area to retry.');
      }
    }, 2000);
  };

  const clearPointerLockRetry = (requestGeneration?: number): void => {
    if (requestGeneration !== undefined && requestGeneration !== pointerLockRequestGeneration) return;
    pointerLockRetryPending = false;
    if (pointerLockRetryTimer !== undefined) {
      window.clearTimeout(pointerLockRetryTimer);
      pointerLockRetryTimer = undefined;
    }
  };

  const onPointerLockChange = (): void => {
    const locked = document.pointerLockElement === canvas;
    if (locked) {
      clearPointerLockRetry();
      if (unlockFallbackTimer !== undefined) window.clearTimeout(unlockFallbackTimer);
      unlockFallbackTimer = undefined;
      // A pending browser request can finish after the worker opens a menu.
      if (document.documentElement.dataset.doom3DomPointerLockReady === '1' &&
          (!relativeMouseWanted || document.documentElement.dataset.doom3InputReady !== '1' ||
           document.documentElement.dataset.doom3Exited === '1')) {
        pointerWasLocked = false;
        document.exitPointerLock();
        return;
      }
    }
    if (pointerWasLocked && !locked) {
      if (unlockFallbackTimer !== undefined) window.clearTimeout(unlockFallbackTimer);
      unlockFallbackTimer = undefined;
      cancelEscapeHold();
      restoreCanvasFocus = true;
      focusGameCanvas();
      // Outside keyboard-lock fullscreen, the browser may consume Escape when
      // releasing pointer lock. Deliver one native pause/back tap if it did.
      if (!escapeExitAwaitingKeyUp && performance.now() >= ignoreUnlockUntil &&
          document.documentElement.dataset.doom3DisplayTransition !== '1') unlockFallbackTimer = window.setTimeout(() => {
        unlockFallbackTimer = undefined;
        focusGameCanvas();
        if (performance.now() >= ignoreUnlockUntil && relativeMouseWanted && !document.pointerLockElement && document.hasFocus() &&
            document.documentElement.dataset.doom3InputReady === '1' &&
            performance.now() - lastEscapePress > 250 && !isFullscreenGateVisible()) {
          const key = { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true };
          canvas.dispatchEvent(new KeyboardEvent('keydown', key));
          canvas.dispatchEvent(new KeyboardEvent('keyup', key));
        }
      }, 50);
    }
    pointerWasLocked = locked;
  };

  const cancelEscapeHold = (): void => {
    if (escapeHeldTimer !== undefined) window.clearTimeout(escapeHeldTimer);
    escapeHeldTimer = undefined;
  };

  const onBlur = (): void => {
    restoreCanvasFocus = document.activeElement === canvas || pointerWasLocked;
    cancelEscapeHold();
    escapeExitAwaitingKeyUp = false;
  };
  const onFocus = (): void => {
    if (restoreCanvasFocus) focusGameCanvas();
    restoreCanvasFocus = false;
  };

  const onPointerLockError = (event: Event): void => {
    // Promise-based requests have a request-specific rejection handler above;
    // this unversioned event may belong to an older request.
    if (!pointerLockRetryPending || pointerLockRequestReturnsPromise) return;
    const errorEvent = event as Event & {
      name?: string;
      message?: string;
      error?: { name?: string; message?: string };
    };
    const name = errorEvent.error?.name ?? errorEvent.name ?? event.type;
    const message = errorEvent.error?.message ?? errorEvent.message ?? 'The browser did not expose an error message.';
    console.warn(`[DOOM 3 browser controls] SDL pointer lock retry failed (${name}): ${message}`, event);
    clearPointerLockRetry();
    options.onError?.(`Pointer lock failed (${name}): ${message}`);
  };

  const onFullscreenChange = (): void => {
    if (document.documentElement.dataset.doom3DisplayTransition === '1') onDisplayTransition();
    if (document.fullscreenElement) {
      if (fullscreenGate) fullscreenGate.hidden = true;
      requestEscapeLock();
    } else if (escapeLockRequested) {
      keyboard?.unlock?.();
      escapeLockRequested = false;
      escapeLockAcquired = false;
      ++escapeLockRevision;
      cancelEscapeHold();
    }
    if (needsFullscreen() && !document.fullscreenElement && fullscreenGate) {
      fullscreenGate.hidden = false;
      if (!escapeExitAwaitingKeyUp) fullscreenButton?.focus();
    }
    if (document.hasFocus() && !isFullscreenGateVisible()) canvas.focus({ preventScroll: true });
    if (document.fullscreenElement && relativeMouseWanted) requestCanvasCapture(false);
  };

  const enterFullscreen = (): void => {
    const fullscreenTarget = document.documentElement;
    if (!fullscreenTarget.requestFullscreen) {
      const message = 'Fullscreen is unavailable in this browser.';
      if (fullscreenMessage) fullscreenMessage.textContent = message;
      options.onError?.(message);
      return;
    }
    void fullscreenTarget.requestFullscreen().then(() => {
      canvas.focus();
      requestEscapeLock();
    }).catch(() => {
      const message = 'The browser could not enter fullscreen. Allow fullscreen for this site and try again.';
      if (fullscreenMessage) fullscreenMessage.textContent = message;
      options.onError?.(message);
    });
  };
  const continueWindowed = (): void => {
    if (fullscreenGate) fullscreenGate.hidden = true;
    canvas.focus({ preventScroll: true });
  };

  canvas.addEventListener('keydown', onKeyDown, true);
  canvas.addEventListener('keyup', onKeyUp, true);
  canvas.addEventListener('wheel', onWheel, { capture: true, passive: false });
  document.addEventListener('wheel', onWheel, { capture: true, passive: false });
  document.addEventListener('keydown', blockGameplayInputBehindGate, true);
  document.addEventListener('keyup', blockGameplayInputBehindGate, true);
  document.addEventListener('keypress', blockGameplayInputBehindGate, true);
  document.addEventListener('wheel', blockWheelBehindGate, { capture: true, passive: false });
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('doom3-display-transition', onDisplayTransition);
  document.addEventListener('doom3-relative-mouse', onRelativeMouseIntent);
  canvas.addEventListener('pointerdown', onCanvasPointerDown, true);
  document.addEventListener('pointerlockchange', onPointerLockChange);
  document.addEventListener('pointerlockerror', onPointerLockError);
  window.addEventListener('blur', onBlur);
  window.addEventListener('focus', onFocus);
  fullscreenButton?.addEventListener('click', enterFullscreen);
  windowedButton?.addEventListener('click', continueWindowed);
  if (needsFullscreen() && !document.fullscreenElement && fullscreenGate) {
    fullscreenGate.hidden = false;
    fullscreenButton?.focus();
  }
  requestEscapeLock();

  return () => {
    canvas.removeEventListener('keydown', onKeyDown, true);
    canvas.removeEventListener('keyup', onKeyUp, true);
    canvas.removeEventListener('wheel', onWheel, true);
    document.removeEventListener('wheel', onWheel, true);
    document.removeEventListener('keydown', blockGameplayInputBehindGate, true);
    document.removeEventListener('keyup', blockGameplayInputBehindGate, true);
    document.removeEventListener('keypress', blockGameplayInputBehindGate, true);
    document.removeEventListener('wheel', blockWheelBehindGate, true);
    document.removeEventListener('fullscreenchange', onFullscreenChange);
    document.removeEventListener('doom3-display-transition', onDisplayTransition);
    document.removeEventListener('doom3-relative-mouse', onRelativeMouseIntent);
    canvas.removeEventListener('pointerdown', onCanvasPointerDown, true);
    document.removeEventListener('pointerlockchange', onPointerLockChange);
    document.removeEventListener('pointerlockerror', onPointerLockError);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('focus', onFocus);
    fullscreenButton?.removeEventListener('click', enterFullscreen);
    windowedButton?.removeEventListener('click', continueWindowed);
    if (escapeHeldTimer !== undefined) window.clearTimeout(escapeHeldTimer);
    if (unlockFallbackTimer !== undefined) window.clearTimeout(unlockFallbackTimer);
    clearPointerLockRetry();
    if (escapeLockRequested) keyboard?.unlock?.();
    ++escapeLockRevision;
    escapeLockRequested = false;
    escapeLockAcquired = false;
  };
}
