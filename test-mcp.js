#!/usr/bin/env node

// Simple MCP client test - sends a web_search request to the running MCP server
const { spawn } = require('child_process');

// Set a dummy API key for testing (server will use mocked responses if no real key)
process.env.GEMINI_API_KEY = 'test-key-for-demo';

// Start the MCP server
const server = spawn('npx', ['tsx', 'src/server.ts'], {
  stdio: ['pipe', 'pipe', 'inherit']
});

// MCP initialization request
const initRequest = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0.0' }
  }
};

// Web search tool call request
const searchRequest = {
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/call',
  params: {
    name: 'web_search',
    arguments: {
      q: 'What is Node.js?',
      mode: 'normal'
    }
  }
};

let responseCount = 0;

server.stdout.on('data', (data) => {
  const lines = data.toString().split('\n').filter(line => line.trim());
  
  lines.forEach(line => {
    if (line.trim()) {
      try {
        const response = JSON.parse(line);
        console.log('📥 Response:', JSON.stringify(response, null, 2));
        
        responseCount++;
        
        // After init, send search request
        if (responseCount === 1) {
          console.log('📤 Sending search request...');
          server.stdin.write(JSON.stringify(searchRequest) + '\n');
        }
        
        // After search response, close
        if (responseCount === 2) {
          console.log('✅ Test completed successfully!');
          server.kill();
          process.exit(0);
        }
      } catch (e) {
        console.log('Raw output:', line);
      }
    }
  });
});

server.on('error', (error) => {
  console.error('❌ Server error:', error);
  process.exit(1);
});

// Send initialization request
console.log('📤 Sending init request...');
server.stdin.write(JSON.stringify(initRequest) + '\n');

// Timeout after 10 seconds
setTimeout(() => {
  console.log('⏰ Test timed out');
  server.kill();
  process.exit(1);
}, 10000);