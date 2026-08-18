export type DeploymentStatus =
  | 'QUEUED'
  | 'CLONING'
  | 'DETECTING'
  | 'BUILDING'
  | 'DEPLOYING'
  | 'HEALTHCHECK'
  | 'LIVE'
  | 'SUPERSEDED'
  | 'STOPPED'
  | 'FAILED'
  | 'CANCELLED';

const TRANSITIONS: Record<DeploymentStatus, readonly DeploymentStatus[]> = {
  QUEUED: ['CLONING', 'FAILED', 'CANCELLED'],
  CLONING: ['DETECTING', 'FAILED', 'CANCELLED'],
  DETECTING: ['BUILDING', 'FAILED', 'CANCELLED'],
  BUILDING: ['DEPLOYING', 'FAILED', 'CANCELLED'],
  DEPLOYING: ['HEALTHCHECK', 'FAILED', 'CANCELLED'],
  HEALTHCHECK: ['LIVE', 'FAILED', 'CANCELLED'],
  LIVE: ['SUPERSEDED', 'STOPPED'],
  SUPERSEDED: [],
  STOPPED: [],
  FAILED: [],
  CANCELLED: [],
};

export function canTransition(from: DeploymentStatus, to: DeploymentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Throws with a descriptive message if the transition isn't legal. */
export function assertTransition(from: DeploymentStatus, to: DeploymentStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal deployment state transition: ${from} -> ${to}`);
  }
}

export function isTerminal(status: DeploymentStatus): boolean {
  return TRANSITIONS[status].length === 0;
}
