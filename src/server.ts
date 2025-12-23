#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createGeminiClient, systemInstruction } from "./lib/client.js";

/**
 * Env config
 * - GEMINI_API_KEY or GOOGLE_API_KEY: API key (required)
 * - GENAI_BASE_URL or GEMINI_BASE_URL: override base URL
 * - MODEL: default model (fallback to gemini-3-flash-preview)
 * - MCP_NO_START=1 prevents starting the stdio transport (useful for tests)
 *
 * Rate limiting:
 * - RATE_LIMIT_RPM: Requests per minute (default: 60)
 * - RATE_LIMIT_MAX_BURST: Maximum burst capacity (default: 10)
 *
 * Retry configuration:
 * - MAX_RETRIES: Maximum retry attempts (default: 5)
 * - BASE_RETRY_DELAY: Base retry delay in ms (default: 1000)
 * - MAX_RETRY_DELAY: Maximum retry delay in ms (default: 60000)
 *
 * Timeout:
 * - REQUEST_TIMEOUT: Default request timeout in ms (default: 60000)
 */

const DEFAULT_MODEL = process.env.MODEL || "gemini-3-flash-preview";

/** Token limits for verbosity levels */
const VERBOSITY_TOKENS: Record<string, number> = {
  concise: 4096,
  normal: 16384,
  detailed: 65535
};

let geminiClient: ReturnType<typeof createGeminiClient> | undefined;
function getGeminiClient() {
  geminiClient ??= createGeminiClient();
  return geminiClient;
}

const server = new McpServer({
  name: "mcp-gemini-web",
  version: "0.3.1"
});

/** ---------------------------------------------
 * Opinionated system instruction
 *  - Behave as a grounded research assistant.
 *  - If the query is about APIs/libraries/frameworks, emphasize official docs,
 *    versions, minimal correct examples, and precise citations.
 * --------------------------------------------- */

/** Common grounded call (single step) */
async function groundedCall({
  model,
  prompt,
  maxOutputTokens,
  timeout
}: {
  model: string;
  prompt: string;
  maxOutputTokens?: number;
  timeout?: number;
}) {
  return await getGeminiClient().generateContent({
    model,
    prompt,
    maxOutputTokens,
    systemInstruction: systemInstruction(),
    useSearch: true
  }, timeout);
}

/** Multi-step "research" mode with configurable concurrency */
async function researchCall({
  model,
  question,
  maxSteps = 3,
  maxOutputTokens,
  concurrency = "parallel",
  timeout
}: {
  model: string;
  question: string;
  maxSteps?: number;
  maxOutputTokens?: number;
  concurrency?: "parallel" | "sequential";
  timeout?: number;
}) {
  // 1) Ask Gemini to propose focused sub-queries in JSON.
  const planRes = await getGeminiClient().generateContent({
    model,
    prompt:
      `You will create a brief research plan for this question:

"${question}"

Return STRICT JSON with:
{
  "queries": [ "query1", "query2", ... up to 6 ],
  "notes": "one sentence on focus"
}

Queries should prefer authoritative sources (official docs, standards, vendors, primary reporting).`,
    systemInstruction: systemInstruction(),
    responseMimeType: "application/json",
    useSearch: true
  }, timeout);

  // Be permissive parsing (SDK returns .text even for JSON mode)
  let plan: { queries: string[]; notes?: string } = { queries: [] };
  try {
    plan = JSON.parse(planRes.text || "{}");
  } catch {
    // Fallback: a naive extraction if the model didn't obey JSON perfectly
    const match = (planRes.text || "").match(/\[\s*"(.*?)"\s*\]/s);
    const arr = match ? match[1].split(/"\s*,\s*"/g) : [];
    plan.queries = arr;
  }
  if (!Array.isArray(plan.queries) || plan.queries.length === 0) {
    plan.queries = [question];
  }

  // Limit queries to maxSteps
  const queriesToRun = plan.queries.slice(0, Math.max(1, maxSteps));

  // 2) Run grounded searches for each planned query.
  const perQueryNotes: Array<{ q: string; text: string; sources: Array<{ uri: string; title: string }> }> = [];

  if (concurrency === "parallel") {
    // Parallel execution using Promise.allSettled for resilience
    const results = await Promise.allSettled(
      queriesToRun.map((q) =>
        groundedCall({
          model,
          prompt:
            `Research focus: ${question}\n` +
            `Sub-query: ${q}\n` +
            `Synthesize key points with citations. If API/library related, highlight relevant official docs and version info.`,
          maxOutputTokens,
          timeout
        })
      )
    );

    // Process results, collecting successful ones
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === "fulfilled") {
        perQueryNotes.push({ q: queriesToRun[i], text: result.value.text, sources: result.value.sources });
      } else {
        // On failure, add a note but continue
        perQueryNotes.push({ q: queriesToRun[i], text: `[Error: ${result.reason}]`, sources: [] });
      }
    }
  } else {
    // Sequential execution (original behavior)
    for (const q of queriesToRun) {
      const { text, sources } = await groundedCall({
        model,
        prompt:
          `Research focus: ${question}\n` +
          `Sub-query: ${q}\n` +
          `Synthesize key points with citations. If API/library related, highlight relevant official docs and version info.`,
        maxOutputTokens,
        timeout
      });
      perQueryNotes.push({ q, text, sources });
    }
  }

  // 3) Synthesize final answer (one more grounded pass for structure).
  const synthesis = await getGeminiClient().generateContent({
    model,
    prompt:
      `Synthesize a concise answer for:
"${question}"

Use these findings (markdown bullets allowed). Do NOT fabricate sources.

${perQueryNotes.map((n, i) => `Q${i + 1}: ${n.q}\n---\n${n.text}`).join("\n\n")}
`,
    systemInstruction: systemInstruction(),
    useSearch: true
  }, timeout);

  const dedup = new Map<string, { uri: string; title: string }>();
  const allSources = perQueryNotes.flatMap((n) => n.sources);
  for (const s of allSources) if (s?.uri && !dedup.has(s.uri)) dedup.set(s.uri, s);

  return {
    text: synthesis.text || perQueryNotes.map((n) => n.text).join("\n\n"),
    sources: [...dedup.values()],
    queries: queriesToRun
  };
}

