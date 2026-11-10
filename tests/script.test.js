"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createStep, duplicateStep, variableCountText, createExportRow, addAllRuns, applyExportTimes, stepLines, parseScript, parseCSV, controlText, getRuns, withExtension, filenameStem } = require("../script.js");

test("variable count includes only entries with both a name and a value", () => {
  const variables = [{ name: "", value: "" }, { name: "x", value: "" }, { name: " ", value: "2" }];
  assert.equal(variableCountText(variables), "0 variables changed");
  variables[1].value = "0";
  assert.equal(variableCountText(variables), "1 variable changed");
  variables[2].name = "y";
  assert.equal(variableCountText(variables), "2 variables changed");
});

test("fixed extension fields add and display their suffix without duplicating it", () => {
  assert.equal(withExtension("Tipping_input", ".vsc"), "Tipping_input.vsc");
  assert.equal(withExtension("Tipping_input.vsc", ".vsc"), "Tipping_input.vsc");
  assert.equal(withExtension("inputs", ".csv"), "inputs.csv");
  assert.equal(withExtension("Tipping_sobol", ".txt"), "Tipping_sobol.txt");
  assert.equal(withExtension("Tipping_sobol.txt", ".txt"), "Tipping_sobol.txt");
  assert.equal(filenameStem("Tipping_output.lst", ".lst"), "Tipping_output");
  assert.equal(withExtension("", ".lst"), "");
});

test("only new export steps start expanded", () => {
  assert.equal(createStep("export").expanded, true);
  for (const type of ["single", "sensitivity", "raw"]) assert.equal(createStep(type).expanded, false);
});

test("duplicated steps have independent data and retain linked exports", () => {
  for (const type of ["single", "sensitivity"]) {
    const run = createStep(type);
    run.variables = [{ name: "Constant", value: "1" }];
    const copy = duplicateStep(run);
    assert.notEqual(copy.id, run.id);
    assert.deepEqual(stepLines(copy), stepLines(run));
    copy.variables[0].value = "2";
    assert.equal(run.variables[0].value, "1");
    assert.deepEqual(getRuns([run, copy]).map(item => item.id), [run.id, copy.id]);
  }
  const run = createStep("single");
  const exportStep = createStep("export");
  exportStep.rows.push(createExportRow(run.id));
  exportStep.rows[0].targetTouched = true;
  exportStep.rows[0].target = "custom.csv";
  const copy = duplicateStep(exportStep);
  assert.equal(copy.rows[0].runId, run.id);
  assert.deepEqual(stepLines(copy, [run, copy]), stepLines(exportStep, [run, exportStep]));
  copy.rows[0].target = "other.csv";
  assert.equal(exportStep.rows[0].target, "custom.csv");
  const imported = parseScript("MENU>RUN|O\n\n");
  const rawCopy = duplicateStep(imported.steps[0]);
  assert.notEqual(rawCopy.id, imported.steps[0].id);
  assert.deepEqual(stepLines(rawCopy), stepLines(imported.steps[0]));
  assert.equal(imported.steps.length, 1);
});

test("import removes blank lines and preserves commands and final newline", () => {
  const source = "SIMULATE>RUNNAME|No-Policy\r\nSIMULATE>SETVAL|Carbon Price Scenario=0\r\nMENU>RUN|o\r\n\r\nMENU>VDF2CSV|No-Policy.vdfx|No-Policy.csv|||1|2020|2100\r\n";
  const parsed = parseScript(source);
  assert.deepEqual(parsed.steps.map(step => step.type), ["single", "export"]);
  assert.equal(parsed.steps.flatMap(step => stepLines(step, parsed.steps)).join("\r\n") + (parsed.trailingNewline ? "\r\n" : ""), source.replace("\r\n\r\n", "\r\n"));
  assert.equal(parsed.steps[0].reset, false);
  parsed.steps[0].variables[0].value = "5";
  assert.deepEqual(stepLines(parsed.steps[0]), ["SIMULATE>RUNNAME|No-Policy", "SIMULATE>SETVAL|Carbon Price Scenario=5", "MENU>RUN|O"]);
  assert.equal(parseScript("").steps.length, 0);
  assert.equal(parseScript(" \r\n\t\r\n").steps.length, 0);
  assert.equal(parseScript("MENU>RUN|o").trailingNewline, false);
});

