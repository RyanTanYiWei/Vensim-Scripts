"use strict";

const SAMPLER_COLUMNS = ["Type", "Variable", "Distribution", "Min", "Max", "Increment", "Remarks"];
const SAMPLER_GROUPS = [
  { type: "Constant", label: "Constants" },
  { type: "Input", label: "Inputs" },
  { type: "Output", label: "Outputs" }
];
const DEFAULT_SAMPLER_SETTINGS = { method: "L", simulations: "100", seed: "1234", order: "first", filename: "" };
const MAX_SOBOL_CELLS = 5000000;

function splitDelimited(text, delimiter) {
  const rows = [];
  let row = [], value = "", quoted = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') { value += '"'; index++; }
      else if (character === '"') quoted = false;
      else value += character;
    } else if (character === '"' && value === "") quoted = true;
    else if (character === delimiter) { row.push(value); value = ""; }
    else if (character === "\r" || character === "\n") {
      row.push(value); rows.push(row); row = []; value = "";
      if (character === "\r" && text[index + 1] === "\n") index++;
    } else value += character;
  }
  if (quoted) throw new Error("A quoted CSV field has no closing quote.");
  if (value || row.length) { row.push(value); rows.push(row); }
  return rows;
}

function detectDelimiter(text) {
  const firstLine = text.split(/\r\n|\n|\r/, 1)[0] || "";
  const commaCount = splitDelimited(firstLine, ",")[0].length;
  const tabCount = splitDelimited(firstLine, "\t")[0].length;
  return tabCount > commaCount ? "\t" : ",";
}

function parseSamplerTable(text) {
  const source = text.replace(/^\uFEFF/, "");
  const records = splitDelimited(source, detectDelimiter(source)).filter(row => row.some(cell => cell.trim()));
  if (!records.length) throw new Error("The table is empty.");
  const headers = records[0].map(header => header.trim().toLowerCase());
  const required = ["type", "variable"];
  if (required.some(header => !headers.includes(header))) {
    throw new Error("The first row must include Type and Variable column headers.");
  }
  if (headers.some(header => !SAMPLER_COLUMNS.some(column => column.toLowerCase() === header))) {
    throw new Error("The table contains an unsupported column header.");
  }
  const headerIndexes = new Map(headers.map((header, index) => [header, index]));
  if (headerIndexes.size !== headers.length) throw new Error("Column headers must be unique.");
  const rows = [];
  records.slice(1).forEach((record, rowIndex) => {
    if (record.length > headers.length && record.slice(headers.length).some(cell => cell.trim())) {
      throw new Error(`Row ${rowIndex + 2} has values outside the header columns.`);
    }
    const values = Object.fromEntries(SAMPLER_COLUMNS.map(column => {
      const index = headerIndexes.get(column.toLowerCase());
      return [column.toLowerCase(), index === undefined ? "" : (record[index] || "").trim()];
    }));
    const type = SAMPLER_GROUPS.find(group => group.type.toLowerCase() === values.type.toLowerCase());
    if (!type) throw new Error(`Row ${rowIndex + 2} must have Type Constant, Input, or Output.`);
    if (!values.variable) throw new Error(`Row ${rowIndex + 2} is missing a Variable name.`);
    rows.push({ ...values, type: type.type });
  });
  return rows;
}

function constantValue(row) {
  return row.min.trim() || row.max.trim();
}

const samplerCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function sortSamplerRows(rows, type, key, direction) {
  const numeric = ["value", "min", "max", "increment"].includes(key);
  const valueFor = row => (key === "value" ? constantValue(row) : row[key]).trim();
  const sorted = rows.filter(row => row.type === type).sort((a, b) => {
    const left = valueFor(a), right = valueFor(b);
    if (!left || !right) return left ? -1 : right ? 1 : 0;
    let result;
    if (numeric) {
      const leftNumber = Number(left), rightNumber = Number(right);
      const leftNumeric = Number.isFinite(leftNumber), rightNumeric = Number.isFinite(rightNumber);
      if (leftNumeric && rightNumeric) result = leftNumber < rightNumber ? -1 : leftNumber > rightNumber ? 1 : 0;
      else if (leftNumeric !== rightNumeric) result = leftNumeric ? -1 : 1;
      else result = samplerCollator.compare(left, right);
    } else result = samplerCollator.compare(left, right);
    return direction === "ascending" ? result : -result;
  });
  let index = 0;
  return rows.map(row => row.type === type ? sorted[index++] : row);
}

