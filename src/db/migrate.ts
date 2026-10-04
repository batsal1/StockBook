import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db, pool } from './index.js';

await pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
await migrate(db, { migrationsFolder: './drizzle' });
console.log('Database is up to date');
await pool.end();
