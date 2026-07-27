import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { regularFileMaterial } from "@lenticule-science/infomaterial-observation";
import { validateInfomaterialObservationReceipt } from "@lenticule-science/infomaterial-observation/receipt";
import { semanticBytes, semanticId } from "@red-cup-engineering/rmn-semantic-conformance";
import { CARRIER_REFINEMENT_PROFILE, normalizeCarrierRefinementReceipt } from "@red-cup-engineering/rmn-semantic-conformance/carrier-refinement";
import { hierarchicalCircuitId, normalizeHierarchicalCircuit } from "@red-cup-engineering/rmn-semantic-conformance/hierarchical-circuit";
import { decodeRelationalValue, encodeRelationalValue, RELATIONAL_VALUE_TYPE } from "@red-cup-engineering/rmn-semantic-conformance/relational-value";

export const WASM_FOUR_CARRIER_PROFILE = "org.emsenn.infomaterial.wasm-four-carrier.v1";
export const PROVIDER_ACCOUNT = "eip155:31337:0x685c8eb6d6fd9354bc1f281de76d60c51ba280db";
const MAXIMUM_BYTES = 1_048_576;
const CAIP10 = /^eip155:[1-9][0-9]*:0x[0-9a-f]{40}$/u;
const RUNNER = fileURLToPath(new URL("../bin/run-wasm-four.mjs", import.meta.url));
const EXPORTS = Object.freeze(["negativeEvidence", "positiveEvidence"]);

function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
function exactKeys(value, keys) { return value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0"); }
function caip10(value, field) { if (typeof value !== "string" || !CAIP10.test(value)) fail("malformed-refinement", `${field} must be a chain-qualified EVM account`); return value; }
function typed(value) { const encoded = encodeRelationalValue(value), term = ["ascribe", encoded.type, encoded.term]; return { bytes: semanticBytes(term), id: semanticId(term), term }; }
function rawNi(bytes) { return `ni:///sha-256;${createHash("sha256").update(bytes).digest("base64url")}`; }

function decodeCarrier(source) {
  if (!exactKeys(source, ["bytesBase64", "mode", "profile"]) || source.profile !== WASM_FOUR_CARRIER_PROFILE) fail("malformed-carrier", "carrier must use the exact WebAssembly FOUR profile");
  if (typeof source.bytesBase64 !== "string" || source.bytesBase64.length === 0) fail("malformed-carrier", "carrier bytes must be canonical base64");
  const bytes = Buffer.from(source.bytesBase64, "base64");
  if (bytes.length === 0 || bytes.length > MAXIMUM_BYTES || bytes.toString("base64") !== source.bytesBase64) fail("malformed-carrier", "carrier bytes are absent, oversized, or noncanonical base64");
  if (typeof source.mode !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(source.mode)) fail("malformed-carrier", "carrier mode must be a decimal nonnegative integer");
  return { profile: source.profile, bytesBase64: source.bytesBase64, mode: source.mode, bytes, modeValue: BigInt(source.mode) };
}

export function normalizeWasmFourCarrier(source) {
  const carrier = decodeCarrier(source);
  return { profile: carrier.profile, bytesBase64: carrier.bytesBase64, mode: carrier.mode };
}

function readU32(bytes, state) {
  let value = 0, shift = 0;
  for (let count = 0; count < 5; count += 1) {
    if (state.at >= bytes.length) fail("malformed-wasm", "truncated unsigned LEB128");
    const byte = bytes[state.at++]; value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return value >>> 0;
    shift += 7;
  }
  fail("malformed-wasm", "oversized unsigned LEB128");
}

function readVector(bytes, state, read) { const count = readU32(bytes, state), result = []; for (let index = 0; index < count; index += 1) result.push(read(bytes, state)); return result; }
function readName(bytes, state) {
  const length = readU32(bytes, state), end = state.at + length;
  if (end > bytes.length) fail("malformed-wasm", "truncated UTF-8 name");
  const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(state.at, end)); state.at = end; return value;
}

