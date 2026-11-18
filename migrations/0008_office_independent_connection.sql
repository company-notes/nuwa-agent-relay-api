-- Preserve a coworker's explicit independent choice while refreshing the office roster.
ALTER TABLE gateway_office_coworkers ADD COLUMN independent_at TEXT;
