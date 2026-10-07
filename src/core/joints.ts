/**
 * Joint catalog: nature-inspired joints plus a few purely robotic ones.
 *
 * Joint frame
 * -----------
 * A joint lives at the parent's snap point. Its frame is built from that snap:
 *
 *   Z  = the snap normal (points from the parent into the child)
 *   Y  = the snap "up" direction, rotated about Z by the joint's `angle`
 *   X  = Y × Z  (the "side" axis)
 *
 * so a hinge always bends about X, a pivot / wheel turns about Z (the line of
 * the connection, i.e. along the bone), and a slider extends along Z.
 *
 * Every joint type exposes a list of degrees of freedom (DOFs). Each DOF gets
 * its own drive (see `drives.ts`): it can hang free, act as a passive spring,
 * or follow a signal as a servo (angle) or motor (speed).
 */
import { rad } from './math';

export type JointType =
  | 'weld'
  | 'hinge'
  | 'pivot'
  | 'ball'
  | 'saddle'
  | 'condyloid'
  | 'gliding'
  | 'spine'
  | 'wheel'
  | 'slider';

export type DofAxis = 'angX' | 'angY' | 'angZ' | 'linX' | 'linY' | 'linZ';

export interface DofDef {
  /** Stable key used in blueprints and expressions, e.g. `knee.bend`. */
  name: string;
  label: string;
  axis: DofAxis;
  kind: 'angular' | 'linear';
  /** Default range (radians or metres); `null` means unlimited / continuous. */
  limits: [number, number] | null;
}

export type DefaultDriveMode = 'free' | 'spring';

export interface JointTypeDef {
  type: JointType;
  label: string;
  family: 'natural' | 'robotic';
  /** Where this joint shows up in a body. */
  analog: string;
  description: string;
  dofs: DofDef[];
  /** Drive given to every DOF of a freshly placed joint. */
  defaultDrive: DefaultDriveMode;
}

const bend = (lo: number, hi: number): DofDef => ({
  name: 'bend',
  label: 'Bend (about the side axis)',
  axis: 'angX',
  kind: 'angular',
  limits: [rad(lo), rad(hi)],
});
const swing = (lo: number, hi: number): DofDef => ({
  name: 'swing',
  label: 'Swing (about the up axis)',
  axis: 'angY',
  kind: 'angular',
  limits: [rad(lo), rad(hi)],
});
const twist = (lo: number, hi: number): DofDef => ({
  name: 'twist',
  label: 'Twist (about the connection axis)',
  axis: 'angZ',
  kind: 'angular',
  limits: [rad(lo), rad(hi)],
});

export const JOINT_TYPES: Readonly<Record<JointType, JointTypeDef>> = {
  weld: {
    type: 'weld',
    label: 'Weld',
    family: 'natural',
    analog: 'Fibrous joint: skull sutures, fused bones',
    description: 'Rigid bond. The two parts behave as one.',
    dofs: [],
    defaultDrive: 'free',
  },
  hinge: {
    type: 'hinge',
    label: 'Hinge',
    family: 'natural',
    analog: 'Elbow, knee, finger joints',
    description: 'Bends back and forth about one axis across the connection.',
    dofs: [bend(-135, 135)],
    defaultDrive: 'free',
  },
  pivot: {
    type: 'pivot',
    label: 'Pivot',
    family: 'natural',
    analog: 'Neck (atlas–axis), forearm rotation',
    description: 'Rotates about the line of the connection, like turning your head.',
    dofs: [twist(-90, 90)],
    defaultDrive: 'free',
  },
  ball: {
    type: 'ball',
    label: 'Ball & socket',
    family: 'natural',
    analog: 'Hip, shoulder',
    description: 'Bends, swings and twists: three rotational degrees of freedom.',
    dofs: [bend(-100, 100), swing(-60, 60), twist(-45, 45)],
    defaultDrive: 'free',
  },
  saddle: {
    type: 'saddle',
    label: 'Saddle',
    family: 'natural',
    analog: 'Base of the thumb (also: universal / Cardan joint)',
    description: 'Bends and swings on two perpendicular axes, but cannot twist.',
    dofs: [bend(-60, 60), swing(-60, 60)],
    defaultDrive: 'free',
  },
  condyloid: {
    type: 'condyloid',
    label: 'Condyloid',
    family: 'natural',
    analog: 'Wrist, knuckles',
    description: 'Like a saddle, but the second axis only rocks a little.',
    dofs: [bend(-80, 80), swing(-25, 25)],
    defaultDrive: 'free',
  },
  gliding: {
    type: 'gliding',
    label: 'Gliding',
    family: 'natural',
    analog: 'Plane joints between wrist and ankle bones',
    description: 'The parts slide a little across each other without rotating.',
    dofs: [
      { name: 'shift_side', label: 'Shift sideways', axis: 'linX', kind: 'linear', limits: [-0.02, 0.02] },
      { name: 'shift_up', label: 'Shift up/down', axis: 'linY', kind: 'linear', limits: [-0.02, 0.02] },
    ],
    defaultDrive: 'free',
  },
  spine: {
    type: 'spine',
    label: 'Spine disc',
    family: 'natural',
    analog: 'Cartilaginous joint: intervertebral discs',
    description: 'Springy joint that flexes a little in every direction. Chain several for a spine or tail.',
    dofs: [bend(-25, 25), swing(-25, 25), twist(-10, 10)],
    defaultDrive: 'spring',
  },
  wheel: {
    type: 'wheel',
    label: 'Axle',
    family: 'robotic',
    analog: 'Wheel hub / motor shaft (rare in nature: bacterial flagella)',
    description: 'Spins forever about the connection axis. Give it a motor to drive a wheel.',
    dofs: [{ name: 'spin', label: 'Spin', axis: 'angZ', kind: 'angular', limits: null }],
    defaultDrive: 'free',
  },
  slider: {
    type: 'slider',
    label: 'Slider',
    family: 'robotic',
    analog: 'Linear actuator / piston (in nature: a muscle contracting)',
    description: 'Extends and retracts along the connection axis.',
    dofs: [{ name: 'slide', label: 'Extension', axis: 'linZ', kind: 'linear', limits: [-0.05, 0.15] }],
    defaultDrive: 'free',
  },
};

export const JOINT_TYPE_LIST: readonly JointTypeDef[] = Object.values(JOINT_TYPES);

export function isJointType(value: unknown): value is JointType {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(JOINT_TYPES, value);
}

export function getJointType(type: JointType): JointTypeDef {
  const def = JOINT_TYPES[type];
  if (!def) throw new Error(`Unknown joint type "${type}"`);
  return def;
}

export function findDof(type: JointType, dofName: string): DofDef | undefined {
  return getJointType(type).dofs.find((d) => d.name === dofName);
}

/** Index of each DOF axis in Rapier's `JointAxis` enum (LinX..AngZ = 0..5). */
export const AXIS_INDEX: Readonly<Record<DofAxis, number>> = {
  linX: 0,
  linY: 1,
  linZ: 2,
  angX: 3,
  angY: 4,
  angZ: 5,
};
