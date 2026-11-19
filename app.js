"use strict";
/* TD-3 Grid: draws a TD-3 pattern on a grid, plays it on the TD-3, keeps patterns in a
   library in the browser, and reads and writes the TD-3's own patterns over USB SysEx.
   The pattern format is in td3.js. */

const $ = (id) => document.getElementById(id);
const STORAGE_KEY = "td3-grid";
const LIBRARY_KEY = "td3-grid-library";
const THEME_KEY = "td3-grid-theme";
const UNDO_LIMIT = 100;
const REPLY_TIMEOUT_MS = 1500;
const SETTLE_MS = 250; // A pause after writing a pattern, before reading it back.
const LOOKAHEAD_MS = 120;
const TICK_MS = 25;

const state = {
  pattern: TD3.emptyPattern(),
  name: "",
  libraryId: null,
  bpm: 125,
  root: 0,
  scale: "chromatic",
  group: 0,
  slot: 0,
  channel: 1,
  hear: true,
  moveWithKey: true,
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
  if (typeof saved.moveWithKey === "boolean") state.moveWithKey = saved.moveWithKey;
  if (typeof saved.outputName === "string") state.outputName = saved.outputName;
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

const keyNotes = () => new Set(TD3.SCALES[state.scale].map((degree) => (state.root + degree) % 12));

// The row and octave move a step was drawn with, as the root a row up and the root above
// are the same pitch. Used while it still matches the step's note.
let drawnAt = [];

function gridPlace(item, index) {
  const before = state.pattern.steps[index - 1];
  if (item.kind === "tie" && before && before.kind !== "rest") return gridPlace(before, index - 1);
  const hint = drawnAt[index];
  const back = hint && TD3.fromGrid(hint.row, hint.shift, state.root);
  if (back && TD3.height(back) === TD3.height(item)) return hint;
  return TD3.onGrid(item, state.root);
}

// The grid's rows, the root above first: the notes of the key and mode, and any the
// pattern already uses.
function visibleRows() {
  const inKey = keyNotes();
  const used = new Set(state.pattern.steps.map((item, index) => (item.kind === "rest" ? null : gridPlace(item, index).row)));
  return Array.from({ length: 13 }, (_, index) => 12 - index)
    .filter((row) => inKey.has((state.root + row) % 12) || used.has(row));
}

let shownRows = "";

function buildRows() {
  const rows = visibleRows();
  const shape = `${state.root}:${rows.join()}`;
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
    label.textContent = TD3.rowName(row, state.root);
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

function render() {
  buildRows();
  const { steps, length } = state.pattern;
  const isRoot = (row) => row === 0 || row === 12;
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
    cell.setAttribute("aria-label", `Step ${index + 1}, ${TD3.rowName(row, state.root)}: ${here ? describe(item) : "empty"}`);
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
    if (!TD3.fromGrid(row, shift, state.root)) shift = 0;
    if (item.kind === "rest") Object.assign(item, { accent: false, slide: false });
    Object.assign(item, { kind: "note" }, TD3.fromGrid(row, shift, state.root));
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
      .find((option) => TD3.fromGrid(row, option, state.root));
    const next = move === undefined ? null : TD3.fromGrid(row, move, state.root);
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
        const from = before && before.kind !== "rest" ? { note: before.note, octave: before.octave } : TD3.fromGrid(0, 0, state.root);
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

const play = { on: false, step: 0, nextTime: 0, stopTimer: null, offs: [], absorbed: new Set() };

const stepMs = () => (60000 / state.bpm / 4) * (state.pattern.triplet ? 2 / 3 : 1);

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
  const { steps, length } = state.pattern;
  if (play.absorbed.delete(index)) return;
  const item = steps[index];
  if (item.kind !== "note") return;
  const note = TD3.midiNote(item);
  const tiesAfter = (from) => {
    let count = 0;
    while (from + count + 1 < length && steps[from + count + 1].kind === "tie") count += 1;
    return count;
  };
  let span = 1 + tiesAfter(index);
  let last = item;
  let next = steps[(index + span) % length];
  while (last.slide && next.kind === "note" && TD3.midiNote(next) === note && span < length) {
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

function tick() {
  if (!play.on) return;
  const now = performance.now();
  const until = now + LOOKAHEAD_MS;
  // After the computer sleeps, carry on from now rather than playing the missed steps at once.
  if (play.nextTime < now - stepMs()) play.nextTime = now + 10;
  while (play.nextTime < until) {
    const index = play.step % state.pattern.length;
    playStep(index, play.nextTime);
    const shown = index;
    const delay = Math.max(0, play.nextTime - performance.now());
    setTimeout(() => showStep(play.on ? shown : null), delay);
    play.nextTime += stepMs();
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

function startPlaying() {
  if (!output) {
    setStatus("Connect the TD-3 to play the pattern.", true);
    return;
  }
  play.on = true;
  play.step = 0;
  play.absorbed.clear();
  play.nextTime = performance.now() + 30;
  play.stopTimer = everyTick(tick);
  tick();
  $("play").setAttribute("aria-pressed", "true");
  $("play").textContent = "Stop";
}

function stopIfPlaying() {
  if (!play.on) return;
  play.on = false;
  play.stopTimer();
  // Notes already on their way are let go now, and everything is silenced.
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

function togglePlay() {
  if (play.on) stopIfPlaying();
  else startPlaying();
}

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
  $("library-empty").hidden = library.length > 0;
  $("library-empty").textContent = library.length ? "" : "No saved patterns yet. Save one, or read a group from the TD-3.";
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
    row.append(load, rename, remove);
    return row;
  }));
}

function loadFromLibrary(item) {
  change(item.pattern, `Loaded "${item.name}". Undo brings back what was in the grid.`);
  state.name = item.name;
  state.libraryId = item.id;
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
  $("name").value = name;
  saveLibrary();
  save();
  renderLibrary();
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

/* ---------- Setting up ---------- */

function fillSelects() {
  $("root").replaceChildren(...TD3.KEYS.slice(0, 12).map((name, index) => new Option(name, String(index))));
  $("scale").replaceChildren(...Object.keys(TD3.SCALES).map((name) =>
    new Option(name === "chromatic" ? "All notes" : name[0].toUpperCase() + name.slice(1), name)));
  $("channel").replaceChildren(...Array.from({ length: 16 }, (_, index) => new Option(String(index + 1), String(index + 1))));
  $("group").replaceChildren(...Array.from({ length: TD3.GROUPS }, (_, index) => new Option(String(index + 1), String(index))));
  $("slot").replaceChildren(...Array.from({ length: TD3.SLOTS }, (_, index) => new Option(TD3.slotName(index), String(index))));
  $("root").value = String(state.root);
  $("scale").value = state.scale;
  $("channel").value = String(state.channel);
  $("group").value = String(state.group);
  $("slot").value = String(state.slot);
  $("bpm").value = String(state.bpm);
  $("hear").checked = state.hear;
  $("move-notes").checked = state.moveWithKey;
  $("name").value = state.name;
}

function setTheme(light) {
  if (light) document.documentElement.dataset.theme = "light";
  else delete document.documentElement.dataset.theme;
  $("theme-toggle").textContent = light ? "Dark mode" : "Light mode";
  try {
    localStorage.setItem(THEME_KEY, light ? "light" : "dark");
  } catch {
    // It's just not remembered.
  }
}

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
  };
  $("length").onchange = () => {
    const length = Math.min(16, Math.max(1, Math.round(Number($("length").value)) || 16));
    change({ ...TD3.copyPattern(state.pattern), length }, `${length} steps play.`);
  };
  $("triplet").onclick = () => change({ ...TD3.copyPattern(state.pattern), triplet: !state.pattern.triplet },
    state.pattern.triplet ? "Plays in sixteenths." : "Plays in triplets.");
  $("hear").onchange = () => { state.hear = $("hear").checked; save(); };

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

  $("root").onchange = () => {
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
  $("scale").onchange = () => { state.scale = $("scale").value; save(); render(); };
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
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) undoRedo(state.redo, state.undo, "Redone.");
      else undoRedo(state.undo, state.redo, "Undone.");
    }
  });
  window.addEventListener("pagehide", stopIfPlaying);
}

restore();
buildLanes();
fillSelects();
setTheme(document.documentElement.dataset.theme === "light");
bindControls();
render();
startMidi();
