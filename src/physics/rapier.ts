/**
 * Loads the Rapier physics engine (WebAssembly) once.
 * The `-compat` build embeds the wasm, so this works the same in the browser
 * and in Node. It is imported lazily so the page can show up before the
 * (large) engine has arrived.
 */
export type Rapier = typeof import('@dimforge/rapier3d-compat').default;

let loading: Promise<Rapier> | null = null;

export function loadRapier(): Promise<Rapier> {
  loading ??= import('@dimforge/rapier3d-compat').then(async (mod) => {
    await mod.default.init();
    return mod.default;
  });
  return loading;
}
