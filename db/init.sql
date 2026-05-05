-- ============================================================
-- NEPALGIG - Phase 1 Database Init
-- PostgreSQL 15 | RLS enabled | Magic Link Auth
-- Run: psql -U postgres -f init.sql
-- ============================================================

-- ============================================================
-- EXTENSIONS
-- ============================================================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "citext";    -- case-insensitive email

-- ============================================================
-- DATABASE ROLES (for RLS)
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
END
$$;

-- ============================================================
-- ENUMS
-- ============================================================
DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('pending', 'freelancer', 'client', 'admin');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE gig_status AS ENUM ('draft', 'pending_review', 'active', 'paused', 'funded', 'completed', 'disputed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE proposal_status AS ENUM ('pending', 'accepted', 'rejected', 'withdrawn', 'completed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE payment_status AS ENUM ('pending', 'escrowed', 'released', 'refunded', 'disputed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE token_type AS ENUM ('magic_link', 'email_verify', 'password_reset');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================
-- TABLE: users
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Contact (phone is required, email optional for magic links)
  phone           VARCHAR(20)  UNIQUE,                    -- +977XXXXXXXXXX format
  email           CITEXT       UNIQUE,                    -- optional

  -- Role management (LOCKED - no self-promotion)
  role            user_role    NOT NULL DEFAULT 'pending',
  role_locked     BOOLEAN      NOT NULL DEFAULT TRUE,     -- prevents client-side role change

  -- Identity & Security
  full_name       VARCHAR(100),
  display_name    VARCHAR(50),
  avatar_url      TEXT,
  device_hash     VARCHAR(64),                            -- SHA-256 of device fingerprint

  -- Abuse Prevention
  banned          BOOLEAN      NOT NULL DEFAULT FALSE,
  ban_reason      TEXT,
  ban_expires_at  TIMESTAMPTZ,
  failed_attempts INTEGER      NOT NULL DEFAULT 0,
  last_failed_at  TIMESTAMPTZ,

  -- Nepal-specific
  district        VARCHAR(50),
  province        SMALLINT     CHECK (province BETWEEN 1 AND 7),
  nid_verified    BOOLEAN      NOT NULL DEFAULT FALSE,    -- National ID verified (Phase 2)

  -- Freelancer profile (populated when role='freelancer')
  skills          TEXT[]       DEFAULT '{}',
  bio             TEXT,
  hourly_rate_npr INTEGER,                               -- in NPR paisa (× 100)
  portfolio_urls  TEXT[]       DEFAULT '{}',

  -- Stats (denormalized for performance)
  total_earned_npr BIGINT      NOT NULL DEFAULT 0,       -- in paisa
  total_spent_npr  BIGINT      NOT NULL DEFAULT 0,       -- in paisa
  rating_avg      NUMERIC(3,2) CHECK (rating_avg BETWEEN 1 AND 5),
  rating_count    INTEGER      NOT NULL DEFAULT 0,

  -- Timestamps
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  last_seen_at    TIMESTAMPTZ,
  email_verified_at TIMESTAMPTZ,
  phone_verified_at TIMESTAMPTZ
);

-- Indexes on users
CREATE INDEX IF NOT EXISTS idx_users_phone      ON users(phone);
CREATE INDEX IF NOT EXISTS idx_users_email      ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role       ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_device_hash ON users(device_hash);
CREATE INDEX IF NOT EXISTS idx_users_banned     ON users(banned) WHERE banned = TRUE;
CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at DESC);