/** Helper to format response based on include_sources option */
function formatResponse(
  text: string,
  mode: string,
  sources: Array<{ uri: string; title: string }>,
  queries: string[],
  includeSources: boolean
): string {
  if (!includeSources) {
    return text;
  }
  const metadataLabel = mode === "research" ? "Research Metadata" : "Search Metadata";
  return `${text}\n\n--- ${metadataLabel} ---\nMode: ${mode}\nQueries used: ${queries.join(', ')}\nSources found: ${sources.length}\n\nSources:\n${sources.map((s) => `- ${s.title || 'Untitled'}: ${s.uri}`).join('\n')}`;
}

/** Helper to format batch response */
function formatBatchResponse(
  results: Array<{ success: boolean; data?: any; error?: Error }>,
  includeSources: boolean
): string {
  const parts = results.map((result, i) => {
    if (result.success) {
      const content = includeSources
        ? formatResponse(result.data.text, "batch", result.data.sources, result.data.queries, true)
        : result.data.text;
      return `## Query ${i + 1} (Success)\n\n${content}`;
    }
    return `## Query ${i + 1} (Failed)\n\nError: ${result.error?.message || "Unknown error"}`;
  });

  return parts.join("\n\n---\n\n");
}

/** ---------------------------------------------
 * Tool: web_search
 * --------------------------------------------- */
server.registerTool(
  "web_search",
  {
    title: "Grounded web search (Gemini + Google Search)",
    description:
      "Grounded search with citations. mode='normal' for a single pass; mode='research' for a multi-step, deeper approach. Use verbosity to control output length.",
    inputSchema: z.object({
      q: z.string().min(1).describe("User query"),
      mode: z.enum(["normal", "research"]).default("normal")
        .describe("Search mode: 'normal' (fast) or 'research' (deeper multi-step)"),
      model: z.string().default(DEFAULT_MODEL)
        .describe("Model to use. Options: gemini-3-flash-preview (default), gemini-3-pro-preview, gemini-2.5-flash, gemini-2.5-pro"),
      verbosity: z.enum(["concise", "normal", "detailed"]).default("normal")
        .describe("Output length: 'concise' (~4096 tokens), 'normal' (~16384 tokens), 'detailed' (~65535 tokens)"),
      max_tokens: z.number().int().min(64).max(131072).optional()
        .describe("Override verbosity with exact token limit"),
      max_steps: z.number().int().min(1).max(6).default(3)
        .describe("Only used in research mode: number of sub-queries to run (1-6)"),
      include_sources: z.boolean().default(false)
        .describe("Include source citations and metadata in response"),
      research_concurrency: z.enum(["parallel", "sequential"]).default("parallel")
        .describe("In research mode: run sub-queries in parallel or sequentially"),
      timeout: z.number().int().min(5000).max(300000).optional()
        .describe("Request timeout in milliseconds")
    }).shape
  },
  async ({ q, mode, model, verbosity, max_tokens, max_steps, include_sources, research_concurrency, timeout }) => {
    // Determine token limit: explicit max_tokens overrides verbosity preset
    const tokenLimit = max_tokens ?? VERBOSITY_TOKENS[verbosity] ?? VERBOSITY_TOKENS.normal;

    if (mode === "research") {
      const { text, sources, queries } = await researchCall({
        model,
        question: q,
        maxSteps: max_steps,
        maxOutputTokens: tokenLimit,
        concurrency: research_concurrency,
        timeout
      });
      return {
        content: [
          {
            type: "text",
            text: formatResponse(text, mode, sources, queries, include_sources)
          }
        ]
      };
    } else {
      const { text, sources, queries } = await groundedCall({
        model,
        prompt: q,
        maxOutputTokens: tokenLimit,
        timeout
      });
      return {
        content: [
          {
            type: "text",
            text: formatResponse(text, mode, sources, queries, include_sources)
          }
        ]
      };
    }
  }
);

