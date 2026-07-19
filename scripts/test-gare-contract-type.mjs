#!/usr/bin/env node
/** Deterministic tests for gare contract-type + GARE_undefined normalization. */
import assert from "node:assert/strict";
import {
  classifyGareContractType,
  normalizeGareRelevanceCategory,
} from "../src/lib/gare/contract-type.ts";
import { relevanceCategory } from "../src/lib/gare/display.ts";

assert.equal(classifyGareContractType({ object: "Lavori di ristrutturazione scuola" }).type, "LAVORI");
assert.equal(classifyGareContractType({ object: "Servizi di pulizia uffici comunali" }).type, "SERVIZI");
assert.equal(classifyGareContractType({ object: "Fornitura di dispositivi medici" }).type, "FORNITURE");
assert.equal(
  classifyGareContractType({ object: "Lavori e fornitura impianti elettrici" }).type,
  "MISTO"
);
assert.equal(classifyGareContractType({ object: "" }).type, "NON_CLASSIFICATO");
assert.equal(classifyGareContractType({ cpvText: "CPV 45000000" }).type, "LAVORI");
assert.equal(classifyGareContractType({ object: "Appalto generico ente" }).type, "NON_CLASSIFICATO");
assert.equal(
  classifyGareContractType({ mainProcurementCategory: "works" }).type,
  "LAVORI"
);

assert.equal(relevanceCategory(undefined), "GARE_LOW");
assert.equal(relevanceCategory(null), "GARE_LOW");
assert.equal(normalizeGareRelevanceCategory("GARE_undefined", "Assicurazione RC sanitaria", "X", 100000), "GARE_HIGH");
assert.equal(normalizeGareRelevanceCategory("GARE_HIGH"), "GARE_HIGH");
assert.equal(normalizeGareRelevanceCategory(null, "fornitura acqua", "Y", 1000), "GARE_LOW");

console.log("✓ gare contract-type + GARE_undefined normalization");
