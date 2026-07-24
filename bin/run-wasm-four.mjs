#!/usr/bin/env node
import { readFileSync } from "node:fs";

const source = JSON.parse(readFileSync(0, "utf8"));
const bytes = Buffer.from(source.bytesBase64, "base64");
const module = new WebAssembly.Module(bytes);
const instance = new WebAssembly.Instance(module, {});
const inputs = [[false, false], [true, false], [false, true], [true, true]];
const vectors = inputs.map(([positiveEvidence, negativeEvidence]) => {
  const positive = instance.exports.positiveEvidence(Number(positiveEvidence), Number(negativeEvidence));
  const negative = instance.exports.negativeEvidence(Number(positiveEvidence), Number(negativeEvidence));
  if ((positive !== 0 && positive !== 1) || (negative !== 0 && negative !== 1)) throw new Error("carrier returned a non-bit result");
  return { input: { positiveEvidence, negativeEvidence }, output: { positiveEvidence: positive === 1, negativeEvidence: negative === 1 } };
});
process.stdout.write(JSON.stringify({ vectors }));
