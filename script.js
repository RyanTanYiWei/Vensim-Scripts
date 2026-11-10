"use strict";

const TYPES = {
  single: { title: "Single Run", icon: "▶" },
  sensitivity: { title: "Sensitivity Run", icon: "◈" },
  export: { title: "Export CSV", icon: "↗" },
  raw: { title: "Custom Command", icon: "⌘" }
};
let nextStepId = 0;

function createStep(type) {
  if (type === "single") return { id: ++nextStepId, type, expanded: false, name: "Baseline", variables: [{ name: "", value: "" }], cin: "", overwrite: true };
  if (type === "sensitivity") return { id: ++nextStepId, type, expanded: false, name: "Sensitivity", mode: "vsc", vsc: "", samples: "", control: "samples.vsc", output: "", cin: "", variables: [], overwrite: true };
  if (type === "export") return { type, expanded: true, rows: [] };
  return { id: ++nextStepId, type: "raw", expanded: false, line: "" };
}

function duplicateStep(step) {
  const copy = { ...step };
  if (step.id !== undefined) copy.id = ++nextStepId;
  if (step.variables) copy.variables = step.variables.map(variable => ({ ...variable }));
  if (step.rows) copy.rows = step.rows.map(row => ({ ...row }));
  if (step.imported) copy.imported = { ...step.imported, lines: [...step.imported.lines] };
  return copy;
}

function variableCountText(variables) {
  const count = variables.filter(variable => variable.name.trim() && variable.value.trim()).length;
  return `${count} ${count === 1 ? "variable" : "variables"} changed`;
}

function setval(variable) {
  const command = `SIMULATE>SETVAL|${variable.name}=${variable.value}`;
  return /[\[\]]/.test(variable.name) ? `"${command}"` : command;
}

function withExtension(filename, extension, existingExtensions = [extension]) {
  if (!filename) return filename;
  return existingExtensions.some(suffix => filename.toLowerCase().endsWith(suffix)) ? filename : `${filename}${extension}`;
}

function filenameStem(filename, extension) {
  return filename.toLowerCase().endsWith(extension) ? filename.slice(0, -extension.length) : filename;
}

function getRuns(steps) {
  const runs = [];
  let name = "";
  steps.forEach((step, index) => {
    if (step.type === "single" || step.type === "sensitivity") {
      runs.push({ id: step.id, type: step.type, name: step.name, index });
      name = step.name;
    } else if (step.type === "raw") {
      const runName = /^SIMULATE>RUNNAME\|([^|&]*)$/i.exec(step.line);
      if (runName) name = runName[1];
      const run = /^MENU>RUN(_SENSITIVITY)?(?:\|[^|&]*)?$/i.exec(step.line);
      if (run && name) runs.push({ id: step.id, type: run[1] ? "sensitivity" : "single", name, index });
    }
  });
  return runs;
}

function createExportRow(runId = null, model = null) {
  return { runId, target: "", targetTouched: false, interval: "1", start: model ? model.initialTime : "", end: model ? model.finalTime : "" };
}

function addAllRuns(step, runs, index, model = null) {
  step.rows = step.rows.filter(row => row.runId !== null || row.targetTouched);
  const selected = new Set(step.rows.map(row => row.runId));
  runs.filter(run => run.index < index && !selected.has(run.id)).forEach(run => step.rows.push(createExportRow(run.id, model)));
}

function applyExportTimes(step, source, runs) {
  const singleIds = new Set(runs.filter(run => run.type === "single").map(run => run.id));
  step.rows.forEach(row => {
    if (!singleIds.has(row.runId)) return;
    row.start = source.start; row.end = source.end;
    row.startTouched = true; row.endTouched = true;
  });
}

function stepLines(step, steps = []) {
  if (step.type === "raw") return [step.line];
  if (step.type === "single" || step.type === "sensitivity") {
    const lines = step.reset === false ? [] : ["SIMULATE>BASED|"];
    lines.push(`SIMULATE>RUNNAME|${step.name}`);
    if (step.cin) lines.push(`SIMULATE>READCIN|${step.cin}`);
    lines.push(...step.variables.filter(variable => step.type !== "single" || variable.name.trim() || variable.value.trim()).map(setval));
    if (step.type === "sensitivity") {
      lines.push(`SIMULATE>SENSITIVITY|${step.mode === "samples" ? step.control : step.vsc}`);
      if (step.output) lines.push(`SIMULATE>SENSSAVELIST|${step.output}`);
      lines.push(`MENU>RUN_SENSITIVITY|${step.overwrite ? "O" : ""}`);
    } else lines.push(`MENU>RUN|${step.overwrite ? "O" : ""}`);
    return preserveImportedLines(step, lines);
  }
  const runs = getRuns(steps);
  const lines = step.rows.flatMap(row => {
    const run = runs.find(item => item.id === row.runId);
    if (!run) return [];
    const source = `${run.name}.vdfx`;
    const target = row.targetTouched ? row.target : `${run.name}.csv`;
    if (run.type === "sensitivity") return [`MENU>SENS2FILE|${source}|${target}|,`];
    const args = [source, target, "", "", row.interval, row.start, row.end];
    while (args.length > 2 && !args[args.length - 1]) args.pop();
    return [`MENU>VDF2CSV|${args.join("|")}`];
  });
  return preserveImportedLines(step, lines);
}

