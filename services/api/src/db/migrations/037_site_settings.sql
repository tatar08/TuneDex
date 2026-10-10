-- Settings staff choose for the whole web app (Tar 2026-10-11). For now one: 'web_theme', the layout every
-- signed-in visitor of the web app gets. Changes are audited (brand.web_theme.set).
CREATE TABLE site_settings (
  key         text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  value       text NOT NULL CHECK (length(value) BETWEEN 1 AND 200),
  updated_by  uuid NOT NULL REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