-- ============================================================
-- TABLE: magic_tokens (Auth - No SMS Phase 1)
-- ============================================================
CREATE TABLE IF NOT EXISTS magic_tokens (
  id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID        REFERENCES users(id) ON DELETE CASCADE,

  -- Token details
  token_hash  VARCHAR(64) NOT NULL UNIQUE,               -- SHA-256 of raw token
  token_type  token_type  NOT NULL DEFAULT 'magic_link',

  -- Delivery
  email       CITEXT,                                    -- where link was sent
  phone       VARCHAR(20),                               -- for future SMS

  -- Security
  ip_address  INET,
  user_agent  TEXT,
  device_hash VARCHAR(64),

  -- State
  used        BOOLEAN     NOT NULL DEFAULT FALSE,
  used_at     TIMESTAMPTZ,
  attempts    SMALLINT    NOT NULL DEFAULT 0,            -- brute force guard

  -- Expiry (15 minutes for magic links)
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '15 minutes'),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_magic_tokens_token_hash  ON magic_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_magic_tokens_user_id     ON magic_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_magic_tokens_email       ON magic_tokens(email);
CREATE INDEX IF NOT EXISTS idx_magic_tokens_expires_at  ON magic_tokens(expires_at);
-- Partial index: only valid unused tokens
CREATE INDEX IF NOT EXISTS idx_magic_tokens_valid       ON magic_tokens(token_hash, expires_at)
  WHERE used = FALSE AND expires_at > NOW();

