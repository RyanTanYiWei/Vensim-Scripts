"use strict";

const MODEL_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const MODEL_NAME = /^[\p{L}][\p{L}\p{N}_ '$]*$/u;
const MODEL_QUOTED_NAME = /^"[^"\\|&\r\n]+"$/u;
const TIME_NAMES = new Set(["INITIAL TIME", "FINAL TIME", "TIME STEP", "SAVEPER"]);

function modelKey(name) {
  return name.replace(/"/g, "").replace(/[\s_]+/g, " ").replace(/\s*([\[\],])\s*/g, "$1").trim().toUpperCase();
}

function isModelName(name) { return MODEL_NAME.test(name) || MODEL_QUOTED_NAME.test(name); }

function parseModel(text) {
  if (!text || text.includes("\uFFFD")) throw new Error("The model is empty or is not valid UTF-8.");
  const marker = text.indexOf("\\\\\\---///");
  if (marker !== -1) text = text.slice(0, marker);
  text = text.replace(/^\uFEFF/, "").replace(/^\s*\{UTF-8\}\s*/i, "");
  const records = text.split("|");
  if (records.length < 2 || !text.includes("~")) throw new Error("This does not look like a Vensim text model (.mdl).");
  const ranges = new Map(), knownRanges = new Set(), equations = [];
  for (const record of records) {
    const parts = record.split("~");
    if (parts.length < 2) continue;
    const equation = parts[0].replace(/\\\s*\r?\n\s*/g, " ").trim();
    if (!equation || equation.startsWith("*") || equation.startsWith(":")) continue;
    const range = /^([^:=\[\]\r\n]+):\s*([\s\S]+)$/.exec(equation);
    if (range && MODEL_NAME.test(range[1].trim())) {
      knownRanges.add(modelKey(range[1]));
      const members = range[2].split(",").map(value => value.trim());
      if (members.length && members.every(value => isModelName(value) && !/[\[\]!]/.test(value))) {
        ranges.set(modelKey(range[1]), members);
      }
      continue;
    }
    const assignment = /^([\s\S]+?)\s*(==|=)\s*([\s\S]+)$/.exec(equation);
    if (!assignment) continue;
    equations.push({ name: assignment[1].trim().replace(/\s+/g, " "), operator: assignment[2], value: assignment[3].trim().replace(/\s+/g, " "), units: parts[1].trim().replace(/\s*\[[^\]]*\]\s*$/, "").trim() });
  }
  if (!equations.length) throw new Error("No model equations were found in this file.");
  const constants = [], unresolved = [];
  let initialTime = "", finalTime = "", timeUnit = "";
  for (const equation of equations) {
    const key = modelKey(equation.name);
    if (TIME_NAMES.has(key)) {
      if (key === "INITIAL TIME" && MODEL_NUMBER.test(equation.value)) initialTime = equation.value;
      if (key === "FINAL TIME" && MODEL_NUMBER.test(equation.value)) finalTime = equation.value;
      if (!timeUnit && (key === "INITIAL TIME" || key === "FINAL TIME" || key === "TIME STEP") && equation.units) timeUnit = equation.units;
      continue;
    }
    if (equation.operator !== "=") continue;
    const nameMatch = /^([^\[\]]+)(?:\[([^\[\]]+)\])?$/.exec(equation.name);
    if (!nameMatch) continue;
    const name = nameMatch[1].trim();
    const values = equation.value.split(",").map(value => value.trim());
    if (!values.every(value => MODEL_NUMBER.test(value))) {
      if (/^(?:GET\s+XLS\s+CONSTANTS|TABBED\s+ARRAY)\s*\(/i.test(equation.value)) unresolved.push(equation.name);
      continue;
    }
    if (!isModelName(name)) { unresolved.push(equation.name); continue; }
    if (!nameMatch[2]) {
      if (values.length === 1) constants.push({ name, value: values[0] });
      else unresolved.push(equation.name);
      continue;
    }
    const subscripts = nameMatch[2].split(",").map(value => value.trim());
    const rangePositions = subscripts.map((subscript, index) => ranges.has(modelKey(subscript)) ? index : -1).filter(index => index !== -1);
    if (!subscripts.every(isModelName) || (rangePositions.length > 1 && values.length !== 1) || subscripts.some(subscript => knownRanges.has(modelKey(subscript)) && !ranges.has(modelKey(subscript)))) {
      unresolved.push(equation.name);
    } else if (rangePositions.length > 1) {
      let combinations = [[]];
      for (const subscript of subscripts) {
        const members = ranges.get(modelKey(subscript)) || [subscript];
        combinations = combinations.flatMap(prefix => members.map(member => [...prefix, member]));
      }
      combinations.forEach(parts => constants.push({ name: `${name}[${parts.join(",")}]`, value: values[0] }));
    } else if (rangePositions.length === 1) {
      const position = rangePositions[0], members = ranges.get(modelKey(subscripts[position]));
      if (values.length !== 1 && members.length !== values.length) { unresolved.push(equation.name); continue; }
      members.forEach((member, index) => {
        const resolved = [...subscripts]; resolved[position] = member;
        constants.push({ name: `${name}[${resolved.join(",")}]`, value: values.length === 1 ? values[0] : values[index] });
      });
    } else if (values.length === 1) {
      constants.push({ name: `${name}[${subscripts.join(",")}]`, value: values[0] });
    } else unresolved.push(equation.name);
  }
  const unique = new Map(), conflicts = new Set();
  for (const constant of constants) {
    const key = modelKey(constant.name);
    if (unique.has(key) && unique.get(key).value !== constant.value) conflicts.add(key);
    else if (!unique.has(key)) unique.set(key, constant);
  }
  for (const key of conflicts) { unresolved.push(unique.get(key).name); unique.delete(key); }
  return { constants: [...unique.values()], initialTime, finalTime, timeUnit, unresolved };
}

if (typeof module !== "undefined" && module.exports) module.exports = { parseModel, modelKey };
