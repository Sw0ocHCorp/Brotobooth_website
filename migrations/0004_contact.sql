-- Rubrique de contact (docs/superpowers/specs/2026-11-11-rubrique-contact-design.md, §2 et §6) : un message du formulaire
-- et l'e-mail qui le porte au propriétaire. Seuls nom, e-mail, téléphone facultatif, message et empreinte salée de l'IP.
CREATE TABLE contact_messages (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  message TEXT NOT NULL,
  ip_hash TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX contact_messages_created_at ON contact_messages(created_at);

ALTER TABLE notifications ADD COLUMN contact_id TEXT REFERENCES contact_messages(id);
