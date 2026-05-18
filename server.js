const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

function loadLocalEnvFile() {
    const envPath = path.join(__dirname, ".env");
    if (!fs.existsSync(envPath)) return;

    const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
    lines.forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) return;
        const separator = trimmed.indexOf("=");
        if (separator < 1) return;

        const key = trimmed.slice(0, separator).trim();
        let value = trimmed.slice(separator + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (!process.env[key]) process.env[key] = value;
    });
}

loadLocalEnvFile();

const app = express();
const PORT = Number(process.env.PORT || 10000);

function cleanEnvValue(value) {
    let cleaned = String(value || "").trim();
    if ((cleaned.startsWith('"') && cleaned.endsWith('"')) || (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
        cleaned = cleaned.slice(1, -1).trim();
    }
    return cleaned;
}

const GOOGLE_MAPS_API_KEY = cleanEnvValue(process.env.GOOGLE_MAPS_SERVER_API_KEY || process.env.GOOGLE_MAPS_API_KEY || "");
const GOOGLE_MAPS_BROWSER_API_KEY = cleanEnvValue(process.env.GOOGLE_MAPS_BROWSER_API_KEY || "");
const DISTRIBUTION_ORIGIN_NAME = process.env.DISTRIBUTION_ORIGIN_NAME || "PDT Bello Campo";
const DISTRIBUTION_ORIGIN = process.env.DISTRIBUTION_ORIGIN || "Edificio Onnis, Avenida Francisco de Miranda, & Avenida Coromoto, Caracas 1060, Miranda, Venezuela";
const DATABASE_URL = process.env.DATABASE_URL || "";
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "*";
const NEON_SOURCE_TABLE = process.env.NEON_SOURCE_TABLE || "hojas_ruta_exportadas";
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

function isRouteSheetSource(columns) {
    const normalized = columns.map(normalizeHeader);
    return normalized.includes("id_hoja") && normalized.includes("facturas");
}

function makeRouteKey(sheetId) {
    return `hoja:${normalizeText(sheetId)}`;
}

function parseRouteKey(route) {
    const value = normalizeText(route);
    if (value.toLowerCase().startsWith("hoja:")) return value.slice(5);
    return "";
}

function formatDateValue(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return normalizeText(value);
    return date.toISOString().slice(0, 10);
}

function makeRouteDisplayName(sheet) {
    const routeName = normalizeText(sheet.ruta_nombre) || "SIN RUTA";
    const date = formatDateValue(sheet.fecha_entrega);
    return date ? `${routeName} - ${date}` : routeName;
}

function normalizeDeliveryAddress(address) {
    const value = normalizeText(address);
    if (!value) return "";
    const comparable = normalizeHeader(value);
    if (comparable.includes("venezuela")) return value;
    if (comparable.includes("caracas")) return `${value}, Venezuela`;
    return `${value}, Caracas, Venezuela`;
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

async function fetchRouteSheets(routeFilter = "") {
    const { schema, table } = parseTableRef(NEON_SOURCE_TABLE);
    const tableRef = `${quoteIdent(schema)}.${quoteIdent(table)}`;
    const routeSheetId = parseRouteKey(routeFilter);
    const values = [];
    const where = routeSheetId ? "WHERE id_hoja::text = $1" : "";
    if (routeSheetId) values.push(routeSheetId);

    const result = await pool.query(
        `SELECT
            id_hoja::text,
            ruta_nombre,
            fecha_entrega,
            conductor,
            numero_camion,
            total_despachos,
            total_cestas,
            usuario,
            nombre_archivo,
            COALESCE(facturas, '[]'::jsonb) AS facturas
         FROM ${tableRef}
         ${where}
         ORDER BY fecha_entrega DESC, id_hoja DESC`,
        values
    );
    return result.rows;
}

function flattenRouteSheetClients(sheets) {
    const clients = [];
    sheets.forEach((sheet) => {
        const routeKey = makeRouteKey(sheet.id_hoja);
        const routeName = normalizeText(sheet.ruta_nombre) || "SIN RUTA";
        const routeDisplayName = makeRouteDisplayName(sheet);
        const facturas = Array.isArray(sheet.facturas) ? sheet.facturas : [];

        facturas.forEach((invoice, index) => {
            const clientId = normalizeText(invoice.numero_control || invoice.id_factura || index + 1);
            const address = normalizeDeliveryAddress(invoice.direccion_texto);
            const name = normalizeText(invoice.cliente_nombre);
            const key = makeClientKey(
                `${sheet.id_hoja}:${clientId}:${normalizeText(invoice.numero_factura || invoice.id_factura || index + 1)}`,
                routeKey,
                address
            );

            clients.push({
                key,
                sheet: "hojas_ruta_exportadas",
                sheetId: String(sheet.id_hoja),
                rowNumber: index + 1,
                clientId,
                invoiceId: normalizeText(invoice.id_factura),
                invoiceNumber: normalizeText(invoice.numero_factura),
                controlNumber: normalizeText(invoice.numero_control),
                name,
                nombre_o_razon_social: name,
                address,
                originalAddress: normalizeText(invoice.direccion_texto),
                route: routeKey,
                routeName,
                routeDisplayName,
                zone: normalizeText(invoice.zona_nombre),
                transport: normalizeText(invoice.transporte_nombre || sheet.numero_camion),
                driver: normalizeText(sheet.conductor),
                truck: normalizeText(sheet.numero_camion),
                deliveryDate: formatDateValue(sheet.fecha_entrega),
                totalDispatches: Number(sheet.total_despachos || facturas.length || 0),
                totalBaskets: Number(sheet.total_cestas || 0),
                detail: Array.isArray(invoice.detalle) ? invoice.detalle : []
            });
        });
    });
    return clients;
}

async function fetchSourceClients(routeFilter) {
    const columns = await getSourceColumns();
    if (!columns.length) throw new Error(`No existe la tabla ${NEON_SOURCE_TABLE} en Neon.`);

    if (isRouteSheetSource(columns)) {
        const sheets = await fetchRouteSheets(routeFilter);
        return flattenRouteSheetClients(sheets);
    }

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
    const base = await fetchSourceClients(route);
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
            routeName: normalizeText(override.route_name || client.routeName),
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
    const columns = await getSourceColumns();
    if (isRouteSheetSource(columns)) {
        const sheets = await fetchRouteSheets("");
        return sheets.map((sheet) => {
            const facturas = Array.isArray(sheet.facturas) ? sheet.facturas : [];
            return {
                route: makeRouteKey(sheet.id_hoja),
                routeName: normalizeText(sheet.ruta_nombre) || "SIN RUTA",
                displayName: makeRouteDisplayName(sheet),
                sheetId: String(sheet.id_hoja),
                deliveryDate: formatDateValue(sheet.fecha_entrega),
                driver: normalizeText(sheet.conductor),
                truck: normalizeText(sheet.numero_camion),
                totalClients: facturas.length,
                totalDispatches: Number(sheet.total_despachos || facturas.length || 0),
                totalBaskets: Number(sheet.total_cestas || 0)
            };
        });
    }

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

function hasGoogleMapsConfig() {
    return Boolean(GOOGLE_MAPS_API_KEY && GOOGLE_MAPS_BROWSER_API_KEY);
}

function makeGoogleMapsDirectionsUrl(origin, sequence) {
    const stops = sequence.map((client) => client.address).filter(Boolean);
    const destination = stops[stops.length - 1] || "";
    const waypoints = stops.slice(0, -1);
    const params = new URLSearchParams({
        api: "1",
        origin,
        destination,
        travelmode: "driving"
    });
    if (waypoints.length) {
        params.set("waypoints", waypoints.join("|"));
    }
    return `https://www.google.com/maps/dir/?${params.toString()}`;
}

function formatMeters(meters) {
    if (!Number.isFinite(meters)) return "";
    if (meters < 1000) return `${Math.round(meters)} m`;
    return `${(meters / 1000).toFixed(1)} km`;
}

function parseDurationSeconds(duration) {
    const match = String(duration || "").match(/^(\d+(?:\.\d+)?)s$/);
    return match ? Number(match[1]) : 0;
}

function formatDuration(duration) {
    const seconds = parseDurationSeconds(duration);
    if (!seconds) return "";
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

async function computeOptimizedRoute(originAddress, clients) {
    if (!GOOGLE_MAPS_API_KEY) {
        throw new Error("Falta GOOGLE_MAPS_SERVER_API_KEY o GOOGLE_MAPS_API_KEY en variables de entorno.");
    }

    const cleanClients = clients.filter((client) => client.address).slice(0, 24);
    if (!cleanClients.length) {
        throw new Error("La ruta necesita al menos 1 cliente con direccion para calcular con Routes API.");
    }

    const matrix = cleanClients.length > 1
        ? await computeTrafficMatrix(originAddress, cleanClients)
        : null;
    const orderedClients = matrix
        ? optimizeClientOrderByDuration(cleanClients, matrix.durations)
        : cleanClients;
    const routeDetails = await computeRouteDetails(originAddress, orderedClients);

    return buildOptimizedRouteResponse(originAddress, orderedClients, routeDetails, matrix);
}

async function googleRoutesRequest(url, fieldMask, body) {
    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Goog-Api-Key": GOOGLE_MAPS_API_KEY,
            "X-Goog-FieldMask": fieldMask
        },
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        let detail = "";
        try {
            const text = await response.text();
            if (text) {
                try {
                    const payload = JSON.parse(text);
                    detail = payload?.error?.message ? `: ${payload.error.message}` : `: ${text.slice(0, 240)}`;
                } catch (_) {
                    detail = `: ${text.slice(0, 240)}`;
                }
            }
        } catch (_) {
            detail = "";
        }
        throw new Error(`Google Routes API HTTP ${response.status}${detail}`);
    }

    return response.json();
}

async function computeTrafficMatrix(originAddress, clients) {
    const locations = [
        { address: originAddress },
        ...clients.map((client) => ({ address: client.address }))
    ];
    const body = {
        origins: locations.map((location) => ({ waypoint: location })),
        destinations: locations.map((location) => ({ waypoint: location })),
        travelMode: "DRIVE",
        routingPreference: "TRAFFIC_AWARE",
        departureTime: new Date().toISOString(),
        languageCode: "es-419",
        units: "METRIC"
    };
    const entries = await googleRoutesRequest(
        "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix",
        "originIndex,destinationIndex,duration,distanceMeters,status,condition",
        body
    );
    const size = locations.length;
    const durations = Array.from({ length: size }, () => Array(size).fill(Infinity));
    const distances = Array.from({ length: size }, () => Array(size).fill(0));

    for (let index = 0; index < size; index += 1) {
        durations[index][index] = 0;
    }

    if (!Array.isArray(entries)) {
        throw new Error("Google Routes API no devolvio una matriz de rutas valida.");
    }

    entries.forEach((entry) => {
        const originIndex = Number(entry.originIndex);
        const destinationIndex = Number(entry.destinationIndex);
        if (!Number.isInteger(originIndex) || !Number.isInteger(destinationIndex)) return;
        const statusCode = entry.status?.code;
        if (statusCode && statusCode !== 0) return;

        const seconds = parseDurationSeconds(entry.duration);
        if (originIndex !== destinationIndex && seconds > 0) {
            durations[originIndex][destinationIndex] = seconds;
        }
        distances[originIndex][destinationIndex] = Number(entry.distanceMeters || 0);
    });

    return { durations, distances, queriedAt: new Date().toISOString() };
}

function pathDurationSeconds(order, durations) {
    let total = 0;
    let previous = 0;
    for (const clientIndex of order) {
        const matrixIndex = clientIndex + 1;
        const value = durations[previous]?.[matrixIndex];
        total += Number.isFinite(value) ? value : 86400;
        previous = matrixIndex;
    }
    return total;
}

function nearestNeighborOrder(clients, durations) {
    const remaining = clients.map((_, index) => index);
    const order = [];
    let previousMatrixIndex = 0;

    while (remaining.length) {
        let bestRemainingIndex = 0;
        let bestDuration = Infinity;
        remaining.forEach((clientIndex, remainingIndex) => {
            const matrixIndex = clientIndex + 1;
            const duration = durations[previousMatrixIndex]?.[matrixIndex] ?? Infinity;
            if (duration < bestDuration) {
                bestDuration = duration;
                bestRemainingIndex = remainingIndex;
            }
        });
        const [nextClientIndex] = remaining.splice(bestRemainingIndex, 1);
        order.push(nextClientIndex);
        previousMatrixIndex = nextClientIndex + 1;
    }

    return order;
}

function twoOptOpenPath(order, durations) {
    let best = [...order];
    let bestScore = pathDurationSeconds(best, durations);
    let improved = true;
    let guard = 0;

    while (improved && guard < 100) {
        improved = false;
        guard += 1;
        for (let start = 0; start < best.length - 1; start += 1) {
            for (let end = start + 1; end < best.length; end += 1) {
                const candidate = [
                    ...best.slice(0, start),
                    ...best.slice(start, end + 1).reverse(),
                    ...best.slice(end + 1)
                ];
                const candidateScore = pathDurationSeconds(candidate, durations);
                if (candidateScore + 1 < bestScore) {
                    best = candidate;
                    bestScore = candidateScore;
                    improved = true;
                }
            }
        }
    }

    return best;
}

function optimizeClientOrderByDuration(clients, durations) {
    const nearest = nearestNeighborOrder(clients, durations);
    const improved = twoOptOpenPath(nearest, durations);
    return improved.map((clientIndex) => clients[clientIndex]);
}

async function computeRouteDetails(originAddress, sequence) {
    const destination = sequence[sequence.length - 1];
    const intermediates = sequence.slice(0, -1);
    const body = {
        origin: { address: originAddress },
        destination: { address: destination.address },
        intermediates: intermediates.map((client) => ({ address: client.address })),
        travelMode: "DRIVE",
        routingPreference: "TRAFFIC_AWARE",
        departureTime: new Date().toISOString(),
        optimizeWaypointOrder: false,
        languageCode: "es-419",
        units: "METRIC"
    };
    const payload = await googleRoutesRequest(
        "https://routes.googleapis.com/directions/v2:computeRoutes",
        [
            "routes.distanceMeters",
            "routes.duration",
            "routes.staticDuration",
            "routes.polyline.encodedPolyline",
            "routes.legs.distanceMeters",
            "routes.legs.duration",
            "routes.legs.staticDuration",
            "routes.legs.endLocation"
        ].join(","),
        body
    );
    const route = payload?.routes?.[0];
    if (!route) throw new Error("Google Routes API no devolvio rutas para esa consulta.");
    return route;
}

function buildOptimizedRouteResponse(originAddress, sequence, route, matrix) {
    const legs = Array.isArray(route.legs) ? route.legs : [];
    return {
        origin: originAddress,
        totalClients: sequence.length,
        totalDistanceKm: Number(((route.distanceMeters || 0) / 1000).toFixed(2)),
        totalDurationText: formatDuration(route.duration),
        totalDurationSeconds: parseDurationSeconds(route.duration),
        trafficAware: true,
        optimizationMethod: matrix
            ? "routes_api_traffic_matrix_nearest_neighbor_2opt"
            : "routes_api_single_stop",
        matrixQueriedAt: matrix?.queriedAt || "",
        queriedAt: new Date().toISOString(),
        polyline: route.polyline?.encodedPolyline || "",
        googleMapsUrl: makeGoogleMapsDirectionsUrl(originAddress, sequence),
        sequence: sequence.map((client, index) => {
            const leg = legs[index] || {};
            const latLng = leg.endLocation?.latLng;
            return {
                ...client,
                stopNumber: index + 1,
                legDistanceMeters: Number(leg.distanceMeters || 0),
                legDistanceText: formatMeters(Number(leg.distanceMeters || 0)),
                legDurationText: formatDuration(leg.duration),
                legDurationSeconds: parseDurationSeconds(leg.duration),
                location: latLng ? {
                    lat: Number(latLng.latitude),
                    lng: Number(latLng.longitude)
                } : null
            };
        })
    };
}

async function optimizeRoute(clients, originAddress) {
    return computeOptimizedRoute(originAddress, clients);
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
        res.json({
            ok: true,
            service: "vrp-proyectoback",
            db: "connected",
            source: NEON_SOURCE_TABLE,
            googleMapsReady: hasGoogleMapsConfig()
        });
    } catch (error) {
        res.status(500).json({ ok: false, error: String(error.message || error) });
    }
});

app.get("/api/maps-config", (_, res) => {
    res.json({
        ok: true,
        enabled: hasGoogleMapsConfig(),
        browserApiKey: GOOGLE_MAPS_BROWSER_API_KEY,
        origin: DISTRIBUTION_ORIGIN,
        originName: DISTRIBUTION_ORIGIN_NAME,
        requiredApis: [
            "Routes API",
            "Maps JavaScript API"
        ],
        missing: [
            !GOOGLE_MAPS_API_KEY ? "GOOGLE_MAPS_SERVER_API_KEY" : "",
            !GOOGLE_MAPS_BROWSER_API_KEY ? "GOOGLE_MAPS_BROWSER_API_KEY" : ""
        ].filter(Boolean)
    });
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
