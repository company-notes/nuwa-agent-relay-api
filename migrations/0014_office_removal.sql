-- Retain explicit office removal independently of partially completed enrollment.
ALTER TABLE gateway_office_coworkers ADD COLUMN removed_at TEXT;
