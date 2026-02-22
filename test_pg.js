const { Pool } = require('pg');

const pool = new Pool({
    connectionString: 'postgresql://neondb_owner:npg_aZBm5IU0kdst@ep-lucky-resonance-a1onlowx-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require',
    ssl: { rejectUnauthorized: false }
});

async function test() {
    try {
        const result = await pool.query('SELECT NOW() as now, current_database() as db, version() as ver');
        console.log('✅ CONNECTED TO NEON!');
        console.log('   Time:', result.rows[0].now);
        console.log('   Database:', result.rows[0].db);
        console.log('   Version:', result.rows[0].ver.substring(0, 50));

        // Test table creation
        await pool.query('CREATE TABLE IF NOT EXISTS test_table (id SERIAL PRIMARY KEY, msg TEXT)');
        await pool.query("INSERT INTO test_table (msg) VALUES ('hello from ghost relay')");
        const r2 = await pool.query('SELECT * FROM test_table');
        console.log('   Test table rows:', r2.rows.length);
        await pool.query('DROP TABLE test_table');
        console.log('   Table CRUD: ✅');

        console.log('\n🎯 CONNECTION VERIFIED. Ready for deployment!');
        await pool.end();
    } catch (e) {
        console.error('❌ Failed:', e.message);
        await pool.end();
    }
}

test();
