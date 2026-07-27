import { readFileSync } from "node:fs";
import { compileRmlLaw } from "@red-cup-engineering/rmn-semantic-conformance/law";

export const WASM_FOUR_REFINEMENT_LAW = compileRmlLaw(
  readFileSync(new URL("../content/contracts/assay-wasm-four-carrier-refinement.rml", import.meta.url), "utf8"),
);
