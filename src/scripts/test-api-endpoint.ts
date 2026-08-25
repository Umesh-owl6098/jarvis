/**
 * Test the API endpoint directly
 * Simulates what the UI will send
 */

import fetch from 'node-fetch';

async function testAPIEndpoint() {
  console.log('🧪 Testing API endpoint\n');

  const goal = 'Open example.com and tell me the page title';
  console.log(`📋 Task: "${goal}\n`);

  try {
    console.log('Sending request to /api/agent/execute...\n');

    // In a real scenario, this would go to http://localhost:3000/api/agent/execute
    // For testing without running the server, we'll import and test directly
    const { POST } = await import('../app/api/agent/execute/route');

    const mockRequest = {
      json: async () => ({ goal }),
    } as any;

    const response = await POST(mockRequest);
    const data = await response.json();

    console.log('📊 Response:');
    console.log(`   Status: ${data.status}`);
    console.log(`   Steps: ${data.steps}`);
    console.log(`   Tokens: ${data.tokensUsed}`);
    console.log(`   Result: ${data.result}`);
    console.log(`   Actions: ${data.actions?.join(' → ') || 'none'}\n`);

    if (data.status === 'success') {
      console.log('✅ Task completed successfully');
      console.log(`   Expected flow: navigate → extract → finish`);
      console.log(`   Actual flow: ${data.actions?.join(' → ')}`);

      // Check if it followed expected pattern
      if (data.actions?.includes('navigation') && data.actions?.includes('extraction')) {
        console.log('   ✅ Flow is reasonable\n');
      } else if (data.actions?.some((a: string) => a.includes('repeated'))) {
        console.log('   ❌ Repeated action detected\n');
      }
    } else {
      console.log(`❌ Task failed: ${data.result}`);
    }

  } catch (error: any) {
    console.error('Error:', error.message);
  }
}

testAPIEndpoint().catch(console.error);
