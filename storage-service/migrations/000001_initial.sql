CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    auth_subject text NOT NULL UNIQUE CHECK (length(auth_subject) BETWEEN 1 AND 128),
    email text NOT NULL DEFAULT '',
    email_verified boolean NOT NULL DEFAULT false,
    display_name text NOT NULL DEFAULT '',
    role text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sites (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL REFERENCES users(id),
    geometry geometry(Polygon, 4326) NOT NULL,
    area_m2 double precision GENERATED ALWAYS AS (ST_Area(geometry::geography)) STORED,
    location_metadata jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(location_metadata) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (NOT ST_IsEmpty(geometry) AND ST_IsValid(geometry)),
    CHECK (ST_XMin(geometry::box3d) >= -180 AND ST_XMax(geometry::box3d) <= 180),
    CHECK (ST_YMin(geometry::box3d) >= -90 AND ST_YMax(geometry::box3d) <= 90),
    CHECK (area_m2 > 0 AND area_m2 < 'Infinity'::float8),
    UNIQUE (id, owner_id)
);
CREATE INDEX sites_owner_idx ON sites(owner_id, created_at DESC);
CREATE INDEX sites_geometry_idx ON sites USING gist(geometry);

CREATE TABLE design_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL REFERENCES users(id),
    site_id uuid NOT NULL,
    input_snapshot jsonb NOT NULL CHECK (jsonb_typeof(input_snapshot) = 'object'),
    site_snapshot jsonb NOT NULL CHECK (jsonb_typeof(site_snapshot) = 'object'),
    status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed')),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
    input_hash text NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (site_id, owner_id) REFERENCES sites(id, owner_id),
    UNIQUE (owner_id, idempotency_key)
);
CREATE INDEX design_requests_owner_idx ON design_requests(owner_id, created_at DESC);

CREATE FUNCTION preserve_request_input() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF ROW(NEW.owner_id, NEW.site_id, NEW.input_snapshot, NEW.site_snapshot, NEW.idempotency_key, NEW.input_hash)
       IS DISTINCT FROM ROW(OLD.owner_id, OLD.site_id, OLD.input_snapshot, OLD.site_snapshot, OLD.idempotency_key, OLD.input_hash) THEN
        RAISE EXCEPTION 'design request input is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER design_request_immutable BEFORE UPDATE ON design_requests
FOR EACH ROW EXECUTE FUNCTION preserve_request_input();

CREATE TABLE generation_jobs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id uuid NOT NULL UNIQUE REFERENCES design_requests(id),
    status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed')),
    stage text NOT NULL DEFAULT 'generation' CHECK (stage IN ('generation', 'prediction', 'complete')),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    lease_token uuid,
    lease_expires_at timestamptz,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    safe_error_code text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((status = 'running' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
        OR (status <> 'running' AND lease_token IS NULL AND lease_expires_at IS NULL))
);
CREATE INDEX generation_jobs_pending_idx ON generation_jobs(status, next_attempt_at);
CREATE INDEX generation_jobs_leases_idx ON generation_jobs(lease_expires_at) WHERE status = 'running';

CREATE TABLE task_outbox (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id uuid NOT NULL UNIQUE REFERENCES generation_jobs(id),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    available_at timestamptz NOT NULL DEFAULT now(),
    dispatched_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX task_outbox_pending_idx ON task_outbox(available_at) WHERE dispatched_at IS NULL;

CREATE TABLE designs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id uuid NOT NULL UNIQUE REFERENCES design_requests(id),
    concept jsonb NOT NULL CHECK (jsonb_typeof(concept) = 'object'),
    ai_model text NOT NULL CHECK (length(ai_model) > 0),
    prompt_version text NOT NULL CHECK (length(prompt_version) > 0),
    publication_state text NOT NULL DEFAULT 'private' CHECK (publication_state IN ('private', 'published')),
    published_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((publication_state = 'published') = (published_at IS NOT NULL))
);
CREATE INDEX designs_public_idx ON designs(created_at DESC, id) WHERE publication_state = 'published';

CREATE TABLE predictions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    design_id uuid NOT NULL REFERENCES designs(id),
    status text NOT NULL CHECK (status IN ('available', 'incomplete', 'unavailable')),
    currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    region text NOT NULL CHECK (length(region) > 0),
    low_amount numeric(18,2),
    base_amount numeric(18,2),
    high_amount numeric(18,2),
    materials jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(materials) = 'array'),
    breakdown jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(breakdown) = 'object'),
    projections jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(projections) = 'array'),
    assumptions jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(assumptions) = 'object'),
    pricing_source text NOT NULL,
    pricing_version text NOT NULL,
    model_version text NOT NULL,
    valuation_date date NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((low_amount IS NULL AND base_amount IS NULL AND high_amount IS NULL AND status <> 'available')
        OR (low_amount IS NOT NULL AND base_amount IS NOT NULL AND high_amount IS NOT NULL
            AND low_amount >= 0 AND low_amount <= base_amount AND base_amount <= high_amount
            AND high_amount < 'Infinity'::numeric))
);
CREATE INDEX predictions_design_idx ON predictions(design_id, created_at DESC);

CREATE TABLE inquiries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    sender_id uuid NOT NULL REFERENCES users(id),
    design_id uuid NOT NULL REFERENCES designs(id),
    message text NOT NULL CHECK (length(message) BETWEEN 1 AND 5000),
    contact_email text NOT NULL CHECK (length(contact_email) BETWEEN 3 AND 320),
    status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'in_progress', 'closed')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inquiries_admin_idx ON inquiries(status, created_at DESC);
CREATE INDEX inquiries_sender_idx ON inquiries(sender_id, created_at DESC);
CREATE INDEX inquiries_design_idx ON inquiries(design_id);

CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;
CREATE TRIGGER users_updated BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER sites_updated BEFORE UPDATE ON sites FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER requests_updated BEFORE UPDATE ON design_requests FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER jobs_updated BEFORE UPDATE ON generation_jobs FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER designs_updated BEFORE UPDATE ON designs FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER inquiries_updated BEFORE UPDATE ON inquiries FOR EACH ROW EXECUTE FUNCTION set_updated_at();
