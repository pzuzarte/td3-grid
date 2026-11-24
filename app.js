"use strict";
/* TD-3 Grid: draws a TD-3 pattern on a grid, plays it on the TD-3, keeps patterns in a
   library in the browser, and reads and writes the TD-3's own patterns over USB SysEx.
   The pattern format is in td3.js. */

const $ = (id) => document.getElementById(id);
const STORAGE_KEY = "td3-grid";
const LIBRARY_KEY = "td3-grid-library";
// Shared by all the grids, so switching one switches them all.
const THEME_KEY = "midi-grids-theme";
const UNDO_LIMIT = 100;
const REPLY_TIMEOUT_MS = 1500;
const SETTLE_MS = 250; // A pause after writing a pattern, before reading it back.
const LOOKAHEAD_MS = 120;
const TICK_MS = 25;

const state = {
  pattern: TD3.emptyPattern(),
  name: "",
  libraryId: null,
  fileKey: null, // The .syx file the pattern came from or was saved to, so Save writes to it.
  bpm: 125,
  root: 0,
  scale: "chromatic",
  group: 0,
  slot: 0,
  channel: 1,
  hear: true,
  sendClock: false, // MIDI clock, start and stop with playback.
  moveWithKey: true,
  keyOff: false, // No key: the rows are the TD-3's own keys, C to the high C, all showing.
  outputName: "",
  undo: [],
  redo: [],
};
let library = [];
let midi = null;
let output = null;
let accentThreshold = null;
let putBack = null; // What a Send or Paste replaced, so it can be restored.
let copied = null; // A pattern copied from the TD-3, with where it came from.
let busy = false;

/* ---------- Saving in the browser ---------- */

function readJson(key, fallback) {
  try {
    const text = localStorage.getItem(key);
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback; // Private windows can refuse storage.
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    setStatus("The browser wouldn't save. Back up the library to keep it.", true);
  }
}

function save() {
  const { undo, redo, ...kept } = state;
  writeJson(STORAGE_KEY, { ...kept, rowsFollowKey: true });
  renderNameBar();
}

function renderNameBar() {
  const label = $("pattern-name");
  label.textContent = state.name || "Untitled";
  label.classList.toggle("untitled", !state.name);
  label.title = state.fileKey
    ? `"${state.name}" is a .syx file. Save writes to it again.`
    : state.libraryId ? `"${state.name}" is in the library in this browser. Save updates it there.`
      : "This pattern hasn't been saved yet. Save asks where to save it.";
}

function restore() {
  const saved = readJson(STORAGE_KEY, {});
  state.pattern = TD3.cleanPattern(saved.pattern);
  state.name = typeof saved.name === "string" ? saved.name.slice(0, 40) : "";
  state.libraryId = typeof saved.libraryId === "string" ? saved.libraryId : null;
  if (Number.isFinite(saved.bpm)) state.bpm = Math.min(300, Math.max(40, saved.bpm));
  if (Number.isInteger(saved.root) && saved.root >= 0 && saved.root < 12) state.root = saved.root;
  // Pages saved before the mode chose the rows start with all notes showing.
  if (TD3.SCALES[saved.scale] && saved.rowsFollowKey) state.scale = saved.scale;
  if (Number.isInteger(saved.group) && saved.group >= 0 && saved.group < TD3.GROUPS) state.group = saved.group;
  if (Number.isInteger(saved.slot) && saved.slot >= 0 && saved.slot < TD3.SLOTS) state.slot = saved.slot;
  if (Number.isInteger(saved.channel) && saved.channel >= 1 && saved.channel <= 16) state.channel = saved.channel;
  if (typeof saved.hear === "boolean") state.hear = saved.hear;
  if (typeof saved.sendClock === "boolean") state.sendClock = saved.sendClock;
  if (typeof saved.moveWithKey === "boolean") state.moveWithKey = saved.moveWithKey;
  if (typeof saved.keyOff === "boolean") state.keyOff = saved.keyOff;
  if (typeof saved.outputName === "string") state.outputName = saved.outputName;
  if (typeof saved.fileKey === "string") state.fileKey = saved.fileKey;
  library = cleanLibrary(readJson(LIBRARY_KEY, []));
}

function cleanLibrary(items) {
  if (!Array.isArray(items)) return [];
  return items.filter((item) => item && typeof item.name === "string").map((item) => ({
    id: typeof item.id === "string" ? item.id : newId(),
    name: item.name.slice(0, 40) || "Untitled",
    pattern: TD3.cleanPattern(item.pattern),
    saved: typeof item.saved === "string" ? item.saved : new Date().toISOString(),
  }));
}

const newId = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const saveLibrary = () => writeJson(LIBRARY_KEY, library);

/* ---------- Status ---------- */

function setStatus(text, isError = false) {
  const status = $("status");
  status.textContent = text;
  status.classList.toggle("error", isError);
}

/* ---------- Changing the pattern ---------- */

// Every change goes through here, so it can be undone.
function change(next, message) {
  state.undo.push(TD3.copyPattern(state.pattern));
  if (state.undo.length > UNDO_LIMIT) state.undo.shift();
  state.redo = [];
  state.pattern = TD3.cleanPattern(next);
  save();
  render();
  if (message) setStatus(message);
}

function undoRedo(from, to, word) {
  if (!from.length) return;
  to.push(TD3.copyPattern(state.pattern));
  state.pattern = from.pop();
  save();
  render();
  setStatus(word);
}

// A copy of the pattern with one step changed by edit(step, steps).
function withStep(index, edit) {
  const next = TD3.copyPattern(state.pattern);
  edit(next.steps[index], next.steps);
  // Ties hold the note before them, so they follow it.
  for (let at = 1; at < next.steps.length; at += 1) {
    const item = next.steps[at];
    const before = next.steps[at - 1];
    if (item.kind !== "tie") continue;
    if (before.kind === "rest") item.kind = "rest";
    else Object.assign(item, { note: before.note, octave: before.octave });
  }
  return next;
}

/* ---------- Drawing the grid ---------- */

// The root the grid's rows start from. With the key off, that's the TD-3's own C.
const gridRoot = () => (state.keyOff ? 0 : state.root);
const keyNotes = () => new Set(TD3.SCALES[state.keyOff ? "chromatic" : state.scale].map((degree) => (gridRoot() + degree) % 12));

// The row and octave move a step was drawn with, as the root a row up and the root above
// are the same pitch. Used while it still matches the step's note.
let drawnAt = [];

function gridPlace(item, index) {
  const before = state.pattern.steps[index - 1];
  if (item.kind === "tie" && before && before.kind !== "rest") return gridPlace(before, index - 1);
  const hint = drawnAt[index];
  const back = hint && TD3.fromGrid(hint.row, hint.shift, gridRoot());
  if (back && TD3.height(back) === TD3.height(item)) return hint;
  return TD3.onGrid(item, gridRoot());
}

// The grid's rows, the root above first: the notes of the key and mode, and any the
// pattern already uses.
function visibleRows() {
  const inKey = keyNotes();
  const used = new Set(state.pattern.steps.map((item, index) => (item.kind === "rest" ? null : gridPlace(item, index).row)));
  return Array.from({ length: 13 }, (_, index) => 12 - index)
    .filter((row) => inKey.has((gridRoot() + row) % 12) || used.has(row));
}

let shownRows = "";

function buildRows() {
  const rows = visibleRows();
  const shape = `${gridRoot()}:${rows.join()}`;
  if (shape === shownRows) return;
  shownRows = shape;
  const grid = $("grid");
  const cells = [document.createElement("span")];
  for (let index = 0; index < TD3.STEPS; index += 1) {
    const number = document.createElement("span");
    number.className = "step-number";
    number.textContent = String(index + 1);
    number.dataset.step = String(index);
    cells.push(number);
  }
  for (const row of rows) {
    const label = document.createElement("span");
    label.className = "label";
    label.dataset.row = String(row);
    label.textContent = TD3.rowName(row, gridRoot());
    cells.push(label);
    for (let index = 0; index < TD3.STEPS; index += 1) {
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "cell";
      cell.dataset.step = String(index);
      cell.dataset.row = String(row);
      if (index % 4 === 0) cell.classList.add("beat");
      cells.push(cell);
    }
  }
  grid.replaceChildren(...cells);
}

