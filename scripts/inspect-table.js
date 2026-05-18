const { Pool } = require("pg");

const DATABASE_URL = process.env.DATABASE_URL || "";
const TABLE_NAME = process.env.TABLE_NAME || "hojas_ruta_exportadas";
const SAMPLE_LIMIT = Math.min(Number(process.env.SAMPLE_LIMIT || 5), 20);

if (!DATABASE_URL) {
    throw new Error("Falta DATABASE_URL.");
}

function quoteIdent(identifier) {
    return `"${String(identifier).replace(/"/g, "\"\"")}"`;
}

function parseTableRef(tableRef) {
    const parts = String(tableRef || "").split(".");
    if (parts.length === 2) return { schema: parts[0], table: parts[1] };
    return { schema: "public", table: String(tableRef || "") };
}

async function run() {
    const pool = new Pool({
        connectionString: DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });

    try {
        const { schema, table } = parseTableRef(TABLE_NAME);
        const columns = await pool.query(
            `SELECT column_name, data_type
             FROM information_schema.columns
             WHERE table_schema = $1 AND table_name = $2
             ORDER BY ordinal_position`,
            [schema, table]
        );
        const tableRef = `${quoteIdent(schema)}.${quoteIdent(table)}`;
        const count = await pool.query(`SELECT COUNT(*)::int AS total FROM ${tableRef}`);
        const sample = await pool.query(`SELECT * FROM ${tableRef} LIMIT $1`, [SAMPLE_LIMIT]);

        console.log(JSON.stringify({
            table: `${schema}.${table}`,
            columns: columns.rows,
            count: count.rows[0],
            sample: sample.rows
        }, null, 2));
    } finally {
        await pool.end();
    }
}

run().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
});
