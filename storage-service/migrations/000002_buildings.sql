-- The active backend now stores user-rendered buildings. Keep existing users and
-- legacy tables intact; this migration does not discard previously stored data.
CREATE TABLE buildings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL REFERENCES users(id),
    name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
    data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX buildings_owner_created_idx ON buildings(owner_id, created_at DESC, id DESC);

CREATE TRIGGER buildings_updated BEFORE UPDATE ON buildings
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