test("imports several runs and linked exports without changing commands", () => {
  const names = ["No-Policy", "C400-lin", "C160-gr5", "C80-gr5", "C0to400-lin"];
  const source = names.map((name, index) => `SIMULATE>RUNNAME|${name}\nSIMULATE>SETVAL|Carbon Price Scenario=${index}\nMENU>RUN|o\n\n`).join("")
    + names.map(name => `MENU>VDF2CSV|${name}.vdfx|${name}.csv|||1|2020|2100\n`).join("");
  const parsed = parseScript(source);
  assert.equal(parsed.steps.filter(step => step.type === "single").length, 5);
  const exports = parsed.steps.filter(step => step.type === "export");
  assert.equal(exports.length, 1);
  assert.equal(exports[0].rows.length, 5);
  const output = parsed.steps.flatMap(step => stepLines(step, parsed.steps)).join("\n") + (parsed.trailingNewline ? "\n" : "");
  assert.equal(output, source.replace(/\n\n/g, "\n"));
  parsed.steps[0].name = "Changed";
  assert.match(stepLines(exports[0], parsed.steps)[0], /^MENU>VDF2CSV\|Changed\.vdfx\|Changed\.csv/);
});

test("blank lines between run and export commands do not prevent grouping", () => {
  const parsed = parseScript("SIMULATE>RUNNAME|A\n  \nSIMULATE>SETVAL|x=1\n\nMENU>RUN|O\n\nMENU>VDF2CSV|A.vdfx|A.csv\n\t\nMENU>VDF2CSV|A.vdfx|other.csv");
  assert.deepEqual(parsed.steps.map(step => step.type), ["single", "export"]);
  assert.equal(parsed.steps[1].rows.length, 2);
  assert.equal(parsed.steps.flatMap(step => stepLines(step, parsed.steps)).length, 5);
});

test("imports sensitivity runs, export options, and preserves unsupported commands", () => {
  const source = [
    "simulate>based|", "simulate>runname|Test", "SIMULATE>READCIN|settings.csv",
    '"SIMULATE>SETVAL|Test[a,b]=2"', "SIMULATE>SENSITIVITY|inputs.vsc",
    "SIMULATE>SENSSAVELIST|outputs.lst", "MENU>RUN_SENSITIVITY|o",
    "MENU>SENS2FILE|Test.vdfx|custom.csv|,", "MENU>VDF2CSV|other.vdfx|other.csv",
    "SPECIAL>LOADMODEL|model.mdl"
  ].join("\n");
  const parsed = parseScript(source);
  assert.deepEqual(parsed.steps.map(step => step.type), ["sensitivity", "export", "raw", "raw"]);
  assert.equal(parsed.steps[0].variables[0].name, "Test[a,b]");
  assert.equal(parsed.steps[0].vsc, "inputs.vsc");
  assert.equal(parsed.steps[1].rows[0].target, "custom.csv");
  assert.equal(parsed.steps.flatMap(step => stepLines(step, parsed.steps)).join("\n"), source);
  parsed.steps[0].variables[0].value = "4";
  assert.ok(stepLines(parsed.steps[0]).includes('"SIMULATE>SETVAL|Test[a,b]=4"'));
  const noList = parseScript("SIMULATE>RUNNAME|A\nSIMULATE>SENSITIVITY|in.vsc\nMENU>RUN_SENSITIVITY|O");
  assert.equal(noList.steps[0].type, "sensitivity");
  assert.equal(noList.steps[0].allowEmptyOutput, true);
});

test("ambiguous exports and unsupported sequences remain raw", () => {
  const source = [
    "SIMULATE>RUNNAME|A", "MENU>RUN|O",
    "SIMULATE>RUNNAME|A", "MENU>RUN|O",
    "MENU>VDF2CSV|A.vdfx|a.csv|||1",
    "SIMULATE>RUNNAME|B", "SIMULATE>UNKNOWN|x", "MENU>RUN|O"
  ].join("\n");
  const parsed = parseScript(source);
  assert.deepEqual(parsed.steps.map(step => step.type), ["single", "single", "raw", "raw", "raw", "raw"]);
  assert.equal(parsed.steps.flatMap(step => stepLines(step, parsed.steps)).join("\n"), source);
  const caseCollision = parseScript("SIMULATE>RUNNAME|A\nMENU>RUN|O\nSIMULATE>RUNNAME|a\nMENU>RUN|O\nMENU>VDF2CSV|A.vdfx|A.csv");
  assert.equal(caseCollision.steps[2].type, "raw");
});

