"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const TD3 = require("../td3.js");

const hex = (text) => text.trim().split(/\s+/).map((value) => parseInt(value, 16));

// A pattern as the TD-3 sent it, from the unofficial notes: 16 notes alternating between
// two pitches, all with slides, in group 1 pattern A2.
const DUMP = hex(`
  F0 00 20 32 00 01 0A 78 00 01 00 00 02 04 02 03
  02 04 02 03 02 04 02 03 02 04 02 03 02 04 02 03
  02 04 02 03 02 04 02 03 02 04 02 03 00 00 00 00
  00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
  00 00 00 00 00 00 00 00 00 00 00 00 00 01 00 01
  00 01 00 01 00 01 00 01 00 01 00 01 00 01 00 01
  00 01 00 01 00 01 00 01 00 01 00 01 00 00 01 00
  00 00 0F 0F 0F 0F 00 00 00 00 F7`);

const steps = (text) => text.trim().split(/\s+/).map((code) => {
  const [kind, note = "0", octave = "0", flags = ""] = code.split(":");
  return TD3.step({
    kind: { n: "note", t: "tie", r: "rest" }[kind],
    note: Number(note), octave: Number(octave), accent: flags.includes("a"), slide: flags.includes("s"),
  });
});
const pattern = (text, fields = {}) => TD3.cleanPattern({ steps: steps(text), length: 16, ...fields });

test("the TD-3's own pattern reads as 16 sliding notes", () => {
  assert.equal(DUMP.length, 123);
  const { group, slot, pattern: read } = TD3.decode(DUMP);
  assert.equal(group, 0);
  assert.equal(slot, 1);
  assert.equal(read.length, 16);
  assert.equal(read.triplet, false);
  assert.ok(read.steps.every((item) => item.kind === "note" && item.slide && !item.accent));
  // 0x24 is the C an octave above the middle C, and 0x23 the B below it.
  assert.deepEqual(read.steps.slice(0, 2).map((item) => [item.note, item.octave]), [[0, 1], [11, 0]]);
});

test("writing that pattern back gives the same message", () => {
  const { pattern: read } = TD3.decode(DUMP);
  assert.deepEqual(TD3.encode(read, 0, 1), DUMP);
});

test("pitches cover three octaves, with the high C marked as the TD-3 marks it", () => {
  assert.equal(TD3.pitchValue(0, 0), 0x18);
  assert.equal(TD3.pitchValue(0, -1), 0x0C);
  assert.equal(TD3.pitchValue(12, 1), 0x30 | 0x80);
  assert.deepEqual(TD3.fromPitchValue(0x24 | 0x80), { note: 12, octave: 0 });
  assert.deepEqual(TD3.fromPitchValue(0x24), { note: 0, octave: 1 });
  assert.deepEqual(TD3.fromPitchValue(0x30), { note: 12, octave: 1 });
  for (let octave = -1; octave <= 1; octave += 1) {
    for (let note = 0; note <= 12; note += 1) {
      assert.deepEqual(TD3.fromPitchValue(TD3.pitchValue(note, octave)), { note, octave });
    }
  }
});

test("rests and ties are flagged by step, and only notes use up pitches", () => {
  const written = pattern("n:0 t r n:2::a n:4:1:s r r r r r r r r r r r");
  const bytes = TD3.encode(written, 2, 9);
  assert.equal(bytes.length, 123);
  assert.deepEqual(bytes.slice(0, 10), [0xF0, 0x00, 0x20, 0x32, 0x00, 0x01, 0x0A, 0x78, 2, 9]);
  // Three notes, so three pitches, then the middle C in the rest.
  assert.deepEqual(bytes.slice(12, 20), [0x01, 0x08, 0x01, 0x0A, 0x02, 0x08, 0x01, 0x08]);
  assert.deepEqual(bytes.slice(44, 50), [0, 0, 0, 1, 0, 0]);
  assert.deepEqual(bytes.slice(76, 82), [0, 0, 0, 0, 0, 1]);
  // Step 1 is held into step 2, so its tie flag is clear. Steps 3 and 6 to 16 are rests.
  assert.deepEqual(bytes.slice(114, 118), [0x0F, 0x0E, 0x0F, 0x0F]);
  assert.deepEqual(bytes.slice(118, 122), [0x0E, 0x04, 0x0F, 0x0F]);
  assert.equal(bytes[122], 0xF7);
  assert.deepEqual(TD3.decode(bytes).pattern, written);
});

test("a tie after a tie keeps holding the same note", () => {
  const written = pattern("n:7::a t t n:3 r r r r r r r r r r r r");
  const read = TD3.decode(TD3.encode(written, 0, 0)).pattern;
  assert.deepEqual(read.steps.slice(0, 4).map((item) => [item.kind, item.note]), [["note", 7], ["tie", 7], ["tie", 7], ["note", 3]]);
});

test("step count and triplets are kept", () => {
  const written = pattern("n:0 n:1 n:2 r r r r r r r r r r r r r", { length: 12, triplet: true });
  const bytes = TD3.encode(written, 0, 0);
  assert.deepEqual(bytes.slice(108, 112), [0, 1, 0, 0x0C]);
  const read = TD3.decode(bytes).pattern;
  assert.equal(read.length, 12);
  assert.equal(read.triplet, true);
  assert.equal(TD3.decode(TD3.encode({ ...written, length: 16 }, 0, 0)).pattern.length, 16);
});

