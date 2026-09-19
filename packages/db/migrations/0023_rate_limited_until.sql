-- M8-i4: Google Calendar 429/403 backoff scheduling (PRD §16.1
-- "Respect 403/429 backoff"; review docs/M8_i4_GOOGLE_CALENDAR_HARDENING_REVIEW.md T4).
--
-- When the provider rate-limits a connection with Retry-After N, the engine
-- records now + N here. Worker cycles make ZERO provider calls for that
-- connection while this instant is in the future; the marker is cleared when
-- the pass runs again. NULL (default) = no active backoff.
ALTER TABLE calendar_connections ADD COLUMN rate_limited_until TIMESTAMPTZ;
