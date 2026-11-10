"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Sobol } = require("lobos");
const { parseSamplerTable, samplerConstantCSV, samplerTableCSV, samplerInputVSC, samplerOutputList, samplerSettings, samplerSobolText, sortSamplerRows } = require("../sampler.js");

const table = [
  "Type,Variable,Distribution,Min,Max,Increment,Remarks",
  "Constant,Global Diet Scenario Switch,X,0,,,Diet",
  "Input,Global Diet Composition Switch,VECTOR,0,4,1,Options",
  "Input,Target Percentage for Change,UNIFORM,0,100,,Options",
  "Output,Total Agricultural Land Demand ,X,,,,System Outputs"
].join("\r\n");

test("parses CSV sampler rows and generates the three example formats", () => {
  const rows = parseSamplerTable(table);
  assert.equal(rows.length, 4);
  assert.equal(samplerConstantCSV(rows), "Global Diet Scenario Switch,0\n");
  assert.equal(samplerInputVSC(rows),
    "100,L,1234,,1 \r\nGlobal Diet Composition Switch=VECTOR(0,4,1) \r\nTarget Percentage for Change=RANDOM_UNIFORM(0,100) \r\n");
  assert.equal(samplerOutputList(rows), "Total Agricultural Land Demand \r\n");
});

test("parses Excel-style tab-delimited text and quoted CSV values", () => {
  const tabSeparated = "Type\tVariable\tDistribution\tMin\tMax\tIncrement\tRemarks\r\nConstant\t\"A, B\"\tX\t2";
  assert.deepEqual(parseSamplerTable(tabSeparated), [{
    type: "Constant", variable: "A, B", distribution: "X", min: "2", max: "", increment: "", remarks: ""
  }]);
  const quoted = parseSamplerTable("Type,Variable,Distribution,Min,Max,Increment,Remarks\nConstant,\"A \"\"quoted\"\" name\",X,4,,,,");
  assert.equal(samplerConstantCSV(quoted), '"A ""quoted"" name",4\n');
});

test("rejects malformed, unsupported, or incomplete sampler data", () => {
  assert.throws(() => parseSamplerTable("Variable,Min\nx,1"), /Type and Variable/);
  assert.throws(() => parseSamplerTable(`${table}\r\nOther,x,X,1,,,`), /Type Constant, Input, or Output/);
  const unsupported = parseSamplerTable("Type,Variable,Distribution,Min,Max,Increment\nInput,x,NORMAL,0,1,");
  assert.throws(() => samplerInputVSC(unsupported), /unsupported Distribution/);
  const missingMin = parseSamplerTable("Type,Variable,Distribution,Min\nConstant,x,X,");
  assert.throws(() => samplerConstantCSV(missingMin), /needs a Variable and Value/);
});

test("constant export uses Min when present and falls back to Max", () => {
  const rows = parseSamplerTable("Type,Variable,Min,Max\nConstant,Min first,0,9\nConstant,Max fallback,,7\nConstant,Both missing,,");
  assert.throws(() => samplerConstantCSV(rows), /needs a Variable and Value/);
  rows.pop();
  assert.equal(samplerConstantCSV(rows), "Min first,0\nMax fallback,7\n");
});

test("exports an editable sampler table in displayed group order with hidden fields", () => {
  const rows = parseSamplerTable([
    "Type,Variable,Distribution,Min,Max,Increment,Remarks",
    'Output,"Output, one",X,2,3,4,"quote ""and"" comma, here"',
    "Constant,Constant one,X,,7,2,Hidden values",
    "Input,Input one,UNIFORM,0,10,,Input remarks"
  ].join("\n"));
  rows[2].remarks = "Edited\nremarks";
  rows[0].variable = 'Output, "renamed"';
  const csv = samplerTableCSV(rows);
  assert.match(csv, /^Type,Variable,Distribution,Min,Max,Increment,Remarks\r\n/);
  assert.deepEqual(parseSamplerTable(csv), [rows[1], rows[2], rows[0]]);
  assert.deepEqual(parseSamplerTable(samplerTableCSV([])), []);
  assert.throws(() => samplerTableCSV([{ ...rows[0], variable: " " }]), /needs a Variable name/);
  assert.throws(() => samplerTableCSV([{ ...rows[0], type: "Other" }]), /valid Type/);
});

