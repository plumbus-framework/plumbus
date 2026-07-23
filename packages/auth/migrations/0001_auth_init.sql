CREATE TABLE IF NOT EXISTS auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id text NOT NULL,
  session_ref text NOT NULL,
  session_id_hash text NOT NULL,
  user_lookup text NOT NULL,
  principal_envelope text NOT NULL,
  csrf_hash text NOT NULL,
  schema_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS auth_sessions_application_session_id_hash_idx
  ON auth_sessions (application_id, session_id_hash);
CREATE UNIQUE INDEX IF NOT EXISTS auth_sessions_application_session_ref_idx
  ON auth_sessions (application_id, session_ref);
CREATE INDEX IF NOT EXISTS auth_sessions_application_user_created_idx
  ON auth_sessions (application_id, user_lookup, created_at);
CREATE INDEX IF NOT EXISTS auth_sessions_expires_at_idx
  ON auth_sessions (expires_at);

CREATE TABLE IF NOT EXISTS auth_login_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id text NOT NULL,
  state_hash text NOT NULL,
  browser_binding_hash text NOT NULL,
  provider_id text NOT NULL,
  payload_envelope text NOT NULL,
  schema_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS auth_login_transactions_application_state_hash_idx
  ON auth_login_transactions (application_id, state_hash);
CREATE INDEX IF NOT EXISTS auth_login_transactions_application_binding_created_idx
  ON auth_login_transactions (application_id, browser_binding_hash, created_at);
CREATE INDEX IF NOT EXISTS auth_login_transactions_expires_at_idx
  ON auth_login_transactions (expires_at);
