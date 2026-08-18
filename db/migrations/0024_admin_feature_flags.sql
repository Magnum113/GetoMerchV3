-- Runtime feature switches owned by the admin application. These switches are
-- an additional business-level gate; they never replace the narrower env
-- allow-lists and external-write gates.

CREATE SCHEMA IF NOT EXISTS getomerch_admin AUTHORIZATION getomerch_owner;

CREATE TABLE public.merch_admin_feature_flags (
  feature_key text PRIMARY KEY,
  enabled boolean DEFAULT false NOT NULL,
  revision bigint DEFAULT 1 NOT NULL,
  updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  updated_by text NOT NULL,
  CONSTRAINT merch_admin_feature_flags_key_check CHECK (
    feature_key ~ '^[a-z][a-z0-9_]{1,79}$'
  ),
  CONSTRAINT merch_admin_feature_flags_revision_check CHECK (revision >= 1),
  CONSTRAINT merch_admin_feature_flags_actor_check CHECK (
    length(updated_by) BETWEEN 1 AND 200
  )
);

INSERT INTO public.merch_admin_feature_flags (
  feature_key, enabled, updated_by
)
VALUES ('chestny_znak', false, 'migration')
ON CONFLICT (feature_key) DO NOTHING;

CREATE VIEW getomerch_admin.feature_flag_safe
WITH (security_barrier = true)
AS
SELECT
  feature_key,
  enabled,
  revision,
  updated_at,
  updated_by
FROM public.merch_admin_feature_flags;

CREATE FUNCTION getomerch_admin.set_feature_flag(
  p_feature_key text,
  p_enabled boolean,
  p_expected_revision bigint,
  p_actor text
)
RETURNS TABLE (
  feature_key text,
  enabled boolean,
  revision bigint,
  updated_at timestamp with time zone,
  updated_by text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  UPDATE public.merch_admin_feature_flags AS flag
  SET
    enabled = p_enabled,
    revision = flag.revision + 1,
    updated_at = clock_timestamp(),
    updated_by = p_actor
  WHERE flag.feature_key = p_feature_key
    AND p_feature_key = 'chestny_znak'
    AND p_expected_revision >= 1
    AND flag.revision = p_expected_revision
    AND p_actor IS NOT NULL
    AND length(p_actor) BETWEEN 1 AND 200
  RETURNING
    flag.feature_key,
    flag.enabled,
    flag.revision,
    flag.updated_at,
    flag.updated_by
$function$;

REVOKE ALL ON SCHEMA getomerch_admin FROM PUBLIC;
REVOKE ALL ON public.merch_admin_feature_flags
  FROM PUBLIC, getomerch_app;
REVOKE ALL ON getomerch_admin.feature_flag_safe FROM PUBLIC;
REVOKE ALL ON FUNCTION getomerch_admin.set_feature_flag(
  text, boolean, bigint, text
) FROM PUBLIC;

GRANT USAGE ON SCHEMA getomerch_admin
  TO getomerch_app, getomerch_backup;
GRANT SELECT ON getomerch_admin.feature_flag_safe
  TO getomerch_app, getomerch_backup;
GRANT SELECT ON public.merch_admin_feature_flags TO getomerch_backup;
GRANT EXECUTE ON FUNCTION getomerch_admin.set_feature_flag(
  text, boolean, bigint, text
) TO getomerch_app;

DO $grant_worker$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'getomerch_marking_worker') THEN
    GRANT USAGE ON SCHEMA getomerch_admin TO getomerch_marking_worker;
    GRANT SELECT ON getomerch_admin.feature_flag_safe TO getomerch_marking_worker;
  END IF;
END
$grant_worker$;

COMMENT ON TABLE public.merch_admin_feature_flags IS
  'Audited business-level feature switches for GetoMerch Admin.';
COMMENT ON COLUMN public.merch_admin_feature_flags.enabled IS
  'Master application switch; narrower environment safety gates still apply.';
