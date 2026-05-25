const { Pool } = require("pg");

const DATABASE_URL = process.env.DATABASE_URL || "";

if (!DATABASE_URL) {
    throw new Error("Falta DATABASE_URL.");
}

function getDatabaseSslConfig(connectionString) {
    const mode = new URL(connectionString).searchParams.get("sslmode");
    return String(mode || "").toLowerCase() === "disable" ? false : { rejectUnauthorized: false };
}

async function run() {
    const pool = new Pool({
        connectionString: DATABASE_URL,
        ssl: getDatabaseSslConfig(DATABASE_URL)
    });

    try {
        const sheets = await pool.query(`
            SELECT
                id_hoja::text,
                ruta_nombre,
                fecha_entrega::text,
                conductor,
                numero_camion,
                total_despachos,
                total_cestas,
                jsonb_array_length(COALESCE(facturas, '[]'::jsonb)) AS paradas
            FROM public.hojas_ruta_exportadas
            ORDER BY fecha_entrega DESC, id_hoja DESC
        `);
        const firstInvoice = await pool.query(`
            SELECT id_hoja::text, jsonb_pretty(facturas->0) AS factura
            FROM public.hojas_ruta_exportadas
            WHERE jsonb_array_length(COALESCE(facturas, '[]'::jsonb)) > 0
            ORDER BY fecha_entrega DESC, id_hoja DESC
            LIMIT 1
        `);

        console.log(JSON.stringify({
            sheets: sheets.rows,
            firstInvoice: firstInvoice.rows[0] || null
        }, null, 2));
    } finally {
        await pool.end();
    }
}

run().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
});
