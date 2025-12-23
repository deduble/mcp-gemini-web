import { describe, it, expect, vi } from "vitest";

process.env.MCP_NO_START = "1";
process.env.GEMINI_API_KEY = "test";

// Simple call counter to branch mock behavior
let callCount = 0;
let lastArgs: any = null;

// Mock @google/genai
vi.mock("@google/genai", () => {
  return {
    GoogleGenAI: vi.fn().mockImplementation(() => {
      return {
        models: {
          generateContent: vi.fn().mockImplementation(async (args: any) => {
            callCount++;
            lastArgs = args;
            // If the model asked for JSON planning (research step 1)
            if (args?.config?.responseMimeType === "application/json") {
              return {
                text: JSON.stringify({ queries: ["site:example.com docs foo", "foo api reference"], notes: "test" }),
                candidates: [{ groundingMetadata: { webSearchQueries: ["planner"], groundingChunks: [] } }]
              };
            }
            // Otherwise return a grounded snippet
            return {
              text: `Answer ${callCount}`,
              candidates: [
                {
                  groundingMetadata: {
                    webSearchQueries: ["q1", "q2"],
                    groundingChunks: [
                      { web: { uri: "https://example.com", title: "Example" } }
                    ]
                  }
                }
              ]
            };
          })
        }
      };
    })
  };
});

const { groundedCall, researchCall, getGeminiClient } = await import("../src/server");
const geminiClient = getGeminiClient();

describe("groundedCall", () => {
  it("returns text and sources", async () => {
    const res = await groundedCall({ model: "gemini-2.5-flash", prompt: "hello" });
    expect(res.text).toMatch(/Answer/);
    expect(Array.isArray(res.sources)).toBe(true);
  });

  it("supports timeout parameter", async () => {
    const res = await groundedCall({ model: "gemini-2.5-flash", prompt: "hello", timeout: 10000 });
    expect(res.text).toMatch(/Answer/);
    expect(lastArgs?.config?.httpOptions?.timeout).toBe(10000);
  });
});

describe("researchCall", () => {
  it("plans queries and synthesizes in parallel mode", async () => {
    callCount = 0; // Reset counter
    const res = await researchCall({
      model: "gemini-2.5-flash",
      question: "foo bar",
      maxSteps: 2,
      concurrency: "parallel"
    });
    expect(res.text).toContain("Answer");
    expect(res.queries.length).toBeGreaterThan(0);
  });

  it("plans queries and synthesizes in sequential mode", async () => {
    callCount = 0; // Reset counter
    const res = await researchCall({
      model: "gemini-2.5-flash",
      question: "foo bar",
      maxSteps: 2,
      concurrency: "sequential"
    });
    expect(res.text).toContain("Answer");
    expect(res.queries.length).toBeGreaterThan(0);
  });

  it("supports timeout parameter", async () => {
    callCount = 0;
    const res = await researchCall({
      model: "gemini-2.5-flash",
      question: "foo bar",
      maxSteps: 2,
      timeout: 15000
    });
    expect(res.text).toContain("Answer");
  });
});

describe("geminiClient", () => {
  it("provides health metrics", () => {
    const metrics = geminiClient.getMetrics();
    expect(metrics).toHaveProperty("healthy");
    expect(metrics).toHaveProperty("uptime");
    expect(metrics).toHaveProperty("requestsTotal");
    expect(metrics).toHaveProperty("rateLimitTokens");
  });

  it("can perform a live health probe", async () => {
    const ok = await geminiClient.healthCheck(1000);
    expect(ok).toBe(true);
  });

  it("provides estimated wait time", () => {
    const waitTime = geminiClient.getEstimatedWaitTime();
    expect(typeof waitTime).toBe("number");
    expect(waitTime).toBeGreaterThanOrEqual(0);
  });
});