test("imported export keeps blank frequency and explicit time bounds", () => {
  const parsed = parseScript("SIMULATE>RUNNAME|A\nMENU>RUN|O\nMENU>VDF2CSV|A.vdfx|custom.csv||||1900|2100");
  const row = parsed.steps[1].rows[0];
  assert.equal(row.interval, "");
  assert.equal(row.start, "1900");
  assert.equal(row.end, "2100");
  assert.equal(row.startTouched, true);
  assert.equal(row.endTouched, true);
  row.target = "edited.csv";
  assert.equal(stepLines(parsed.steps[1], parsed.steps)[0], "MENU>VDF2CSV|A.vdfx|edited.csv||||1900|2100");
});

test("CSV imports two columns, handles quoted subscripts, and rejects malformed rows", () => {
  assert.deepEqual(parseCSV('Global Diet Scenario Switch,0\r\n"Test[a,b]",2\r\n'), [
    { name: "Global Diet Scenario Switch", value: "0" },
    { name: "Test[a,b]", value: "2" }
  ]);
  assert.throws(() => parseCSV("variable,1,extra"));
  assert.throws(() => parseCSV('"unclosed,1'));
  assert.throws(() => parseCSV("var|bad,1"));
});

test("single run resets before changes and quotes subscripted commands", () => {
  const step = createStep("single");
  assert.deepEqual(stepLines(step), ["SIMULATE>BASED|", "SIMULATE>RUNNAME|Baseline", "MENU>RUN|O"]);
  step.variables[0] = { name: "  ", value: "  " };
  assert.deepEqual(stepLines(step), ["SIMULATE>BASED|", "SIMULATE>RUNNAME|Baseline", "MENU>RUN|O"]);
  step.cin = "changes.cin";
  step.variables = [{ name: "Test[a,b]", value: "2" }];
  step.overwrite = false;
  assert.deepEqual(stepLines(step), ["SIMULATE>BASED|", "SIMULATE>RUNNAME|Baseline", "SIMULATE>READCIN|changes.cin", '"SIMULATE>SETVAL|Test[a,b]=2"', "MENU>RUN|"]);
  step.variables = [{ name: 'Test[male,"0-4"]', value: "2" }];
  assert.equal(stepLines(step)[3], '"SIMULATE>SETVAL|Test[male,"0-4"]=2"');
});

test("additional input filenames receive the fixed csv extension for both run types", () => {
  for (const type of ["single", "sensitivity"]) {
    const step = createStep(type);
    step.cin = "inputs.csv";
    assert.ok(stepLines(step).includes("SIMULATE>READCIN|inputs.csv"));
    step.cin = withExtension("inputs", ".csv");
    assert.ok(stepLines(step).includes("SIMULATE>READCIN|inputs.csv"));
  }
});

test("imported additional input filenames retain their original extension or lack of one", () => {
  for (const filename of ["settings.cin", "settings"]) {
    const source = `SIMULATE>RUNNAME|Imported\nSIMULATE>READCIN|${filename}\nMENU>RUN|O`;
    const parsed = parseScript(source);
    assert.equal(parsed.steps.flatMap(step => stepLines(step)).join("\n"), source);
  }
});

test("imported runs can be selected without rewriting their commands", () => {
  const parsed = parseScript("SIMULATE>RUNNAME|One\nMENU>RUN|o\nSIMULATE>RUNNAME|Many\nMENU>RUN_SENSITIVITY|O\n");
  const runs = getRuns(parsed.steps);
  assert.deepEqual(runs.map(run => [run.name, run.type]), [["One", "single"], ["Many", "sensitivity"]]);
  const step = createStep("export");
  step.rows.push(createExportRow(runs[1].id));
  assert.deepEqual(stepLines(step, [...parsed.steps, step]), ["MENU>SENS2FILE|Many.vdfx|Many.csv|,"]);
});

