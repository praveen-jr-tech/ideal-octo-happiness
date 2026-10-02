-- Campus Wallet V1 local ledger. Demo data only; never load a real student roster.

CREATE TABLE IF NOT EXISTS accounts (
  id UUID PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('student', 'merchant')),
  college_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  pin_hash TEXT NOT NULL,
  photo_data TEXT,
  frozen BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS photo_data TEXT;

CREATE TABLE IF NOT EXISTS ledger_entries (
  id UUID PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES accounts (id),
  amount_paise BIGINT NOT NULL,
  entry_type TEXT NOT NULL,
  related_account_id UUID REFERENCES accounts (id),
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ledger_entries_account_created_idx
  ON ledger_entries (account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS qr_tokens (
  id UUID PRIMARY KEY,
  student_id UUID NOT NULL REFERENCES accounts (id),
  token TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS qr_tokens_student_idx ON qr_tokens (student_id);
CREATE INDEX IF NOT EXISTS qr_tokens_token_idx ON qr_tokens (token);
