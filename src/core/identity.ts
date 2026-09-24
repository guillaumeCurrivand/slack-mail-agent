import { randomUUID } from 'node:crypto';

export type Actor = { team: string; user: string; channel: string };
export const ownerKey = (actor: Pick<Actor, 'team' | 'user'>) => `${actor.team}:${actor.user}`;
export const uid = () => randomUUID();