function preserveImportedLines(step, lines) {
  return step.imported && step.imported.canonical === JSON.stringify(lines) ? [...step.imported.lines] : lines;
}

function rememberImported(step, lines, steps) {
  step.imported = { lines: [...lines], canonical: JSON.stringify(stepLines(step, steps)) };
}

function parseRun(lines, start) {
  let index = start;
  const reset = /^SIMULATE>BASED\|$/i.test(lines[index]);
  if (reset) index++;
  const name = /^SIMULATE>RUNNAME\|([^|&]+)$/i.exec(lines[index] || "");
  if (!name || !name[1].trim()) return null;
  index++;
  let cin = "";
  const change = /^SIMULATE>READCIN\|([^|&]+)$/i.exec(lines[index] || "");
  if (change) { cin = change[1]; index++; }
  const variables = [];
  while (index < lines.length) {
    const variable = /^(?:"SIMULATE>SETVAL\|(.+)"|SIMULATE>SETVAL\|(.+))$/i.exec(lines[index]);
    if (!variable) break;
    const assignment = variable[1] || variable[2];
    const equal = assignment.indexOf("=");
    if (equal < 1) return null;
    const variableName = assignment.slice(0, equal), value = assignment.slice(equal + 1);
    if (!variableName.trim() || !value.trim() || /[=|&]/.test(variableName) || /[|&"]/.test(value) || (variableName.match(/"/g) || []).length % 2 !== 0) return null;
    variables.push({ name: variableName, value });
    index++;
  }
  const sensitivity = /^SIMULATE>SENSITIVITY\|([^|&]+)$/i.exec(lines[index] || "");
  let output = "";
  if (sensitivity) {
    index++;
    const saveList = /^SIMULATE>SENSSAVELIST\|([^|&]+)$/i.exec(lines[index] || "");
    if (saveList) { output = saveList[1]; index++; }
  }
  const run = /^MENU>RUN(_SENSITIVITY)?(?:\|(O)?)?$/i.exec(lines[index] || "");
  if (!run || Boolean(run[1]) !== Boolean(sensitivity)) return null;
  const step = createStep(sensitivity ? "sensitivity" : "single");
  step.name = name[1]; step.cin = cin; step.reset = reset; step.overwrite = Boolean(run[2]);
  step.variables = variables.length || sensitivity ? variables : [{ name: "", value: "" }];
  if (sensitivity) { step.vsc = sensitivity[1]; step.output = output; step.allowEmptyOutput = !output; }
  index++;
  rememberImported(step, lines.slice(start, index), []);
  return { step, end: index };
}

function parseExport(line, steps) {
  const parts = line.split("|");
  const isSingle = /^MENU>VDF2CSV$/i.test(parts[0]);
  const isSensitivity = /^MENU>SENS2FILE$/i.test(parts[0]);
  if ((!isSingle && !isSensitivity) || !parts[1] || !parts[2] || parts.some(part => part.includes("&"))) return null;
  if (isSingle && (parts.length > 8 || parts[3] || parts[4])) return null;
  if (isSensitivity && (parts.length !== 4 || parts[3] !== ",")) return null;
  const runs = getRuns(steps).filter(run => run.type === (isSingle ? "single" : "sensitivity") && `${run.name}.vdfx`.toLowerCase() === parts[1].toLowerCase());
  if (runs.length !== 1) return null;
  const row = createExportRow(runs[0].id);
  row.target = parts[2]; row.targetTouched = parts[2] !== `${runs[0].name}.csv`;
  if (isSingle) {
    row.interval = parts[5] || ""; row.start = parts[6] || ""; row.end = parts[7] || "";
    row.startTouched = true; row.endTouched = true;
  }
  return row;
}

function parseScript(text) {
  if (text === "") return { steps: [], trailingNewline: false };
  const lines = text.replace(/^\uFEFF/, "").split(/\r\n|\n|\r/);
  const trailingNewline = lines[lines.length - 1] === "";
  if (trailingNewline) lines.pop();
  const commands = lines.filter(line => line.trim() !== "");
  const steps = [];
  for (let index = 0; index < commands.length;) {
    const run = parseRun(commands, index);
    if (run) { steps.push(run.step); index = run.end; continue; }
    let row = parseExport(commands[index], steps);
    if (row) {
      const step = createStep("export"), original = [];
      while (row) {
        step.rows.push(row); original.push(commands[index++]);
        row = index < commands.length ? parseExport(commands[index], steps) : null;
      }
      steps.push(step); rememberImported(step, original, steps);
      continue;
    }
    const line = commands[index++];
    steps.push({ id: ++nextStepId, type: "raw", line });
  }
  return { steps, trailingNewline };
}

