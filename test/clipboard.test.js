const test = require("node:test");
const assert = require("node:assert");
const TD3 = require("../td3.js");
test("TD-3 pattern round-trips through notes", () => {
  const p = TD3.emptyPattern();
  p.steps[0] = TD3.step({ kind: "note", note: 0, octave: 0, accent: true });
  p.steps[1] = TD3.step({ kind: "tie", note: 0, octave: 0 });
  p.steps[4] = TD3.step({ kind: "note", note: 7, octave: -1, slide: true });
  p.steps[5] = TD3.step({ kind: "note", note: 12, octave: 1 });
  const clip = TD3.toNotes(p);
  assert.equal(clip.notes.length, 3);
  assert.deepEqual(clip.notes.map((n) => [n.time, n.length, n.note]), [[0, 480, 36], [960, 240, 31], [1200, 240, 60]]);
  const back = TD3.fromNotes(clip);
  assert.deepEqual(back.steps.slice(0, 6).map((s) => [s.kind, s.note, s.octave, s.accent, s.slide]),
    p.steps.slice(0, 6).map((s) => [s.kind, s.kind === "rest" ? 0 : s.note, s.kind === "rest" ? 0 : s.octave, s.accent, s.slide]));
});
test("notes from another grid become steps", () => {
  const clip = { span: 7680, notes: [
    { time: 0, length: 720, note: 45, velocity: 1 },
    { time: 0, length: 240, note: 52, velocity: 1 },
    { time: 960, length: 360, note: 48, velocity: 0.5 },
    { time: 1200, length: 240, note: 96, velocity: 0.5 },
  ] };
  const p = TD3.fromNotes(clip);
  assert.equal(p.length, 16); assert.equal(p.triplet, false);
  assert.deepEqual(p.steps.slice(0, 6).map((s) => s.kind), ["note", "tie", "tie", "rest", "note", "note"]);
  assert.equal(TD3.midiNote(p.steps[0]), 45);
  assert.equal(p.steps[0].accent, true); assert.equal(p.steps[4].accent, false);
  assert.equal(p.steps[4].slide, true);
  assert.ok(TD3.midiNote(p.steps[5]) <= 60 && TD3.midiNote(p.steps[5]) % 12 === 0);
});
test("triplets are found", () => {
  const p = TD3.fromNotes({ span: 1920, notes: [0, 320, 640].map((time) => ({ time, length: 320, note: 36, velocity: 1 })) });
  assert.equal(p.triplet, true); assert.equal(p.steps[2].kind, "note"); assert.equal(p.length, 6);
});
