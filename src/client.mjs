import { randomUUID } from "node:crypto";
import { Message, Role } from "@a2a-js/sdk";
import { a2aResultParts, sendRmnTask } from "@red-cup-engineering/a2a-rmn-task-client-service";
import { extractRmnPart, rmnPart } from "@red-cup-engineering/a2a-rmn-part-service";
import { checkTerm, decodeSemantic, semanticBytes } from "@red-cup-engineering/relation-model-notation-runtime";
import { circuitInterfaceFromAgentCard, SOVEREIGN_CIRCUIT_INTERFACE_EXTENSION } from "@red-cup-engineering/relation-model-notation-runtime/hierarchical-circuit";
import { decodeCarrierRefinementReceipt } from "@red-cup-engineering/relation-model-notation-runtime/carrier-refinement";
import { encodeWasmFourRefinementRequest } from "./refinement-assay.mjs";
import { jsonId } from "./semantic-identity.mjs";

const responseParts = a2aResultParts;

export async function assayWasmFourCarrier({ agentUrl, producer, component, materialObservation, carrier, signal, send = sendRmnTask }) {
  const request = encodeWasmFourRefinementRequest({ kind: "WasmFourCarrierRefinementAssayRequest", producer, component, materialObservation, carrier });
  const term = ["ascribe", request.type, request.term], bytes = semanticBytes(term);
  const message = Message.toJSON({ messageId: randomUUID(), contextId: "", taskId: "", role: Role.ROLE_USER, parts: [rmnPart(bytes, "wasm-four-refinement-request.rmn.cbor")], metadata: {}, extensions: [], referenceTaskIds: [] });
  const exchange = await send({ agentUrl, extensions: [SOVEREIGN_CIRCUIT_INTERFACE_EXTENSION], message, requireSignature: true, ...(signal ? { signal } : {}) });
  const output = extractRmnPart(responseParts(exchange.result)), response = decodeSemantic(output.bytes);
  if (!semanticBytes(response).equals(output.bytes) || response?.[0] !== "ascribe" || response.length !== 3) throw new Error("refinement provider returned noncanonical RMN");
  checkTerm(response[2], response[1]);
  const receipt = decodeCarrierRefinementReceipt(response[1], response[2]);
  const provider = circuitInterfaceFromAgentCard(exchange.agentCard);
  if (receipt.provider !== provider.account) throw new Error("refinement receipt provider does not own the signed Agent Card");
  return { receipt, receiptNi: jsonId(response, "lenticule.carrier-refinement.receipt"), response, exchange };
}
