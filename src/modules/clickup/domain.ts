export type Identity = { id: string; name: string; email: string };
export type Connection = { id: string; identity: Identity; tokens: string };
export type Task = { id: string; name: string; status: string; statusType: string; archived: boolean; assignees: string[]; due: number | null; priority: string; workspace: string; list: string; url: string };
export type Scan = { connectionId: string; page: number; tasks: Task[]; seen: string[]; complete: boolean; finished: boolean; notice: string; retrievedAt: string };
export type Confirmation = { id: string; kind: 'connect' | 'disconnect'; data: Connection | { id: string }; expected: string | null; status: string; resultId: string | null };
