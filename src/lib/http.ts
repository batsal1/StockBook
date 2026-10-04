import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { badRequest, forbidden } from './errors.js';
import { auditLogs, branches } from '../db/schema.js';
import type { Tx } from '../db/index.js';

export type Role = 'owner' | 'manager' | 'cashier';
export interface Ctx { userId: string; shopId: string; role: Role }

declare module '@fastify/jwt' {
  interface FastifyJWT { payload: Ctx; user: Ctx }
}

/** Validate input with a zod schema; turns failures into a readable 400. */
export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const first = r.error.issues[0];
    throw badRequest(`${first.path.join('.') || 'input'}: ${first.message}`, r.error.issues);
  }
  return r.data;
}

export function ctx(req: FastifyRequest): Ctx {
  return req.user;
}

/** Route guard: `preHandler: allow('owner', 'manager')`. */
export const allow = (...roles: Role[]) => async (req: FastifyRequest, _reply: FastifyReply) => {
  if (!roles.includes(req.user.role)) throw forbidden();
};

export async function defaultBranchId(tx: Tx, shopId: string, branchId?: string | null): Promise<string> {
  if (branchId) {
    const [b] = await tx.select({ id: branches.id }).from(branches).where(and(eq(branches.id, branchId), eq(branches.shopId, shopId)));
    if (!b) throw badRequest('Unknown branch');
    return b.id;
  }
  const [b] = await tx.select({ id: branches.id }).from(branches).where(and(eq(branches.shopId, shopId), eq(branches.isDefault, true)));
  if (!b) throw badRequest('This shop has no default branch');
  return b.id;
}

export async function audit(tx: Tx, c: Ctx, action: string, entity: string, entityId: string | null, data?: unknown) {
  await tx.insert(auditLogs).values({ shopId: c.shopId, userId: c.userId, action, entity, entityId, data: data as object });
}

export const today = () => new Date().toISOString().slice(0, 10);
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD');
export const month = z.string().regex(/^\d{4}-\d{2}$/, 'use YYYY-MM');
export const paise = z.number().int().min(0);
export const uuidS = z.string().uuid();

/** First and last day of a YYYY-MM month. */
export function monthRange(m: string): [string, string] {
  const [y, mo] = m.split('-').map(Number);
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return [`${m}-01`, `${m}-${String(last).padStart(2, '0')}`];
}
