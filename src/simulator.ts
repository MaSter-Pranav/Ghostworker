import OpenAI from "openai";
import { parseExpressionAt } from "acorn";
import type { AdapterFunction, JsonRecord } from "./registry.js";

const modelName = process.env.OPENAI_MODEL || "gpt-5.6";
const demoMode = process.env.GHOSTWORKER_DEMO_MODE === "true";
let client: OpenAI | undefined;

const getClient = (): OpenAI => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required unless GHOSTWORKER_DEMO_MODE=true");
  client ??= new OpenAI({ apiKey });
  return client;
};
const forbiddenSyntax = /\b(?:require|import|eval|Function|process|global|fetch|XMLHttpRequest|WebSocket|setTimeout|setInterval|while|for|do|constructor|prototype|__proto__)\b/;
const allowedNodeTypes = new Set([
  "ArrowFunctionExpression", "Identifier", "ObjectExpression", "Property", "MemberExpression",
  "Literal", "ConditionalExpression", "LogicalExpression", "BinaryExpression", "UnaryExpression",
  "ArrayExpression", "ChainExpression", "CallExpression", "TemplateLiteral", "TemplateElement",
]);

const validateAdapterAst = (code: string): void => {
  const expression = parseExpressionAt(code, 0, { ecmaVersion: "latest" }) as unknown as { type: string; end: number; [key: string]: unknown };
  if (expression.end !== code.length || expression.type !== "ArrowFunctionExpression") throw new Error("Adapter must be a single arrow-function expression");
  const walk = (node: unknown, parentField?: string): void => {
    if (!node || typeof node !== "object") return;
    const candidate = node as { type?: string; [key: string]: unknown };
    if (typeof candidate.type === "string") {
      if (!allowedNodeTypes.has(candidate.type)) throw new Error(`Unsafe syntax node: ${candidate.type}`);
      if (candidate.type === "Identifier" && parentField !== "key" && parentField !== "property" && candidate.name !== "payload") {
        throw new Error(`Unexpected identifier: ${String(candidate.name)}`);
      }
      if (candidate.type === "MemberExpression" && candidate.computed !== false) throw new Error("Computed property access is not permitted");
      if (candidate.type === "CallExpression") throw new Error("Function calls are not permitted in adapters");
    }
    for (const [field, value] of Object.entries(candidate)) {
      if (Array.isArray(value)) value.forEach((entry) => walk(entry, field));
      else if (value && typeof value === "object") walk(value, field);
    }
  };
  walk(expression);
};

export interface SandboxVerification {
  approved: boolean;
  reason: string;
  output?: JsonRecord;
  execute?: AdapterFunction;
  modelEvidence: string;
}

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const executeVerifiedAdapter = (patchedCode: string, testPayload: JsonRecord, reason: string, modelEvidence: string): SandboxVerification => {
  try {
    const adapter = new Function(`"use strict"; return (${patchedCode});`)() as unknown;
    if (typeof adapter !== "function") throw new Error("Adapter is not a function");
    const output = (adapter as AdapterFunction)(structuredClone(testPayload));
    if (!isRecord(output) || Object.keys(output).length === 0) throw new Error("Adapter result must be a non-empty JSON object");
    return { approved: true, reason, output, execute: adapter as AdapterFunction, modelEvidence };
  } catch (error) {
    return { approved: false, reason: error instanceof Error ? error.message : "Unknown adapter execution error", modelEvidence };
  }
};

export async function verifyPatchInSandbox(patchedCode: string, testPayload: JsonRecord): Promise<SandboxVerification> {
  if (patchedCode.length > 16_000 || forbiddenSyntax.test(patchedCode)) {
    return { approved: false, reason: "Static policy rejected unsafe adapter syntax", modelEvidence: "local-policy" };
  }
  try {
    validateAdapterAst(patchedCode);
  } catch (error) {
    return { approved: false, reason: error instanceof Error ? error.message : "Invalid adapter syntax", modelEvidence: "ast-policy" };
  }
  if (demoMode) {
    return executeVerifiedAdapter(patchedCode, testPayload, "Demo mode: deterministic AST policy and in-memory mapping verification passed", "demo-mode:no-external-model");
  }

  const response = await getClient().responses.create({
    model: modelName,
    store: false,
    tools: [{ type: "shell" } as never],
    tool_choice: "required",
    instructions: [
      "You are the Ghostworker sandbox verifier.",
      "Use the hosted shell tool to run Node.js only in its isolated environment.",
      "Evaluate the supplied adapter expression against the supplied JSON payload.",
      "Confirm it returns a non-empty JSON object suitable for HTTP 200. Do not access network, files, environment variables, or use shell commands outside the isolated test.",
      "Finish by returning only JSON: { approved: boolean, reason: string }.",
    ].join(" "),
    input: `Evaluate this JSON sandbox request and return JSON only.\n\n${JSON.stringify({ patchedCode, testPayload })}`,
    text: { format: { type: "json_object" } },
  });

  let modelVerdict: { approved: boolean; reason: string };
  try {
    modelVerdict = JSON.parse(response.output_text) as { approved: boolean; reason: string };
  } catch {
    return { approved: false, reason: "Sandbox verifier returned invalid JSON", modelEvidence: response.id };
  }
  if (!modelVerdict.approved) return { approved: false, reason: modelVerdict.reason, modelEvidence: response.id };

  return executeVerifiedAdapter(patchedCode, testPayload, "Hosted sandbox and deterministic runtime checks passed", response.id);
}
