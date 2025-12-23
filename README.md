# MCP Gemini Web Search

A Model Context Protocol (MCP) server that provides grounded web search and research powered by Google's Gemini models + Google Search grounding, with retries, rate limiting, and health checks.

## Features

- **`web_search` tool** with dual modes:
  - `normal`: Fast, single-step grounded search
  - `research`: Multi-step research with query planning → execution → synthesis
- **`web_search_batch` tool** to run up to 20 independent searches in parallel
- **`health_check` tool** for metrics (and optional live probe)
- **Google Search grounding** for accurate, cited results
- **Opinionated system instructions** that prioritize official documentation for API/library queries
- **Resilience features**: rate limiting, retries (exponential backoff + jitter), and per-request timeouts
- **Configurable models and endpoints** (supports custom base URLs via `httpOptions.baseUrl`)

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

- `GEMINI_API_KEY` or `GOOGLE_API_KEY` (required): Google AI API key
- `GENAI_BASE_URL` or `GEMINI_BASE_URL` (optional): Custom API endpoint base URL
- `MODEL` (optional): Default model (default: `gemini-3-flash-preview`)
- `REQUEST_TIMEOUT` (optional): Default request timeout in ms (default: `60000`)

Rate limiting:
- `RATE_LIMIT_RPM` (optional): Requests per minute (default: `60`)
- `RATE_LIMIT_MAX_BURST` (optional): Max burst capacity (default: `10`)

Retries:
- `MAX_RETRIES` (optional): Max retry attempts (default: `5`)
- `BASE_RETRY_DELAY` (optional): Base delay in ms (default: `1000`)
- `MAX_RETRY_DELAY` (optional): Max delay in ms (default: `60000`)
- `JITTER_FACTOR` (optional): Jitter factor 0-1 (default: `0.1`)

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
    "mode": "normal",
    "verbosity": "normal",
    "include_sources": true
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
    "max_steps": 4,
    "research_concurrency": "parallel"
  }
}
```

### Batch Search (Parallel)
```json
{
  "tool": "web_search_batch",
  "arguments": {
    "queries": [
      "Node.js 22 release notes",
      "TypeScript 5.6 new features",
      "Vitest 2 migration guide"
    ],
    "include_sources": false
  }
}
```

### Health Check
```json
{
  "tool": "health_check",
  "arguments": {
    "include_metrics": true,
    "probe": false
  }
}
```

### Health Check (Live Probe)
```json
{
  "tool": "health_check",
  "arguments": {
    "include_metrics": true,
    "probe": true,
    "probe_timeout": 10000
  }
}
```

## Tool Parameters

### `web_search`
- `q` (string, required): Search query
- `mode` (`"normal"` | `"research"`, optional): Default `"normal"`
- `model` (string, optional): Model to use (default: `MODEL` env or `gemini-3-flash-preview`)
- `verbosity` (`"concise"` | `"normal"` | `"detailed"`, optional): Default `"normal"`
- `max_tokens` (number, optional): Overrides verbosity (64–131072)
- `max_steps` (number, optional): Research steps (1–6, default: 3; only in `research` mode)
- `research_concurrency` (`"parallel"` | `"sequential"`, optional): Default `"parallel"` (only in `research` mode)
- `include_sources` (boolean, optional): Include sources + metadata footer (default: `false`)
- `timeout` (number, optional): Per-request timeout in ms (5000–300000)

### `web_search_batch`
- `queries` (string[], required): 1–20 queries
- `model`, `verbosity`, `max_tokens`, `include_sources`, `timeout`: Same meaning as `web_search` (applies per query)

### `health_check`
- `include_metrics` (boolean, optional): Default `true`
- `probe` (boolean, optional): If true, performs a lightweight API call (default `false`)
- `probe_timeout` (number, optional): Probe timeout in ms (1000–30000, default `10000`)

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