function inspectAbi(bytes) {
  let module;
  try { module = new WebAssembly.Module(bytes); } catch (error) { fail("malformed-wasm", `WebAssembly validation failed: ${error.message}`); }
  if (WebAssembly.Module.imports(module).length !== 0) fail("wasm-import-refused", "the bounded carrier profile permits no imports");
  const state = { at: 8 };
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]))) fail("malformed-wasm", "unsupported WebAssembly magic or version");
  const types = [], functions = [], exports = [];
  while (state.at < bytes.length) {
    const id = bytes[state.at++], length = readU32(bytes, state), end = state.at + length;
    if (end > bytes.length) fail("malformed-wasm", "section exceeds carrier bytes");
    const section = bytes.subarray(state.at, end), cursor = { at: 0 }; let parsed = false;
    if (id === 1) {
      parsed = true;
      types.push(...readVector(section, cursor, (body, at) => {
        if (body[at.at++] !== 0x60) fail("wasm-abi-refused", "only function types are admitted");
        const params = readVector(body, at, (raw, position) => raw[position.at++]);
        const results = readVector(body, at, (raw, position) => raw[position.at++]);
        return { params, results };
      }));
    } else if (id === 2) {
      parsed = true;
      if (readU32(section, cursor) !== 0) fail("wasm-import-refused", "the bounded carrier profile permits no imports");
    } else if (id === 3) {
      parsed = true;
      functions.push(...readVector(section, cursor, (body, at) => readU32(body, at)));
    } else if (id === 7) {
      parsed = true;
      exports.push(...readVector(section, cursor, (body, at) => ({ name: readName(body, at), kind: body[at.at++], index: readU32(body, at) })));
    } else if (id === 8) fail("wasm-start-refused", "the bounded carrier profile permits no start section");
    if (parsed && cursor.at !== section.length) fail("malformed-wasm", `section ${id} contains trailing bytes`);
    state.at = end;
  }
  const names = exports.map(({ name }) => name).sort();
  if (JSON.stringify(names) !== JSON.stringify(EXPORTS) || exports.some(({ kind }) => kind !== 0)) fail("wasm-abi-refused", "the module must export exactly the two evidence-bit functions");
  for (const entry of exports) {
    const type = types[functions[entry.index]];
    if (!type || JSON.stringify(type.params) !== "[127,127]" || JSON.stringify(type.results) !== "[127]") fail("wasm-abi-refused", `${entry.name} must have type (i32,i32)->i32`);
  }
  return { imports: 0, exports: names };
}

function normalizeRequest(source) {
  if (!exactKeys(source, ["carrier", "component", "kind", "materialObservation", "producer"]) || source.kind !== "WasmFourCarrierRefinementAssayRequest") fail("malformed-refinement", "refinement request has an unknown, absent, or legacy field");
  const component = normalizeHierarchicalCircuit(source.component);
  if (component.instances.length !== 0 || component.nets.length !== 0 || component.ports.filter(({ direction }) => direction === "input").length !== 1 || component.ports.filter(({ direction }) => direction === "output").length !== 1 || component.behavior.factors.length !== 1) fail("unsupported-component", "the first WebAssembly proof profile requires one irreducible leaf factor with one input and one output");
  const producer = caip10(source.producer, "producer");
  if (producer === PROVIDER_ACCOUNT) fail("self-assay-refused", "the refinement provider cannot assay its own carrier");
  const materialObservation = validateInfomaterialObservationReceipt(source.materialObservation);
  if (materialObservation.rootKind !== "file") fail("unsupported-material", "the WebAssembly carrier must be one observed regular file");
  return { kind: source.kind, producer, component, materialObservation: source.materialObservation, carrier: decodeCarrier(source.carrier) };
}

export function encodeWasmFourRefinementRequest(source) {
  const value = normalizeRequest(source), publicValue = { ...value, carrier: { profile: value.carrier.profile, bytesBase64: value.carrier.bytesBase64, mode: value.carrier.mode } };
  const encoded = encodeRelationalValue(publicValue); return { value: publicValue, type: encoded.type, term: encoded.term };
}

export function decodeWasmFourRefinementRequest(type, term) {
  if (JSON.stringify(type) !== JSON.stringify(RELATIONAL_VALUE_TYPE)) fail("malformed-refinement", "refinement request must use the relational RMN type");
  return encodeWasmFourRefinementRequest(decodeRelationalValue(type, term)).value;
}

