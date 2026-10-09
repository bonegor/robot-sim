import type { Blueprint } from '../core/blueprint';
import { RobotBuilder } from '../core/builder';
import { arm } from './arm';
import { balancer } from './balancer';
import { dog } from './dog';
import { hexapod } from './hexapod';
import { pendulum } from './pendulum';
import { rover } from './rover';
import { salamander } from './salamander';
import { snake } from './snake';
import { spider } from './spider';
import { WALKER_CONTROLS } from './walker';

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
  {
    id: 'dog',
    name: 'Dog',
    summary: 'Steerable trotting quadruped: a shared gait clock, sliding paws to turn, balance reflexes and a springy tail.',
    controls: WALKER_CONTROLS,
    build: () => dog(),
  },
  {
    id: 'spider',
    name: 'Spider',
    summary: 'Eight-legged arachnid walking an alternating tetrapod gait; it can spin on the spot.',
    controls: WALKER_CONTROLS,
    build: () => spider(),
  },
  {
    id: 'salamander',
    name: 'Salamander',
    summary: 'Sprawling quadruped: its spine and tail swing in a wave locked to the steps, which lengthens its stride.',
    controls: WALKER_CONTROLS,
    build: () => salamander(),
  },
  { id: 'hexapod', name: 'Hexapod', summary: 'Six legs, tripod gait. Each hip is a two-axis saddle joint.', build: () => hexapod() },
  { id: 'rover', name: 'Rover', summary: 'Four wheel motors mixed from the keyboard.', controls: 'Arrow keys / WASD to drive', build: () => rover() },
  {
    id: 'balancer',
    name: 'Balancer',
    summary: 'Two-wheeled inverted pendulum that keeps itself upright with a feedback loop on its pitch sensor.',
    controls: '↑/↓ or W/S drive · ←/→ or A/D turn · click it to give it a shove',
    build: () => balancer(),
  },
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

export { arm, balancer, dog, hexapod, pendulum, rover, salamander, snake, spider };