function buildLanes() {
  const lanes = [
    ["octave", "Oct"],
    ["accent", "Accent"],
    ["slide", "Slide"],
    ["kind", "Step"],
  ];
  const laneCells = [];
  for (const [lane, text] of lanes) {
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = text;
    laneCells.push(label);
    for (let index = 0; index < TD3.STEPS; index += 1) {
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "lane-cell";
      cell.dataset.step = String(index);
      cell.dataset.lane = lane;
      if (index % 4 === 0) cell.classList.add("beat");
      laneCells.push(cell);
    }
  }
  $("lanes").replaceChildren(...laneCells);
}

function describe(item) {
  if (item.kind === "rest") return "rest";
  const parts = [item.kind === "tie" ? `tie, holding ${TD3.keyName(item)}` : TD3.keyName(item)];
  if (item.kind === "note" && item.accent) parts.push("accent");
  if (item.kind === "note" && item.slide) parts.push("slide");
  return parts.join(", ");
}

// Lane text, with a shorter form for narrow screens.
function laneText(cell, long, short = long) {
  const wide = document.createElement("span");
  wide.className = "long";
  wide.textContent = long;
  const narrow = document.createElement("span");
  narrow.className = "short";
  narrow.textContent = short;
  cell.replaceChildren(wide, narrow);
}

function renderKey() {
  $("root").value = state.keyOff ? "off" : String(state.root);
  $("scale").value = state.keyOff ? "off" : state.scale;
  $("generate").disabled = state.keyOff;
  $("generate").title = state.keyOff
    ? "Choose a key to generate a line, as lines are written in a key"
    : "Replaces the pattern with a new acid line in the key. Undo brings the old one back.";
}

function render() {
  renderKey();
  buildRows();
  const { steps, length } = state.pattern;
  const isRoot = (row) => !state.keyOff && (row === 0 || row === 12);
  const places = steps.map((item, index) => gridPlace(item, index));
  document.querySelectorAll("#grid .label").forEach((label) => {
    label.classList.toggle("root", isRoot(Number(label.dataset.row)));
  });
  document.querySelectorAll("#grid .cell").forEach((cell) => {
    const index = Number(cell.dataset.step);
    const row = Number(cell.dataset.row);
    const item = steps[index];
    const here = item.kind !== "rest" && places[index].row === row;
    cell.classList.toggle("in-key", isRoot(row));
    cell.classList.toggle("on", here && item.kind === "note");
    cell.classList.toggle("tied", here && item.kind === "tie");
    cell.classList.toggle("accented", here && item.kind === "note" && item.accent);
    cell.classList.toggle("slid", here && item.kind === "note" && item.slide);
    cell.classList.toggle("up", here && item.kind === "note" && places[index].shift > 0);
    cell.classList.toggle("down", here && item.kind === "note" && places[index].shift < 0);
    cell.classList.toggle("off-length", index >= length);
    cell.setAttribute("aria-label", `Step ${index + 1}, ${TD3.rowName(row, gridRoot())}: ${here ? describe(item) : "empty"}`);
  });
  document.querySelectorAll("#lanes .lane-cell").forEach((cell) => {
    const index = Number(cell.dataset.step);
    const item = steps[index];
    const lane = cell.dataset.lane;
    const note = item.kind === "note";
    cell.classList.remove("on", "down", "tie", "rest");
    cell.classList.toggle("off-length", index >= length);
    if (lane === "octave") {
      const { shift } = places[index];
      if (!note) laneText(cell, "");
      else if (shift > 1) laneText(cell, "Up 2", "U2");
      else if (shift > 0) laneText(cell, "Up");
      else if (shift < -1) laneText(cell, "Down 2", "D2");
      else if (shift < 0) laneText(cell, "Down", "Dn");
      else laneText(cell, "-");
      cell.classList.toggle("on", note && shift > 0);
      cell.classList.toggle("down", note && shift < 0);
      cell.disabled = !note;
      cell.title = note ? "Octave: click for up, down or neither" : "";
    } else if (lane === "accent" || lane === "slide") {
      laneText(cell, note && item[lane] ? (lane === "accent" ? "Acc" : "Sl") : "", note && item[lane] ? (lane === "accent" ? "A" : "S") : "");
      cell.classList.toggle("on", note && item[lane]);
      cell.disabled = !note;
      cell.title = note ? `${lane === "accent" ? "Accent" : "Slide into the next note"}: click to turn on or off` : "";
    } else {
      laneText(cell, { note: "Note", tie: "Tie", rest: "Rest" }[item.kind], { note: "N", tie: "T", rest: "R" }[item.kind]);
      cell.classList.add(item.kind === "note" ? "on" : item.kind);
      cell.title = "Click for a note, a tie or a rest";
    }
    cell.setAttribute("aria-label", `Step ${index + 1} ${cell.dataset.lane}: ${describe(item)}`);
  });
  $("length").value = String(length);
  $("triplet").setAttribute("aria-pressed", String(state.pattern.triplet));
  $("undo").disabled = !state.undo.length;
  $("redo").disabled = !state.redo.length;
  renderLibrary();
}

/* ---------- Editing with the mouse ---------- */

let drawing = null; // { row } while dragging notes onto steps.

// A note on a row of the grid, keeping the step's octave move where the TD-3 can play it.
function placeNote(index, row) {
  return withStep(index, (item) => {
    let shift = item.kind === "rest" ? 0 : gridPlace(item, index).shift;
    if (!TD3.fromGrid(row, shift, gridRoot())) shift = 0;
    if (item.kind === "rest") Object.assign(item, { accent: false, slide: false });
    Object.assign(item, { kind: "note" }, TD3.fromGrid(row, shift, gridRoot()));
    drawnAt[index] = { row, shift };
  });
}

function onGridDown(event) {
  const cell = event.target.closest(".cell");
  if (!cell) return;
  event.preventDefault();
  const index = Number(cell.dataset.step);
  const row = Number(cell.dataset.row);
  const item = state.pattern.steps[index];
  if (item.kind === "note" && gridPlace(item, index).row === row) {
    change(withStep(index, (step) => { step.kind = "rest"; }), `Step ${index + 1} is now a rest.`);
    drawing = { row: null };
  } else {
    change(placeNote(index, row));
    setStatus(`Step ${index + 1}: ${TD3.keyName(state.pattern.steps[index])}.`);
    hear(state.pattern.steps[index]);
    drawing = { row, last: index };
  }
  cell.releasePointerCapture?.(event.pointerId);
}

function onGridOver(event) {
  if (!drawing || !(event.buttons & 1)) return;
  const cell = event.target.closest(".cell");
  if (!cell) return;
  const index = Number(cell.dataset.step);
  if (index === drawing.last) return;
  drawing.last = index;
  const item = state.pattern.steps[index];
  if (drawing.row === null) {
    if (item.kind !== "rest") {
      state.pattern = withStep(index, (step) => { step.kind = "rest"; });
      render();
    }
    return;
  }
  // Drawing on adds to the change already in the undo list.
  state.pattern = placeNote(index, drawing.row);
  hear(state.pattern.steps[index]);
  render();
}

