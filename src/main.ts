import './style.css';
import { loadRapier } from './physics/rapier';
import { App } from './ui/App';
import { Viewport } from './render/Viewport';

async function main(): Promise<void> {
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  await loadRapier();
  const viewport = new Viewport($('viewport'));
  const app = new App(viewport, {
    toolbar: $('toolbar'),
    palette: $('palette'),
    inspector: $('inspector'),
    hud: $('hud'),
    hint: $('tip'),
    help: $<HTMLDialogElement>('help'),
  });
  $('loading').remove();
  // Handy for poking around from the browser console.
  (window as unknown as { app: App }).app = app;
}

main().catch((err: unknown) => {
  const el = document.getElementById('loading');
  if (el) el.textContent = `Failed to start: ${err instanceof Error ? err.message : String(err)}`;
  console.error(err);
});
