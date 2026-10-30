/** Pause only audio contexts that this policy owns; never resume autoplay-blocked
 * or intentionally suspended contexts just because the browser regains focus. */
export function createFocusAudioPolicy(enabled: () => boolean, focused: () => boolean) {
  const states = new Map<AudioContext, { owned: boolean; pending: boolean; dirty: boolean }>();
  const reconcile = (context: AudioContext): void => {
    const state = states.get(context);
    if (!state) return;
    state.dirty = true;
    if (state.pending) return;
    state.pending = true;
    void (async () => {
      while (state.dirty && context.state !== 'closed') {
        state.dirty = false;
        const pause = enabled() && !focused();
        try {
          if (pause && context.state === 'running') {
            state.owned = true;
            await context.suspend();
          } else if (!pause && state.owned && context.state === 'suspended') {
            await context.resume();
            state.owned = false;
          } else if (!pause && context.state === 'running') state.owned = false;
        } catch { break; } // Retry on the next focus/gesture, not in a busy loop.
      }
    })().finally(() => { state.pending = false; if (context.state === 'closed') states.delete(context); });
  };
  return {
    register(context: AudioContext): void {
      if (states.has(context)) return;
      states.set(context, { owned: false, pending: false, dirty: false });
      context.addEventListener('statechange', () => reconcile(context));
      reconcile(context);
    },
    sync(): void { for (const context of states.keys()) reconcile(context); },
  };
}
