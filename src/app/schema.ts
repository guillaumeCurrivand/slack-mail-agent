import { coreSchema } from '../core/store.js';
import { mailSchema } from '../modules/mail/store.js';

// Old installations had only mail jobs and AI calls. Existing rows acquire the
// mail identifier when the missing column is added. Repeated runs preserve it.
export const legacyMetadataMigration = `
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS module text NOT NULL DEFAULT 'mail';
ALTER TABLE jobs ALTER COLUMN module SET DEFAULT 'core';
ALTER TABLE ai_calls ADD COLUMN IF NOT EXISTS module text NOT NULL DEFAULT 'mail';
ALTER TABLE ai_calls ALTER COLUMN module SET DEFAULT 'core';
`;

// Full schema for integration tests. Runtime initializes only enabled modules.
export const schema = coreSchema + legacyMetadataMigration + mailSchema;
