import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { GoogleGenAI } from "@google/genai";

/**
 * Env config
 * - GEMINI_API_KEY or GOOGLE_API_KEY: API key
 * - GENAI_BASE_URL or GEMINI_BASE_URL: override base URL (you said you'll replace this)
 * - MODEL: default model (fallback to gemini-2.5-flash)
 * - MCP_NO_START=1 prevents starting the stdio transport (useful for tests)
 */
const API_KEY =
  process.env.GEMINI_API_KEY ||
  process.env.GOOGLE_API_KEY ||
  "";

if (!API_KEY) {
  console.error("Missing GEMINI_API_KEY/GOOGLE_API_KEY");
  process.exit(1);
}

const BASE_URL =
  process.env.GENAI_BASE_URL ||
  process.env.GEMINI_BASE_URL ||
  undefined;

const DEFAULT_MODEL = process.env.MODEL || "gemini-2.5-flash";


const ai = new GoogleGenAI({
  apiKey: API_KEY,
  ...(BASE_URL ? {
    httpOptions: {
      baseUrl: BASE_URL
    }
  } : {})
});

const server = new McpServer({
  name: "mcp-gemini-web",
  version: "0.2.0"
});

/** ---------------------------------------------
 * Opinionated system instruction
 *  - Behave as a grounded research assistant.
 *  - If the query is about APIs/libraries/frameworks, emphasize official docs,
 *    versions, minimal correct examples, and precise citations.
 * --------------------------------------------- */
function systemInstruction() {
  return [
    "You are a grounded web research assistant.",
    "Always use Google Search grounding; cite trustworthy primary sources.",
    "When the user is asking about an API/library/framework:",
    "- Prefer OFFICIAL documentation, standards, and vendor references.",
    "- State version numbers when available.",
    "- Provide minimal, correct examples (no pseudocode) only if helpful.",
    "When not about APIs, still provide concise, sourced answers.",
    "Return claims that require evidence with citations."
  ].join("\n");
}

/** Common grounded call (single step) */
async function groundedCall({
  model,
  prompt,
  maxOutputTokens
}: {
  model: string;
  prompt: string;
  maxOutputTokens?: number;
}) {
  const response = await ai.models.generateContent({
    model,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: {
      tools: [{ googleSearch: {} }], // Web grounding (official API)
      systemInstruction: systemInstruction()
    },
    ...(maxOutputTokens ? { generationConfig: { maxOutputTokens } } : {})
  });

  const text =
    (response.text ?? "").trim() ||
    (response.candidates?.[0]?.content?.parts?.find((p: any) => p.text)?.text ?? "");

  const candidate: any = response.candidates?.[0] ?? {};
  const gm = candidate.groundingMetadata ?? null;

  const sources =
    gm?.groundingChunks?.map((c: any) =>
      c?.web?.uri ? { uri: c.web.uri, title: c.web.title ?? "" } : null
    ).filter(Boolean) ?? [];

  const queries = gm?.webSearchQueries ?? [];

  return { text, sources, queries, raw: response };
}

