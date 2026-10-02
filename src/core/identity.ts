import { randomUUID } from 'node:crypto';

export type Actor = { team: string; user: string; channel: string };
export type IntegrationActor = { kind: 'integration'; team: string; integration: string };
export type WorkIdentity = Actor | IntegrationActor;
export const isIntegration = (actor: WorkIdentity): actor is IntegrationActor => 'kind' in actor && actor.kind === 'integration';
export const ownerKey = (actor: Pick<Actor, 'team' | 'user'>) => `${actor.team}:${actor.user}`;
export const workOwnerKey = (actor: WorkIdentity) => isIntegration(actor) ? `${actor.team}:integration:${actor.integration}` : ownerKey(actor);
export const uid = () => randomUUID();
