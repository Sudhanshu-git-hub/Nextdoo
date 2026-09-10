-- PRD §8.5 review flow: "optional notes". One owner-authored note per local
-- day (workspace time zone) per workspace. `day` is the local date key, never
-- an instant, so notes stay stable across DST and zone changes.
CREATE TABLE review_notes (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  day date NOT NULL,
  body varchar(500) NOT NULL,
  updated_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, day),
  CHECK (char_length(body) >= 1)
);
CREATE INDEX review_notes_workspace_idx ON review_notes(workspace_id, day DESC);
