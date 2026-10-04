import type { FastifyPluginAsync } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { attachments } from '../db/schema.js';
import { badRequest, notFound } from '../lib/errors.js';
import { ctx } from '../lib/http.js';
import { ALLOWED_MIME, storage } from '../lib/storage.js';

const routes: FastifyPluginAsync = async (app) => {
  /** Upload a bill photo or PDF (multipart field "file"). Attach it to a bill or payment by its id. */
  app.post('/', async (req, reply) => {
    const c = ctx(req);
    const file = await req.file();
    if (!file) throw badRequest('Send the file in a multipart field named "file"');
    const ext = ALLOWED_MIME[file.mimetype];
    if (!ext) throw badRequest('Upload a JPG, PNG, WEBP, HEIC photo or a PDF');
    const data = await file.toBuffer();
    const key = await storage.put(c.shopId, ext, data);
    const [row] = await db.insert(attachments).values({
      shopId: c.shopId, filename: file.filename, mime: file.mimetype, sizeBytes: data.length, storageKey: key, uploadedBy: c.userId,
    }).returning();
    return reply.status(201).send({ id: row.id, filename: row.filename, mime: row.mime, sizeBytes: row.sizeBytes });
  });

  app.get('/', async (req) => {
    const c = ctx(req);
    return db.select({ id: attachments.id, filename: attachments.filename, mime: attachments.mime, sizeBytes: attachments.sizeBytes, createdAt: attachments.createdAt })
      .from(attachments).where(eq(attachments.shopId, c.shopId)).orderBy(desc(attachments.createdAt)).limit(200);
  });

  app.get('/:id', async (req, reply) => {
    const c = ctx(req);
    const { id } = req.params as { id: string };
    const [a] = await db.select().from(attachments).where(and(eq(attachments.id, id), eq(attachments.shopId, c.shopId)));
    if (!a) throw notFound('File');
    reply.header('Content-Type', a.mime).header('Content-Disposition', `inline; filename="${encodeURIComponent(a.filename)}"`);
    return reply.send(await storage.get(a.storageKey));
  });
};

export default routes;
