const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
const PORT = Number(process.env.PORT || 10000);
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || "";
const DISTRIBUTION_ORIGIN = process.env.DISTRIBUTION_ORIGIN || "Planta Bello Campo, Caracas, Venezuela";
const DATABASE_URL = process.env.DATABASE_URL || "";
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "*";
const NEON_SOURCE_TABLE = process.env.NEON_SOURCE_TABLE || "DIRECCIONES Y RUTAS";
const AUTO_DEPLOY_ON_DB_CHANGE = String(process.env.AUTO_DEPLOY_ON_DB_CHANGE || "false").toLowerCase() === "true";
const RENDER_DEPLOY_HOOK_URL = process.env.RENDER_DEPLOY_HOOK_URL || "";
const DB_WATCH_INTERVAL_MS = Number(process.env.DB_WATCH_INTERVAL_MS || 120000);
const AUTO_DEPLOY_COOLDOWN_MS = Number(process.env.AUTO_DEPLOY_COOLDOWN_MS || 600000);
const DB_CHANGE_WATCH_QUERY = process.env.DB_CHANGE_WATCH_QUERY || "";

if (!DATABASE_URL) {
    throw new Error("Falta DATABASE_URL para conectar con Neon.");
}

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

app.use(cors({ origin: FRONTEND_ORIGIN === "*" ? true : FRONTEND_ORIGIN }));
app.use(express.json({ limit: "1mb" }));

