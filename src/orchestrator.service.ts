import OpenAI from "openai";
import type { JsonRecord } from "./registry.js";

export interface HealingProposal {
  diagnostic: string;
  refactoredCode: string;
  securityAssessment: string;
}

interface TriageReport {
  diagnostic: string;
  suggestedRepair: string;
}

interface SecurityReport {
  approved: boolean;
  findings: string[];
}

const modelName = process.env.OPENAI_MODEL || "gpt-5.6";
const demoMode = process.env.GHOSTWORKER_DEMO_MODE === "true";
let client: OpenAI | undefined;

const getClient = (): OpenAI => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required unless GHOSTWORKER_DEMO_MODE=true");
  client ??= new OpenAI({ apiKey });
  return client;
};

const parseJson = <T>(value: string, label: string): T => {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
};

const codeFenceFree = (code: string): string => code.replace(/^```(?:javascript|js)?\s*/i, "").replace(/\s*```$/, "").trim();

const createDemoProposal = (errorLog: string, targetPayload: JsonRecord): HealingProposal => {
  const observedFields = Object.keys(targetPayload).sort().join(", ") || "none";
  return {
    diagnostic: `Demo mode identified the missing id field from the captured adapter failure (${errorLog}). It observed payload fields: ${observedFields}. The repaired adapter uses a stable external identifier fallback and preserves the event type and timestamp.`,
    refactoredCode: "(payload) => ({ eventId: payload.id ?? payload.eventId ?? payload.event_id ?? payload.customer?.externalId ?? 'unknown', type: payload.type ?? payload.eventType ?? 'unknown', receivedAt: payload.occurredAt ?? payload.timestamp ?? 'demo' })",
    securityAssessment: "Demo mode used a deterministic, allowlisted pure adapter expression. No network, filesystem, secret, timer, loop, dynamic evaluation, or process access is present in the patch.",
  };
};

export class OrchestratorService {
  async healWorkflowFailure(brokenCode: string, errorLog: string, targetPayload: JsonRecord): Promise<HealingProposal> {
    if (demoMode) return createDemoProposal(errorLog, targetPayload);

    const openai = getClient();
    const sharedContext = JSON.stringify({ brokenCode, errorLog, targetPayload });
    const [triageResponse, securityResponse] = await Promise.all([
      openai.responses.create({
        model: modelName,
        store: false,
        instructions: "You are Triage Sentinel. Identify the precise schema or semantic failure. Return only JSON with diagnostic and suggestedRepair. Never include executable code.",
        input: `Return JSON only.\n\nFailure context JSON:\n${sharedContext}`,
        text: { format: { type: "json_object" } },
      }),
      openai.responses.create({
        model: modelName,
        store: false,
        instructions: "You are Security Guardrail. Examine this failed adapter context for leaked secrets, data exfiltration, dynamic imports, process access, prototype manipulation, or unbounded loops. Return only JSON with approved boolean and findings string array.",
        input: `Return JSON only.\n\nFailure context JSON:\n${sharedContext}`,
        text: { format: { type: "json_object" } },
      }),
    ]);

    const triage = parseJson<TriageReport>(triageResponse.output_text, "Triage Sentinel");
    const security = parseJson<SecurityReport>(securityResponse.output_text, "Security Guardrail");
    if (!security.approved) throw new Error(`Security Guardrail rejected repair context: ${security.findings.join("; ")}`);

    const synthesisResponse = await openai.responses.create({
      model: modelName,
      store: false,
      instructions: [
        "You are Ghostworker's repair synthesizer.",
        "Return only a JSON object matching the requested schema.",
        "refactoredCode must be a self-contained JavaScript adapter expression: (payload) => ({ ... }).",
        "The adapter must be deterministic, synchronous, pure, and use only payload data and standard JavaScript expressions.",
        "Reject imports, require, eval, Function, globals, network access, filesystem access, timers, loops, assignments, and secret-like literals.",
      ].join(" "),
      input: JSON.stringify({ brokenCode, errorLog, targetPayload, triage, security }),
      text: {
        format: {
          type: "json_schema",
          name: "healing_proposal",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["diagnostic", "refactoredCode", "securityAssessment"],
            properties: {
              diagnostic: { type: "string" },
              refactoredCode: { type: "string" },
              securityAssessment: { type: "string" },
            },
          },
        },
      },
    });

    const proposal = parseJson<HealingProposal>(synthesisResponse.output_text, "Repair synthesizer");
    return { ...proposal, refactoredCode: codeFenceFree(proposal.refactoredCode) };
  }

  getModelName(): string {
    return modelName;
  }
}
