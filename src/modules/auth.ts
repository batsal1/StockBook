import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { config } from '../config.js';
import { branches, memberships, sequences, shops, users } from '../db/schema.js';
import { AppError, badRequest, conflict } from '../lib/errors.js';
import { allow, audit, ctx, parse, type Role } from '../lib/http.js';

const SHOP_TYPES = ['grocery', 'cosmetics', 'pharmacy', 'apparel', 'electronics', 'hardware', 'stationery', 'general'] as const;

const Register = z.object({
  shopName: z.string().trim().min(2),
  shopType: z.enum(SHOP_TYPES).default('general'),
  name: z.string().trim().min(2),
  email: z.string().trim().email(),
  phone: z.string().trim().optional(),
  password: z.string().min(8, 'use at least 8 characters'),
});
const Login = z.object({ email: z.string().trim().email(), password: z.string().min(1), shopId: z.string().uuid().optional() });
const Staff = z.object({ name: z.string().trim().min(2), email: z.string().trim().email(), password: z.string().min(8), role: z.enum(['manager', 'cashier']) });
const ShopPatch = z.object({
  name: z.string().trim().min(2), shopType: z.enum(SHOP_TYPES), gstin: z.string().trim().toUpperCase().nullable(), address: z.string().nullable(),
  phone: z.string().nullable(), taxInclusive: z.boolean(), roundToRupee: z.boolean(),
  openingCashPaise: z.number().int(), openingBankPaise: z.number().int(), extraFields: z.array(z.string().trim().min(1)).max(20),
  email: z.string().trim().email().nullable().or(z.literal('').transform(() => null)), invoicePrefix: z.string().trim().max(20).nullable(),
  defaultGstBps: z.number().int().min(0).max(10_000), paymentTermsDays: z.number().int().min(0).max(365), expiryWarnDays: z.number().int().min(1).max(365),
  allowNegativeStock: z.boolean(), costMethod: z.enum(['latest', 'average']), fixedAssetsPaise: z.number().int().min(0),
  nextInvoiceNumber: z.number().int().min(1), // only used together with invoicePrefix
}).partial();