test("other messages aren't read as patterns", () => {
  assert.equal(TD3.decode([0xF0, 0x00, 0x20, 0x32, 0x00, 0x01, 0x0A, 0x76, 0xF7]), null);
  assert.equal(TD3.decode(DUMP.slice(0, 60)), null);
  assert.equal(TD3.decode([0x90, 60, 100]), null);
});

test("requests and the configuration reply", () => {
  assert.deepEqual(TD3.requestPattern(3, 15), [0xF0, 0x00, 0x20, 0x32, 0x00, 0x01, 0x0A, 0x77, 3, 15, 0xF7]);
  const reply = hex("F0 00 20 32 00 01 0A 76 00 08 0C 02 02 00 01 02 03 46 F7");
  assert.deepEqual(TD3.decodeConfig(reply), { inChannel: 9, clockSource: 3, accentThreshold: 0x46 });
});

test("a file of patterns splits into its messages", () => {
  const file = [...DUMP, ...TD3.encode(TD3.emptyPattern(), 1, 2)];
  const messages = TD3.splitSysex(file);
  assert.equal(messages.length, 2);
  assert.equal(TD3.decode(messages[1]).slot, 2);
});

test("transposing keeps notes in their octave where it can, and stops at the edges", () => {
  const written = pattern("n:11 n:0:1 n:12 r r r r r r r r r r r r r");
  const up = TD3.transpose(written, 1);
  assert.deepEqual(up.steps.slice(0, 2).map((item) => [item.note, item.octave]), [[12, 0], [1, 1]]);
  assert.equal(TD3.transpose(written, 13), null);
  const down = TD3.transpose(written, -12);
  assert.deepEqual(down.steps.slice(0, 3).map((item) => [item.note, item.octave]), [[11, -1], [0, 0], [0, 0]]);
});

test("rotating moves only the steps that play", () => {
  const written = pattern("n:0 n:1 n:2 n:3 n:9 n:9 n:9 n:9 n:9 n:9 n:9 n:9 n:9 n:9 n:9 n:9", { length: 4 });
  assert.deepEqual(TD3.rotate(written, 1).steps.slice(0, 5).map((item) => item.note), [3, 0, 1, 2, 9]);
  assert.deepEqual(TD3.rotate(written, -1).steps.slice(0, 4).map((item) => item.note), [1, 2, 3, 0]);
});

test("a tie can't start a pattern", () => {
  const cleaned = TD3.cleanPattern({ steps: [{ kind: "tie", note: 4 }], length: 16 });
  assert.equal(cleaned.steps[0].kind, "note");
  const rotated = TD3.rotate(pattern("t:0 n:2 t r r r r r r r r r r r r n:5"), 0);
  assert.equal(rotated.steps[0].kind, "note");
});

test("generated lines stay in the key and in range", () => {
  let seed = 7;
  const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let round = 0; round < 50; round += 1) {
    const made = TD3.generate({ root: 9, scale: "minor pentatonic", random });
    assert.equal(made.steps[0].kind !== "tie", true);
    for (const item of made.steps.filter((entry) => entry.kind === "note")) {
      assert.ok([9, 0, 2, 4, 7, 12].includes(item.note), `note ${item.note}`);
      assert.ok(TD3.height(item) >= 0 && TD3.height(item) <= 36);
    }
    assert.deepEqual(TD3.decode(TD3.encode(made, 0, 0)).pattern, made);
  }
});

test("in C the grid is the TD-3's own keyboard, with its Down and Up keys", () => {
  for (let octave = -1; octave <= 1; octave += 1) {
    for (let note = 0; note <= 12; note += 1) {
      assert.deepEqual(TD3.onGrid({ note, octave }, 0), { row: note, shift: octave });
      assert.deepEqual(TD3.fromGrid(note, octave, 0), { note, octave });
    }
  }
  assert.equal(TD3.rowName(12, 0), "C'");
  // Two octaves is past the TD-3's Down and Up keys, so the octave lane skips it.
  assert.equal(TD3.fromGrid(7, 2, 0), null);
  assert.equal(TD3.fromGrid(7, -2, 0), null);
});

test("in other keys the rows run from the root to the root above", () => {
  assert.deepEqual([0, 1, 3, 12].map((row) => TD3.rowName(row, 9)), ["A", "A#", "C", "A'"]);
  for (let root = 1; root < 12; root += 1) {
    // Every note the TD-3 can play has a place on the grid, and comes back the same.
    for (let value = 0; value <= 36; value += 1) {
      const item = TD3.fromHeight(value);
      const { row, shift } = TD3.onGrid(item, root);
      assert.ok(row >= 0 && row <= 12 && shift >= -2 && shift <= 2);
      assert.equal(TD3.height(TD3.fromGrid(row, shift, root)), value);
    }
    // The bottom row is the root.
    assert.equal(TD3.height(TD3.fromGrid(0, 0, root)) % 12, root);
  }
  // Octave moves past the TD-3's range are refused.
  assert.equal(TD3.fromGrid(0, -1, 9), null);
  assert.equal(TD3.fromGrid(12, 1, 2), null);
});
