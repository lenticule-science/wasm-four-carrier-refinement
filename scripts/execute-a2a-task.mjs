#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Message, Role } from "@a2a-js/sdk";
import { extractRmnPart, rmnPart } from "@red-cup-engineering/a2a-rmn-part-service";
import { checkTerm, decodeSemantic, semanticBytes } from "@red-cup-engineering/rmn-semantic-conformance";
import { createSettlementStore } from "@lenticule-science/witness-journal-rdf-projection-service/client";
import { assayWasmFourCarrierRefinement, decodeWasmFourRefinementRequest } from "../src/refinement-assay.mjs";
import { WASM_FOUR_REFINEMENT_LAW } from "../src/law.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function executeA2aMessage(source, env = process.env) {
  const message = Message.fromJSON(source);
  if (message.role !== Role.ROLE_USER) throw new Error("carrier refinement requires an A2A ROLE_USER message");
  if (!env.RWIL_RDF_AGENT) throw new Error("RWIL_RDF_AGENT is required; the refinement provider cannot keep an ambient book");
  const input = extractRmnPart(message.parts), term = decodeSemantic(input.bytes);
  if (!semanticBytes(term).equals(input.bytes) || term?.[0] !== "ascribe" || term.length !== 3) throw new Error("refinement request must be canonical typed RMN CBOR");
  checkTerm(term[2], term[1]);
  const request = decodeWasmFourRefinementRequest(term[1], term[2]);
  const result = await assayWasmFourCarrierRefinement(request);
  const recordedAt = new Date().toISOString();
  const store = createSettlementStore({ settlementRoot: ROOT, agentUrl: env.RWIL_RDF_AGENT });
  await store.record({ category: "wasm-four-carrier-refinement.proof", recordedAt, record: { ...result.proof, semanticId: result.proofSemanticId, law: WASM_FOUR_REFINEMENT_LAW.id } });
  await store.record({ category: "wasm-four-carrier-refinement.receipt", recordedAt, record: { ...result.receipt, semanticId: result.semanticId, law: WASM_FOUR_REFINEMENT_LAW.id } });
  return Message.toJSON({ messageId: randomUUID(), contextId: message.contextId, taskId: message.taskId, role: Role.ROLE_AGENT, parts: [rmnPart(result.canonicalBytes, "carrier-refinement-receipt.rmn.cbor")], metadata: { disposition: "conformant", receiptNi: result.semanticId, componentNi: result.receipt.component, materialRootNi: result.receipt.materialRoot, profile: result.receipt.profile }, extensions: [], referenceTaskIds: [] });
}

try { const source = JSON.parse(readFileSync(0, "utf8")); process.stdout.write(`${JSON.stringify(await executeA2aMessage(source))}\n`); }
catch (error) { process.stderr.write(`${error.code ?? "carrier-refinement-refusal"}: ${error.message}\n`); process.exitCode = 1; }