function onLaneClick(event) {
  const cell = event.target.closest(".lane-cell");
  if (!cell || cell.disabled) return;
  const index = Number(cell.dataset.step);
  const lane = cell.dataset.lane;
  const item = state.pattern.steps[index];
  if (lane === "octave") {
    // Up, down, then neither, skipping a move past the TD-3's range.
    const { row, shift } = gridPlace(item, index);
    const order = [0, 1, 2, -1, -2];
    const move = [1, 2, 3, 4].map((ahead) => order[(order.indexOf(shift) + ahead) % order.length])
      .find((option) => TD3.fromGrid(row, option, gridRoot()));
    const next = move === undefined ? null : TD3.fromGrid(row, move, gridRoot());
    if (!next) {
      setStatus(`Step ${index + 1} can't move an octave in this key without going past the TD-3's range.`, true);
      return;
    }
    drawnAt[index] = { row, shift: move };
    change(withStep(index, (step) => { Object.assign(step, next); }), `Step ${index + 1}: ${TD3.keyName(next)}.`);
    hear(state.pattern.steps[index]);
  } else if (lane === "accent" || lane === "slide") {
    change(withStep(index, (step) => { step[lane] = !step[lane]; }),
      `Step ${index + 1}: ${lane} ${state.pattern.steps[index][lane] ? "off" : "on"}.`);
  } else {
    const before = state.pattern.steps[index - 1];
    const order = index === 0 || before.kind === "rest" ? ["note", "rest"] : ["note", "tie", "rest"];
    const kind = order[(order.indexOf(item.kind) + 1) % order.length];
    change(withStep(index, (step) => {
      if (kind === "note" && step.kind === "rest") {
        const from = before && before.kind !== "rest" ? { note: before.note, octave: before.octave } : TD3.fromGrid(0, 0, gridRoot());
        Object.assign(step, from, { accent: false, slide: false });
      }
      step.kind = kind;
    }), `Step ${index + 1} is now a ${kind}.`);
  }
}

/* ---------- MIDI ---------- */

function setMidiPill(text, kind = "") {
  const pill = $("midi-state");
  pill.textContent = text;
  pill.className = `pill ${kind}`;
}

async function startMidi() {
  if (!navigator.requestMIDIAccess) {
    setMidiPill("No MIDI", "warn");
    setStatus("This browser has no Web MIDI. Use a current Chrome or Edge.", true);
    return;
  }
  try {
    midi = await navigator.requestMIDIAccess({ sysex: true });
  } catch {
    setMidiPill("MIDI blocked", "warn");
    $("midi-retry").hidden = false;
    setStatus("MIDI access was refused. Allow it, including SysEx, then click Allow MIDI.", true);
    return;
  }
  $("midi-retry").hidden = true;
  midi.onstatechange = () => refreshPorts();
  refreshPorts();
}

const isTd3 = (port) => /\bTD-?3/i.test(port.name || "");

function refreshPorts() {
  const outputs = midi ? [...midi.outputs.values()] : [];
  const chosen = outputs.find((port) => port.name === state.outputName) || outputs.find(isTd3) || null;
  const select = $("output");
  select.replaceChildren(...(outputs.length
    ? outputs.map((port) => new Option(port.name, port.name))
    : [new Option("Not connected", "")]));
  if (state.outputName && !outputs.some((port) => port.name === state.outputName)) {
    select.add(new Option(`${state.outputName} (not connected)`, state.outputName));
  }
  select.value = chosen ? chosen.name : state.outputName;
  const changed = chosen !== output;
  output = chosen && chosen.name === select.value ? chosen : null;
  for (const input of midi ? midi.inputs.values() : []) input.onmidimessage = onMessage;
  if (!output) {
    setMidiPill("TD-3 not connected", "warn");
  } else {
    setMidiPill(isTd3(output) ? "TD-3 connected" : "Connected", "ok");
    if (changed) readConfig();
  }
}

function send(data, at) {
  if (!output) return false;
  try {
    output.send(data, at);
    return true;
  } catch (error) {
    setStatus(`Couldn't send to ${output.name}: ${error.message}`, true);
    return false;
  }
}

// Waiting replies, each with what it accepts.
const waiting = [];

function onMessage(event) {
  const data = Array.from(event.data);
  if (data[0] !== 0xF0) return;
  const found = waiting.findIndex((entry) => entry.accepts(data));
  if (found < 0) return;
  const [entry] = waiting.splice(found, 1);
  clearTimeout(entry.timer);
  entry.resolve(data);
}

function ask(message, accepts) {
  return new Promise((resolve, reject) => {
    if (!send(message)) {
      reject(new Error("The TD-3 isn't connected."));
      return;
    }
    const entry = { accepts, resolve };
    entry.timer = setTimeout(() => {
      waiting.splice(waiting.indexOf(entry), 1);
      reject(new Error("The TD-3 didn't answer. Check it's connected by USB, as patterns can't go over the MIDI sockets."));
    }, REPLY_TIMEOUT_MS);
    waiting.push(entry);
  });
}

async function readConfig() {
  try {
    const config = TD3.decodeConfig(await ask(TD3.requestConfig(), (data) => TD3.decodeConfig(data) !== null));
    state.channel = config.inChannel;
    accentThreshold = config.accentThreshold;
    $("channel").value = String(state.channel);
    save();
    setStatus(`Connected to ${output.name}, listening on channel ${state.channel}.`);
  } catch {
    // Older firmware or another instrument. Notes still play on the chosen channel.
  }
}

async function readPattern(group, slot) {
  const reply = await ask(TD3.requestPattern(group, slot), (data) => {
    const read = TD3.decode(data);
    return read !== null && read.group === group && read.slot === slot;
  });
  return TD3.decode(reply).pattern;
}

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const samePattern = (a, b) => JSON.stringify(TD3.encode(a, 0, 0)) === JSON.stringify(TD3.encode(b, 0, 0));

// Writes a pattern and reads it back to check it arrived.
async function writePattern(pattern, group, slot) {
  if (!send(TD3.encode(pattern, group, slot))) throw new Error("The TD-3 isn't connected.");
  await wait(SETTLE_MS);
  const back = await readPattern(group, slot);
  if (!samePattern(back, pattern)) throw new Error("The TD-3 has a different pattern there than the one sent. Try sending it again.");
}

async function withBusy(task) {
  if (busy) return;
  busy = true;
  document.querySelectorAll("#read, #send, #read-group, #put-back, #copy, #paste").forEach((button) => { button.disabled = true; });
  try {
    await task();
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    busy = false;
    document.querySelectorAll("#read, #send, #read-group, #put-back, #copy").forEach((button) => { button.disabled = false; });
    renderCopied();
  }
}

const place = () => TD3.placeName(state.group, state.slot);

function onRead() {
  withBusy(async () => {
    setStatus(`Reading ${place()}...`);
    const pattern = await readPattern(state.group, state.slot);
    stopIfPlaying();
    change(pattern, `Read ${place()} from the TD-3. Undo brings back what was in the grid.`);
    state.name = place();
    state.libraryId = null;
    $("name").value = state.name;
    save();
  });
}

function confirmDialog(text, okText = "Replace") {
  return new Promise((resolve) => {
    const dialog = $("confirm");
    $("confirm-text").textContent = text;
    $("confirm-ok").textContent = okText;
    const finish = (answer) => {
      dialog.close();
      $("confirm-ok").onclick = null;
      $("confirm-cancel").onclick = null;
      resolve(answer);
    };
    $("confirm-ok").onclick = () => finish(true);
    $("confirm-cancel").onclick = () => finish(false);
    dialog.oncancel = () => resolve(false);
    dialog.showModal();
  });
}

// Writes a pattern to the chosen place after asking, keeping what was there for Put back.
function replaceOnTd3(pattern, what, done) {
  withBusy(async () => {
    const group = state.group;
    const slot = state.slot;
    const where = TD3.placeName(group, slot);
    const ok = await confirmDialog(`Replace ${where} on the TD-3 with ${what}? The page keeps what's there now, so Put back can restore it.`);
    if (!ok) return;
    setStatus(`Reading what's in ${where} first...`);
    const before = await readPattern(group, slot);
    setStatus(`Writing to ${where}...`);
    await writePattern(pattern, group, slot);
    putBack = { pattern: before, group, slot };
    $("put-back-text").textContent = `What was in ${where} before`;
    $("put-back-row").hidden = false;
    setStatus(`${done} ${where}, and checked. Put back restores what was there.`);
  });
}

