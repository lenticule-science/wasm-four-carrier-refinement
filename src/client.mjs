import { randomUUID } from "node:crypto";
import { Message, Role } from "@a2a-js/sdk";
import { a2aResultParts, sendRmnTask } from "@emsenn/a2a-rmn-task-client-service";
import { extractRmnPart, rmnPart } from "@emsenn/a2a-rmn-part-service";
import { checkTerm, decodeSemantic, semanticBytes, semanticId } from "@emsenn/rmn-semantic-conformance";
import { circuitInterfaceFromAgentCard, SOVEREIGN_CIRCUIT_INTERFACE_EXTENSION } from "@emsenn/rmn-semantic-conformance/hierarchical-circuit";
import { decodeCarrierRefinementReceipt } from "@emsenn/rmn-semantic-conformance/carrier-refinement";
import { encodeWasmFourRefinementRequest } from "./refinement-assay.mjs";

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
  return { receipt, receiptNi: semanticId(response), response, exchange };
}