function parseCSV(text) {
  const rows = [];
  let row = [], value = "", quoted = false, afterQuote = false;
  text = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { value += '"'; i++; }
      else if (char === '"') { quoted = false; afterQuote = true; }
      else value += char;
    } else if (char === '"' && value === "" && !afterQuote) quoted = true;
    else if (char === "," || char === "\n" || char === "\r") {
      row.push(value); value = ""; afterQuote = false;
      if (char !== ",") { rows.push(row); row = []; if (char === "\r" && text[i + 1] === "\n") i++; }
    } else {
      if (afterQuote || char === '"') throw new Error("Invalid CSV quoting.");
      value += char;
    }
  }
  if (quoted) throw new Error("An opening CSV quote has no closing quote.");
  if (value || row.length || afterQuote) { row.push(value); rows.push(row); }
  return rows.filter(r => r.some(cell => cell.trim())).map((r, i) => {
    if (r.length !== 2 || !r[0].trim() || !r[1].trim() || /[\r\n|&"]/.test(r.join("")) || /[=]/.test(r[0])) {
      throw new Error(`Row ${i + 1} must contain a variable name and value, with no command separators.`);
    }
    return { name: r[0].trim(), value: r[1].trim() };
  });
}

function controlText(step) { return `,F,,${step.samples},1\r\n`; }

if (typeof module !== "undefined" && module.exports) module.exports = { createStep, duplicateStep, variableCountText, createExportRow, addAllRuns, applyExportTimes, stepLines, parseScript, parseCSV, controlText, getRuns, withExtension, filenameStem };