function onSend() {
  replaceOnTd3(state.pattern, `the grid's pattern${state.name ? `, "${state.name}"` : ""}`, "Sent to");
}

function renderCopied() {
  $("paste").disabled = busy || !copied;
  $("copied-text").textContent = copied ? `Copied ${TD3.placeName(copied.group, copied.slot)}` : "Nothing copied";
}

function onCopy() {
  withBusy(async () => {
    const { group, slot } = state;
    setStatus(`Copying ${place()}...`);
    copied = { pattern: await readPattern(group, slot), group, slot };
    setStatus(`Copied ${place()}. Choose where it goes, then click Paste.`);
  });
}

function onPaste() {
  if (!copied) return;
  const from = TD3.placeName(copied.group, copied.slot);
  if (copied.group === state.group && copied.slot === state.slot) {
    setStatus(`That's where it was copied from. Choose another place to paste ${from} into.`, true);
    return;
  }
  replaceOnTd3(copied.pattern, `the pattern copied from ${from}`, `Pasted ${from} into`);
}

function onPutBack() {
  if (!putBack) return;
  withBusy(async () => {
    const where = TD3.placeName(putBack.group, putBack.slot);
    setStatus(`Putting back ${where}...`);
    await writePattern(putBack.pattern, putBack.group, putBack.slot);
    putBack = null;
    $("put-back-row").hidden = true;
    setStatus(`Put back what was in ${where}.`);
  });
}

function onReadGroup() {
  withBusy(async () => {
    const group = state.group;
    const stamp = new Date().toISOString().slice(0, 10);
    const read = [];
    for (let slot = 0; slot < TD3.SLOTS; slot += 1) {
      setStatus(`Reading group ${group + 1}, ${slot + 1} of 16...`);
      read.push({ id: newId(), name: `${stamp} group ${group + 1} ${TD3.slotName(slot)}`, pattern: await readPattern(group, slot), saved: new Date().toISOString() });
    }
    library.push(...read);
    saveLibrary();
    renderLibrary();
    setStatus(`Copied group ${group + 1}'s 16 patterns into the library.`);
  });
}

/* ---------- Playing ---------- */

// preview is a library pattern being heard instead of the grid's, as { key, pattern, name }.
const play = { on: false, step: 0, pulse: 0, nextTime: 0, stopTimer: null, offs: [], absorbed: new Set(), preview: null, previewStarted: false };
const PPQ = 960; // Pulses to a beat, as the other grids count them for Sync.
const playing = () => play.preview?.pattern || state.pattern;
const pulsesPerStep = () => PPQ / (playing().triplet ? 3 : 4);

// A step is a sixteenth, or in triplet mode an eighth-note triplet, three to a beat.
const stepMs = () => 60000 / state.bpm / (playing().triplet ? 3 : 4);

function velocity(accent) {
  if (accent) return 127;
  return accentThreshold === null ? 64 : Math.max(1, Math.min(100, accentThreshold));
}

function noteOn(note, accent, at) {
  send([0x90 | (state.channel - 1), note, velocity(accent)], at);
}

function noteOff(note, at) {
  send([0x80 | (state.channel - 1), note, 0], at);
}

// Plays one step, deciding how long its note lasts from the steps after it. A slide into
// the same note just holds it, so that note isn't started again.
function playStep(index, at) {
  const { steps, length } = playing();
  if (play.absorbed.delete(index)) return;
  const item = steps[index];
  if (item.kind !== "note") return;
  // A song section can shift the notes, kept in range.
  const shift = song?.transpose || 0;
  const midi = (step) => Math.max(0, Math.min(127, TD3.midiNote(step) + shift));
  const note = midi(item);
  const tiesAfter = (from) => {
    let count = 0;
    while (from + count + 1 < length && steps[from + count + 1].kind === "tie") count += 1;
    return count;
  };
  let span = 1 + tiesAfter(index);
  let last = item;
  let next = steps[(index + span) % length];
  while (last.slide && next.kind === "note" && midi(next) === note && span < length) {
    const at2 = (index + span) % length;
    play.absorbed.add(at2);
    last = next;
    span += 1 + tiesAfter(at2);
    next = steps[(index + span) % length];
  }
  const ms = stepMs();
  noteOn(note, item.accent, at);
  // A slide holds the note until just after the next one starts.
  const slides = last.slide && next.kind === "note" && span < length;
  const end = slides ? at + span * ms + 4 : at + (span - 1) * ms + ms * 0.55;
  play.offs.push({ note, at: end });
  noteOff(note, end);
}

/* A song from Song Grid while it plays one: { bars, loop, cues, pulse, muted }. Each cue
   starts, at a bar of 4/4, the grid's own pattern ("grid"), a library pattern named by its
   id, or silence, from its first step. The song ends or loops after its last bar. The part
   arrives just before Song Grid starts playback. See sync.js. */
const SONG_BAR = PPQ * 4;
let song = null;
let pendingSong = null;

// Called before each step. Returns false once the song has ended.
function followSong() {
  if (song.pulse % SONG_BAR !== 0) return true;
  // Each bar after the first moves the song on, following any move from Song Grid.
  if (song.pulse > 0 && !Sync.songNextBar(song)) {
    stopIfPlaying();
    setStatus("The song has ended.");
    return false;
  }
  const bar = song.bar;
  const cue = Sync.songCue(song, bar);
  // Song Grid's mute and solo buttons can silence this grid from any bar.
  if (!cue) {
    song.muted = song.off || Sync.songSilenced(song);
    return true;
  }
  song.transpose = cue.transpose || 0;
  if (cue.bpm && cue.bpm !== state.bpm) {
    state.bpm = cue.bpm;
    $("bpm").value = String(cue.bpm);
  }
  const item = typeof cue.pattern === "string" && cue.pattern !== "grid" ? library.find((entry) => entry.id === cue.pattern) : null;
  song.off = cue.pattern === null || (cue.pattern !== "grid" && !item);
  song.muted = song.off || Sync.songSilenced(song);
  // A library pattern plays in place of the grid's, which stays as it is.
  play.preview = item ? { key: "song", pattern: TD3.cleanPattern(item.pattern), name: item.name } : null;
  play.step = 0;
  play.absorbed.clear();
  const what = cue.pattern === "grid" ? "the grid's pattern" : item ? `"${item.name}"` : "silent";
  const missing = cue.pattern !== null && cue.pattern !== "grid" && !item ? " The library pattern it names isn't in this browser's library." : "";
  setStatus(`Song: ${what} from bar ${bar + 1}.${missing}`, Boolean(missing));
  return true;
}

function tick() {
  if (!play.on) return;
  const now = performance.now();
  const until = now + LOOKAHEAD_MS;
  // After the computer sleeps, carry on from now rather than playing the missed steps at once.
  if (play.nextTime < now - stepMs()) play.nextTime = now + 10;
  while (play.nextTime < until) {
    if (song && !followSong()) return;
    const index = play.step % playing().length;
    beatAndClock(play.nextTime);
    if (!song?.muted) playStep(index, play.nextTime);
    const shown = play.preview ? null : index;
    const delay = Math.max(0, play.nextTime - performance.now());
    setTimeout(() => showStep(play.on ? shown : null), delay);
    play.nextTime += stepMs();
    play.pulse += pulsesPerStep();
    if (song) song.pulse += pulsesPerStep();
    play.step = index + 1;
  }
  play.offs = play.offs.filter((off) => off.at > performance.now() - 1000);
}

function showStep(index) {
  document.querySelectorAll(".step-number.now, .cell.now").forEach((cell) => cell.classList.remove("now"));
  if (index === null) return;
  document.querySelectorAll(`.step-number[data-step="${index}"]`).forEach((cell) => cell.classList.add("now"));
}

