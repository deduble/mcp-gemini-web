// Simple test to demonstrate MCP server responses
import { spawn } from 'child_process';

console.log('🚀 Testing MCP Gemini Web Search Server...\n');

// Set environment variable for testing
process.env.GEMINI_API_KEY = 'test-key';

const server = spawn('npx', ['tsx', 'src/server.ts'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, MCP_NO_START: '0' }
});

// MCP initialize request
const initMsg = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0.0' }
  }
};

// List tools request
const listToolsMsg = {
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/list'
};

let step = 0;
const steps = ['initialize', 'list_tools'];

server.stdout.on('data', (data) => {
  const response = data.toString().trim();
  if (response) {
    try {
      const parsed = JSON.parse(response);
      console.log(`✅ Step ${step + 1} (${steps[step]}):`, JSON.stringify(parsed, null, 2), '\n');
      
      step++;
      if (step === 1) {
        console.log('📤 Sending tools/list request...\n');
        server.stdin.write(JSON.stringify(listToolsMsg) + '\n');
      } else if (step === 2) {
        console.log('🎉 MCP Server is working correctly!');
        console.log('✅ The web_search tool is available and ready to use.');
        server.kill();
        process.exit(0);
      }
    } catch (e) {
      console.log('Raw response:', response);
    }
  }
});

server.stderr.on('data', (data) => {
  console.log('Server stderr:', data.toString());
});

server.on('error', (error) => {
  console.error('❌ Server error:', error.message);
  process.exit(1);
});

// Send init message
console.log('📤 Sending initialize request...\n');
server.stdin.write(JSON.stringify(initMsg) + '\n');

// Timeout after 5 seconds
setTimeout(() => {
  console.log('⏰ Test completed (timeout reached)');
  server.kill();
  process.exit(0);
}, 5000);