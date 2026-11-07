-- Schéma de la spec, section 3.

CREATE TABLE bookings (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,           -- au moins 128 bits aléatoires, pour /acompte
  event_date TEXT NOT NULL,             -- AAAA-MM-JJ, heure de Paris
  status TEXT NOT NULL,                 -- voir la section 4 de la spec
  source TEXT NOT NULL,                 -- site, manual
  plan TEXT,
  price_cents INTEGER,
  deposit_cents INTEGER,
  client_name TEXT, client_email TEXT, client_phone TEXT,
  event_type TEXT, venue TEXT, event_hours TEXT, message TEXT,
  ip_hash TEXT,                         -- empreinte salée, pour les limites uniquement
  terms_version TEXT,                   -- version des CGV acceptée, à la date created_at
  hold_until TEXT,                      -- échéance en UTC, nulle si pas d'échéance
  stripe_session TEXT,
  stripe_session_expires TEXT,
  deposit_paid_at TEXT,
  balance_paid_at TEXT,
  notes TEXT,
  anonymized_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Seule garantie contre la double réservation. La liste des états doit rester celle de
-- ACTIVE_STATUSES (worker/bookings.ts) : test/worker/repository.test.ts vérifie l'accord
-- pour chacun des sept états.
CREATE UNIQUE INDEX one_booking_per_day ON bookings(event_date)
  WHERE status IN ('pending_review', 'awaiting_deposit', 'confirmed', 'blocked');

CREATE INDEX bookings_hold_until ON bookings(hold_until);
-- NOCASE, comme les requêtes de worker/repository.ts : une adresse compte pareil quelle que soit sa casse.
CREATE INDEX bookings_client_email ON bookings(client_email COLLATE NOCASE);
CREATE INDEX bookings_ip_hash ON bookings(ip_hash);

CREATE TABLE booking_history (
  id INTEGER PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  at TEXT NOT NULL,
  actor TEXT NOT NULL,                  -- client, owner, system, stripe
  event TEXT NOT NULL,
  detail TEXT
);

CREATE TABLE notifications (
  id INTEGER PRIMARY KEY,
  booking_id TEXT REFERENCES bookings(id),
  dedupe_key TEXT NOT NULL UNIQUE,      -- ex. b42:d-7:telegram, évite tout doublon
  channel TEXT NOT NULL,                -- email, telegram
  recipient TEXT NOT NULL,              -- owner, client
  template TEXT NOT NULL,
  due_at TEXT NOT NULL,
  sent_at TEXT,
  cancelled_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);

CREATE INDEX notifications_due_at ON notifications(due_at);

CREATE TABLE system_state (
  key TEXT PRIMARY KEY,                 -- ex. last_cron_run
  value TEXT NOT NULL
);