// A worker's timer keeps running in a background tab, where a page's own slows down.
function everyTick(callback) {
  if (typeof Worker === "undefined") {
    const timer = setInterval(callback, TICK_MS);
    return () => clearInterval(timer);
  }
  const worker = new Worker(URL.createObjectURL(new Blob(
    [`setInterval(() => postMessage(0), ${TICK_MS});`], { type: "text/javascript" })));
  worker.onmessage = callback;
  return () => worker.terminate();
}

function startPlaying({ startAt = null, fromLink = false } = {}) {
  if (!output) {
    setStatus("Connect the TD-3 to play the pattern.", true);
    return false;
  }
  if (!fromLink) endPreview();
  if (!fromLink) song = null;
  if (song) Object.assign(Sync.songStart(song), { pulse: 0, muted: false });
  play.on = true;
  play.step = 0;
  play.pulse = 0;
  play.absorbed.clear();
  const shared = fromLink ? null : link.announcePlay(state.bpm);
  play.nextTime = startAt ?? shared ?? performance.now() + 30;
  if (state.sendClock) send([0xFA], play.nextTime);
  play.stopTimer = everyTick(tick);
  tick();
  $("play").setAttribute("aria-pressed", "true");
  $("play").textContent = "Stop";
  return true;
}

function stopIfPlaying() {
  endPreview();
  if (!play.on) return;
  play.on = false;
  play.stopTimer();
  // Notes already on their way are let go now, and everything is silenced.
  if (output && state.sendClock) send([0xFC]);
  if (output) {
    output.clear?.();
    for (const off of play.offs) noteOff(off.note);
    send([0xB0 | (state.channel - 1), 123, 0]);
  }
  play.offs = [];
  showStep(null);
  $("play").setAttribute("aria-pressed", "false");
  $("play").textContent = "Play";
}

// Hears a library pattern on the TD-3 without loading it. If the grid is already playing,
// the library pattern takes over in time, and the grid's comes back when it ends.
function togglePreview(key, pattern, name) {
  if (play.preview?.key === key) {
    const started = play.previewStarted;
    endPreview();
    if (started) stopIfPlaying();
    setStatus(`Stopped hearing "${name}".`);
    return;
  }
  if (!output) {
    setStatus("Connect the TD-3 to hear patterns.", true);
    return;
  }
  const wasPlaying = play.on;
  play.preview = { key, pattern: TD3.cleanPattern(pattern), name };
  play.absorbed.clear();
  if (!wasPlaying) {
    // Heard on its own, without starting the other grids.
    startPlaying({ fromLink: true });
    play.previewStarted = true;
  }
  showStep(null);
  renderPreviewButtons();
  setStatus(`Hearing "${name}" on the TD-3. Click Hear again to stop.`);
}

function endPreview() {
  if (!play.preview) return;
  play.preview = null;
  play.previewStarted = false;
  play.absorbed.clear();
  renderPreviewButtons();
}

function renderPreviewButtons() {
  document.querySelectorAll("button.hear").forEach((button) => {
    const on = play.preview?.key === button.dataset.key;
    button.setAttribute("aria-pressed", String(on));
    button.textContent = on ? "Stop" : "Hear";
  });
}

function hearButton(key, pattern, name) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "hear toggle";
  button.dataset.key = key;
  button.title = `Plays "${name}" on the TD-3 without loading it`;
  button.onclick = () => togglePreview(key, pattern, name);
  return button;
}

// A metronome click on each beat, louder on each bar, from this computer. See recorder.js.
const click = Recorder.createClick({ storageKey: "td3-grid-click", button: $("click") });
const CLOCK_PULSES = PPQ / 24; // MIDI clock is 24 to a beat.

// The click and MIDI clock for the step starting at a time, whatever the step's length.
function beatAndClock(at) {
  if (play.pulse % PPQ === 0) click.at(at, play.pulse % (4 * PPQ) === 0);
  if (!state.sendClock) return;
  const pulses = pulsesPerStep();
  for (let pulse = 0; pulse < pulses; pulse += CLOCK_PULSES) send([0xF8], at + (pulse / pulses) * stepMs());
}

// Stops playback everywhere and silences anything still sounding on the TD-3.
function panic() {
  if (play.on) {
    const quiet = play.previewStarted;
    stopIfPlaying();
    if (!quiet) link.announceStop();
  }
  if (!output) {
    setStatus("No MIDI output connected.", true);
    return;
  }
  send([0xB0 | (state.channel - 1), 120, 0]);
  send([0xB0 | (state.channel - 1), 123, 0]);
  setStatus("All notes off.");
}

function togglePlay() {
  if (play.on) {
    const quiet = play.previewStarted;
    stopIfPlaying();
    if (!quiet) link.announceStop();
    setStatus("Stopped.");
  } else {
    startPlaying();
  }
}

function renderPeers(names) {
  const pill = $("sync-peers");
  pill.hidden = !$("sync").checked;
  pill.textContent = names.length ? `Linked: ${names.join(", ")}` : "Not linked";
  pill.className = `pill ${names.length ? "ok" : ""}`;
  pill.title = names.length ? "Play, stop and tempo are shared with these pages." : "No other grid is open in this browser with Sync on.";
}

// Plays together with the other grids when they're open in this browser. See sync.js.
// Puts the patterns kept with a song in Song Grid back: its grid pattern into the grid,
// where Undo brings back what was there, and library patterns the library doesn't have
// into it. Library patterns it already has are left as they are. See sync.js.
function loadAssets(assets) {
  const items = Array.isArray(assets.patterns) ? assets.patterns.filter((item) => item && typeof item.ref === "string" && item.data && typeof item.data === "object") : [];
  const grid = items.find((item) => item.ref === "grid");
  const added = items.filter((item) => item.ref !== "grid" && !library.some((entry) => entry.id === item.ref)).map((item) => ({
    id: item.ref.slice(0, 64), name: (typeof item.label === "string" ? item.label : "").slice(0, 40) || "Untitled",
    pattern: TD3.cleanPattern(item.data), saved: new Date().toISOString(),
  }));
  const kept = items.filter((item) => item.ref !== "grid").length - added.length;
  if (grid) change(grid.data);
  if (added.length) {
    library.push(...added);
    saveLibrary();
    renderLibrary();
  }
  const parts = [];
  if (grid) parts.push("Put the grid pattern in. Undo here brings back what was there.");
  if (added.length) parts.push(`Added ${added.length} pattern${added.length === 1 ? "" : "s"} to the library.`);
  if (kept) parts.push(`${kept} ${kept === 1 ? "was" : "were"} in the library already.`);
  const message = parts.join(" ") || "There was nothing to put in.";
  setStatus(`From Song Grid: ${message}`, !parts.length);
  return { ok: parts.length > 0, message };
}

/* What this grid can offer Song Grid for a song, to pick from: the pattern in its grid,
   and its library's. fetchPicked gives the ones picked, as assets. See sync.js. */
function catalog() {
  const [grid, ...saved] = collectAssets().patterns;
  const choice = (item) => ({ id: item.id, label: item.label, meta: `${item.length}, ${item.notes} note${item.notes === 1 ? "" : "s"}` });
  return { grid: [choice(grid)], patterns: saved.map(choice), sounds: [], note: "" };
}

function fetchPicked({ patterns: ids = [] } = {}) {
  const list = Array.isArray(ids) ? ids : [];
  return { patterns: collectAssets().patterns.filter((item) => list.includes(item.id)), sound: null };
}

// What Song Grid keeps of this grid for a song: its patterns, and its sound where it has
// one. See sync.js.
function collectAssets() {
  const count = (pattern) => pattern.steps.slice(0, pattern.length).filter((item) => item.kind === "note").length;
  const entry = (id, ref, label, pattern) => ({
    id, ref, label, length: `${pattern.length} steps${pattern.triplet ? ", triplets" : ""}`, notes: count(pattern), data: TD3.copyPattern(pattern),
  });
  const patterns = [entry("td3:grid", "grid", `Grid pattern${state.name ? `, ${state.name}` : ""}`, state.pattern),
    ...library.map((item) => entry(`td3:${item.id}`, item.id, item.name, item.pattern))];
  // The TD-3's sound is set by its own knobs, so there's none to keep.
  return { patterns, sound: null };
}