function normalizeBit(value, field) { if (value !== false && value !== true) fail("malformed-refinement", `${field} must be an explicit evidence bit`); return value; }
function normalizePair(value, field) {
  if (!exactKeys(value, ["negativeEvidence", "positiveEvidence"])) fail("malformed-refinement", `${field} must expose exactly two evidence bits`);
  return { positiveEvidence: normalizeBit(value.positiveEvidence, `${field}.positiveEvidence`), negativeEvidence: normalizeBit(value.negativeEvidence, `${field}.negativeEvidence`) };
}

function executeCarrier(bytes, execute = undefined) {
  if (execute) return execute(bytes);
  const run = spawnSync(process.execPath, [RUNNER], { input: JSON.stringify({ bytesBase64: bytes.toString("base64") }), encoding: "utf8", timeout: 2_000, maxBuffer: 128 * 1024, env: { PATH: process.env.PATH ?? "" } });
  if (run.error?.code === "ETIMEDOUT") fail("wasm-timeout", "carrier execution exceeded the proof-profile time bound");
  if (run.status !== 0) fail("wasm-execution-refused", String(run.stderr || run.stdout || run.error?.message).slice(0, 2000));
  try { return JSON.parse(run.stdout); } catch { fail("wasm-execution-refused", "carrier runner returned malformed output"); }
}

export async function assayWasmFourCarrierRefinement(source, options = {}) {
  const request = normalizeRequest(source), carrier = request.carrier, componentId = hierarchicalCircuitId(request.component);
  const material = regularFileMaterial(carrier.bytes, carrier.modeValue);
  if (material.materialRoot !== request.materialObservation.materialRoot) fail("material-drift", "carrier bytes and mode do not inhabit the observed material root");
  const abi = inspectAbi(carrier.bytes), result = await executeCarrier(carrier.bytes, options.execute);
  if (!Array.isArray(result?.vectors) || result.vectors.length !== 4) fail("incomplete-vectors", "carrier did not execute the complete FOUR basis");
  const expectedByInput = new Map(request.component.behavior.factors[0].rows.map((row) => [JSON.stringify(row.input[0]), row.output[0]]));
  const vectors = result.vectors.map((vector, index) => {
    const input = normalizePair(vector?.input, `observed vector ${index} input`), observed = normalizePair(vector?.output, `observed vector ${index} output`), expected = expectedByInput.get(JSON.stringify(input));
    if (!expected) fail("unexpected-vector", `carrier returned an input outside the component behavior at vector ${index}`);
    const matched = expected.positiveEvidence === observed.positiveEvidence && expected.negativeEvidence === observed.negativeEvidence;
    if (!matched) fail("behavior-mismatch", `carrier output differs from component behavior at vector ${index}`);
    return { input, expected, observed, matched: true };
  });
  if (new Set(vectors.map(({ input }) => JSON.stringify(input))).size !== 4) fail("incomplete-vectors", "carrier repeated or omitted a FOUR input");
  const proof = { kind: "WasmFourCarrierRefinementProof", profile: WASM_FOUR_CARRIER_PROFILE, imports: abi.imports, abi: { exports: abi.exports, parameters: ["positiveEvidence", "negativeEvidence"], results: ["positiveEvidence", "negativeEvidence"] }, vectorCount: 4, vectorSet: typed(vectors).id, vectors };
  const proofDocument = typed(proof), behavior = typed(request.component.behavior).id;
  const receipt = normalizeCarrierRefinementReceipt({ kind: "CircuitCarrierRefinementReceipt", profile: CARRIER_REFINEMENT_PROFILE, proofProfile: WASM_FOUR_CARRIER_PROFILE, provider: PROVIDER_ACCOUNT, producer: request.producer, component: componentId, behavior, carrier: rawNi(carrier.bytes), materialRoot: material.materialRoot, observation: request.materialObservation.semanticId, proof: proofDocument.id, equivalent: true, customerMaterialMutated: false });
  const document = typed(receipt); return { receipt, proof, proofSemanticId: proofDocument.id, proofCanonicalBytes: proofDocument.bytes, semanticId: document.id, canonicalBytes: document.bytes };
}