-- ============================================================
-- TABLE: sessions
-- ============================================================
CREATE TABLE IF NOT EXISTS sessions (
  id            UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  session_token VARCHAR(64) NOT NULL UNIQUE,             -- SHA-256 of raw token

  -- Security context
  ip_address    INET,
  user_agent    TEXT,
  device_hash   VARCHAR(64),

  -- State
  revoked       BOOLEAN     NOT NULL DEFAULT FALSE,
  revoked_at    TIMESTAMPTZ,
  revoke_reason TEXT,

  -- Expiry (30 days)
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days'),
  last_active   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_token      ON sessions(session_token) WHERE revoked = FALSE;
CREATE INDEX IF NOT EXISTS idx_sessions_user_id    ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

-- ============================================================
-- TABLE: gigs
-- ============================================================
CREATE TABLE IF NOT EXISTS gigs (
  id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id       UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

  -- Gig details
  title           VARCHAR(150) NOT NULL,
  description     TEXT         NOT NULL,
  category        VARCHAR(50)  NOT NULL,
  subcategory     VARCHAR(50),
  tags            TEXT[]       DEFAULT '{}',

  -- Budget (in NPR paisa × 100 for precision)
  budget_min_npr  INTEGER      NOT NULL CHECK (budget_min_npr > 0),
  budget_max_npr  INTEGER      NOT NULL CHECK (budget_max_npr >= budget_min_npr),
  budget_type     VARCHAR(20)  NOT NULL DEFAULT 'fixed' CHECK (budget_type IN ('fixed','hourly')),

  -- Timeline
  deadline        DATE,
  duration_days   INTEGER      CHECK (duration_days > 0),

  -- Status & Visibility
  status          gig_status   NOT NULL DEFAULT 'draft',
  is_funded       BOOLEAN      NOT NULL DEFAULT FALSE,   -- escrow funded
  funded_at       TIMESTAMPTZ,

  -- Accepted proposal (set when gig moves to 'funded')
  accepted_proposal_id UUID,                              -- FK added after proposals table

  -- Nepal-specific
  location_type   VARCHAR(20)  DEFAULT 'remote' CHECK (location_type IN ('remote','onsite','hybrid')),
  district        VARCHAR(50),
  province        SMALLINT     CHECK (province BETWEEN 1 AND 7),

  -- Abuse prevention
  flagged         BOOLEAN      NOT NULL DEFAULT FALSE,
  flag_reason     TEXT,
  admin_notes     TEXT,

  -- Stats
  proposal_count  INTEGER      NOT NULL DEFAULT 0,
  view_count      INTEGER      NOT NULL DEFAULT 0,

  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  published_at    TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ  DEFAULT (NOW() + INTERVAL '30 days')
);

CREATE INDEX IF NOT EXISTS idx_gigs_client_id   ON gigs(client_id);
CREATE INDEX IF NOT EXISTS idx_gigs_status      ON gigs(status);
CREATE INDEX IF NOT EXISTS idx_gigs_category    ON gigs(category);
CREATE INDEX IF NOT EXISTS idx_gigs_is_funded   ON gigs(is_funded);
CREATE INDEX IF NOT EXISTS idx_gigs_created_at  ON gigs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gigs_budget      ON gigs(budget_min_npr, budget_max_npr);
-- Full-text search index
CREATE INDEX IF NOT EXISTS idx_gigs_fts         ON gigs USING GIN (
  to_tsvector('english', title || ' ' || description || ' ' || array_to_string(tags, ' '))
);

-- ============================================================
-- TABLE: proposals
-- ============================================================
CREATE TABLE IF NOT EXISTS proposals (
  id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  gig_id          UUID        NOT NULL REFERENCES gigs(id) ON DELETE CASCADE,
  freelancer_id   UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

  -- Bid details
  bid_amount_npr  INTEGER     NOT NULL CHECK (bid_amount_npr > 0),  -- paisa
  bid_type        VARCHAR(20) NOT NULL DEFAULT 'fixed' CHECK (bid_type IN ('fixed','hourly')),
  cover_letter    TEXT        NOT NULL,
  estimated_days  INTEGER     CHECK (estimated_days > 0),

  -- Status
  status          proposal_status NOT NULL DEFAULT 'pending',

  -- Milestones (JSONB for flexibility)
  milestones      JSONB       DEFAULT '[]',
  /*
    milestones format:
    [
      { "title": "Design mockup", "amount_npr": 5000, "due_days": 3, "completed": false },
      ...
    ]
  */

  -- Attachment references
  portfolio_items TEXT[]      DEFAULT '{}',

  -- Timestamps
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accepted_at     TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,

  -- Prevent duplicate proposals
  UNIQUE(gig_id, freelancer_id)
);

CREATE INDEX IF NOT EXISTS idx_proposals_gig_id        ON proposals(gig_id);
CREATE INDEX IF NOT EXISTS idx_proposals_freelancer_id ON proposals(freelancer_id);
CREATE INDEX IF NOT EXISTS idx_proposals_status        ON proposals(status);
CREATE INDEX IF NOT EXISTS idx_proposals_created_at    ON proposals(created_at DESC);

-- Add FK for accepted_proposal_id in gigs (after proposals table exists)
ALTER TABLE gigs ADD CONSTRAINT fk_gigs_accepted_proposal
  FOREIGN KEY (accepted_proposal_id) REFERENCES proposals(id) ON DELETE SET NULL;

-- ============================================================
-- TABLE: escrow_payments
-- ============================================================
CREATE TABLE IF NOT EXISTS escrow_payments (
  id                UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  gig_id            UUID          NOT NULL REFERENCES gigs(id) ON DELETE RESTRICT,
  proposal_id       UUID          NOT NULL REFERENCES proposals(id) ON DELETE RESTRICT,
  client_id         UUID          NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  freelancer_id     UUID          NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

  -- Amounts (paisa)
  gross_amount_npr  INTEGER       NOT NULL CHECK (gross_amount_npr > 0),
  platform_fee_npr  INTEGER       NOT NULL DEFAULT 0,     -- 5% of gross
  net_amount_npr    INTEGER       NOT NULL,               -- gross - platform_fee

  -- Payment method (Phase 1: manual bank transfer)
  payment_method    VARCHAR(30)   DEFAULT 'bank_transfer',
  payment_ref       VARCHAR(100),                         -- bank reference
  payment_proof_url TEXT,                                 -- uploaded screenshot

  -- Status
  status            payment_status NOT NULL DEFAULT 'pending',

  -- Timestamps
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  escrowed_at       TIMESTAMPTZ,
  released_at       TIMESTAMPTZ,
  refunded_at       TIMESTAMPTZ,

  -- Admin
  admin_notes       TEXT,
  verified_by       UUID REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_escrow_gig_id       ON escrow_payments(gig_id);
CREATE INDEX IF NOT EXISTS idx_escrow_client_id    ON escrow_payments(client_id);
CREATE INDEX IF NOT EXISTS idx_escrow_freelancer_id ON escrow_payments(freelancer_id);
CREATE INDEX IF NOT EXISTS idx_escrow_status       ON escrow_payments(status);

-- ============================================================
-- TABLE: reviews
-- ============================================================
CREATE TABLE IF NOT EXISTS reviews (
  id            UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  gig_id        UUID        NOT NULL REFERENCES gigs(id) ON DELETE CASCADE,
  proposal_id   UUID        NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  reviewer_id   UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reviewee_id   UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  rating        SMALLINT    NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment       TEXT,

  -- Prevent duplicate reviews per gig-pair
  UNIQUE(gig_id, reviewer_id, reviewee_id),

  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reviews_reviewee_id ON reviews(reviewee_id);
CREATE INDEX IF NOT EXISTS idx_reviews_gig_id      ON reviews(gig_id);

-- ============================================================
-- TABLE: abuse_logs (Anti-abuse audit trail)
-- ============================================================
CREATE TABLE IF NOT EXISTS abuse_logs (
  id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID        REFERENCES users(id) ON DELETE SET NULL,

  event_type  VARCHAR(50) NOT NULL,  -- 'ban', 'flag_gig', 'spam_detect', 'rate_limit', etc.
  target_type VARCHAR(30),           -- 'user', 'gig', 'proposal', 'token'
  target_id   UUID,

  ip_address  INET,
  device_hash VARCHAR(64),
  details     JSONB       DEFAULT '{}',

  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_abuse_logs_user_id    ON abuse_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_abuse_logs_ip_address ON abuse_logs(ip_address);
CREATE INDEX IF NOT EXISTS idx_abuse_logs_event_type ON abuse_logs(event_type);
CREATE INDEX IF NOT EXISTS idx_abuse_logs_created_at ON abuse_logs(created_at DESC);

-- ============================================================
-- TABLE: rate_limits (Token bucket per IP/user)
-- ============================================================
CREATE TABLE IF NOT EXISTS rate_limits (
  id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  key         VARCHAR(100) NOT NULL UNIQUE,  -- 'ip:1.2.3.4:magic_link' or 'user:uuid:action'
  tokens      INTEGER     NOT NULL DEFAULT 10,
  last_refill TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_key ON rate_limits(key);

-- ============================================================
-- ENABLE ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE users           ENABLE ROW LEVEL SECURITY;
ALTER TABLE magic_tokens    ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions        ENABLE ROW LEVEL SECURITY;
ALTER TABLE gigs            ENABLE ROW LEVEL SECURITY;
ALTER TABLE proposals       ENABLE ROW LEVEL SECURITY;
ALTER TABLE escrow_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE reviews         ENABLE ROW LEVEL SECURITY;
ALTER TABLE abuse_logs      ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- RLS HELPER FUNCTIONS
-- ============================================================

-- Get current user's ID from session context (set by app)
CREATE OR REPLACE FUNCTION current_user_id() RETURNS UUID AS $$
  SELECT NULLIF(current_setting('app.user_id', TRUE), '')::UUID;
$$ LANGUAGE SQL STABLE SECURITY DEFINER;

-- Get current user's role
CREATE OR REPLACE FUNCTION current_user_role() RETURNS user_role AS $$
  SELECT role FROM users WHERE id = current_user_id();
$$ LANGUAGE SQL STABLE SECURITY DEFINER;

-- Check if current user is admin
CREATE OR REPLACE FUNCTION is_admin() RETURNS BOOLEAN AS $$
  SELECT COALESCE(role = 'admin', FALSE) FROM users WHERE id = current_user_id();
$$ LANGUAGE SQL STABLE SECURITY DEFINER;

-- Check if current user is banned
CREATE OR REPLACE FUNCTION is_banned() RETURNS BOOLEAN AS $$
  SELECT COALESCE(banned, TRUE) FROM users WHERE id = current_user_id();
$$ LANGUAGE SQL STABLE SECURITY DEFINER;

-- ============================================================
-- RLS POLICIES: users
-- ============================================================

-- Users can view their own profile; everyone can view basic public profiles
CREATE POLICY "users_select_own" ON users
  FOR SELECT USING (
    id = current_user_id()          -- own profile (full)
    OR (NOT banned)                 -- others see non-banned users (limited by view)
  );

-- Users can only update their own profile (never role or banned fields)
CREATE POLICY "users_update_own" ON users
  FOR UPDATE USING (id = current_user_id() AND NOT is_banned())
  WITH CHECK (
    id = current_user_id()
    AND role = (SELECT role FROM users WHERE id = current_user_id())  -- role unchanged
    AND banned = (SELECT banned FROM users WHERE id = current_user_id()) -- banned unchanged
    AND role_locked = TRUE          -- cannot unlock role_locked
  );

-- Only app backend can insert (via service role bypass)
CREATE POLICY "users_insert_backend" ON users
  FOR INSERT WITH CHECK (is_admin());

-- Admins can do anything
CREATE POLICY "users_admin_all" ON users
  FOR ALL USING (is_admin());

-- ============================================================
-- RLS POLICIES: magic_tokens
-- ============================================================

-- Only the owning user can view their tokens (and only unused)
CREATE POLICY "magic_tokens_select_own" ON magic_tokens
  FOR SELECT USING (user_id = current_user_id());

-- Backend inserts only
CREATE POLICY "magic_tokens_insert_backend" ON magic_tokens
  FOR INSERT WITH CHECK (is_admin());

-- Backend/system can mark as used
CREATE POLICY "magic_tokens_update_backend" ON magic_tokens
  FOR UPDATE USING (is_admin());

-- ============================================================
-- RLS POLICIES: sessions
-- ============================================================

CREATE POLICY "sessions_select_own" ON sessions
  FOR SELECT USING (user_id = current_user_id());

CREATE POLICY "sessions_insert_backend" ON sessions
  FOR INSERT WITH CHECK (is_admin());

CREATE POLICY "sessions_update_backend" ON sessions
  FOR UPDATE USING (user_id = current_user_id() OR is_admin());

-- ============================================================
-- RLS POLICIES: gigs
-- ============================================================

-- FREELANCERS: Can only see FUNDED gigs (active market for bidding)
-- CLIENTS: Can see their own gigs in any status
-- ADMINS: See everything
-- PUBLIC (pending users): Can see active/funded gigs only
CREATE POLICY "gigs_select" ON gigs
  FOR SELECT USING (
    is_admin()
    OR client_id = current_user_id()              -- client sees own gigs
    OR (                                           -- freelancers see funded/active gigs
      current_user_role() = 'freelancer'
      AND is_funded = TRUE
      AND status IN ('funded', 'active')
      AND NOT flagged
    )
    OR (                                           -- pending users see active non-flagged
      current_user_role() IN ('pending', 'client')
      AND status = 'active'
      AND NOT flagged
    )
  );

-- Clients can insert gigs (not banned)
CREATE POLICY "gigs_insert_client" ON gigs
  FOR INSERT WITH CHECK (
    client_id = current_user_id()
    AND current_user_role() = 'client'
    AND NOT is_banned()
  );

-- Clients can update their OWN gigs (only in draft/pending_review)
CREATE POLICY "gigs_update_client" ON gigs
  FOR UPDATE USING (
    client_id = current_user_id()
    AND current_user_role() = 'client'
    AND NOT is_banned()
    AND status IN ('draft', 'pending_review')
  )
  WITH CHECK (
    client_id = current_user_id()
    AND is_funded = (SELECT is_funded FROM gigs WHERE id = gigs.id)  -- cannot self-fund
    AND flagged = FALSE  -- cannot unflag own gig
  );

-- Admins full control
CREATE POLICY "gigs_admin_all" ON gigs
  FOR ALL USING (is_admin());

-- ============================================================
-- RLS POLICIES: proposals
-- ============================================================

-- Freelancers see own proposals
-- Clients see proposals on their gigs
-- Admins see all
CREATE POLICY "proposals_select" ON proposals
  FOR SELECT USING (
    is_admin()
    OR freelancer_id = current_user_id()           -- own proposals
    OR EXISTS (                                     -- client sees proposals on own gig
      SELECT 1 FROM gigs
      WHERE gigs.id = proposals.gig_id
        AND gigs.client_id = current_user_id()
    )
  );

-- Only freelancers can submit proposals (on funded gigs only, not banned)
CREATE POLICY "proposals_insert_freelancer" ON proposals
  FOR INSERT WITH CHECK (
    freelancer_id = current_user_id()
    AND current_user_role() = 'freelancer'
    AND NOT is_banned()
    AND EXISTS (
      SELECT 1 FROM gigs
      WHERE gigs.id = proposals.gig_id
        AND gigs.is_funded = TRUE
        AND gigs.status IN ('funded', 'active')
        AND NOT gigs.flagged
    )
  );

-- Freelancers can update own pending proposals
CREATE POLICY "proposals_update_freelancer" ON proposals
  FOR UPDATE USING (
    freelancer_id = current_user_id()
    AND current_user_role() = 'freelancer'
    AND NOT is_banned()
    AND status = 'pending'
  )
  WITH CHECK (
    freelancer_id = current_user_id()
    AND status = 'pending'  -- cannot self-accept/complete
  );

-- Admins full control
CREATE POLICY "proposals_admin_all" ON proposals
  FOR ALL USING (is_admin());

-- ============================================================
-- RLS POLICIES: escrow_payments
-- ============================================================

-- Parties to the payment can view it
CREATE POLICY "escrow_select" ON escrow_payments
  FOR SELECT USING (
    is_admin()
    OR client_id = current_user_id()
    OR freelancer_id = current_user_id()
  );

-- Only admins manage escrow (manual Phase 1)
CREATE POLICY "escrow_admin_all" ON escrow_payments
  FOR ALL USING (is_admin());

-- ============================================================
-- RLS POLICIES: reviews
-- ============================================================

CREATE POLICY "reviews_select_public" ON reviews
  FOR SELECT USING (TRUE);  -- reviews are public

CREATE POLICY "reviews_insert" ON reviews
  FOR INSERT WITH CHECK (
    reviewer_id = current_user_id()
    AND NOT is_banned()
    AND EXISTS (
      SELECT 1 FROM proposals p
      JOIN gigs g ON g.id = p.gig_id
      WHERE p.id = reviews.proposal_id
        AND p.status = 'completed'
        AND (
          (current_user_role() = 'client' AND g.client_id = current_user_id())
          OR (current_user_role() = 'freelancer' AND p.freelancer_id = current_user_id())
        )
    )
  );

-- ============================================================
-- RLS POLICIES: abuse_logs
-- ============================================================

-- Only admins see abuse logs
CREATE POLICY "abuse_logs_admin_only" ON abuse_logs
  FOR ALL USING (is_admin());

-- ============================================================
-- TRIGGERS: updated_at auto-update
-- ============================================================

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_gigs_updated_at
  BEFORE UPDATE ON gigs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_proposals_updated_at
  BEFORE UPDATE ON proposals
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- TRIGGER: Sync proposal_count on gigs
-- ============================================================

CREATE OR REPLACE FUNCTION sync_gig_proposal_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE gigs SET proposal_count = proposal_count + 1 WHERE id = NEW.gig_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE gigs SET proposal_count = GREATEST(proposal_count - 1, 0) WHERE id = OLD.gig_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER trg_sync_proposal_count
  AFTER INSERT OR DELETE ON proposals
  FOR EACH ROW EXECUTE FUNCTION sync_gig_proposal_count();

-- ============================================================
-- TRIGGER: Update user ratings on review
-- ============================================================

CREATE OR REPLACE FUNCTION sync_user_rating()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE users SET
    rating_avg   = sub.avg_rating,
    rating_count = sub.cnt
  FROM (
    SELECT
      AVG(rating)::NUMERIC(3,2) AS avg_rating,
      COUNT(*)                  AS cnt
    FROM reviews
    WHERE reviewee_id = NEW.reviewee_id
  ) sub
  WHERE users.id = NEW.reviewee_id;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER trg_sync_user_rating
  AFTER INSERT ON reviews
  FOR EACH ROW EXECUTE FUNCTION sync_user_rating();

-- ============================================================
-- TRIGGER: Prevent role change (LOCK)
-- ============================================================

CREATE OR REPLACE FUNCTION prevent_role_change()
RETURNS TRIGGER AS $$
BEGIN
  -- Allow only admins to change role
  IF OLD.role != NEW.role AND NOT is_admin() THEN
    RAISE EXCEPTION 'Role changes are locked. Contact admin.';
  END IF;
  -- Prevent un-banning self
  IF OLD.banned = TRUE AND NEW.banned = FALSE AND NOT is_admin() THEN
    RAISE EXCEPTION 'Cannot unban self.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER trg_prevent_role_change
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION prevent_role_change();

-- ============================================================
-- TRIGGER: Auto-cleanup expired tokens (runs on insert)
-- ============================================================

CREATE OR REPLACE FUNCTION cleanup_expired_tokens()
RETURNS TRIGGER AS $$
BEGIN
  -- Delete tokens older than 1 day (expired)
  DELETE FROM magic_tokens
  WHERE expires_at < NOW() - INTERVAL '1 day';
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER trg_cleanup_expired_tokens
  AFTER INSERT ON magic_tokens
  FOR EACH ROW EXECUTE FUNCTION cleanup_expired_tokens();

-- ============================================================
-- VIEWS (safe public views strip sensitive data)
-- ============================================================

-- Public freelancer profile (no PII)
CREATE OR REPLACE VIEW public_freelancer_profiles AS
SELECT
  u.id,
  u.display_name,
  u.avatar_url,
  u.skills,
  u.bio,
  u.hourly_rate_npr,
  u.district,
  u.province,
  u.rating_avg,
  u.rating_count,
  u.total_earned_npr,
  u.created_at
FROM users u
WHERE u.role = 'freelancer'
  AND u.banned = FALSE;

-- Public gig listing (active funded gigs for freelancers)
CREATE OR REPLACE VIEW public_gig_listings AS
SELECT
  g.id,
  g.title,
  g.description,
  g.category,
  g.subcategory,
  g.tags,
  g.budget_min_npr,
  g.budget_max_npr,
  g.budget_type,
  g.deadline,
  g.duration_days,
  g.location_type,
  g.district,
  g.province,
  g.proposal_count,
  g.view_count,
  g.published_at,
  g.expires_at,
  -- Client info (minimal)
  u.display_name   AS client_display_name,
  u.rating_avg     AS client_rating,
  u.district       AS client_district
FROM gigs g
JOIN users u ON u.id = g.client_id
WHERE g.status IN ('active', 'funded')
  AND g.is_funded = TRUE
  AND NOT g.flagged
  AND u.banned = FALSE;

-- ============================================================
-- INITIAL SEED: Admin user
-- ============================================================
INSERT INTO users (
  id, phone, email, role, role_locked, full_name, display_name, banned
) VALUES (
  uuid_generate_v4(),
  '+9779800000000',
  'admin@nepalgig.com',
  'admin',
  TRUE,
  'NepalgGig Admin',
  'Admin',
  FALSE
) ON CONFLICT DO NOTHING;

-- ============================================================
-- GRANT PERMISSIONS
-- ============================================================

-- App user gets RLS-filtered access (set app.user_id in each request)
GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO app_user;

-- Anonymous gets very limited read
GRANT USAGE ON SCHEMA public TO anon;
GRANT SELECT ON public_gig_listings TO anon;
GRANT SELECT ON public_freelancer_profiles TO anon;

-- ============================================================
-- COMMENTS
-- ============================================================
COMMENT ON TABLE users           IS 'Core user table. Role is locked and can only be changed by admin.';
COMMENT ON TABLE magic_tokens    IS 'One-time magic link tokens for passwordless auth. 15min TTL.';
COMMENT ON TABLE sessions        IS 'Active user sessions with 30-day expiry.';
COMMENT ON TABLE gigs            IS 'Client-posted jobs. Freelancers can only see funded gigs.';
COMMENT ON TABLE proposals       IS 'Freelancer bids on funded gigs.';
COMMENT ON TABLE escrow_payments IS 'Payment escrow. Phase 1: manual bank transfer verification.';
COMMENT ON TABLE reviews         IS 'Mutual reviews after completed gigs.';
COMMENT ON TABLE abuse_logs      IS 'Audit log for all abuse/security events.';
COMMENT ON COLUMN users.role     IS 'Locked after assignment. pending→freelancer/client by admin only.';
COMMENT ON COLUMN users.device_hash IS 'SHA-256 fingerprint for multi-account abuse detection.';
COMMENT ON COLUMN gigs.is_funded IS 'TRUE only after escrow payment confirmed. Freelancers see funded gigs only.';