const link = Sync.connect({
  startOff: true, // Each visit starts with Sync off.
  name: "TD-3 Grid",
  checkbox: $("sync"),
  storageKey: "td3-grid-sync",
  start({ bpm, at }) {
    stopIfPlaying();
    state.bpm = bpm;
    $("bpm").value = String(bpm);
    // Song Grid sends this page its part just before it starts playback.
    song = pendingSong;
    pendingSong = null;
    return startPlaying({ startAt: at, fromLink: true });
  },
  stop: () => stopIfPlaying(),
  song: (part) => { pendingSong = part; },
  assets: collectAssets,
  loadAssets,
  answers: { catalog, fetch: fetchPicked },
  songMoved(data) {
    const move = song && Sync.songMove(data, song.bars);
    if (move) song.moves.push(move);
  },
  tempo({ bpm, at, pulse }) {
    state.bpm = bpm;
    $("bpm").value = String(bpm);
    if (!play.on || !Number.isFinite(pulse)) return;
    play.nextTime = Sync.aligned({
      nextTime: play.nextTime, nextPulse: play.pulse, at, pulse, msPerPulse: stepMs() / pulsesPerStep(), pulsesPerBeat: PPQ,
    });
  },
  status: (message, isError) => setStatus(message, isError),
  peers: renderPeers,
});

const announceTempo = () => link.announceTempo({ bpm: state.bpm, nextTime: play.nextTime, nextPulse: play.on ? play.pulse : 0 });

// A short note when a step is drawn, so you hear it.
function hear(item) {
  if (!state.hear || play.on || !output || !item || item.kind === "rest") return;
  const note = TD3.midiNote(item);
  const now = performance.now();
  noteOn(note, item.accent, now);
  noteOff(note, now + 180);
}

/* ---------- Library ---------- */

function renderLibrary() {
  const search = $("search").value.trim().toLowerCase();
  const shown = library.filter((item) => !search || item.name.toLowerCase().includes(search));
  $("library-empty").hidden = shown.length > 0;
  $("library-empty").textContent = library.length
    ? `No library patterns match "${$("search").value.trim()}".`
    : "No saved patterns yet. Save one, or read a group from the TD-3.";
  $("library").replaceChildren(...shown.map((item) => {
    const row = document.createElement("li");
    row.classList.toggle("current", item.id === state.libraryId);
    const load = document.createElement("button");
    load.type = "button";
    load.className = "load";
    load.textContent = item.name;
    load.title = `Load "${item.name}" into the grid. Saved ${item.saved.slice(0, 10)}.`;
    load.onclick = () => loadFromLibrary(item);
    const rename = document.createElement("button");
    rename.type = "button";
    rename.textContent = "Rename";
    rename.onclick = () => renameInLibrary(item);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Delete";
    remove.onclick = () => deleteFromLibrary(item);
    row.append(load, hearButton(`browser:${item.id}`, item.pattern, item.name), rename, remove);
    return row;
  }));
  renderPreviewButtons();
}

function loadFromLibrary(item) {
  change(item.pattern, `Loaded "${item.name}". Undo brings back what was in the grid.`);
  state.name = item.name;
  state.libraryId = item.id;
  state.fileKey = null;
  $("name").value = item.name;
  save();
  renderLibrary();
}

function saveToLibrary(asNew) {
  const name = $("name").value.trim() || "Untitled";
  const existing = !asNew && library.find((item) => item.id === state.libraryId);
  if (existing) {
    Object.assign(existing, { name, pattern: TD3.copyPattern(state.pattern), saved: new Date().toISOString() });
    setStatus(`Saved "${name}".`);
  } else {
    const item = { id: newId(), name, pattern: TD3.copyPattern(state.pattern), saved: new Date().toISOString() };
    library.unshift(item);
    state.libraryId = item.id;
    setStatus(`Saved "${name}" in the library.`);
  }
  state.name = name;
  state.fileKey = null;
  $("name").value = name;
  saveLibrary();
  save();
  renderLibrary();
}

/* ---------- Pattern files ---------- */

// A pattern saved as a .syx file, anywhere, with the Mac's Save dialog, starting in the
// pattern folder. Save writes to the pattern's file again, or its library entry.
const patternFiles = NamedFile.create({
  db: "td3-grid-files", id: "td3-grid-patterns", extension: ".syx", description: "TD-3 pattern", mime: "application/octet-stream",
});

const patternBytes = () => new Uint8Array(TD3.encode(state.pattern, state.group, state.slot));
const startFolder = () => (folder.status === "ready" ? folder.folder : undefined);

async function savePatternFile({ asNew = false } = {}) {
  if (!asNew && !state.fileKey && state.libraryId && library.some((item) => item.id === state.libraryId)) {
    saveToLibrary(false);
    return;
  }
  if (!patternFiles.supported()) {
    setStatus("Saving patterns as files needs Chrome or Edge on a computer.", true);
    return;
  }
  try {
    let saved = null;
    if (!asNew && state.fileKey) saved = await patternFiles.save(state.fileKey, patternBytes());
    if (!saved) {
      const key = NamedFile.newKey();
      saved = await patternFiles.saveAs(key, $("name").value.trim() || state.name || "Untitled", patternBytes(), { startIn: startFolder() });
      if (!saved) {
        setStatus("Not saved.");
        return;
      }
      state.fileKey = key;
    }
    state.name = saved.name;
    state.libraryId = null;
    $("name").value = saved.name;
    save();
    renderLibrary();
    if (folder.status === "ready") folderTask(() => folder.refresh());
    setStatus(`Saved "${saved.name}.syx", for ${place()}.`);
  } catch (error) {
    setStatus(`Couldn't save it: ${error.message}`, true);
  }
}

async function openPatternFile() {
  if (!patternFiles.supported()) {
    setStatus("Opening pattern files needs Chrome or Edge on a computer.", true);
    return;
  }
  const key = NamedFile.newKey();
  try {
    const opened = await patternFiles.open(key, { startIn: startFolder() });
    if (!opened) return;
    const pattern = firstPattern(opened.bytes);
    if (!pattern) {
      await patternFiles.forget(key);
      setStatus(`"${opened.name}" has no TD-3 pattern in it.`, true);
      return;
    }
    change(pattern, `Opened "${opened.name}.syx". Undo brings back what was in the grid.`);
    state.name = opened.name;
    state.libraryId = null;
    state.fileKey = key;
    $("name").value = opened.name;
    save();
    renderLibrary();
  } catch (error) {
    setStatus(`Couldn't open it: ${error.message}`, true);
  }
}

function renameInLibrary(item) {
  const name = prompt("New name", item.name);
  if (name === null || !name.trim()) return;
  item.name = name.trim().slice(0, 40);
  if (item.id === state.libraryId) {
    state.name = item.name;
    $("name").value = item.name;
    save();
  }
  saveLibrary();
  renderLibrary();
}

async function deleteFromLibrary(item) {
  if (!await confirmDialog(`Delete "${item.name}" from the library? This can't be undone, unless it's in a backup.`, "Delete")) return;
  library = library.filter((entry) => entry !== item);
  if (state.libraryId === item.id) state.libraryId = null;
  saveLibrary();
  save();
  renderLibrary();
  setStatus(`Deleted "${item.name}".`);
}