function samplerConstantCSV(rows) {
  const constants = rows.filter(row => row.type === "Constant");
  if (!constants.length) throw new Error("There are no Constant rows to export.");
  return constants.map((row, index) => {
    const value = constantValue(row);
    if (!row.variable.trim() || !value) throw new Error(`Constant row ${index + 1} needs a Variable and Value.`);
    return [row.variable.trim(), value].map(csvCell).join(",");
  }).join("\n") + "\n";
}

function csvCell(value) {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function samplerTableCSV(rows) {
  const groupedRows = SAMPLER_GROUPS.flatMap(group => rows.filter(row => row.type === group.type));
  if (groupedRows.length !== rows.length) throw new Error("Every row needs a valid Type.");
  groupedRows.forEach((row, index) => {
    if (!row.variable.trim()) throw new Error(`Table row ${index + 1} needs a Variable name before export.`);
  });
  return [SAMPLER_COLUMNS, ...groupedRows.map(row => SAMPLER_COLUMNS.map(column => row[column.toLowerCase()]))]
    .map(record => record.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

function samplerSettings(settings = DEFAULT_SAMPLER_SETTINGS) {
  const simulations = String(settings.simulations).trim(), seed = String(settings.seed).trim();
  if (!/^\d+$/.test(simulations) || !Number.isSafeInteger(Number(simulations)) || Number(simulations) < 1) {
    throw new Error("Simulations must be a positive whole number.");
  }
  if (!/^\d+$/.test(seed) || Number(seed) > 2147483647) throw new Error("Seed must be an integer from 0 to 2147483647.");
  if (settings.method === "L") return { method: "L", simulations, seed };
  if (settings.method !== "sobol") throw new Error("Choose Latin Hypercube or Sobol.");
  if (!["first", "total", "second"].includes(settings.order)) throw new Error("Choose a supported Sobol order.");
  const count = Number(simulations);
  if (count > 1048576 || !Number.isInteger(Math.log2(count))) throw new Error("Sobol base sample size must be a power of two, up to 1048576.");
  const filename = String(settings.filename || "").trim();
  if (!filename || /[<>:"/\\|?*,\r\n]/.test(filename) || !/\.txt$/i.test(filename)) {
    throw new Error("Enter a valid Sobol sample filename ending in .txt (without a path or comma).");
  }
  return { method: "sobol", simulations, seed, order: settings.order, filename };
}

function samplerInputVSC(rows, settings = DEFAULT_SAMPLER_SETTINGS) {
  const options = samplerSettings(settings);
  const inputs = rows.filter(row => row.type === "Input");
  if (!inputs.length) throw new Error("There are no Input rows to export.");
  if (options.method === "sobol") {
    checkSobolSize(sobolInputs(rows).length, options);
    return `,F,,${options.filename},1\r\n`;
  }
  const lines = inputs.map((row, index) => {
    const distribution = row.distribution.trim().toUpperCase();
    const fields = [row.min, row.max, row.increment].map(value => value.trim());
    if (!row.variable.trim() || !fields[0] || !fields[1]) throw new Error(`Input row ${index + 1} needs a Variable, Min, and Max value.`);
    if (fields.slice(0, 2).some(value => /[,\r\n]/.test(value)) || /[\r\n=]/.test(row.variable)) {
      throw new Error(`Input row ${index + 1} contains characters that cannot be represented in a Vensim assignment.`);
    }
    if (distribution === "UNIFORM") return `${row.variable.trim()}=RANDOM_UNIFORM(${fields[0]},${fields[1]}) `;
    if (distribution === "VECTOR") {
      if (!fields[2] || /[,\r\n]/.test(fields[2])) throw new Error(`Input row ${index + 1} needs a valid Increment for VECTOR.`);
      return `${row.variable.trim()}=VECTOR(${fields[0]},${fields[1]},${fields[2]}) `;
    }
    throw new Error(`Input row ${index + 1} has unsupported Distribution "${row.distribution}". Use UNIFORM or VECTOR.`);
  });
  return `${options.simulations},L,${options.seed},,1 \r\n${lines.join("\r\n")}\r\n`;
}

function sobolInputs(rows) {
  const inputs = rows.filter(row => row.type === "Input"), names = new Set();
  if (!inputs.length) throw new Error("There are no Input rows to sample.");
  if (inputs.length > 500) throw new Error("Sobol sampling supports at most 500 inputs.");
  return inputs.map((row, index) => {
    const name = row.variable.trim(), distribution = row.distribution.trim().toUpperCase();
    if (!name || /[\t\r\n]/.test(name) || name.startsWith("#")) throw new Error(`Input row ${index + 1} needs a valid single-line Variable name.`);
    const key = name.toUpperCase().replace(/[\s_]+/g, " ").replace(/\s*([\[\],])\s*/g, "$1");
    if (names.has(key)) throw new Error(`Input row ${index + 1} duplicates another variable.`);
    names.add(key);
    const minText = row.min.trim(), maxText = row.max.trim();
    const min = Number(minText), max = Number(maxText);
    if (!minText || !maxText || !Number.isFinite(min) || !Number.isFinite(max) || max <= min || !Number.isFinite(max - min)) {
      throw new Error(`Input row ${index + 1} needs finite numeric Min and Max values with Max greater than Min.`);
    }
    if (distribution === "UNIFORM") return { name, min, max, distribution };
    if (distribution === "VECTOR") {
      const stepText = row.increment.trim(), step = Number(stepText);
      const steps = (max - min) / step;
      if (!stepText || !Number.isFinite(step) || step <= 0 || !Number.isSafeInteger(Math.round(steps)) ||
          Math.abs(steps - Math.round(steps)) > 1e-10 * Math.max(1, Math.abs(steps))) {
        throw new Error(`Input row ${index + 1} needs a positive VECTOR Increment that evenly divides its range.`);
      }
      return { name, min, max, distribution, step, count: Math.round(steps) + 1 };
    }
    throw new Error(`Input row ${index + 1} has unsupported Distribution "${row.distribution}". Use UNIFORM or VECTOR.`);
  });
}

function checkSobolSize(dimensions, options) {
  const rowsPerSample = (options.order === "second" ? 2 * dimensions : dimensions) + 2;
  if (Number(options.simulations) * rowsPerSample * dimensions > MAX_SOBOL_CELLS) {
    throw new Error("Sobol table is too large; reduce the sample size or number of inputs.");
  }
}

function samplerSobolText(rows, settings, SobolGenerator) {
  const options = samplerSettings(settings);
  if (options.method !== "sobol") throw new Error("Choose Sobol to create a sample table.");
  const inputs = sobolInputs(rows), dimensions = inputs.length, n = Number(options.simulations);
  checkSobolSize(dimensions, options);
  if (typeof SobolGenerator !== "function") throw new Error("The Sobol generator is unavailable. Check that the bundled library is loaded.");
  let state = Number(options.seed) >>> 0;
  const shifts = Array.from({ length: dimensions * 2 }, () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return (value ^ (value >>> 14)) >>> 0;
  });
  const generator = new SobolGenerator(dimensions * 2);
  const lines = [inputs.map(input => input.name).join("\t")];
  const mapValue = (u, input) => input.distribution === "VECTOR"
    ? input.min + Math.floor(u * input.count) * input.step
    : input.min + u * (input.max - input.min);
  const addRow = values => lines.push(values.map(value => String(Number(value.toPrecision(15)))).join("\t"));
  for (let sample = 0; sample < n; sample++) {
    const point = generator.take(1)[0].map((value, index) => (((value * 4294967296) >>> 0) ^ shifts[index]) >>> 0);
    const a = inputs.map((input, index) => mapValue(point[index] / 4294967296, input));
    const b = inputs.map((input, index) => mapValue(point[index + dimensions] / 4294967296, input));
    addRow(a);
    for (let i = 0; i < dimensions; i++) addRow(a.map((value, index) => index === i ? b[index] : value));
    if (options.order === "second") {
      for (let i = 0; i < dimensions; i++) addRow(b.map((value, index) => index === i ? a[index] : value));
    }
    addRow(b);
  }
  return `${lines.join("\r\n")}\r\n`;
}

function samplerOutputList(rows) {
  const outputs = rows.filter(row => row.type === "Output");
  if (!outputs.length) throw new Error("There are no Output rows to export.");
  return outputs.map((row, index) => {
    if (!row.variable.trim() || /[\r\n]/.test(row.variable)) throw new Error(`Output row ${index + 1} needs a single-line Variable name.`);
    return `${row.variable.trim()} `;
  }).join("\r\n") + "\r\n";
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { parseSamplerTable, samplerConstantCSV, samplerTableCSV, samplerInputVSC, samplerOutputList, samplerSettings, samplerSobolText, sortSamplerRows };
}

if (typeof document !== "undefined") {
  let rows = [];
  let nextRowId = 0;
  const sortStates = {};
  const status = document.querySelector("#sampler-status");
  const announce = message => {
    status.textContent = message;
    document.querySelector("#announcement").textContent = message;
  };

  function setImportedRows(imported, filename) {
    rows = imported.map(row => ({ ...row, id: ++nextRowId }));
    SAMPLER_GROUPS.forEach(group => { delete sortStates[group.type]; });
    if (filename) document.querySelector("#sampler-prefix").value = filename.replace(/\.[^.]+$/, "");
    renderSamplerRows();
    announce(`Imported ${rows.length} ${rows.length === 1 ? "row" : "rows"}${filename ? ` from ${filename}` : ""}.`);
  }

  function addSamplerRow(type) {
    rows.push({ id: ++nextRowId, type, variable: "", distribution: "", min: "", max: "", increment: "", remarks: "" });
    delete sortStates[type];
    renderSamplerRows();
    const last = document.querySelector(`#sampler-group-${type} tbody tr:last-child input`);
    if (last) last.focus();
  }

  function clearSort(type) {
    delete sortStates[type];
    const header = document.querySelector(`#sampler-group-${type} th[aria-sort]`);
    if (header) {
      header.removeAttribute("aria-sort");
      const button = header.querySelector("button");
      button.textContent = button.dataset.column;
    }
  }

  function renderSamplerRows() {
    const groups = document.querySelector("#sampler-groups");
    groups.replaceChildren();
    SAMPLER_GROUPS.forEach(group => {
      const groupRows = rows.filter(row => row.type === group.type);
      const section = document.createElement("section"); section.className = "sampler-group"; section.id = `sampler-group-${group.type}`;
      const heading = document.createElement("div"); heading.className = "sampler-group-heading";
      const title = document.createElement("h3"); title.textContent = `${group.label} `;
      const count = document.createElement("span"); count.className = "count"; count.textContent = `${groupRows.length} ${groupRows.length === 1 ? "row" : "rows"}`;
      title.append(count);
      const add = document.createElement("button"); add.type = "button"; add.className = "small-button"; add.textContent = `+ Add ${group.type.toLowerCase()}`;
      add.addEventListener("click", () => addSamplerRow(group.type));
      heading.append(title, add); section.append(heading);
      const table = document.createElement("table"); table.className = `sampler-table sampler-table-${group.type.toLowerCase()}`;
      const columns = group.type === "Constant"
        ? ["Type", "Variable", "Value", "Remarks"]
        : group.type === "Output" ? ["Type", "Variable", "Remarks"] : SAMPLER_COLUMNS;
      const colgroup = document.createElement("colgroup");
      [...columns.map(column => column.toLowerCase()), "actions"].forEach(name => {
        const col = document.createElement("col"); col.className = `sampler-column-${name}`; colgroup.append(col);
      });
      table.append(colgroup);
      const thead = document.createElement("thead"), headerRow = document.createElement("tr");
      columns.forEach(column => {
        const cell = document.createElement("th"); cell.scope = "col";
        const key = column.toLowerCase(), current = sortStates[group.type];
        if (key === "type") cell.textContent = column;
        else {
          const button = document.createElement("button"); button.type = "button"; button.className = "sampler-sort";
          button.dataset.column = column;
          button.setAttribute("aria-label", `Sort ${group.label} by ${column}`);
          const active = current && current.key === key;
          button.textContent = `${column}${active ? current.direction === "ascending" ? " ↑" : " ↓" : ""}`;
          if (active) cell.setAttribute("aria-sort", current.direction);
          button.addEventListener("click", () => {
            const previous = sortStates[group.type];
            const direction = previous && previous.key === key && previous.direction === "ascending" ? "descending" : "ascending";
            rows = sortSamplerRows(rows, group.type, key, direction);
            sortStates[group.type] = { key, direction };
            renderSamplerRows();
            document.querySelector(`#sampler-group-${group.type} button[aria-label="Sort ${group.label} by ${column}"]`).focus();
            announce(`${group.label} sorted by ${column}, ${direction}.`);
          });
          cell.append(button);
        }
        headerRow.append(cell);
      });
      const actionHeader = document.createElement("th"); actionHeader.scope = "col"; headerRow.append(actionHeader);
      thead.append(headerRow); table.append(thead);
      const tbody = document.createElement("tbody");
      groupRows.forEach(row => {
        const tr = document.createElement("tr");
        columns.forEach(column => {
          const key = column.toLowerCase(), td = document.createElement("td");
          if (key === "type") {
            const select = document.createElement("select"); select.setAttribute("aria-label", "Row type");
            SAMPLER_GROUPS.forEach(optionGroup => {
              const option = document.createElement("option"); option.value = optionGroup.type; option.textContent = optionGroup.type; select.append(option);
            });
            select.value = row.type;
            select.addEventListener("change", () => {
              delete sortStates[row.type]; delete sortStates[select.value];
              row.type = select.value; renderSamplerRows();
            });
            td.append(select);
          } else {
            const input = document.createElement("input"); input.type = "text"; input.value = key === "value" ? constantValue(row) : row[key];
            input.setAttribute("aria-label", `${column} for ${row.variable || "new row"}`);
            if (key === "variable") {
              input.setAttribute("list", row.type === "Output" ? "model-variables" : "model-constants");
              input.placeholder = "Search model or enter a name";
            }
            input.addEventListener("input", () => {
              if (key === "value") { row.min = input.value; row.max = ""; }
              else row[key] = input.value;
              if (sortStates[group.type] && sortStates[group.type].key === key) clearSort(group.type);
            });
            td.append(input);
          }
          tr.append(td);
        });
        const actionCell = document.createElement("td");
        const remove = document.createElement("button"); remove.type = "button"; remove.className = "remove-variable";
        remove.textContent = "×"; remove.setAttribute("aria-label", `Remove ${row.variable || "blank"} row`);
        remove.addEventListener("click", () => { rows = rows.filter(candidate => candidate.id !== row.id); renderSamplerRows(); });
        actionCell.append(remove); tr.append(actionCell); tbody.append(tr);
      });
      if (!tbody.children.length) {
        const emptyRow = document.createElement("tr"), emptyCell = document.createElement("td");
        emptyCell.colSpan = columns.length + 1; emptyCell.className = "sampler-empty"; emptyCell.textContent = `No ${group.label.toLowerCase()} yet.`;
        emptyRow.append(emptyCell); tbody.append(emptyRow);
      }
      table.append(tbody);
      const tableWrap = document.createElement("div"); tableWrap.className = "sampler-table-wrap"; tableWrap.append(table);
      section.append(tableWrap); groups.append(section);
    });
    updateSamplerSettings();
  }

  async function importFile(file) {
    try { setImportedRows(parseSamplerTable(await file.text()), file.name); }
    catch (error) { announce(`Could not import ${file.name}: ${error.message}`); }
  }

  function outputPrefix() {
    const rawPrefix = document.querySelector("#sampler-prefix").value.trim();
    const prefix = rawPrefix.replace(/\.csv$/i, "");
    if (!prefix) throw new Error("Enter an output filename prefix.");
    if (/[<>:"/\\|?*\r\n]/.test(prefix)) throw new Error("The output prefix cannot contain path separators or filename-reserved characters.");
    return prefix;
  }

  function downloadFile(filename, contents) {
    const url = URL.createObjectURL(new Blob([contents], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = filename; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function currentSamplerSettings() {
    const rawFilename = document.querySelector("#sampler-sobol-file").value.trim();
    const filename = rawFilename || `${outputPrefix()}_sobol`;
    return {
      method: document.querySelector("#sampler-method").value,
      simulations: document.querySelector("#sampler-simulations").value,
      seed: document.querySelector("#sampler-seed").value,
      order: document.querySelector("#sampler-order").value,
      filename: /\.txt$/i.test(filename) ? filename : `${filename}.txt`
    };
  }

  function updateSamplerSettings() {
    const method = document.querySelector("#sampler-method").value;
    const isSobol = method === "sobol";
    document.querySelector("#sampler-order-field").hidden = !isSobol;
    document.querySelector("#sampler-sobol-file-field").hidden = !isSobol;
    document.querySelector("#sampler-sobol-download").hidden = !isSobol;
    document.querySelector("#sampler-count-label").textContent = isSobol ? "Base sample size (N)" : "Simulations";
    const note = document.querySelector("#sampler-settings-note");
    note.hidden = !isSobol;
    if (!isSobol) return;
    const dimensions = rows.filter(row => row.type === "Input").length;
    const count = Number(document.querySelector("#sampler-simulations").value);
    const perSample = (document.querySelector("#sampler-order").value === "second" ? 2 * dimensions : dimensions) + 2;
    const total = dimensions && Number.isSafeInteger(count) && count > 0 ? count * perSample : 0;
    note.textContent = `Sobol uses a seeded digital shift and a power-of-two base size. ${total ? `${total.toLocaleString()} total runs for ${dimensions} inputs.` : "Add inputs and a base size to calculate total runs."} Vensim's file method uses every row in the .txt file; its seed and simulation count are ignored.`;
  }

  function samplerExport(type) {
    const prefix = outputPrefix();
    if (type === "table") return { filename: `${prefix}_table.csv`, contents: samplerTableCSV(rows) };
    if (type === "constant") return { filename: `${prefix}_constant.csv`, contents: samplerConstantCSV(rows) };
    if (type === "input") return { filename: `${prefix}_input.vsc`, contents: samplerInputVSC(rows, currentSamplerSettings()) };
    if (type === "output") return { filename: `${prefix}_output.lst`, contents: samplerOutputList(rows) };
    if (type === "sobol") {
      const settings = currentSamplerSettings();
      return { filename: settings.filename, contents: samplerSobolText(rows, settings, typeof lobos === "undefined" ? undefined : lobos.Sobol) };
    }
    throw new Error("Choose a supported sampler export.");
  }

  function samplerExports() {
    const types = ["constant", "input", "output"];
    if (document.querySelector("#sampler-method").value === "sobol") types.push("sobol");
    return types.map(samplerExport);
  }

  function downloadAll() {
    try {
      const exports = samplerExports();
      exports.forEach(file => downloadFile(file.filename, file.contents));
      announce(`Downloaded all files for ${outputPrefix()}.`);
    } catch (error) { announce(`Could not create all files: ${error.message}`); }
  }

  document.querySelector("#sampler-file").addEventListener("change", event => {
    const file = event.target.files[0];
    if (file) importFile(file);
    event.target.value = "";
  });
  document.querySelector("#sampler-paste-import").addEventListener("click", () => {
    try { setImportedRows(parseSamplerTable(document.querySelector("#sampler-paste").value)); }
    catch (error) { announce(`Could not import pasted rows: ${error.message}`); }
  });
  document.querySelector("#sampler-download-all").addEventListener("click", downloadAll);
  document.querySelector("#sampler-method").addEventListener("change", () => {
    const count = document.querySelector("#sampler-simulations");
    if (document.querySelector("#sampler-method").value === "sobol" && count.value === "100") count.value = "128";
    updateSamplerSettings();
  });
  ["#sampler-simulations", "#sampler-order"].forEach(selector => document.querySelector(selector).addEventListener("input", updateSamplerSettings));
  document.querySelectorAll("[data-export]").forEach(button => button.addEventListener("click", () => {
    try {
      const file = samplerExport(button.dataset.export);
      downloadFile(file.filename, file.contents);
      announce(`Downloaded ${file.filename}.`);
    } catch (error) { announce(`Could not create file: ${error.message}`); }
  }));
  function showToolFromUrl() {
    const hash = window.location.hash;
    const target = hash === "#sensitivity-sampler" ? "sampler-page" : "builder-page";
    document.querySelectorAll(".tool-switch [data-page]").forEach(tab => {
      const selected = tab.dataset.page === target;
      tab.classList.toggle("selected", selected);
      if (selected) tab.setAttribute("aria-current", "page");
      else tab.removeAttribute("aria-current");
      if (selected) document.title = tab.textContent;
    });
    document.querySelectorAll("main > section[id$='-page']").forEach(page => { page.hidden = page.id !== target; });
  }

  window.addEventListener("hashchange", showToolFromUrl);
  showToolFromUrl();
  renderSamplerRows();
}
