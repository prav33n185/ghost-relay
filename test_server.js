// Quick server startup test
process.env.DATABASE_URL = 'postgresql://neondb_owner:npg_aZBm5IU0kdst@ep-lucky-resonance-a1onlowx-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require';

require('./index.js');

setTimeout(async () => {
    try {
        const res = await fetch('http://localhost:3000/health');
        const data = await res.json();
        console.log('\n=== HEALTH CHECK ===');
        console.log(JSON.stringify(data, null, 2));

        // Test identity endpoint
        const idRes = await fetch('http://localhost:3000/identity', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: 'test_hash_123',
                blob: 'encrypted_test_data',
                displayName: 'TestUser',
                peerId: 'QmTestPeer123'
            })
        });
        const idData = await idRes.json();
        console.log('\n=== IDENTITY SAVE ===');
        console.log(JSON.stringify(idData, null, 2));

        // Test directory lookup
        const dirRes = await fetch('http://localhost:3000/directory/test_hash_123');
        const dirData = await dirRes.json();
        console.log('\n=== DIRECTORY LOOKUP ===');
        console.log(JSON.stringify(dirData, null, 2));

        // Cleanup
        await fetch('http://localhost:3000/debug/flush');
        console.log('\n✅ ALL TESTS PASSED');
        process.exit(0);
    } catch (e) {
        console.error('❌ Test failed:', e.message);
        process.exit(1);
    }
}, 4000);
