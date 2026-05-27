CREATE TABLE IF NOT EXISTS clients (
    client_key TEXT PRIMARY KEY,
    sheet_name TEXT NOT NULL,
    row_number INT NOT NULL,
    client_id TEXT NOT NULL,
    name TEXT NOT NULL,
    address TEXT NOT NULL,
    route_name TEXT NOT NULL,
    transport TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_clients_route_name ON clients(route_name);

CREATE TABLE IF NOT EXISTS delivery_status (
    client_key TEXT PRIMARY KEY,
    delivered BOOLEAN NOT NULL DEFAULT FALSE,
    delivered_baskets INT NOT NULL DEFAULT 0,
    delivered_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
