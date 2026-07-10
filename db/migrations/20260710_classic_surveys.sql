-- Athena Survey: classic/offline survey mode
-- Run with: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/20260710_classic_surveys.sql

ALTER TABLE surveys
  ADD COLUMN IF NOT EXISTS survey_mode TEXT NOT NULL DEFAULT 'live',
  ADD COLUMN IF NOT EXISTS report_status TEXT NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS report_published_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS respondent_identity_mode TEXT NOT NULL DEFAULT 'anonymous_or_identified',
  ADD COLUMN IF NOT EXISTS allow_multiple_submissions BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE surveys DROP CONSTRAINT IF EXISTS surveys_survey_mode_check;
ALTER TABLE surveys ADD CONSTRAINT surveys_survey_mode_check CHECK (survey_mode IN ('live','classic'));

ALTER TABLE surveys DROP CONSTRAINT IF EXISTS surveys_report_status_check;
ALTER TABLE surveys ADD CONSTRAINT surveys_report_status_check CHECK (report_status IN ('draft','published'));

ALTER TABLE surveys DROP CONSTRAINT IF EXISTS surveys_respondent_identity_mode_check;
ALTER TABLE surveys ADD CONSTRAINT surveys_respondent_identity_mode_check CHECK (respondent_identity_mode IN ('anonymous_only','anonymous_or_identified','identified_required','invite_required'));

CREATE TABLE IF NOT EXISTS survey_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  survey_id UUID NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
  share_link_id UUID REFERENCES survey_share_links(id) ON DELETE SET NULL,
  respondent_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  invited_email TEXT,
  first_name TEXT,
  last_name TEXT,
  email TEXT,
  respondent_fingerprint TEXT,
  is_anonymous BOOLEAN NOT NULL DEFAULT true,
  status TEXT NOT NULL DEFAULT 'in_progress',
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE survey_submissions DROP CONSTRAINT IF EXISTS survey_submissions_status_check;
ALTER TABLE survey_submissions ADD CONSTRAINT survey_submissions_status_check CHECK (status IN ('in_progress','submitted'));

ALTER TABLE responses
  ADD COLUMN IF NOT EXISTS submission_id UUID REFERENCES survey_submissions(id) ON DELETE CASCADE;

ALTER TABLE survey_share_links DROP CONSTRAINT IF EXISTS survey_share_links_scope_check;
ALTER TABLE survey_share_links ADD CONSTRAINT survey_share_links_scope_check CHECK (scope IN ('survey','question','live_results','classic_survey'));

CREATE INDEX IF NOT EXISTS idx_surveys_mode ON surveys(survey_mode);
CREATE INDEX IF NOT EXISTS idx_surveys_report_status ON surveys(report_status);
CREATE INDEX IF NOT EXISTS idx_submissions_survey ON survey_submissions(survey_id);
CREATE INDEX IF NOT EXISTS idx_submissions_user ON survey_submissions(respondent_user_id);
CREATE INDEX IF NOT EXISTS idx_submissions_email ON survey_submissions(lower(email));
CREATE INDEX IF NOT EXISTS idx_submissions_fingerprint ON survey_submissions(survey_id, respondent_fingerprint);
CREATE INDEX IF NOT EXISTS idx_responses_submission ON responses(submission_id);
