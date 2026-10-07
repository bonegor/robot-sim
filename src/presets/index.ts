import type { Blueprint } from '../core/blueprint';
import { RobotBuilder } from '../core/builder';
import { arm } from './arm';
import { dog } from './dog';
import { hexapod } from './hexapod';
import { pendulum } from './pendulum';
import { rover } from './rover';
import { snake } from './snake';

export interface Preset {
  id: string;
  name: string;
  summary: string;
  /** Keyboard hints shown while simulating. */
  controls?: string;
  build(): Blueprint;
}

/** A single plate to start building from. */
export function starter(): Blueprint {
  return new RobotBuilder('My robot', 'Start here: click a dot on the plate, then pick a part and a joint.')
    .root('body', 'plate')
    .build();
}

export const PRESETS: readonly Preset[] = [
  { id: 'dog', name: 'Dog', summary: 'Trotting quadruped. Legs follow phase-shifted waves; the tail is springy.', build: () => dog() },
  { id: 'hexapod', name: 'Hexapod', summary: 'Six legs, tripod gait. Each hip is a two-axis saddle joint.', build: () => hexapod() },
  { id: 'rover', name: 'Rover', summary: 'Four wheel motors mixed from the keyboard.', controls: 'Arrow keys / WASD to drive', build: () => rover() },
  { id: 'snake', name: 'Snake', summary: 'A travelling wave down a chain of hinges, on free-spinning wheels.', build: () => snake() },
  {
    id: 'arm',
    name: 'Robot arm',
    summary: 'Pinned arm jogged from the keyboard; the fingers dangle freely.',
    controls: 'Q/E base · W/S shoulder · A/D elbow · Z/X wrist · C/V rock',
    build: () => arm(),
  },
  { id: 'pendulum', name: 'Pendulum chain', summary: 'Only free joints: a chaotic hanging chain.', build: () => pendulum() },
  { id: 'starter', name: 'Empty plate', summary: 'Start from scratch.', build: () => starter() },
];

export function presetById(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}

export { arm, dog, hexapod, pendulum, rover, snake };
