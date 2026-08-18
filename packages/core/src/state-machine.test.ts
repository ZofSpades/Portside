import { describe, expect, it } from 'vitest';
import {
  assertTransition,
  canTransition,
  isTerminal,
  type DeploymentStatus,
} from './state-machine.js';

const ALL_STATUSES: DeploymentStatus[] = [
  'QUEUED',
  'CLONING',
  'DETECTING',
  'BUILDING',
  'DEPLOYING',
  'HEALTHCHECK',
  'LIVE',
  'SUPERSEDED',
  'STOPPED',
  'FAILED',
  'CANCELLED',
];

const HAPPY_PATH: DeploymentStatus[] = [
  'QUEUED',
  'CLONING',
  'DETECTING',
  'BUILDING',
  'DEPLOYING',
  'HEALTHCHECK',
  'LIVE',
];

describe('canTransition', () => {
  it('allows the full happy path in order', () => {
    for (let i = 0; i < HAPPY_PATH.length - 1; i++) {
      expect(canTransition(HAPPY_PATH[i]!, HAPPY_PATH[i + 1]!)).toBe(true);
    }
  });

  it('allows any pre-LIVE stage to fail', () => {
    for (const status of [
      'QUEUED',
      'CLONING',
      'DETECTING',
      'BUILDING',
      'DEPLOYING',
      'HEALTHCHECK',
    ] as const) {
      expect(canTransition(status, 'FAILED')).toBe(true);
    }
  });

  it('allows any pre-LIVE stage to be cancelled', () => {
    for (const status of [
      'QUEUED',
      'CLONING',
      'DETECTING',
      'BUILDING',
      'DEPLOYING',
      'HEALTHCHECK',
    ] as const) {
      expect(canTransition(status, 'CANCELLED')).toBe(true);
    }
  });

  it('allows LIVE to become SUPERSEDED or STOPPED, but nothing else', () => {
    expect(canTransition('LIVE', 'SUPERSEDED')).toBe(true);
    expect(canTransition('LIVE', 'STOPPED')).toBe(true);
    expect(canTransition('LIVE', 'FAILED')).toBe(false);
    expect(canTransition('LIVE', 'CANCELLED')).toBe(false);
  });

  it('rejects skipping stages', () => {
    expect(canTransition('QUEUED', 'BUILDING')).toBe(false);
    expect(canTransition('CLONING', 'LIVE')).toBe(false);
  });

  it('rejects moving backwards', () => {
    expect(canTransition('BUILDING', 'DETECTING')).toBe(false);
    expect(canTransition('LIVE', 'HEALTHCHECK')).toBe(false);
  });

  it('rejects any transition out of every terminal state', () => {
    const terminal: DeploymentStatus[] = ['SUPERSEDED', 'STOPPED', 'FAILED', 'CANCELLED'];
    for (const from of terminal) {
      for (const to of ALL_STATUSES) {
        expect(canTransition(from, to)).toBe(false);
      }
    }
  });

  it('rejects a self-transition for every status', () => {
    for (const status of ALL_STATUSES) {
      expect(canTransition(status, status)).toBe(false);
    }
  });
});

describe('assertTransition', () => {
  it('does not throw for a legal transition', () => {
    expect(() => assertTransition('QUEUED', 'CLONING')).not.toThrow();
  });

  it('throws a descriptive error for an illegal transition', () => {
    expect(() => assertTransition('QUEUED', 'LIVE')).toThrow(
      'Illegal deployment state transition: QUEUED -> LIVE',
    );
  });
});

describe('isTerminal', () => {
  it('identifies terminal states', () => {
    for (const status of ['SUPERSEDED', 'STOPPED', 'FAILED', 'CANCELLED'] as const) {
      expect(isTerminal(status)).toBe(true);
    }
  });

  it('identifies non-terminal states', () => {
    for (const status of [
      'QUEUED',
      'CLONING',
      'DETECTING',
      'BUILDING',
      'DEPLOYING',
      'HEALTHCHECK',
      'LIVE',
    ] as const) {
      expect(isTerminal(status)).toBe(false);
    }
  });
});