test("sensitivity file method generates a control file and proper commands", () => {
  const step = createStep("sensitivity");
  step.mode = "samples";
  step.samples = withExtension("Tipping_sobol", ".txt");
  step.control = "samples.vsc";
  step.output = "Tipping_output.lst";
  assert.equal(controlText(step), ",F,,Tipping_sobol.txt,1\r\n");
  assert.deepEqual(stepLines(step).slice(-3), ["SIMULATE>SENSITIVITY|samples.vsc", "SIMULATE>SENSSAVELIST|Tipping_output.lst", "MENU>RUN_SENSITIVITY|O"]);
  step.mode = "vsc";
  step.vsc = "Tipping_input.vsc";
  assert.equal(stepLines(step).at(-3), "SIMULATE>SENSITIVITY|Tipping_input.vsc");
});

test("single and sensitivity exports use their distinct syntax", () => {
  const step = createStep("export");
  const run = createStep("single");
  run.name = "run";
  const row = createExportRow(run.id);
  step.rows.push(row);
  row.target = "results.csv";
  row.targetTouched = true;
  row.start = "2020";
  row.end = "2100";
  assert.equal(stepLines(step, [run, step])[0], "MENU>VDF2CSV|run.vdfx|results.csv|||1|2020|2100");
  run.name = "renamed";
  row.targetTouched = false;
  row.interval = "5";
  assert.equal(stepLines(step, [run, step])[0], "MENU>VDF2CSV|renamed.vdfx|renamed.csv|||5|2020|2100");
  row.interval = "";
  assert.equal(stepLines(step, [run, step])[0], "MENU>VDF2CSV|renamed.vdfx|renamed.csv||||2020|2100");
  run.type = "sensitivity";
  assert.equal(stepLines(step, [run, step])[0], "MENU>SENS2FILE|renamed.vdfx|renamed.csv|,");
  assert.deepEqual(stepLines(step, [step]), []);
});

test("export all adds only missing earlier runs and preserves edited rows", () => {
  const first = createStep("single"); first.name = "First";
  const second = createStep("sensitivity"); second.name = "Second";
  const later = createStep("single"); later.name = "Later";
  const step = createStep("export");
  const existing = createExportRow(first.id, { initialTime: "1900", finalTime: "2100" });
  existing.target = "custom.csv"; existing.targetTouched = true;
  step.rows.push(existing, createExportRow());
  const steps = [first, second, step, later];
  addAllRuns(step, getRuns(steps), 2, { initialTime: "1900", finalTime: "2100" });
  addAllRuns(step, getRuns(steps), 2, { initialTime: "1900", finalTime: "2100" });
  assert.equal(step.rows.length, 2);
  assert.equal(step.rows[0], existing);
  assert.deepEqual(stepLines(step, steps), [
    "MENU>VDF2CSV|First.vdfx|custom.csv|||1|1900|2100",
    "MENU>SENS2FILE|Second.vdfx|Second.csv|,"
  ]);
});

test("apply export times copies only start and end to selected single runs", () => {
  const first = createStep("single"), second = createStep("single"), sensitivity = createStep("sensitivity");
  first.name = "First"; second.name = "Second";
  const step = createStep("export");
  const source = createExportRow(first.id), destination = createExportRow(second.id);
  const sensRow = createExportRow(sensitivity.id), unselected = createExportRow();
  source.start = "2020"; source.end = "2100"; source.interval = "5";
  destination.interval = "2"; sensRow.start = "42"; unselected.start = "99";
  step.rows.push(source, destination, sensRow, unselected);
  const runs = getRuns([first, second, sensitivity, step]);
  applyExportTimes(step, source, runs);
  assert.deepEqual([destination.start, destination.end, destination.interval], ["2020", "2100", "2"]);
  assert.equal(destination.startTouched, true);
  assert.equal(destination.endTouched, true);
  assert.equal(source.startTouched, true);
  assert.equal(sensRow.start, "42");
  assert.equal(unselected.start, "99");
  assert.equal(stepLines(step, [first, second, sensitivity, step])[1], "MENU>VDF2CSV|Second.vdfx|Second.csv|||2|2020|2100");
  source.start = ""; source.end = "";
  applyExportTimes(step, source, runs);
  assert.deepEqual([destination.start, destination.end], ["", ""]);
});