test("sorts each group independently, with numeric order and blanks last", () => {
  const rows = parseSamplerTable([
    "Type,Variable,Distribution,Min,Max,Increment,Remarks",
    "Constant,Z,X,,10,,", "Output,Z,X,,,,", "Constant,A,X,-2,,,",
    "Input,Z,UNIFORM,10,20,,", "Constant,Blank,X,,,,",
    "Input,A,UNIFORM,2,20,,", "Output,A,X,,,,", "Constant,B,X,2,,,"
  ].join("\n"));
  const asc = sortSamplerRows(rows, "Constant", "value", "ascending");
  assert.deepEqual(asc.filter(row => row.type === "Constant").map(row => row.variable), ["A", "B", "Z", "Blank"]);
  const desc = sortSamplerRows(asc, "Constant", "value", "descending");
  assert.deepEqual(desc.filter(row => row.type === "Constant").map(row => row.variable), ["Z", "B", "A", "Blank"]);
  assert.deepEqual(desc.filter(row => row.type === "Input").map(row => row.variable), ["Z", "A"]);
  assert.equal(samplerConstantCSV(desc.filter(row => row.variable !== "Blank")), "Z,10\nB,2\nA,-2\n");
  const inputs = sortSamplerRows(rows, "Input", "min", "ascending");
  assert.deepEqual(inputs.filter(row => row.type === "Input").map(row => row.variable), ["A", "Z"]);
  assert.ok(samplerInputVSC(inputs).indexOf("A=RANDOM_UNIFORM") < samplerInputVSC(inputs).indexOf("Z=RANDOM_UNIFORM"));
  const outputs = sortSamplerRows(rows, "Output", "variable", "ascending");
  assert.equal(samplerOutputList(outputs), "A \r\nZ \r\n");
  assert.deepEqual(rows.filter(row => row.type === "Output").map(row => row.variable), ["Z", "A"]);
});

test("generates configurable Latin Hypercube control header", () => {
  const rows = parseSamplerTable(table);
  const settings = { method: "L", simulations: "256", seed: "42" };
  assert.match(samplerInputVSC(rows, settings), /^256,L,42,,1 \r\n/);
  assert.throws(() => samplerInputVSC(rows, { ...settings, simulations: "0" }), /positive whole/);
  assert.throws(() => samplerInputVSC(rows, { ...settings, seed: "-1" }), /Seed/);
});

test("Sobol file mode emits a file reference and a deterministic Saltelli design", () => {
  const rows = parseSamplerTable(table);
  const settings = { method: "sobol", simulations: "8", seed: "1234", order: "first", filename: "Tipping_sobol.txt" };
  assert.equal(samplerInputVSC(rows, settings), ",F,,Tipping_sobol.txt,1\r\n");
  const text = samplerSobolText(rows, settings, Sobol);
  assert.equal(text, samplerSobolText(rows, settings, Sobol));
  assert.notEqual(text, samplerSobolText(rows, { ...settings, seed: "1235" }, Sobol));
  const lines = text.trim().split("\r\n");
  assert.equal(lines.length, 1 + 8 * (2 + 2));
  assert.equal(lines[0], "Global Diet Composition Switch\tTarget Percentage for Change");
  for (let offset = 1; offset < lines.length; offset += 4) {
    const [a, ab0, ab1, b] = lines.slice(offset, offset + 4).map(line => line.split("\t").map(Number));
    assert.deepEqual(ab0, [b[0], a[1]]);
    assert.deepEqual(ab1, [a[0], b[1]]);
    for (const [vector, uniform] of [a, ab0, ab1, b]) {
      assert.ok(Number.isInteger(vector) && vector >= 0 && vector <= 4);
      assert.ok(uniform >= 0 && uniform < 100);
    }
  }
  assert.equal(text, samplerSobolText(rows, { ...settings, order: "total" }, Sobol));
});

test("second-order Sobol design adds B-with-A cross samples", () => {
  const rows = parseSamplerTable(table);
  const settings = { method: "sobol", simulations: "2", seed: "1234", order: "second", filename: "samples.txt" };
  const lines = samplerSobolText(rows, settings, Sobol).trim().split("\r\n");
  assert.equal(lines.length, 1 + 2 * (2 * 2 + 2));
  const [a, ab0, ab1, ba0, ba1, b] = lines.slice(1, 7).map(line => line.split("\t"));
  assert.deepEqual(ab0, [b[0], a[1]]);
  assert.deepEqual(ab1, [a[0], b[1]]);
  assert.deepEqual(ba0, [a[0], b[1]]);
  assert.deepEqual(ba1, [b[0], a[1]]);
});

test("Sobol validates settings, bounds, sizes and distributions", () => {
  const rows = parseSamplerTable(table);
  const settings = { method: "sobol", simulations: "8", seed: "1234", order: "first", filename: "samples.txt" };
  assert.throws(() => samplerSettings({ ...settings, simulations: "3" }), /power of two/);
  assert.throws(() => samplerSettings({ ...settings, filename: "samples,1.txt" }), /filename/);
  assert.throws(() => samplerSobolText(rows, { ...settings, simulations: "1048576" }, Sobol), /too large/);
  rows[1].increment = "3";
  assert.throws(() => samplerSobolText(rows, settings, Sobol), /evenly divides/);
  rows[1].increment = "1";
  rows[2].variable = rows[1].variable;
  assert.throws(() => samplerSobolText(rows, settings, Sobol), /duplicates/);
});