function download(name, bytes, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const fileName = (text) => text.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") || "pattern";

function exportSyx() {
  const name = `${fileName(state.name || "td3-pattern")}-${TD3.slotName(state.slot)}.syx`;
  download(name, new Uint8Array(TD3.encode(state.pattern, state.group, state.slot)), "application/octet-stream");
  setStatus(`Downloaded ${name}, for ${place()}.`);
}

function exportLibrary() {
  const text = JSON.stringify({ app: "td3-grid", version: 1, patterns: library }, null, 1);
  download(`td3-library-${new Date().toISOString().slice(0, 10)}.json`, text, "application/json");
  setStatus(`Downloaded a backup of ${library.length} patterns.`);
}

async function importFile(file) {
  const stamp = new Date().toISOString();
  let added = [];
  if (/\.syx$/i.test(file.name)) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const base = file.name.replace(/\.syx$/i, "");
    added = TD3.splitSysex(Array.from(bytes)).map(TD3.decode).filter(Boolean).map((read, index, all) => ({
      id: newId(),
      name: all.length > 1 ? `${base} ${TD3.placeName(read.group, read.slot)}` : base,
      pattern: read.pattern,
      saved: stamp,
    }));
  } else {
    try {
      const data = JSON.parse(await file.text());
      added = cleanLibrary(data.patterns).map((item) => ({ ...item, id: library.some((entry) => entry.id === item.id) ? newId() : item.id }));
    } catch {
      added = [];
    }
  }
  if (!added.length) {
    setStatus(`${file.name} has no TD-3 patterns in it.`, true);
    return;
  }
  library.push(...added);
  saveLibrary();
  renderLibrary();
  setStatus(`Added ${added.length} pattern${added.length === 1 ? "" : "s"} from ${file.name}.`);
}

/* ---------- Pattern folder ---------- */

// .syx pattern files in a folder on this computer. See folder.js.
const folder = SoundFolder.create({
  db: "td3-grid-folder",
  extension: ".syx",
  check(bytes) {
    if (!firstPattern(bytes)) throw new Error("No TD-3 pattern in this file.");
  },
});

// The first TD-3 pattern in a file's bytes, or null.
function firstPattern(bytes) {
  for (const message of TD3.splitSysex(Array.from(bytes))) {
    const read = TD3.decode(message);
    if (read) return read.pattern;
  }
  return null;
}

