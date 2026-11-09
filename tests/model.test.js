"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseModel, modelKey } = require("../model.js");

const sample = `{UTF-8}
Region: North,South~~|
Stocks: A,B~~|
Scalar= 1e-06 ~ Dmnl ~ |
negative = -2.5 ~~|
Matrix[North,Stocks]= 4, 9 ~~|
Scalar array[Region]=3,5~~|
Specific[South,A]=7~~|
Calculated=Scalar*2~~|
Level=INTEG(Scalar,0)~~|
Locked == 5~~|
Unknown[Region,Stocks]=1,2,3,4~~|
"Special-name"=42~~|
Extern=GET XLS CONSTANTS('constants.xlsx', 'a', 'b', 'c')~~|
INITIAL TIME = 1900 ~ Year ~ |
FINAL TIME = 2100 ~ Year ~ |
TIME STEP = .125 ~ Year [0,?] ~ |
\\\\\\---/// Sketch information
Bogus=999~~|`;

test("extracts numeric changeable constants and time from model equations", () => {
  const model = parseModel(sample);
  assert.equal(model.initialTime, "1900");
  assert.equal(model.finalTime, "2100");
  assert.equal(model.timeUnit, "Year");
  assert.deepEqual(model.constants, [
    { name: "Scalar", value: "1e-06" }, { name: "negative", value: "-2.5" },
    { name: "Matrix[North,A]", value: "4" }, { name: "Matrix[North,B]", value: "9" },
    { name: "Scalar array[North]", value: "3" }, { name: "Scalar array[South]", value: "5" },
    { name: "Specific[South,A]", value: "7" }, { name: '"Special-name"', value: "42" }
  ]);
  assert.deepEqual(model.unresolved, ["Unknown[Region,Stocks]", "Extern"]);
});

test("never guesses missing time expressions or unsupported range values", () => {
  const model = parseModel("Range: (A1-A5)~~| X[Range]=9~~| INITIAL TIME=Base Year~Year~| FINAL TIME=10~Year~|");
  assert.equal(model.initialTime, "");
  assert.equal(model.finalTime, "10");
  assert.deepEqual(model.constants, []);
  assert.deepEqual(model.unresolved, ["X[Range]"]);
});

test("name matching ignores case, underscores and subscript spacing", () => {
  assert.equal(modelKey("My_variable [North, South]"), modelKey("my variable[north,south]"));
});

test("expands a single value over a range and does not guess conflicting definitions", () => {
  const model = parseModel("Region: North,South~~| X[Region]=3~~| Y=1~~| y=2~~|");
  assert.deepEqual(model.constants, [{ name: "X[North]", value: "3" }, { name: "X[South]", value: "3" }]);
  assert.deepEqual(model.unresolved, ["Y"]);
});

test("expands quoted subscript elements and multiple ranges with one shared value", () => {
  const model = parseModel('Age: "0-4","5-9"~~| Gender: Male,Female~~| "Named-var"[Gender,Age]=7~~|');
  assert.deepEqual(model.constants, [
    { name: '"Named-var"[Male,"0-4"]', value: "7" },
    { name: '"Named-var"[Male,"5-9"]', value: "7" },
    { name: '"Named-var"[Female,"0-4"]', value: "7" },
    { name: '"Named-var"[Female,"5-9"]', value: "7" }
  ]);
});
test("rejects malformed or non-UTF-8 decoded models", () => {
  assert.throws(() => parseModel("hello world"));
  assert.throws(() => parseModel("X=1~~|\ufffd"));
});