if (typeof document !== "undefined") {
  let steps = [createStep("single")];
  let model = null;
  let modelLoadId = 0;
  let trailingNewline = true;
  let draggedIndex = null;
  const stepsElement = document.querySelector("#steps");
  const preview = document.querySelector("#preview");
  const announcement = document.querySelector("#announcement");
  const announce = text => { announcement.textContent = text; };
  const scriptText = () => steps.flatMap(step => stepLines(step, steps)).join("\r\n") + (steps.length && trailingNewline ? "\r\n" : "");

  function applyModelDefaults(step) {
    if (step.type !== "export") return;
    step.rows.forEach(row => {
      if (!row.startTouched) row.start = model ? model.initialTime : "";
      if (!row.endTouched) row.end = model ? model.finalTime : "";
    });
  }
  function renderModel() {
    const list = document.querySelector("#model-constants");
    list.replaceChildren();
    const variableList = document.querySelector("#model-variables");
    variableList.replaceChildren();
    if (model) {
      model.constants.forEach(constant => {
        const option = document.createElement("option");
        option.value = constant.name;
        option.label = `Model value: ${constant.value}`;
        list.append(option);
      });
      model.variables.forEach(name => {
        const option = document.createElement("option"); option.value = name;
        variableList.append(option);
      });
    }
    document.querySelector("#model-title").textContent = model ? model.filename : "Add model context";
    document.querySelector("#model-summary").textContent = model
      ? `${model.constants.length} selectable constants · ${model.variables.length} variables · Time: ${model.initialTime || "unknown"}–${model.finalTime || "unknown"}${model.timeUnit ? ` ${model.timeUnit}` : ""}`
      : "Drop a UTF-8 .mdl file here to find variables and set export times.";
    const warning = document.querySelector("#model-warning");
    const notices = [];
    if (model && model.unresolved.length) notices.push(`${model.unresolved.length} numeric definitions could not be resolved into selectable constants.`);
    if (model && (!model.initialTime || !model.finalTime)) notices.push("Numeric initial or final time was not found; set export times manually.");
    document.querySelector("#model-status").textContent = notices.length ? "Model issues" : model ? "Model loaded" : "Model Context";
    if (notices.length) document.querySelector(".model-details").open = true;
    warning.textContent = notices.join(" ");
    warning.hidden = !notices.length;
    const unresolved = document.querySelector("#model-unresolved");
    const unresolvedList = document.querySelector("#model-unresolved-list");
    unresolvedList.replaceChildren();
    if (model) model.unresolved.forEach(name => { const item = document.createElement("li"); item.textContent = name; unresolvedList.append(item); });
    unresolved.hidden = !model || !model.unresolved.length;
    document.querySelector("#model-clear").hidden = !model;
  }
  async function loadModel(file) {
    const loadId = ++modelLoadId;
    if (!file.name.toLowerCase().endsWith(".mdl")) { alert("Choose a Vensim .mdl file."); return; }
    try {
      const bytes = await file.arrayBuffer();
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const parsed = parseModel(text);
      if (loadId !== modelLoadId) return;
      model = { ...parsed, filename: file.name };
      steps.forEach(applyModelDefaults);
      renderModel(); render();
      announce(`Loaded ${file.name}: ${model.constants.length} constants.`);
    } catch (error) {
      if (loadId === modelLoadId) alert(`Could not load model: ${error.message}. Use a UTF-8 Vensim text model.`);
    }
  }
  const dropZone = document.querySelector("#model-drop");
  const modelDetails = document.querySelector(".model-details");
  document.addEventListener("pointerdown", event => {
    if (!dropZone.contains(event.target)) modelDetails.open = false;
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && modelDetails.open) {
      modelDetails.open = false;
      if (modelDetails.contains(document.activeElement)) document.querySelector("#model-status").focus();
    }
  });
  dropZone.addEventListener("dragover", event => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault(); event.dataTransfer.dropEffect = "copy"; dropZone.classList.add("drag-over");
  });
  dropZone.addEventListener("dragleave", event => { if (!dropZone.contains(event.relatedTarget)) dropZone.classList.remove("drag-over"); });
  dropZone.addEventListener("drop", event => {
    if (!event.dataTransfer.files.length) return;
    event.preventDefault(); dropZone.classList.remove("drag-over");
    if (event.dataTransfer.files.length !== 1) { alert("Drop one .mdl file at a time."); return; }
    loadModel(event.dataTransfer.files[0]);
  });
  document.querySelector("#model-file").addEventListener("change", event => {
    const file = event.target.files[0];
    if (file) loadModel(file);
    event.target.value = "";
  });
  document.querySelector(".model-choose").addEventListener("keydown", event => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); document.querySelector("#model-file").click(); }
  });
  document.querySelector("#model-clear").addEventListener("click", () => {
    modelLoadId++; model = null; steps.forEach(applyModelDefaults); renderModel(); render(); announce("Model context removed.");
  });

  function warningsFor(step, index) {
    const issues = [], prefix = `Step ${index + 1}: `;
    if (step.type === "raw") return issues;
    const invalid = (value) => /[|\r\n&]/.test(value);
    if ((step.type === "single" || step.type === "sensitivity") && !step.name.trim()) issues.push(prefix + "Enter a run name.");
    if (step.type === "single" || step.type === "sensitivity") {
      if (invalid(step.name) || invalid(step.cin)) issues.push(prefix + "Run name or change file contains a command separator.");
      step.variables.forEach(v => {
        if (step.type === "single" && !v.name.trim() && !v.value.trim()) return;
        if (!v.name.trim() || !v.value.trim() || /[=|&\r\n]/.test(v.name) || /[|&"\r\n]/.test(v.value) || (v.name.match(/"/g) || []).length % 2 !== 0) issues.push(prefix + "Check the variable name and value; command separators and unbalanced quotes are not supported.");
      });
    }
    if (step.type === "sensitivity") {
      if (!step.output.trim() && !step.allowEmptyOutput) issues.push(prefix + "Enter a sensitivity output save list (.lst).");
      if (step.mode === "vsc" && !step.vsc.trim()) issues.push(prefix + "Enter a sensitivity control file (.vsc).");
      if (step.mode === "samples" && (!step.samples.trim() || !step.control.trim())) issues.push(prefix + "Enter the sample and generated control file names.");
      if (step.mode === "samples" && /[,\r\n]/.test(step.samples)) issues.push(prefix + "Sample filename cannot contain a comma or newline in the control file.");
      if ([step.vsc, step.samples, step.control, step.output].some(invalid)) issues.push(prefix + "A filename contains a command separator.");
    }
    if (step.type === "export") {
      const runs = getRuns(steps);
      if (!step.rows.length) issues.push(prefix + "Add a run to export.");
      step.rows.forEach(row => {
        const run = runs.find(item => item.id === row.runId);
        if (!run) issues.push(prefix + "Choose a run to export.");
        else if (run.index >= index) issues.push(prefix + "Move the selected run before this export.");
        if (row.targetTouched && !row.target.trim()) issues.push(prefix + "Enter an output filename.");
        if ([row.target, row.interval, row.start, row.end].some(invalid)) issues.push(prefix + "An export field contains a command separator.");
        if (run && run.type === "single" && row.interval.trim() && (!Number.isFinite(Number(row.interval)) || Number(row.interval) <= 0)) issues.push(prefix + "Export interval must be a positive number or blank.");
      });
    }
    return [...new Set(issues)];
  }
  function updatePreview() {
    const lines = steps.flatMap(step => stepLines(step, steps));
    preview.textContent = lines.length ? lines.join("\n") : "Your script will appear here.";
    document.querySelector("#step-count").textContent = `${steps.length} ${steps.length === 1 ? "step" : "steps"}`;
    document.querySelector("#line-count").textContent = `${lines.length} ${lines.length === 1 ? "line" : "lines"}`;
    document.querySelector("#empty-state").hidden = steps.length > 0;
    const warnings = steps.flatMap(warningsFor);
    const box = document.querySelector("#warnings");
    box.hidden = !warnings.length;
    box.replaceChildren();
    if (warnings.length) {
      const list = document.createElement("ul");
      warnings.forEach(warning => { const item = document.createElement("li"); item.textContent = warning; list.append(item); });
      box.append(list);
    }
  }
  function makeButton(label, text, action, disabled = false) {
    const button = document.createElement("button");
    button.type = "button"; button.setAttribute("aria-label", label); button.title = label; button.textContent = text; button.disabled = disabled;
    button.addEventListener("click", action);
    return button;
  }
  function download(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = name.split(/[\\/]/).pop(); link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function move(from, to) {
    if (to < 0 || to >= steps.length || from === to) return;
    const [step] = steps.splice(from, 1); steps.splice(to, 0, step); render(); announce(`Moved step to position ${to + 1}.`);
  }
  function field(labelText, step, key, placeholder, options) {
    const wrapper = document.createElement("div"); wrapper.className = "field";
    const label = document.createElement("label"); label.textContent = labelText;
    const input = document.createElement(options ? "select" : "input");
    if (options) {
      options.forEach(([value, name]) => { const option = document.createElement("option"); option.value = value; option.textContent = name; input.append(option); });
    } else { input.placeholder = placeholder || ""; input.type = "text"; }
    input.value = step[key];
    label.append(input); wrapper.append(label);
    input.addEventListener(options ? "change" : "input", () => {
      step[key] = key === "overwrite" ? input.value === "true" : input.value;
      if (key === "start" || key === "end") step[`${key}Touched`] = true;
      if (key === "mode") {
        render();
      } else {
        updatePreview();
      }
    });
    return wrapper;
  }
  function fixedExtensionField(labelText, step, key, extension, placeholder) {
    const wrapper = document.createElement("div"); wrapper.className = "field";
    const label = document.createElement("label"); label.textContent = labelText;
    const group = document.createElement("div"); group.className = "fixed-extension";
    const input = document.createElement("input"); input.type = "text";
    input.value = filenameStem(step[key], extension); input.placeholder = placeholder;
    input.setAttribute("aria-label", `${labelText} filename`);
    const suffix = document.createElement("span"); suffix.textContent = extension; suffix.setAttribute("aria-hidden", "true");
    group.append(input, suffix); label.append(group); wrapper.append(label);
    input.addEventListener("input", () => {
      step[key] = withExtension(input.value, extension);
      input.value = filenameStem(step[key], extension);
      updatePreview();
    });
    return wrapper;
  }
  function variableSection(step, index) {
    const container = document.createElement("div");
    const heading = document.createElement("div"); heading.className = "variable-heading";
    const headingText = document.createElement("span"); headingText.textContent = "CONSTANTS / VARIABLES";
    const actions = document.createElement("div"); actions.className = "inline-actions";
    const add = makeButton("Add variable", "+ Add variable", () => { step.variables.push({ name: "", value: "" }); render(); });
    add.className = "small-button"; actions.append(add); heading.append(headingText, actions); container.append(heading);
    const list = document.createElement("div"); list.className = "variable-list";
    step.variables.forEach((variable, varIndex) => {
      const row = document.createElement("div"); row.className = "variable-row";
      const name = document.createElement("input"); name.value = variable.name; name.placeholder = model ? "Search model constants" : "Variable name"; name.setAttribute("aria-label", `Step ${index + 1} variable ${varIndex + 1} name`);
      if (model) name.setAttribute("list", "model-constants");
      const value = document.createElement("input"); value.value = variable.value; value.placeholder = "Value"; value.setAttribute("aria-label", `Step ${index + 1} variable ${varIndex + 1} value`);
      name.addEventListener("input", () => { variable.name = name.value; syncVariableHeader(step, index); updatePreview(); });
      value.addEventListener("input", () => { variable.value = value.value; syncVariableHeader(step, index); updatePreview(); });
      const remove = makeButton(`Remove variable ${varIndex + 1}`, "×", () => {
        step.variables.splice(varIndex, 1);
        if (step.type === "single" && !step.variables.length) step.variables.push({ name: "", value: "" });
        render();
      }); remove.className = "remove-variable";
      row.append(name, value, remove); list.append(row);
    });
    container.append(list);
    return container;
  }
  function syncVariableHeader(step, index) {
    if (step.type !== "single") return;
    const header = stepsElement.children[index].querySelector(".header-variables");
    const summary = header.querySelector(".variable-summary");
    if (summary) {
      summary.textContent = variableCountText(step.variables);
    } else {
      header.querySelector(".header-variable-name").value = step.variables[0].name;
      header.querySelector(".header-variable-value").value = step.variables[0].value;
    }
  }
  function detail(step, index) {
    const settings = document.createElement("div"); settings.className = "settings";
    settings.id = `step-content-${index}`;
    settings.hidden = !step.expanded;
    const grid = document.createElement("div"); grid.className = `grid sensitivity-grid${step.mode === "samples" ? " sensitivity-samples" : ""}`;
    if (step.type === "single" || step.type === "sensitivity") {
      if (step.type === "sensitivity") grid.append(field("Sample source", step, "mode", "", [["vsc", "Sensitivity control file (.vsc)"], ["samples", "Sample table (.txt)"]]));
      if (step.type === "sensitivity") {
        if (step.mode === "vsc") grid.append(fixedExtensionField("Sensitivity input", step, "vsc", ".vsc", "e.g. Tipping_input"));
        else {
          grid.append(fixedExtensionField("Sample table", step, "samples", ".txt", "e.g. Tipping_sobol"));
          grid.append(fixedExtensionField("Control file to create", step, "control", ".vsc", "e.g. samples"));
        }
        grid.append(fixedExtensionField("Output variable list", step, "output", ".lst", "e.g. Tipping_output"));
      }
      if (step.type === "sensitivity") settings.append(grid);
      if (step.reset === false) {
        const note = document.createElement("p"); note.className = "helper";
        note.textContent = "This imported run does not reset previous model changes.";
        settings.append(note);
      }
      settings.append(variableSection(step, index));
      if (step.type === "sensitivity" && step.mode === "samples") {
        const note = document.createElement("div"); note.className = "notice";
        note.textContent = "Vensim needs a control file for file-based samples. Download it and place it where Vensim can find it. The sample file must be tab-delimited, with variable names in the first row.";
        const create = makeButton("Download sensitivity control file", "↓ Download .vsc control file", () => {
          if (!step.samples.trim() || !step.control.trim() || /[,\r\n]/.test(step.samples)) { alert("Enter valid sample and control filenames first. The sample filename cannot contain a comma or newline."); return; }
          download(withExtension(step.control, ".vsc"), controlText(step)); announce("Sensitivity control file downloaded.");
        });
        create.className = "small-button"; settings.append(note, create);
      }
    } else if (step.type === "export") {
      const runs = getRuns(steps);
      const actions = document.createElement("div"); actions.className = "inline-actions";
      const all = makeButton("Export all preceding runs", "Export All", () => {
        const available = getRuns(steps).filter(run => run.index < index);
        if (!available.length) { announce("There are no preceding runs to export."); return; }
        addAllRuns(step, available, index, model);
        render(); announce("All preceding runs added to export.");
      });
      all.className = "small-button";
      const clear = makeButton("Clear all export runs", "Clear All", () => { step.rows = []; render(); announce("Export runs cleared."); }, step.rows.length === 0);
      clear.className = "small-button";
      const add = makeButton("Add run to export", "+ Add Run", () => { step.rows.push(createExportRow(null, model)); render(); });
      add.className = "small-button"; actions.append(all, clear, add); settings.append(actions);
      let hasSensitivity = false;
      step.rows.forEach((entry, rowIndex) => {
        const run = runs.find(item => item.id === entry.runId);
        const row = document.createElement("div"); row.className = "export-row"; row.dataset.rowIndex = rowIndex;
        const select = document.createElement("select"); select.setAttribute("aria-label", `Run ${rowIndex + 1} to export in step ${index + 1}`);
        const blank = document.createElement("option"); blank.value = ""; blank.textContent = "Choose run"; select.append(blank);
        if (entry.runId !== null && !run) {
          const missing = document.createElement("option"); missing.value = entry.runId; missing.textContent = "Removed run — choose another"; select.append(missing);
        }
        runs.forEach(item => {
          const option = document.createElement("option"); option.value = item.id; option.textContent = `${item.name || "(unnamed)"} · ${item.type === "single" ? "single" : "sensitivity"}${item.index >= index ? " (after export)" : ""}`; select.append(option);
        });
        select.value = entry.runId === null ? "" : String(entry.runId);
        select.addEventListener("change", () => { entry.runId = select.value ? Number(select.value) : null; render(); });
        const target = document.createElement("input"); target.setAttribute("aria-label", `Output file for run ${rowIndex + 1} in step ${index + 1}`); target.placeholder = "Output .csv";
        target.value = entry.targetTouched ? entry.target : run ? `${run.name}.csv` : "";
        target.addEventListener("input", () => { entry.target = target.value; entry.targetTouched = true; updatePreview(); });
        row.append(select, target);
        if (run && run.type === "sensitivity") {
          hasSensitivity = true;
          const note = document.createElement("span"); note.className = "export-note"; note.textContent = "All times"; note.title = "Vensim sensitivity exports do not support start/end time limits."; row.append(note);
        } else {
          row.append(field("Interval", entry, "interval", "SAVEPER"), field("Start", entry, "start", "Default"), field("End", entry, "end", "Default"));
          if (run && run.type === "single") {
            const apply = makeButton(`Apply start and end from run ${rowIndex + 1} to all single-run exports in step ${index + 1}`, "Apply to All", () => {
              applyExportTimes(step, entry, getRuns(steps)); render();
              announce("Start and end applied to all single-run exports in this step.");
            });
            apply.className = "small-button"; row.append(apply);
          }
        }
        const remove = makeButton(`Remove export run ${rowIndex + 1} in step ${index + 1}`, "×", () => { step.rows.splice(rowIndex, 1); render(); });
        remove.className = "remove-variable"; row.append(remove); settings.append(row);
      });
      if (hasSensitivity) { const helper = document.createElement("p"); helper.className = "helper"; helper.textContent = "Sensitivity exports include all times; Vensim does not support interval or time range options for this export."; settings.append(helper); }
    } else if (step.type === "raw") {
      const input = document.createElement("input"); input.className = "raw-input"; input.value = step.line; input.placeholder = "CLASS>COMMAND|options"; input.setAttribute("aria-label", `Command for step ${index + 1}`);
      input.addEventListener("input", () => { step.line = input.value; updatePreview(); }); settings.append(input);
      input.addEventListener("change", render);
    }
    return settings;
  }
  function importedTitle(step) {
    if (step.type !== "raw") return TYPES[step.type].title;
    const line = step.line.toUpperCase();
    if (line.startsWith("SIMULATE>RUNNAME|")) return "Name Run";
    if (line.startsWith("SIMULATE>SETVAL|") || line.startsWith('"SIMULATE>SETVAL|')) return "Set Value";
    if (line.startsWith("MENU>RUN_SENSITIVITY")) return "Run Sensitivity";
    if (line.startsWith("MENU>RUN")) return "Run Model";
    if (line.startsWith("MENU>VDF2CSV") || line.startsWith("MENU>SENS2FILE")) return "Export CSV";
    if (line.startsWith("SIMULATE>SENSITIVITY|")) return "Sensitivity Input";
    if (line.startsWith("SIMULATE>SENSSAVELIST|")) return "Sensitivity Output List";
    return "Custom Command";
  }
  function importedKind(step) {
    if (step.type !== "raw") return step.type;
    const line = step.line.toUpperCase();
    if (line.startsWith("MENU>VDF2CSV") || line.startsWith("MENU>SENS2FILE")) return "export";
    if (line.startsWith("SIMULATE>SENS") || line.startsWith("MENU>RUN_SENSITIVITY")) return "sensitivity";
    if (line.startsWith("SIMULATE>RUNNAME") || line.startsWith("SIMULATE>SETVAL") || line.startsWith('"SIMULATE>SETVAL') || line.startsWith("MENU>RUN|")) return "single";
    return "raw";
  }
  function render() {
    stepsElement.replaceChildren();
    steps.forEach((step, index) => {
      const card = document.createElement("article"); card.className = "step";
      card.addEventListener("dragover", event => { if (draggedIndex !== null) { event.preventDefault(); card.classList.add("drag-over"); } });
      card.addEventListener("dragleave", () => card.classList.remove("drag-over"));
      card.addEventListener("drop", event => { event.preventDefault(); card.classList.remove("drag-over"); if (draggedIndex !== null) move(draggedIndex, index); draggedIndex = null; });
      const head = document.createElement("div"); head.className = "step-head";
      const handle = document.createElement("button"); handle.type = "button"; handle.className = "handle"; handle.textContent = "⠿"; handle.title = "Drag or use arrow keys to reorder"; handle.setAttribute("aria-label", `Reorder step ${index + 1}; use up or down arrow keys`); handle.draggable = true;
      handle.addEventListener("dragstart", event => { draggedIndex = index; card.classList.add("dragging"); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", String(index)); });
      handle.addEventListener("dragend", () => { draggedIndex = null; document.querySelectorAll(".step").forEach(item => item.classList.remove("dragging", "drag-over")); });
      handle.addEventListener("keydown", event => {
        const to = index + (event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0);
        if (to === index) return;
        event.preventDefault();
        if (to >= 0 && to < steps.length) { move(index, to); stepsElement.children[to].querySelector(".handle").focus(); }
      });
      const kind = importedKind(step);
      const icon = document.createElement("span"); icon.className = `step-icon ${kind}`; icon.textContent = TYPES[kind].icon; icon.setAttribute("aria-hidden", "true");
      const heading = document.createElement("div"); heading.className = "step-heading";
      const title = document.createElement("button");
      title.textContent = `${step.expanded ? "▾" : "▸"}  (${index + 1})  ${importedTitle(step)}`;
      title.type = "button";
      title.className = "step-toggle";
      title.setAttribute("aria-expanded", String(Boolean(step.expanded)));
      title.setAttribute("aria-controls", `step-content-${index}`);
      title.addEventListener("click", () => {
        step.expanded = !step.expanded;
        card.querySelector(".settings").hidden = !step.expanded;
        title.setAttribute("aria-expanded", String(step.expanded));
        title.textContent = `${step.expanded ? "▾" : "▸"}  (${index + 1})  ${importedTitle(step)}`;
      });
      heading.append(title);
      if (step.type === "single" || step.type === "sensitivity") {
        const name = document.createElement("input"); name.className = "run-name"; name.value = step.name; name.setAttribute("aria-label", `Run name for step ${index + 1}`); name.placeholder = "Run name";
        name.addEventListener("input", () => {
          step.name = name.value;
          steps.forEach((item, exportIndex) => {
            if (item.type !== "export") return;
            const exportCard = stepsElement.children[exportIndex];
            exportCard.querySelectorAll(`select option[value="${step.id}"]`).forEach(option => {
              option.textContent = `${step.name || "(unnamed)"} · ${step.type === "single" ? "single" : "sensitivity"}${index >= exportIndex ? " (after export)" : ""}`;
            });
            item.rows.forEach((row, rowIndex) => {
              if (row.runId !== step.id || row.targetTouched) return;
              const target = exportCard.querySelector(`.export-row[data-row-index="${rowIndex}"] input[aria-label^='Output file']`);
              if (target) target.value = `${step.name}.csv`;
            });
          });
          updatePreview();
        });
        heading.append(name);
        if (step.type === "single") {
          const variables = document.createElement("div"); variables.className = "header-variables";
          if (step.variables.length > 1) {
            const summary = document.createElement("span"); summary.className = "variable-summary";
            summary.textContent = variableCountText(step.variables);
            variables.append(summary);
          } else {
            const variable = step.variables[0];
            const variableName = document.createElement("input"); variableName.className = "header-variable-name";
            variableName.placeholder = "Variable"; variableName.value = variable.name;
            variableName.setAttribute("aria-label", `Step ${index + 1} header variable name`);
            if (model) variableName.setAttribute("list", "model-constants");
            const variableValue = document.createElement("input"); variableValue.className = "header-variable-value";
            variableValue.placeholder = "Value"; variableValue.value = variable.value;
            variableValue.setAttribute("aria-label", `Step ${index + 1} header variable value`);
            const syncDetail = () => {
              const row = card.querySelector(".variable-row");
              if (row) { row.querySelectorAll("input")[0].value = variable.name; row.querySelectorAll("input")[1].value = variable.value; }
              updatePreview();
            };
            variableName.addEventListener("input", () => { variable.name = variableName.value; syncDetail(); });
            variableValue.addEventListener("input", () => { variable.value = variableValue.value; syncDetail(); });
            variables.append(variableName, variableValue);
          }
          heading.append(variables);
        }
        const changeInputs = document.createElement("div"); changeInputs.className = "header-inputs";
        const changeExtension = [".csv", ".cin", ".tab", ".txt"].find(extension => step.cin.toLowerCase().endsWith(extension))
          || (step.imported && step.cin ? "" : ".csv");
        const changeGroup = document.createElement("div"); changeGroup.className = "fixed-extension header-input-file";
        const changeFile = document.createElement("input"); changeFile.className = "run-cin"; changeFile.value = changeExtension ? filenameStem(step.cin, changeExtension) : step.cin;
        changeFile.placeholder = "Additional Inputs";
        changeFile.setAttribute("aria-label", `Additional Inputs filename (${changeExtension || "no extension"}) for step ${index + 1}`);
        changeFile.title = "Filename without extension. Passed to Vensim READCIN; use a compatible change-file format.";
        if (changeExtension) {
          const changeSuffix = document.createElement("span"); changeSuffix.textContent = changeExtension; changeSuffix.setAttribute("aria-hidden", "true");
          changeGroup.append(changeFile, changeSuffix);
        } else changeGroup.append(changeFile);
        changeFile.addEventListener("input", () => {
          step.cin = changeFile.value && changeExtension ? withExtension(changeFile.value, changeExtension) : changeFile.value;
          if (changeExtension) changeFile.value = filenameStem(step.cin, changeExtension);
          updatePreview();
        });
        changeInputs.append(changeGroup); heading.append(changeInputs);
      } else if (step.type === "raw") { const subtitle = document.createElement("small"); subtitle.textContent = step.line; heading.append(subtitle); }
      const actions = document.createElement("div"); actions.className = "step-actions";
      actions.append(makeButton(`Duplicate step ${index + 1} below`, "⧉", () => {
        steps.splice(index + 1, 0, duplicateStep(step)); render();
        stepsElement.children[index + 1].querySelector(".step-actions button").focus();
        announce(`Duplicated step ${index + 1} below.`);
      }));
      actions.append(makeButton(`Remove step ${index + 1}`, "×", () => { steps.splice(index, 1); render(); announce("Step removed."); }));
      head.append(handle, icon, heading, actions); card.append(head);
      card.append(detail(step, index));
      stepsElement.append(card);
    });
    updatePreview();
  }
  document.querySelectorAll("[data-add]").forEach(element => element.addEventListener("click", () => { const step = createStep(element.dataset.add); if (step.type === "export") addAllRuns(step, getRuns(steps), steps.length, model); steps.push(step); render(); announce(`${TYPES[element.dataset.add].title} added.`); }));
  document.querySelector("#clear-button").addEventListener("click", () => { if (steps.length && confirm("Clear all steps? This cannot be undone.")) { steps = []; trailingNewline = true; render(); announce("All steps cleared."); } });
  document.querySelector("#import-file").addEventListener("change", async event => {
    const file = event.target.files[0]; if (!file) return;
    if (steps.length && !confirm("Importing replaces your current script. Continue?")) { event.target.value = ""; return; }
    try { const parsed = parseScript(await file.text()); steps = parsed.steps; trailingNewline = parsed.trailingNewline; render(); announce(`Imported ${file.name}.`); }
    catch (error) { alert(`Could not read the file: ${error.message}`); }
    finally { event.target.value = ""; }
  });
  document.querySelector("#download-button").addEventListener("click", () => {
    const issues = steps.flatMap(warningsFor);
    if (issues.length) { alert("Please resolve the highlighted issues before downloading."); return; }
    download("vensim-script.cmd", scriptText()); announce("Script downloaded.");
  });
  document.querySelector("#copy-button").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(scriptText()); announce("Script copied to clipboard."); const button = document.querySelector("#copy-button"); button.textContent = "Copied!"; setTimeout(() => { button.textContent = "Copy"; }, 2000); }
    catch (error) { alert(`Could not copy the script: ${error.message}. You can download it instead.`); }
  });
  render();
}
