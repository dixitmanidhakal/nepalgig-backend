import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

// ── Connection Pool ───────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  // SSL for production (Contabo VPS internal - optional)
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected error on idle client', err);
});

// ── Drizzle instance ──────────────────────────────────────
export const db = drizzle(pool, {
  schema,
  logger: process.env.NODE_ENV === 'development',
});

// ── RLS context setter ────────────────────────────────────
// Call this at the start of every authenticated request
// Sets app.user_id in PostgreSQL session for RLS policies
export async function withUserContext<T>(
  userId: string,
  fn: () => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(`SET LOCAL app.user_id = '${userId}'`);
    const result = await fn();
    return result;
  } finally {
    client.release();
  }
}

// ── Type export ───────────────────────────────────────────
export type DB = typeof db;
