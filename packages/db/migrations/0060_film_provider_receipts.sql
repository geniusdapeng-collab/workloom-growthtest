-- T-2026-1103-9001 / MC-016: an accepted paid task remains identifiable during local failure.
-- Keep the existing dispatched/unknown states and evidence JSON. A late provider acknowledgement
-- may add its receipt; once present, no update may replace or remove its task/request binding.
CREATE FUNCTION guard_film_provider_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.evidence ? 'providerTaskId' AND (
    NEW.provider IS DISTINCT FROM OLD.provider
    OR NEW.provider_model IS DISTINCT FROM OLD.provider_model
    OR NEW.evidence->'providerTaskId' IS DISTINCT FROM OLD.evidence->'providerTaskId'
    OR NEW.evidence->'providerRequestHash' IS DISTINCT FROM OLD.evidence->'providerRequestHash'
    OR (OLD.evidence ? 'providerAcceptedAt'
        AND NEW.evidence->'providerAcceptedAt' IS DISTINCT FROM OLD.evidence->'providerAcceptedAt')
  ) THEN
    RAISE EXCEPTION 'film provider acceptance receipt is immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER film_component_provider_receipt_guard BEFORE UPDATE ON film_component_requests
  FOR EACH ROW EXECUTE FUNCTION guard_film_provider_receipt();