/** ---------------------------------------------
 * Tool: web_search_batch
 * --------------------------------------------- */
server.registerTool(
  "web_search_batch",
  {
    title: "Batch grounded web search (parallel queries)",
    description:
      "Run multiple web search queries in parallel. All queries are executed concurrently for faster results. Returns results for each query with individual success/failure status.",
    inputSchema: z.object({
      queries: z.array(z.string().min(1)).min(1).max(20)
        .describe("Array of queries to run in parallel (max 20)"),
      model: z.string().default(DEFAULT_MODEL)
        .describe("Model to use. Options: gemini-3-flash-preview (default), gemini-3-pro-preview, gemini-2.5-flash, gemini-2.5-pro"),
      verbosity: z.enum(["concise", "normal", "detailed"]).default("normal")
        .describe("Output length: 'concise' (~4096 tokens), 'normal' (~16384 tokens), 'detailed' (~65535 tokens)"),
      max_tokens: z.number().int().min(64).max(131072).optional()
        .describe("Override verbosity with exact token limit"),
      include_sources: z.boolean().default(false)
        .describe("Include source citations and metadata in response"),
      timeout: z.number().int().min(5000).max(300000).optional()
        .describe("Per-request timeout in milliseconds")
    }).shape
  },
  async ({ queries, model, verbosity, max_tokens, include_sources, timeout }) => {
    const tokenLimit = max_tokens ?? VERBOSITY_TOKENS[verbosity] ?? VERBOSITY_TOKENS.normal;

    const results = await getGeminiClient().generateContentBatch(
      queries.map((q) => ({
        model,
        prompt: q,
        maxOutputTokens: tokenLimit,
        systemInstruction: systemInstruction(),
        useSearch: true
      })),
      timeout
    );

    return {
      content: [
        {
          type: "text",
          text: formatBatchResponse(results, include_sources)
        }
      ]
    };
  }
);

/** ---------------------------------------------
 * Tool: health_check
 * --------------------------------------------- */
server.registerTool(
  "health_check",
  {
    title: "Check MCP server health",
    description: "Returns health status and metrics including request counts, rate limit status, and error information.",
    inputSchema: z.object({
      probe: z.boolean().default(false)
        .describe("Perform a real API probe (lightweight request)"),
      probe_timeout: z.number().int().min(1000).max(30000).default(10000)
        .describe("Timeout for probe request in milliseconds"),
      include_metrics: z.boolean().default(true)
        .describe("Include detailed metrics in response")
    }).shape
  },
  async ({ probe, probe_timeout, include_metrics }) => {
    let probeResult: boolean | undefined;
    let metrics: any;
    try {
      const client = getGeminiClient();
      probeResult = probe ? await client.healthCheck(probe_timeout) : undefined;
      metrics = client.getMetrics();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      metrics = {
        healthy: false,
        uptime: 0,
        requestsTotal: 0,
        requestsPending: 0,
        lastError: message,
        lastErrorTime: Date.now(),
        rateLimitTokens: 0
      };
      probeResult = false;
    }

    if (include_metrics) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ...metrics, probe: probeResult }, null, 2)
          }
        ]
      };
    }

    return {
      content: [
        {
          type: "text",
          text:
            `Status: ${metrics.healthy ? "healthy" : "unhealthy"}` +
            (probeResult === undefined ? "" : `\nProbe: ${probeResult ? "ok" : "failed"}`) +
            `\nUptime: ${metrics.uptime}s\nPending requests: ${metrics.requestsPending}`
        }
      ]
    };
  }
);

// Start stdio unless disabled (for tests)
async function start() {
  try {
    getGeminiClient();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (process.env.MCP_NO_START !== "1") {
  start();
}

// Export for testing
export { server, groundedCall, researchCall, getGeminiClient };