/** Multi-step "research" mode (plan → run multiple grounded queries → synthesize) */
async function researchCall({
  model,
  question,
  maxSteps = 3,
  maxOutputTokens
}: {
  model: string;
  question: string;
  maxSteps?: number;
  maxOutputTokens?: number;
}) {
  // 1) Ask Gemini to propose focused sub-queries in JSON.
  const planRes = await ai.models.generateContent({
    model,
    contents: [
      {
        role: "user",
        parts: [{
          text:
`You will create a brief research plan for this question:

"${question}"

Return STRICT JSON with:
{
  "queries": [ "query1", "query2", ... up to 6 ],
  "notes": "one sentence on focus"
}

Queries should prefer authoritative sources (official docs, standards, vendors, primary reporting).`
        }]
      }
    ],
    config: {
      tools: [{ googleSearch: {} }],
      systemInstruction: systemInstruction(),
      ...(maxOutputTokens ? { generationConfig: { maxOutputTokens, responseMimeType: "application/json" } } : { generationConfig: { responseMimeType: "application/json" } })
    }
  });

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
  const perQueryNotes: Array<{ q: string; text: string; sources: any[] }> = [];
  for (const q of queriesToRun) {
    const { text, sources } = await groundedCall({
      model,
      prompt:
        `Research focus: ${question}\n` +
        `Sub-query: ${q}\n` +
        `Synthesize key points with citations. If API/library related, highlight relevant official docs and version info.`,
      maxOutputTokens
    });
    perQueryNotes.push({ q, text, sources });
  }

  // 3) Synthesize final answer (one more grounded pass for structure).
  const synthesis = await ai.models.generateContent({
    model,
    contents: [
      { role: "user", parts: [{ text:
`Synthesize a concise answer for:
"${question}"

Use these findings (markdown bullets allowed). Do NOT fabricate sources.

${perQueryNotes.map((n, i) => `Q${i+1}: ${n.q}\n---\n${n.text}`).join("\n\n")}
` }] }
    ],
    config: {
      tools: [{ googleSearch: {} }],
      systemInstruction: systemInstruction()
    },
    ...(maxOutputTokens ? { generationConfig: { maxOutputTokens } } : {})
  });

  const dedup = new Map<string, { uri: string; title: string }>();
  const allSources = perQueryNotes.flatMap(n => n.sources);
  for (const s of allSources) if (s?.uri && !dedup.has(s.uri)) dedup.set(s.uri, s);
  const queriesUsed = queriesToRun;

  return {
    text: synthesis.text || perQueryNotes.map(n => n.text).join("\n\n"),
    sources: [...dedup.values()],
    queries: queriesUsed
  };
}

/** Single tool: web_search */
server.registerTool(
  "web_search",
  {
    title: "Grounded web search (Gemini + Google Search)",
    description:
      "Grounded search with citations. mode='normal' for a single pass; mode='research' for a multi-step, deeper approach.",
    inputSchema: z.object({
      q: z.string().min(1).describe("User query"),
      mode: z.enum(["normal", "research"]).default("normal")
        .describe("Search mode: 'normal' (fast) or 'research' (deeper multi-step)"),
      model: z.string().default(DEFAULT_MODEL),
      max_tokens: z.number().int().min(64).max(8192).optional(),
      max_steps: z.number().int().min(1).max(6).default(3)
        .describe("Only used in research mode: number of sub-queries to run (1-6)")
    }).shape
  },
  async ({ q, mode, model, max_tokens, max_steps }) => {
    if (mode === "research") {
      const { text, sources, queries } = await researchCall({
        model,
        question: q,
        maxSteps: max_steps,
        maxOutputTokens: max_tokens
      });
      return {
        content: [
          {
            type: "text",
            text: `${text}\n\n--- Research Metadata ---\nMode: ${mode}\nQueries used: ${queries.join(', ')}\nSources found: ${sources.length}\n\nSources:\n${sources.map((s: any) => `- ${s.title || 'Untitled'}: ${s.uri}`).join('\n')}`
          }
        ]
      };
    } else {
      const { text, sources, queries } = await groundedCall({
        model,
        prompt: q,
        maxOutputTokens: max_tokens
      });
      return {
        content: [
          {
            type: "text",
            text: `${text}\n\n--- Search Metadata ---\nMode: ${mode}\nQueries used: ${queries.join(', ')}\nSources found: ${sources.length}\n\nSources:\n${sources.map((s: any) => `- ${s.title || 'Untitled'}: ${s.uri}`).join('\n')}`
          }
        ]
      };
    }
  }
);

// Start stdio unless disabled (for tests)
async function start() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
if (process.env.MCP_NO_START !== "1") {
  start();
}

export { server, groundedCall, researchCall };