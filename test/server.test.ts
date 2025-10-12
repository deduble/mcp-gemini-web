import { describe, it, expect, vi } from "vitest";

// Prevent starting the stdio transport in tests
process.env.MCP_NO_START = "1";

// Simple call counter to branch mock behavior
let callCount = 0;

// Mock @google/genai
vi.mock("@google/genai", () => {
  return {
    GoogleGenAI: vi.fn().mockImplementation(() => {
      return {
        models: {
          generateContent: vi.fn().mockImplementation(async (args: any) => {
            callCount++;
            // If the model asked for JSON planning (research step 1)
            if (args?.config?.generationConfig?.responseMimeType === "application/json") {
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

// Import after mocks
import { groundedCall, researchCall } from "../src/server";

describe("groundedCall", () => {
  it("returns text and sources", async () => {
    const res = await groundedCall({ model: "gemini-2.5-flash", prompt: "hello" });
    expect(res.text).toMatch(/Answer/);
    expect(Array.isArray(res.sources)).toBe(true);
  });
});

describe("researchCall", () => {
  it("plans queries and synthesizes", async () => {
    const res = await researchCall({ model: "gemini-2.5-flash", question: "foo bar", maxSteps: 2 });
    expect(res.text).toContain("Answer");
    expect(res.queries.length).toBeGreaterThan(0);
  });
});