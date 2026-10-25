-- Active project/job model. Retain legacy tables and all existing documents.
CREATE TABLE projects (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL REFERENCES users(id),
    name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
    land jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(land) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, owner_id)
);
CREATE INDEX projects_owner_idx ON projects(owner_id, created_at DESC, id DESC);
CREATE TRIGGER projects_updated BEFORE UPDATE ON projects
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO projects(id, owner_id, name, land, created_at, updated_at)
SELECT id, owner_id, name,
    CASE WHEN jsonb_typeof(data->'site') = 'object' THEN data->'site' ELSE '{}'::jsonb END,
    created_at, updated_at FROM buildings;
ALTER TABLE buildings ADD COLUMN project_id uuid;
UPDATE buildings SET project_id=id;
ALTER TABLE buildings ALTER COLUMN project_id SET NOT NULL;
ALTER TABLE buildings ADD CONSTRAINT buildings_project_owner_fk
    FOREIGN KEY (project_id, owner_id) REFERENCES projects(id, owner_id);
ALTER TABLE buildings ADD CONSTRAINT buildings_id_owner_unique UNIQUE (id, owner_id);
CREATE INDEX buildings_project_idx ON buildings(project_id, owner_id);

CREATE TABLE design_tasks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL REFERENCES users(id),
    project_id uuid NOT NULL,
    request_key text NOT NULL CHECK (length(request_key) BETWEEN 1 AND 200),
    request_hash text NOT NULL,
    request jsonb NOT NULL CHECK (jsonb_typeof(request) = 'object'),
    status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
    progress jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(progress) = 'object'),
    attempts integer NOT NULL DEFAULT 0,
    retry_at timestamptz NOT NULL DEFAULT now(),
    lease_token uuid,
    lease_until timestamptz,
    building_id uuid,
    error text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (project_id, owner_id) REFERENCES projects(id, owner_id),
    FOREIGN KEY (building_id, owner_id) REFERENCES buildings(id, owner_id) ON DELETE CASCADE,
    UNIQUE (owner_id, request_key),
    CHECK ((status='running' AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
        OR (status<>'running' AND lease_token IS NULL AND lease_until IS NULL)),
    CHECK ((status='done') = (building_id IS NOT NULL))
);
CREATE INDEX design_tasks_pending_idx ON design_tasks(status, lease_until, created_at)
    WHERE status IN ('queued','running');
CREATE INDEX design_tasks_owner_idx ON design_tasks(owner_id, created_at DESC, id DESC);
CREATE TRIGGER design_tasks_updated BEFORE UPDATE ON design_tasks
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