function normalizeHeader(value) {
    return String(value || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ");
}

function normalizeText(value) {
    return String(value || "").trim();
}

function quoteIdent(identifier) {
    return `"${String(identifier).replace(/"/g, "\"\"")}"`;
}

function parseTableRef(tableRef) {
    const parts = String(tableRef || "").split(".");
    if (parts.length === 2) return { schema: parts[0], table: parts[1] };
    return { schema: "public", table: String(tableRef || "") };
}

function pickColumn(columns, candidates) {
    const normalized = columns.map((col) => ({ original: col, normalized: normalizeHeader(col) }));
    for (const candidate of candidates) {
        const found = normalized.find((item) => item.normalized === normalizeHeader(candidate));
        if (found) return found.original;
    }
    return null;
}

function pickColumnByContains(columns, fragments) {
    const normalized = columns.map((col) => ({ original: col, normalized: normalizeHeader(col) }));
    const found = normalized.find((item) =>
        fragments.every((fragment) => item.normalized.includes(normalizeHeader(fragment)))
    );
    return found ? found.original : null;
}

function sqlExpr(columnName, fallback = "") {
    if (!columnName) return `'${fallback}'`;
    return `COALESCE(TRIM(${quoteIdent(columnName)}::text), '')`;
}

function makeClientKey(clientId, route, address) {
    return [normalizeText(clientId), normalizeText(route), normalizeText(address)].join("::");
}

async function ensureDatabaseReady() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS client_overrides (
            client_key TEXT PRIMARY KEY,
            name TEXT NOT NULL DEFAULT '',
            address TEXT NOT NULL DEFAULT '',
            route_name TEXT NOT NULL DEFAULT '',
            transport TEXT NOT NULL DEFAULT '',
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
}

async function getSourceColumns() {
    const { schema, table } = parseTableRef(NEON_SOURCE_TABLE);
    const result = await pool.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`,
        [schema, table]
    );
    return result.rows.map((row) => row.column_name);
}

async function fetchSourceClients(routeFilter) {
    const columns = await getSourceColumns();
    if (!columns.length) throw new Error(`No existe la tabla ${NEON_SOURCE_TABLE} en Neon.`);

    const idCol = pickColumn(columns, ["CLIENTES", "CIENTES", "CLIENTE ID", "ID CLIENTE"]);
    const nameCol = pickColumn(columns, [
        "NOMBRE O RAZON SOCIAL",
        "NOMBRE_O_RAZON_SOCIAL",
        "NOMBRE O RAZÓN SOCIAL",
        "NOMBRE_O_RAZÓN_SOCIAL",
        "NOMBRE"
    ]) || pickColumnByContains(columns, ["nombre", "razon"]) || pickColumnByContains(columns, ["nombre"]);
    const addressCol = pickColumn(columns, ["DIRECCION", "DIRECCIÓN"]);
    const routeCol = pickColumn(columns, ["RUTA", "RUTA ASIGNADA"]);
    const transportCol = pickColumn(columns, ["TRANSPORTE"]);

    const { schema, table } = parseTableRef(NEON_SOURCE_TABLE);
    const values = [];
    const where = routeFilter ? `WHERE ${sqlExpr(routeCol)} = $1` : "";
    if (routeFilter) values.push(routeFilter);

    const query = `
        SELECT
            ROW_NUMBER() OVER ()::int AS row_number,
            ${sqlExpr(idCol)} AS client_id,
            ${sqlExpr(nameCol)} AS name,
            ${sqlExpr(addressCol)} AS address,
            ${sqlExpr(routeCol)} AS route_name,
            ${sqlExpr(transportCol)} AS transport
        FROM ${quoteIdent(schema)}.${quoteIdent(table)}
        ${where}
    `;

    const result = await pool.query(query, values);
    return result.rows.map((row) => ({
        key: makeClientKey(row.client_id, row.route_name, row.address),
        sheet: "NEON",
        rowNumber: row.row_number,
        clientId: row.client_id,
        name: row.name,
        nombre_o_razon_social: row.name,
        address: row.address,
        route: row.route_name,
        transport: row.transport
    }));
}

async function getOverridesMap() {
    const result = await pool.query("SELECT client_key, name, address, route_name, transport FROM client_overrides");
    const map = new Map();
    result.rows.forEach((row) => map.set(row.client_key, row));
    return map;
}

async function getClients(route) {
    const base = await fetchSourceClients("");
    const overrides = await getOverridesMap();
    const merged = base.map((client) => {
        const override = overrides.get(client.key);
        if (!override) return client;
        const name = normalizeText(override.name || client.name);
        return {
            ...client,
            name,
            nombre_o_razon_social: name,
            address: normalizeText(override.address || client.address),
            route: normalizeText(override.route_name || client.route),
            transport: normalizeText(override.transport || client.transport)
        };
    });
    if (!route) return merged;
    return merged.filter((client) => normalizeText(client.route) === normalizeText(route));
}

function isClientWithErrors(client) {
    const route = normalizeHeader(client.route);
    const missingFields = !client.clientId || !client.name || !client.address || !client.route;
    return missingFields || route.includes("revisar manualmente");
}

async function routeStats() {
    const clients = await getClients("");
    const grouped = new Map();
    clients.forEach((client) => {
        const route = client.route || "SIN RUTA";
        grouped.set(route, (grouped.get(route) || 0) + 1);
    });
    return Array.from(grouped.entries())
        .map(([route, totalClients]) => ({ route, totalClients }))
        .sort((a, b) => a.route.localeCompare(b.route));
}

async function saveClientOverride(key, data) {
    await pool.query(
        `INSERT INTO client_overrides (client_key, name, address, route_name, transport, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (client_key) DO UPDATE
         SET name = EXCLUDED.name,
             address = EXCLUDED.address,
             route_name = EXCLUDED.route_name,
             transport = EXCLUDED.transport,
             updated_at = NOW()`,
        [key, data.name, data.address, data.route, data.transport]
    );
}

async function getDistance(origin, destination) {
    if (!GOOGLE_MAPS_API_KEY) {
        throw new Error("Falta GOOGLE_MAPS_API_KEY en variables de entorno.");
    }
    const params = new URLSearchParams({
        origins: origin,
        destinations: destination,
        key: GOOGLE_MAPS_API_KEY,
        language: "es"
    });
    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?${params.toString()}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Google API HTTP ${response.status}`);
    const payload = await response.json();
    const element = payload?.rows?.[0]?.elements?.[0];
    if (!element || element.status !== "OK") throw new Error(`Google API sin resultado para: ${destination}`);
    return {
        meters: element.distance.value,
        distanceText: element.distance.text,
        durationText: element.duration.text
    };
}

async function optimizeRoute(clients, originAddress) {
    const pending = clients.filter((c) => c.address).slice(0, 22).map((client) => ({ ...client }));
    const optimized = [];
    let currentOrigin = originAddress;
    let totalMeters = 0;

    while (pending.length > 0) {
        const distances = await Promise.all(
            pending.map(async (client) => ({ client, distance: await getDistance(currentOrigin, client.address) }))
        );
        distances.sort((a, b) => a.distance.meters - b.distance.meters);
        const best = distances[0];
        totalMeters += best.distance.meters;
        optimized.push({
            ...best.client,
            legDistanceMeters: best.distance.meters,
            legDistanceText: best.distance.distanceText,
            legDurationText: best.distance.durationText
        });
        currentOrigin = best.client.address;
        pending.splice(pending.findIndex((client) => client.key === best.client.key), 1);
    }

    return {
        origin: originAddress,
        totalClients: optimized.length,
        totalDistanceKm: Number((totalMeters / 1000).toFixed(2)),
        sequence: optimized
    };
}

function defaultDbChangeQuery() {
    const { schema, table } = parseTableRef(NEON_SOURCE_TABLE);
    const tableRef = `${quoteIdent(schema)}.${quoteIdent(table)}`;
    return `
        SELECT md5(COUNT(*)::text || ':' || COALESCE(SUM(length(t::text))::text, '0')) AS signature
        FROM ${tableRef} AS t
    `;
}

async function getDbSignature() {
    const query = DB_CHANGE_WATCH_QUERY || defaultDbChangeQuery();
    const result = await pool.query(query);
    const signature = result?.rows?.[0]?.signature;
    return String(signature || "");
}

async function triggerRenderDeploy(reason) {
    if (!RENDER_DEPLOY_HOOK_URL) return;
    const response = await fetch(RENDER_DEPLOY_HOOK_URL, { method: "POST" });
    if (!response.ok) {
        throw new Error(`Deploy hook fallo con HTTP ${response.status}`);
    }
    console.log(`Deploy disparado por cambio DB: ${reason}`);
}

function startDbChangeWatcher() {
    if (!AUTO_DEPLOY_ON_DB_CHANGE) return;
    if (!RENDER_DEPLOY_HOOK_URL) {
        console.warn("AUTO_DEPLOY_ON_DB_CHANGE=true pero falta RENDER_DEPLOY_HOOK_URL.");
        return;
    }

    let lastSignature = "";
    let lastDeployAt = 0;

    const checkChanges = async () => {
        try {
            const signature = await getDbSignature();
            if (!lastSignature) {
                lastSignature = signature;
                return;
            }
            if (signature === lastSignature) return;

            const now = Date.now();
            if (now - lastDeployAt < AUTO_DEPLOY_COOLDOWN_MS) {
                console.log("Cambio detectado, pero en cooldown de deploy.");
                lastSignature = signature;
                return;
            }

            lastSignature = signature;
            lastDeployAt = now;
            await triggerRenderDeploy("source_table_signature_changed");
        } catch (error) {
            console.error("Watcher DB error:", error.message || error);
        }
    };

    setInterval(checkChanges, Math.max(30000, DB_WATCH_INTERVAL_MS));
    checkChanges().catch((error) => console.error("Watcher DB init error:", error.message || error));
    console.log("Watcher de cambios en DB activo.");
}

app.get("/api/health", async (_, res) => {
    try {
        await ensureDatabaseReady();
        await pool.query("SELECT 1");
        res.json({ ok: true, service: "vrp-proyectoback", db: "connected", source: NEON_SOURCE_TABLE });
    } catch (error) {
        res.status(500).json({ ok: false, error: String(error.message || error) });
    }
});

app.get("/api/routes", async (_, res) => {
    try {
        await ensureDatabaseReady();
        res.json({ routes: await routeStats() });
    } catch (error) {
        res.status(500).json({ ok: false, error: String(error.message || error) });
    }
});

app.get("/api/clients", async (req, res) => {
    try {
        await ensureDatabaseReady();
        const route = normalizeText(req.query.route);
        const clients = await getClients(route);
        res.json({ total: clients.length, clients });
    } catch (error) {
        res.status(500).json({ ok: false, error: String(error.message || error) });
    }
});

app.get("/api/errors", async (_, res) => {
    try {
        await ensureDatabaseReady();
        const clients = (await getClients("")).filter(isClientWithErrors);
        res.json({ total: clients.length, clients });
    } catch (error) {
        res.status(500).json({ ok: false, error: String(error.message || error) });
    }
});

app.put("/api/clients/:key", async (req, res) => {
    try {
        await ensureDatabaseReady();
        const key = decodeURIComponent(req.params.key);
        const { name, address, route, transport } = req.body || {};
        await saveClientOverride(key, {
            name: normalizeText(name),
            address: normalizeText(address),
            route: normalizeText(route),
            transport: normalizeText(transport)
        });
        res.json({ ok: true, key });
    } catch (error) {
        res.status(500).json({ ok: false, error: String(error.message || error) });
    }
});

app.post("/api/optimize-route", async (req, res) => {
    try {
        await ensureDatabaseReady();
        const route = normalizeText(req.body?.route);
        const origin = normalizeText(req.body?.origin) || DISTRIBUTION_ORIGIN;
        if (!route) return res.status(400).json({ ok: false, error: "Debes enviar route." });
        const clients = (await getClients(route)).filter((client) => client.address);
        if (!clients.length) {
            return res.status(404).json({ ok: false, error: `No hay clientes con direccion para la ruta ${route}.` });
        }
        const optimized = await optimizeRoute(clients, origin);
        res.json({ ok: true, route, optimized });
    } catch (error) {
        res.status(500).json({ ok: false, error: String(error.message || error) });
    }
});

app.listen(PORT, () => {
    console.log(`VRP backend activo en puerto ${PORT}`);
    startDbChangeWatcher();
});
