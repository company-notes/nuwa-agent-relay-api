-- Existing rows require one authoritative refresh; unchanged sends reuse their projection.
ALTER TABLE gateway_office_coworkers ADD COLUMN identity_revision INTEGER NOT NULL DEFAULT -1;
ALTER TABLE gateway_office_coworkers ADD COLUMN identity_available INTEGER NOT NULL DEFAULT 1
  CHECK (identity_available IN (0, 1));
