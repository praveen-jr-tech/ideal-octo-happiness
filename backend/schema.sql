-- Campus Wallet V1 local ledger. Demo data only; never load a real student roster.

CREATE TABLE IF NOT EXISTS accounts (
  id UUID PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('student', 'merchant')),
  college_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  pin_hash TEXT NOT NULL,
  email TEXT,
  email_verified_at TIMESTAMPTZ,
  pending_email TEXT,
  photo_data TEXT,
  frozen BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS email TEXT,
  ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pending_email TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS accounts_email_unique_idx
  ON accounts (email) WHERE email IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS accounts_pending_email_unique_idx
  ON accounts (pending_email) WHERE pending_email IS NOT NULL;

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS photo_data TEXT;
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS card_level TEXT NOT NULL DEFAULT 'STARROW'
    CHECK (card_level IN ('STARROW', 'FENWICK', 'EMBERFALL')),
  ADD COLUMN IF NOT EXISTS card_level_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS card_level_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS card_level_period TEXT,
  ADD COLUMN IF NOT EXISTS card_level_fallback TEXT NOT NULL DEFAULT 'STARROW'
    CHECK (card_level_fallback IN ('STARROW', 'FENWICK')),
  ADD COLUMN IF NOT EXISTS emberfall_first_started_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS ledger_entries (
  id UUID PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES accounts (id),
  amount_paise BIGINT NOT NULL,
  cost_paise BIGINT NOT NULL DEFAULT 0,
  entry_type TEXT NOT NULL,
  related_account_id UUID REFERENCES accounts (id),
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE ledger_entries
  ADD COLUMN IF NOT EXISTS cost_paise BIGINT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS ledger_entries_account_created_idx
  ON ledger_entries (account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS student_transfer_requests (
  request_id TEXT PRIMARY KEY,
  sender_id UUID NOT NULL REFERENCES accounts (id),
  recipient_id UUID NOT NULL REFERENCES accounts (id),
  amount_paise BIGINT NOT NULL CHECK (amount_paise > 0),
  fee_paise BIGINT NOT NULL CHECK (fee_paise >= 0),
  debit_entry_id UUID NOT NULL UNIQUE REFERENCES ledger_entries (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS card_level_settings (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  fenwick_semester_price_paise BIGINT NOT NULL DEFAULT 9900 CHECK (fenwick_semester_price_paise >= 0),
  fenwick_year_price_paise BIGINT NOT NULL DEFAULT 19900 CHECK (fenwick_year_price_paise >= 0),
  emberfall_first_year_price_paise BIGINT NOT NULL DEFAULT 49900 CHECK (emberfall_first_year_price_paise >= 0),
  emberfall_renewal_price_paise BIGINT NOT NULL DEFAULT 24900 CHECK (emberfall_renewal_price_paise >= 0),
  fenwick_transfer_fee_bps INTEGER NOT NULL DEFAULT 50 CHECK (fenwick_transfer_fee_bps BETWEEN 0 AND 10000),
  starrow_withdrawal_fee_bps INTEGER NOT NULL DEFAULT 200 CHECK (starrow_withdrawal_fee_bps BETWEEN 0 AND 10000),
  fenwick_withdrawal_fee_bps INTEGER NOT NULL DEFAULT 50 CHECK (fenwick_withdrawal_fee_bps BETWEEN 0 AND 10000),
  minimum_fee_paise BIGINT NOT NULL DEFAULT 200 CHECK (minimum_fee_paise >= 0),
  maximum_fee_paise BIGINT NOT NULL DEFAULT 5000 CHECK (maximum_fee_paise >= minimum_fee_paise),
  emberfall_grace_days SMALLINT NOT NULL DEFAULT 15 CHECK (emberfall_grace_days BETWEEN 7 AND 15),
  team_invites_per_leader_hour SMALLINT NOT NULL DEFAULT 10 CHECK (team_invites_per_leader_hour BETWEEN 1 AND 1000),
  team_invites_per_leader_day SMALLINT NOT NULL DEFAULT 30 CHECK (team_invites_per_leader_day BETWEEN 1 AND 5000),
  team_invites_per_recipient_leader_hour SMALLINT NOT NULL DEFAULT 3 CHECK (team_invites_per_recipient_leader_hour BETWEEN 1 AND 1000),
  team_invite_recipient_cooldown_seconds SMALLINT NOT NULL DEFAULT 60 CHECK (team_invite_recipient_cooldown_seconds BETWEEN 1 AND 3600),
  team_invites_per_recipient_day SMALLINT NOT NULL DEFAULT 5 CHECK (team_invites_per_recipient_day BETWEEN 1 AND 5000),
  team_invites_per_ip_hour SMALLINT NOT NULL DEFAULT 30 CHECK (team_invites_per_ip_hour BETWEEN 1 AND 10000),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE card_level_settings
  ADD COLUMN IF NOT EXISTS team_invites_per_leader_hour SMALLINT NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS team_invites_per_leader_day SMALLINT NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS team_invites_per_recipient_leader_hour SMALLINT NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS team_invite_recipient_cooldown_seconds SMALLINT NOT NULL DEFAULT 60,
  ADD COLUMN IF NOT EXISTS team_invites_per_recipient_day SMALLINT NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS team_invites_per_ip_hour SMALLINT NOT NULL DEFAULT 30;

INSERT INTO card_level_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS email_verification_codes (
  id UUID PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES accounts (id),
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts SMALLINT NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS email_verification_codes_account_idx
  ON email_verification_codes (account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS membership_purchases (
  request_id TEXT PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES accounts (id),
  card_level TEXT NOT NULL CHECK (card_level IN ('FENWICK', 'EMBERFALL')),
  billing_period TEXT NOT NULL CHECK (billing_period IN ('semester', 'year')),
  amount_paise BIGINT NOT NULL CHECK (amount_paise >= 0),
  starts_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  ledger_entry_id UUID NOT NULL UNIQUE REFERENCES ledger_entries (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS events (
  id UUID PRIMARY KEY,
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 2 AND 120),
  description TEXT NOT NULL DEFAULT '',
  fee_paise BIGINT NOT NULL CHECK (fee_paise > 0),
  team_size SMALLINT NOT NULL DEFAULT 1 CHECK (team_size BETWEEN 1 AND 4),
  organizer_id UUID NOT NULL REFERENCES accounts (id),
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS events_starts_at_idx ON events (starts_at);

CREATE TABLE IF NOT EXISTS event_entry_ledger (
  id UUID PRIMARY KEY,
  reference_key TEXT NOT NULL UNIQUE,
  account_id UUID NOT NULL REFERENCES accounts (id),
  entry_type TEXT NOT NULL CHECK (entry_type IN ('yearly_free', 'top_up')),
  action TEXT NOT NULL CHECK (
    action IN ('grant', 'purchase', 'consume', 'refund', 'expire')
  ),
  quantity INTEGER NOT NULL CHECK (quantity <> 0),
  cost_paise BIGINT NOT NULL DEFAULT 0,
  membership_request_id TEXT REFERENCES membership_purchases (request_id),
  registration_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS event_entry_ledger_account_created_idx
  ON event_entry_ledger (account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS event_entry_topup_requests (
  request_id TEXT PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES accounts (id),
  amount_paise BIGINT NOT NULL CHECK (amount_paise > 0),
  wallet_entry_id UUID NOT NULL UNIQUE REFERENCES ledger_entries (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS event_registrations (
  id UUID PRIMARY KEY,
  event_id UUID NOT NULL REFERENCES events (id),
  leader_account_id UUID NOT NULL REFERENCES accounts (id),
  request_id TEXT NOT NULL UNIQUE,
  team_fee_paise BIGINT NOT NULL CHECK (team_fee_paise > 0),
  paid_paise BIGINT NOT NULL CHECK (paid_paise >= 0),
  status TEXT NOT NULL DEFAULT 'registered'
    CHECK (status IN ('registered', 'cancelled')),
  team_name TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cancelled_at TIMESTAMPTZ
);

ALTER TABLE event_registrations
  ADD COLUMN IF NOT EXISTS team_name TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS event_registrations_event_status_idx
  ON event_registrations (event_id, status);

CREATE TABLE IF NOT EXISTS event_registration_members (
  id UUID PRIMARY KEY,
  registration_id UUID NOT NULL REFERENCES event_registrations (id),
  event_id UUID NOT NULL REFERENCES events (id),
  account_id UUID NOT NULL REFERENCES accounts (id),
  share_paise BIGINT NOT NULL CHECK (share_paise > 0),
  covered_paise BIGINT NOT NULL DEFAULT 0 CHECK (covered_paise >= 0),
  covered_entry_type TEXT CHECK (covered_entry_type IN ('yearly_free', 'top_up')),
  membership_request_id TEXT REFERENCES membership_purchases (request_id),
  payback_due_paise BIGINT NOT NULL DEFAULT 0 CHECK (payback_due_paise >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (registration_id, account_id)
);

CREATE INDEX IF NOT EXISTS event_registration_members_account_idx
  ON event_registration_members (account_id, event_id);

CREATE TABLE IF NOT EXISTS team_invite_attempts (
  id UUID PRIMARY KEY,
  request_id TEXT NOT NULL,
  leader_account_id UUID NOT NULL REFERENCES accounts (id),
  recipient_email TEXT NOT NULL,
  client_ip TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (request_id, recipient_email)
);

CREATE INDEX IF NOT EXISTS team_invite_attempts_leader_created_idx
  ON team_invite_attempts (leader_account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS team_invite_attempts_recipient_created_idx
  ON team_invite_attempts (recipient_email, created_at DESC);

CREATE INDEX IF NOT EXISTS team_invite_attempts_ip_created_idx
  ON team_invite_attempts (client_ip, created_at DESC);

CREATE TABLE IF NOT EXISTS team_invites (
  id UUID PRIMARY KEY,
  team_id UUID NOT NULL REFERENCES event_registrations (id),
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  share_paise BIGINT NOT NULL CHECK (share_paise > 0),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  accepted_user_id UUID REFERENCES accounts (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS team_invites_team_pending_idx
  ON team_invites (team_id, expires_at) WHERE used_at IS NULL AND revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS team_members (
  team_id UUID NOT NULL REFERENCES event_registrations (id),
  event_id UUID NOT NULL REFERENCES events (id),
  user_id UUID NOT NULL REFERENCES accounts (id),
  share_paise BIGINT NOT NULL CHECK (share_paise > 0),
  paid_paise BIGINT NOT NULL DEFAULT 0 CHECK (paid_paise >= 0 AND paid_paise <= share_paise),
  role TEXT NOT NULL CHECK (role IN ('leader', 'member')),
  payback_count SMALLINT NOT NULL DEFAULT 0 CHECK (payback_count >= 0),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (team_id, user_id),
  UNIQUE (event_id, user_id)
);

CREATE INDEX IF NOT EXISTS team_members_user_idx
  ON team_members (user_id, team_id);

CREATE TABLE IF NOT EXISTS team_payback_requests (
  request_id TEXT PRIMARY KEY,
  team_id UUID NOT NULL REFERENCES event_registrations (id),
  sender_id UUID NOT NULL REFERENCES accounts (id),
  recipient_id UUID NOT NULL REFERENCES accounts (id),
  amount_paise BIGINT NOT NULL CHECK (amount_paise > 0),
  fee_paise BIGINT NOT NULL DEFAULT 0 CHECK (fee_paise >= 0),
  sender_entry_id UUID NOT NULL UNIQUE REFERENCES ledger_entries (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS team_payback_requests_team_idx
  ON team_payback_requests (team_id, created_at DESC);

CREATE TABLE IF NOT EXISTS team_reminders (
  id UUID PRIMARY KEY,
  team_id UUID NOT NULL REFERENCES event_registrations (id),
  leader_id UUID NOT NULL REFERENCES accounts (id),
  member_id UUID NOT NULL REFERENCES accounts (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE ledger_entries
  ADD COLUMN IF NOT EXISTS team_id UUID REFERENCES event_registrations (id);

CREATE INDEX IF NOT EXISTS ledger_entries_team_idx
  ON ledger_entries (team_id, created_at DESC) WHERE team_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS membership_purchases_account_created_idx
  ON membership_purchases (account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS withdrawal_requests (
  request_id TEXT PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES accounts (id),
  amount_paise BIGINT NOT NULL CHECK (amount_paise > 0),
  fee_paise BIGINT NOT NULL CHECK (fee_paise >= 0),
  destination_type TEXT NOT NULL CHECK (destination_type IN ('bank', 'upi')),
  status TEXT NOT NULL DEFAULT 'simulated' CHECK (status = 'simulated'),
  ledger_entry_id UUID NOT NULL UNIQUE REFERENCES ledger_entries (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS qr_tokens (
  id UUID PRIMARY KEY,
  student_id UUID NOT NULL REFERENCES accounts (id),
  token TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE qr_tokens ADD COLUMN IF NOT EXISTS used_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS qr_tokens_student_idx ON qr_tokens (student_id);
CREATE INDEX IF NOT EXISTS qr_tokens_token_idx ON qr_tokens (token);

CREATE TABLE IF NOT EXISTS qr_payment_requests (
  payment_id TEXT PRIMARY KEY,
  merchant_id UUID NOT NULL REFERENCES accounts (id),
  student_id UUID NOT NULL REFERENCES accounts (id),
  qr_token_id UUID NOT NULL REFERENCES qr_tokens (id),
  amount_paise BIGINT NOT NULL CHECK (amount_paise > 0),
  student_balance_paise BIGINT NOT NULL CHECK (student_balance_paise >= 0),
  debit_entry_id UUID NOT NULL UNIQUE REFERENCES ledger_entries (id),
  credit_entry_id UUID NOT NULL UNIQUE REFERENCES ledger_entries (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS nfc_sessions (
  token_hash TEXT PRIMARY KEY,
  student_id UUID NOT NULL REFERENCES accounts (id),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS nfc_sessions_student_idx ON nfc_sessions (student_id);
CREATE INDEX IF NOT EXISTS nfc_sessions_expiry_idx ON nfc_sessions (expires_at);

CREATE OR REPLACE FUNCTION reject_ledger_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ledger_entries_append_only ON ledger_entries;
CREATE TRIGGER ledger_entries_append_only
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();

DROP TRIGGER IF EXISTS event_entry_ledger_append_only ON event_entry_ledger;
CREATE TRIGGER event_entry_ledger_append_only
  BEFORE UPDATE OR DELETE ON event_entry_ledger
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