function renderFolder() {
  const states = {
    none: "Choose a folder of .syx pattern files on this computer to browse and hear them here.",
    permission: `Click Allow folder to use "${folder.folder?.name}" again.`,
    missing: "The folder can't be found. Click Choose folder.",
    unsupported: "Browsing a folder needs a current Chrome or Edge on a computer.",
  };
  const ready = folder.status === "ready";
  const skipped = folder.skipped ? ` ${folder.skipped} other .syx file${folder.skipped === 1 ? " isn't a TD-3 pattern" : "s aren't TD-3 patterns"}.` : "";
  $("folder-state").textContent = ready
    ? `"${folder.folder.name}": ${folder.items.length} pattern${folder.items.length === 1 ? "" : "s"}.${skipped}`
    : states[folder.status];
  $("folder-choose").textContent = folder.status === "permission" ? "Allow folder" : ready ? "Choose another" : "Choose folder";
  $("folder-choose").disabled = folder.status === "unsupported";
  $("folder-save").disabled = !ready;
  $("folder-save").title = ready
    ? `Saves the grid's pattern as a .syx file in "${folder.folder.name}", under its name, for the chosen place on the TD-3`
    : "Choose a pattern folder first, under Pattern folder";
  $("folder-refresh").disabled = !ready;
  $("folder-search").hidden = !ready || !folder.items.length;
  const search = $("folder-search").value.trim().toLowerCase();
  const shown = ready ? folder.items.filter((item) => !search || item.name.toLowerCase().includes(search)) : [];
  $("folder-empty").hidden = !ready || shown.length > 0;
  $("folder-empty").textContent = folder.items.length
    ? `No files match "${$("folder-search").value.trim()}".`
    : "No pattern files here yet. Save to folder adds the grid's pattern.";
  $("folder-list").replaceChildren(...shown.map((item) => {
    const pattern = firstPattern(item.bytes);
    const row = document.createElement("li");
    const load = document.createElement("button");
    load.type = "button";
    load.className = "load";
    load.textContent = item.name;
    load.title = `Load "${item.name}.syx" into the grid`;
    load.onclick = () => {
      change(pattern, `Loaded "${item.name}.syx". Undo brings back what was in the grid.`);
      state.name = item.name;
      state.libraryId = null;
      state.fileKey = null;
      // Save writes back to this file.
      const key = NamedFile.newKey();
      folder.folder.getFileHandle(`${item.name}.syx`)
        .then((handle) => patternFiles.remember(key, handle))
        .then(() => { state.fileKey = key; save(); })
        .catch(() => {});
      $("name").value = item.name;
      save();
      renderLibrary();
    };
    const rename = document.createElement("button");
    rename.type = "button";
    rename.textContent = "Rename";
    rename.onclick = () => folderTask(async () => {
      const name = prompt("New name", item.name);
      if (name === null || !name.trim()) return;
      const saved = await folder.rename(item, name);
      setStatus(`Renamed it "${saved}.syx".`);
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Delete";
    remove.onclick = () => folderTask(async () => {
      if (!await confirmDialog(`Delete "${item.name}.syx" from "${folder.folder.name}" on this computer? This can't be undone.`, "Delete")) return;
      await folder.remove(item);
      setStatus(`Deleted "${item.name}.syx".`);
    });
    row.append(load, hearButton(`folder:${item.name}`, pattern, item.name), rename, remove);
    return row;
  }));
  renderPreviewButtons();
}

async function folderTask(task) {
  try {
    await task();
  } catch (error) {
    setStatus(`The folder couldn't be used: ${error.message}`, true);
  }
  renderFolder();
}

function bindFolder() {
  $("folder-choose").onclick = () => folderTask(async () => {
    if (await folder.choose({ another: folder.status === "ready" }) && folder.status === "ready") {
      setStatus(`Using "${folder.folder.name}": ${folder.items.length} pattern${folder.items.length === 1 ? "" : "s"}.`);
    }
  });
  $("folder-refresh").onclick = () => folderTask(() => folder.refresh());
  $("folder-save").onclick = () => folderTask(async () => {
    const name = $("name").value.trim() || "Untitled";
    const saved = await folder.add(name, TD3.encode(state.pattern, state.group, state.slot));
    setStatus(`Saved "${saved}.syx" in "${folder.folder.name}", for ${place()}.`);
  });
  $("folder-search").oninput = renderFolder;
  folderTask(() => folder.restore());
}

/* ---------- Setting up ---------- */

function fillSelects() {
  $("root").replaceChildren(new Option("Off", "off"), ...TD3.KEYS.slice(0, 12).map((name, index) => new Option(name, String(index))));
  $("scale").replaceChildren(new Option("Off", "off"), ...Object.keys(TD3.SCALES).map((name) =>
    new Option(name === "chromatic" ? "All notes" : name[0].toUpperCase() + name.slice(1), name)));
  $("channel").replaceChildren(...Array.from({ length: 16 }, (_, index) => new Option(String(index + 1), String(index + 1))));
  $("group").replaceChildren(...Array.from({ length: TD3.GROUPS }, (_, index) => new Option(String(index + 1), String(index))));
  $("slot").replaceChildren(...Array.from({ length: TD3.SLOTS }, (_, index) => new Option(TD3.slotName(index), String(index))));
  $("channel").value = String(state.channel);
  $("group").value = String(state.group);
  $("slot").value = String(state.slot);
  $("bpm").value = String(state.bpm);
  $("hear").checked = state.hear;
  $("clock").checked = state.sendClock;
  renderNameBar();
  $("move-notes").checked = state.moveWithKey;
  $("name").value = state.name;
}

function setTheme(light) {
  if (light) document.documentElement.dataset.theme = "light";
  else delete document.documentElement.dataset.theme;
  $("theme-toggle").textContent = light ? "☾" : "☀";
  try {
    localStorage.setItem(THEME_KEY, light ? "light" : "dark");
  } catch {
    // It's just not remembered.
  }
}

// Follows a switch made on another grid open in this browser.
window.addEventListener("storage", (event) => {
  if (event.key === THEME_KEY && event.newValue) setTheme(event.newValue === "light");
});

function bindControls() {
  const grid = $("grid");
  grid.addEventListener("pointerdown", onGridDown);
  grid.addEventListener("pointerover", onGridOver);
  window.addEventListener("pointerup", () => { if (drawing) { drawing = null; save(); } });
  // Keyboard users can press a square with Enter or Space.
  grid.addEventListener("click", (event) => {
    if (event.detail !== 0) return;
    onGridDown({ target: event.target, preventDefault() {}, pointerId: 0 });
    drawing = null;
  });
  $("lanes").addEventListener("click", onLaneClick);

  $("play").onclick = togglePlay;
  $("bpm").onchange = () => {
    const bpm = Number($("bpm").value);
    state.bpm = Number.isFinite(bpm) ? Math.min(300, Math.max(40, Math.round(bpm))) : 125;
    $("bpm").value = String(state.bpm);
    save();
    if (play.on) announceTempo();
  };
  $("length").onchange = () => {
    const length = Math.min(16, Math.max(1, Math.round(Number($("length").value)) || 16));
    change({ ...TD3.copyPattern(state.pattern), length }, `${length} steps play.`);
  };
  $("triplet").onclick = () => change({ ...TD3.copyPattern(state.pattern), triplet: !state.pattern.triplet },
    state.pattern.triplet ? "Plays in sixteenths." : "Plays in triplets.");
  $("hear").onchange = () => { state.hear = $("hear").checked; save(); };
  $("clock").onchange = () => { state.sendClock = $("clock").checked; save(); };
  $("stop-all").onclick = panic;

  const move = (semitones, word) => {
    const moved = TD3.transpose(state.pattern, semitones);
    if (!moved) setStatus(`Can't move ${word}: a note would go past the TD-3's three octaves.`, true);
    else change(moved, `Moved every note ${word}.`);
  };
  $("down-semitone").onclick = () => move(-1, "down a semitone");
  $("up-semitone").onclick = () => move(1, "up a semitone");
  $("down-octave").onclick = () => move(-12, "down an octave");
  $("up-octave").onclick = () => move(12, "up an octave");
  $("shift-left").onclick = () => change(TD3.rotate(state.pattern, -1), "Moved the steps left.");
  $("shift-right").onclick = () => change(TD3.rotate(state.pattern, 1), "Moved the steps right.");
  $("generate").onclick = () => {
    if (state.keyOff) return;
    // With all notes showing, lines are written in the minor scale.
    const scale = state.scale === "chromatic" ? "minor" : state.scale;
    const made = TD3.generate({ root: state.root, scale });
    change({ ...made, length: state.pattern.length, triplet: state.pattern.triplet },
      `A new line in ${TD3.KEYS[state.root]} ${scale}. Undo brings the old one back.`);
  };
  $("undo").onclick = () => undoRedo(state.undo, state.redo, "Undone.");
  $("redo").onclick = () => undoRedo(state.redo, state.undo, "Redone.");
  $("clear").onclick = () => change({ ...TD3.emptyPattern(), length: state.pattern.length, triplet: state.pattern.triplet },
    "Cleared. Undo brings it back.");

  const keyOff = (off, message) => {
    state.keyOff = off;
    save();
    render();
    setStatus(message);
  };
  // Turning the key on snaps each note to the nearest in the key, keeping the root.
  const keyOn = () => {
    const name = `${TD3.KEYS[state.root]} ${$("scale").selectedOptions[0]?.text.toLowerCase() || state.scale}`;
    state.keyOff = false;
    if (state.moveWithKey) {
      change(TD3.snapToKey(state.pattern, state.root, state.scale), `Key: ${name}. Notes moved to the nearest notes in the key. Undo puts the notes back.`);
    } else {
      save();
      render();
      setStatus(`Key: ${name}. Notes weren't moved.`);
    }
  };
  $("root").onchange = () => {
    if ($("root").value === "off") {
      keyOff(true, "Key off. The rows are the TD-3's own keys, C to the high C, and notes stay where they are.");
      return;
    }
    if (state.keyOff) {
      state.root = Number($("root").value);
      keyOn();
      return;
    }
    const from = state.root;
    state.root = Number($("root").value);
    save();
    if (state.moveWithKey && state.pattern.steps.some((item) => item.kind !== "rest")) {
      // The nearest way to the new key first, then the other way round.
      const up = (state.root - from + 12) % 12;
      const tries = up <= 6 ? [up, up - 12] : [up - 12, up];
      const moved = tries.map((semitones) => TD3.transpose(state.pattern, semitones)).find(Boolean);
      if (moved && up) {
        change(moved, `Moved the pattern into ${TD3.KEYS[state.root]}. Undo moves it back, leaving the key.`);
        return;
      }
      if (!moved) setStatus(`The pattern can't move into ${TD3.KEYS[state.root]} without going past the TD-3's three octaves, so it stays where it is.`, true);
    }
    render();
  };
  $("scale").onchange = () => {
    if ($("scale").value === "off") {
      keyOff(true, "Key off. The rows are the TD-3's own keys, C to the high C, and notes stay where they are.");
      return;
    }
    state.scale = $("scale").value;
    if (state.keyOff) keyOn();
    else { save(); render(); }
  };
  $("move-notes").onchange = () => { state.moveWithKey = $("move-notes").checked; save(); };
  $("output").onchange = () => {
    stopIfPlaying();
    state.outputName = $("output").value;
    save();
    output = null;
    refreshPorts();
  };
  $("channel").onchange = () => { state.channel = Number($("channel").value); save(); };
  $("group").onchange = () => { state.group = Number($("group").value); save(); };
  $("slot").onchange = () => { state.slot = Number($("slot").value); save(); };

  $("read").onclick = onRead;
  $("send").onclick = onSend;
  $("read-group").onclick = onReadGroup;
  $("put-back").onclick = onPutBack;
  $("copy").onclick = onCopy;
  $("paste").onclick = onPaste;

  $("name").onchange = () => { state.name = $("name").value.trim(); save(); };
  $("save").onclick = () => saveToLibrary(false);
  $("pattern-save").onclick = () => savePatternFile();
  $("pattern-save-as").onclick = () => savePatternFile({ asNew: true });
  $("pattern-open").onclick = openPatternFile;
  $("save-new").onclick = () => saveToLibrary(true);
  $("search").oninput = renderLibrary;
  $("export-syx").onclick = exportSyx;
  $("export").onclick = exportLibrary;
  $("import").onclick = () => $("import-file").click();
  $("import-file").onchange = () => {
    const [file] = $("import-file").files;
    $("import-file").value = "";
    if (file) importFile(file);
  };

  $("midi-retry").onclick = startMidi;
  $("theme-toggle").onclick = () => setTheme(document.documentElement.dataset.theme !== "light");
  $("help-open").onclick = () => $("help").showModal();
  $("help-close").onclick = () => $("help").close();

  document.addEventListener("keydown", (event) => {
    const typing = event.target.closest("input, select, textarea") || document.querySelector("dialog[open]");
    if (typing) return;
    if (event.key === " ") {
      event.preventDefault();
      togglePlay();
    } else if (event.key === "?") {
      $("help").showModal();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      // Cmd+S saves the pattern, and Cmd+Shift+S saves it as a new file.
      event.preventDefault();
      if (!event.repeat) savePatternFile({ asNew: event.shiftKey });
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) undoRedo(state.redo, state.undo, "Redone.");
      else undoRedo(state.undo, state.redo, "Undone.");
    }
  });
  window.addEventListener("pagehide", stopIfPlaying);
}

restore();
// Each visit starts with the key and scale off. Choosing a key brings back the last one.
state.keyOff = true;
buildLanes();
fillSelects();
setTheme(document.documentElement.dataset.theme === "light");
bindControls();
bindFolder();
renderPeers([]);
render();
startMidi();
