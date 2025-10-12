# MCP Gemini Web Search

A Model Context Protocol (MCP) server that provides grounded web search capabilities powered by Google's Gemini 2.5 Flash and Google Search grounding.

## Features

- **Single `web_search` tool** with dual modes:
  - `normal`: Fast, single-step grounded search
  - `research`: Multi-step research with query planning → execution → synthesis
- **Google Search grounding** for accurate, cited results
- **Opinionated system instructions** that prioritize official documentation for API/library queries
- **Configurable models and endpoints**

## Installation

### Via npx (Recommended)
```bash
npx -y mcp-gemini-web
```

### Via npm install
```bash
npm install -g mcp-gemini-web
mcp-gemini-web
```

## Environment Variables

- `GEMINI_API_KEY` or `GOOGLE_API_KEY`: Required - Your Google AI API key
- `GENAI_BASE_URL` or `GEMINI_BASE_URL`: Optional - Custom API endpoint
- `MODEL`: Optional - Model to use (default: `gemini-2.5-flash`)

## MCP Client Configuration

### Claude Desktop
Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "gemini-web": {
      "command": "npx",
      "args": ["-y", "mcp-gemini-web"],
      "env": {
        "GEMINI_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

### Other MCP Clients
The server communicates via stdio using the MCP protocol. Configure your client to run:
```bash
npx -y mcp-gemini-web
```

## Usage Examples

### Normal Search (Fast)
```json
{
  "tool": "web_search",
  "arguments": {
    "q": "what is Node.js 22 LTS",
    "mode": "normal"
  }
}
```

### Research Mode (Deep)
```json
{
  "tool": "web_search",
  "arguments": {
    "q": "compare axios vs fetch for production Node.js usage",
    "mode": "research", 
    "max_steps": 4
  }
}
```

## Tool Parameters

- `q` (string, required): The search query
- `mode` (enum, optional): Search mode - `"normal"` (default) or `"research"`
- `model` (string, optional): Gemini model to use
- `max_tokens` (number, optional): Max output tokens (64-8192)
- `max_steps` (number, optional): Max research steps for research mode (1-6, default: 3)

## Development

```bash
# Clone and install
git clone <repository-url>
cd mcp-gemini-web
npm install

# Development mode
npm run dev

# Build
npm run build

# Test
npm test

# Start built version
npm start
```

## License

MIT

## Contributing

Pull requests welcome! Please ensure tests pass and follow the existing code style.