const routes: FastifyPluginAsync = async (app) => {
  const sign = (userId: string, shopId: string, role: Role) => app.jwt.sign({ userId, shopId, role });

  /** Creates a shop, its main branch and the owner account in one go. */
  app.post('/register', async (req, reply) => {
    const b = parse(Register, req.body);
    const exists = await db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = lower(${b.email})`);
    if (exists.length) throw conflict('An account with this email already exists. Sign in instead.');
    const out = await db.transaction(async (tx) => {
      const [shop] = await tx.insert(shops).values({ name: b.shopName, shopType: b.shopType, phone: b.phone }).returning();
      await tx.insert(branches).values({ shopId: shop.id, name: 'Main', isDefault: true });
      const [user] = await tx.insert(users).values({ name: b.name, email: b.email, phone: b.phone, passwordHash: await bcrypt.hash(b.password, 10) }).returning();
      await tx.insert(memberships).values({ shopId: shop.id, userId: user.id, role: 'owner' });
      return { shop, user };
    });
    return reply.status(201).send({
      token: sign(out.user.id, out.shop.id, 'owner'),
      user: { id: out.user.id, name: out.user.name, email: out.user.email },
      shop: out.shop,
    });
  });

  app.post('/login', async (req) => {
    const b = parse(Login, req.body);
    const [user] = await db.select().from(users).where(sql`lower(${users.email}) = lower(${b.email})`);
    if (!user || !(await bcrypt.compare(b.password, user.passwordHash))) throw new AppError(401, 'Email or password is wrong', 'unauthorized');
    const mems = await db.select({ shopId: memberships.shopId, role: memberships.role, shopName: shops.name })
      .from(memberships).innerJoin(shops, eq(shops.id, memberships.shopId)).where(eq(memberships.userId, user.id));
    if (!mems.length) throw new AppError(403, 'This account is not part of any shop', 'forbidden');
    const m = b.shopId ? mems.find((x) => x.shopId === b.shopId) : mems[0];
    if (!m) throw badRequest('You are not a member of that shop');
    return { token: sign(user.id, m.shopId, m.role), user: { id: user.id, name: user.name, email: user.email }, shops: mems, shopId: m.shopId, role: m.role };
  });

  // signed-in routes
  app.register(async (s) => {
    s.addHook('onRequest', async (req) => {
      try { await req.jwtVerify(); } catch { throw new AppError(401, 'Sign in again to continue', 'unauthorized'); }
    });

    s.get('/me', async (req) => {
      const c = ctx(req);
      const [u] = await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(eq(users.id, c.userId));
      const [shop] = await db.select().from(shops).where(eq(shops.id, c.shopId));
      const br = await db.select().from(branches).where(eq(branches.shopId, c.shopId));
      const [seq] = await db.select().from(sequences).where(and(eq(sequences.shopId, c.shopId), eq(sequences.key, 'sale:prefix')));
      return { user: u, role: c.role, shop: { ...shop, nextInvoiceNumber: seq?.next ?? 1 }, branches: br, aiEnabled: !!config.ANTHROPIC_API_KEY };
    });

    s.patch('/shop', { preHandler: allow('owner') }, async (req) => {
      const c = ctx(req);
      const { nextInvoiceNumber, ...b } = parse(ShopPatch, req.body);
      const [shop] = Object.keys(b).length
        ? await db.update(shops).set({ ...b, invoicePrefix: b.invoicePrefix === '' ? null : b.invoicePrefix }).where(eq(shops.id, c.shopId)).returning()
        : await db.select().from(shops).where(eq(shops.id, c.shopId));
      if (nextInvoiceNumber) {
        await db.insert(sequences).values({ shopId: c.shopId, key: 'sale:prefix', next: nextInvoiceNumber })
          .onConflictDoUpdate({ target: [sequences.shopId, sequences.key], set: { next: nextInvoiceNumber } });
      }
      await audit(db, c, 'update', 'shop', c.shopId, b);
      return shop;
    });

    s.post('/branches', { preHandler: allow('owner') }, async (req, reply) => {
      const c = ctx(req);
      const b = parse(z.object({ name: z.string().trim().min(1) }), req.body);
      const [br] = await db.insert(branches).values({ shopId: c.shopId, name: b.name }).returning();
      return reply.status(201).send(br);
    });

    s.get('/staff', { preHandler: allow('owner', 'manager') }, async (req) => {
      const c = ctx(req);
      return db.select({ id: users.id, name: users.name, email: users.email, role: memberships.role, since: memberships.createdAt })
        .from(memberships).innerJoin(users, eq(users.id, memberships.userId)).where(eq(memberships.shopId, c.shopId));
    });

    /** Change a person's name or role. The owner's own role cannot be changed here, so a shop always keeps an owner. */
    s.patch('/staff/:userId', { preHandler: allow('owner') }, async (req) => {
      const c = ctx(req);
      const { userId } = req.params as { userId: string };
      const b = parse(z.object({ name: z.string().trim().min(2).optional(), role: z.enum(['owner', 'manager', 'cashier']).optional() }), req.body);
      if (userId === c.userId && b.role && b.role !== 'owner') throw badRequest('You cannot remove your own owner access');
      const [m] = await db.select().from(memberships).where(and(eq(memberships.shopId, c.shopId), eq(memberships.userId, userId)));
      if (!m) throw new AppError(404, 'User not found in this shop', 'not_found');
      if (b.role) await db.update(memberships).set({ role: b.role }).where(eq(memberships.id, m.id));
      if (b.name) await db.update(users).set({ name: b.name }).where(eq(users.id, userId));
      await audit(db, c, 'update_staff', 'user', userId, b);
      return { updated: true };
    });

    s.delete('/staff/:userId', { preHandler: allow('owner') }, async (req) => {
      const c = ctx(req);
      const { userId } = req.params as { userId: string };
      if (userId === c.userId) throw badRequest('You cannot remove yourself');
      const r = await db.delete(memberships).where(and(eq(memberships.shopId, c.shopId), eq(memberships.userId, userId))).returning();
      if (!r.length) throw new AppError(404, 'User not found in this shop', 'not_found');
      await audit(db, c, 'remove_staff', 'user', userId);
      return { removed: true };
    });

    s.post('/staff/:userId/password', { preHandler: allow('owner') }, async (req) => {
      const c = ctx(req);
      const { userId } = req.params as { userId: string };
      const { password } = parse(z.object({ password: z.string().min(8, 'use at least 8 characters') }), req.body);
      const [m] = await db.select().from(memberships).where(and(eq(memberships.shopId, c.shopId), eq(memberships.userId, userId)));
      if (!m) throw new AppError(404, 'User not found in this shop', 'not_found');
      await db.update(users).set({ passwordHash: await bcrypt.hash(password, 10) }).where(eq(users.id, userId));
      await audit(db, c, 'reset_password', 'user', userId);
      return { updated: true };
    });

    /** Anyone can change their own password. */
    s.post('/me/password', async (req) => {
      const c = ctx(req);
      const b = parse(z.object({ current: z.string().min(1), password: z.string().min(8, 'use at least 8 characters') }), req.body);
      const [u] = await db.select().from(users).where(eq(users.id, c.userId));
      if (!(await bcrypt.compare(b.current, u.passwordHash))) throw badRequest('The current password is wrong');
      await db.update(users).set({ passwordHash: await bcrypt.hash(b.password, 10) }).where(eq(users.id, c.userId));
      return { updated: true };
    });

    s.post('/staff', { preHandler: allow('owner') }, async (req, reply) => {
      const c = ctx(req);
      const b = parse(Staff, req.body);
      const out = await db.transaction(async (tx) => {
        let [user] = await tx.select().from(users).where(sql`lower(${users.email}) = lower(${b.email})`);
        if (!user) [user] = await tx.insert(users).values({ name: b.name, email: b.email, passwordHash: await bcrypt.hash(b.password, 10) }).returning();
        const [m] = await tx.select().from(memberships).where(and(eq(memberships.shopId, c.shopId), eq(memberships.userId, user.id)));
        if (m) throw conflict('This person is already part of the shop');
        await tx.insert(memberships).values({ shopId: c.shopId, userId: user.id, role: b.role });
        await audit(tx, c, 'add_staff', 'user', user.id, { role: b.role });
        return { id: user.id, name: user.name, email: user.email, role: b.role };
      });
      return reply.status(201).send(out);
    });
  });
};

export default routes;
