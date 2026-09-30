import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDocumentationModule } from '../src/modules/documentation/index.js';
import { DocumentationImport, approveReview } from '../src/modules/documentation/import.js';
import { importSnapshot, importConfig, resolvedImportReview } from './fixtures/documentation-import-review.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('real PostgreSQL import recovery', () => {
  const namespace = `test_import_${randomUUID().replaceAll('-', '')}`;
  let admin: pg.Pool, pool: pg.Pool;
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${namespace}`);
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${namespace}` });
    await createDocumentationModule(pool).initialize!(pool);
  });
  beforeEach(async () => { await pool.query('TRUNCATE documentation_import_effects,documentation_import_batches,documentation_projects,documentation_records CASCADE'); });
  afterAll(async () => { await pool?.end(); if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`); await admin.end(); } });
  it('serializes simultaneous batch applications on separate connections without duplicate records/history', async () => {
    const review = resolvedImportReview(), approval = approveReview(importSnapshot, review, importConfig, 'Synthetic User');
    const a = await pool.connect(), b = await pool.connect();
    try {
      const results = await Promise.all([
        new DocumentationImport(a, importConfig).apply(importSnapshot, review, approval),
        new DocumentationImport(b, importConfig).apply(importSnapshot, review, approval),
      ]);
      for (const result of results) expect(result).toMatchObject({ authoritative: true, reconciled: true, applied: 8, initialHistory: 8, relationships: 6 });
    } finally { a.release(); b.release(); }
  });
  it('retains checkpoints across a real PostgreSQL history error and resumes on another connection', async () => {
    const review = resolvedImportReview(), approval = approveReview(importSnapshot, review, importConfig, 'Synthetic User');
    await pool.query(`CREATE FUNCTION fail_import_history() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.record_kind='component' THEN RAISE EXCEPTION 'Synthetic history failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_import_history BEFORE INSERT ON documentation_record_history FOR EACH ROW EXECUTE FUNCTION fail_import_history();`);
    const a = await pool.connect();
    try {
      expect(await new DocumentationImport(a, importConfig).apply(importSnapshot, review, approval)).toMatchObject({ status: 'failed', authoritative: false, applied: 5, initialHistory: 5 });
    } finally { a.release(); await pool.query('DROP TRIGGER fail_import_history ON documentation_record_history; DROP FUNCTION fail_import_history()'); }
    const b = await pool.connect();
    try { expect(await new DocumentationImport(b, importConfig).apply(importSnapshot, review, approval)).toMatchObject({ authoritative: true, reconciled: true, applied: 8, initialHistory: 8, relationships: 6 }); }
    finally { b.release(); }
  });
});
