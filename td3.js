"use strict";
/* The TD-3's pattern format, and changes to patterns, kept apart from the page so they
   can be tested. Based on Brad Isbell's unofficial notes on the TD-3's MIDI
   (303patterns.com/td3-midi.html), checked against the td3-pattern utility's notes on
   how ties play.

   A pattern here is 16 steps, each a note, a tie or a rest, with how many steps play and
   whether it's in triplets. A note has one of the 13 keys, C to the high C, moved an
   octave down or up or not, and can have an accent and a slide into the next note. A tie
   holds the note before it for another step.

   The TD-3 stores it differently, as the 303 did: a list of pitches with their accents
   and slides, used in turn by each step that starts a note, and two sets of flags for the
   steps, one for rests and one for notes that are held into the next step. */
const TD3 = (() => {
  const HEADER = [0xF0, 0x00, 0x20, 0x32, 0x00, 0x01, 0x0A];
  const REQUEST_PATTERN = 0x77;
  const PATTERN = 0x78;
  const REQUEST_CONFIG = 0x75;
  const CONFIG = 0x76;
  const STEPS = 16;
  const MESSAGE_LENGTH = 123;
  const OFFSETS = { pitch: 12, accent: 44, slide: 76, triplet: 108, length: 110, tie: 114, rest: 118 };
  const EMPTY_PITCH = 0x18; // The middle C, which the TD-3 puts in unused pitches.
  const HIGH_C = 0x80; // The TD-3 marks pitches entered with its high C key.
  const KEYS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B", "C'"];
  const GROUPS = 4;
  const SLOTS = 16; // A1 to A8 then B1 to B8 in each group.

  const step = (fields = {}) => ({
    kind: fields.kind || "rest", // "note", "tie" or "rest".
    note: fields.note ?? 0, // 0 is C, 12 the high C.
    octave: fields.octave ?? 0, // -1 down, 0, or 1 up.
    accent: Boolean(fields.accent),
    slide: Boolean(fields.slide),
  });

  function emptyPattern() {
    return { steps: Array.from({ length: STEPS }, () => step()), length: STEPS, triplet: false };
  }

  const clampInt = (value, low, high, fallback) =>
    (Number.isInteger(value) ? Math.min(high, Math.max(low, value)) : fallback);

  // A pattern from saved data, with anything missing or wrong set to a default.
  function cleanPattern(data) {
    const pattern = emptyPattern();
    if (!data || !Array.isArray(data.steps)) return pattern;
    pattern.steps = pattern.steps.map((blank, index) => {
      const saved = data.steps[index] || {};
      return step({
        kind: ["note", "tie", "rest"].includes(saved.kind) ? saved.kind : "rest",
        note: clampInt(saved.note, 0, 12, 0),
        octave: clampInt(saved.octave, -1, 1, 0),
        accent: saved.accent,
        slide: saved.slide,
      });
    });
    if (pattern.steps[0].kind === "tie") pattern.steps[0].kind = "note";
    pattern.length = clampInt(data.length, 1, STEPS, STEPS);
    pattern.triplet = Boolean(data.triplet);
    return pattern;
  }

  const copyPattern = (pattern) => cleanPattern(JSON.parse(JSON.stringify(pattern)));

  // The TD-3's value for a key and octave. Its middle C is 0x18.
  function pitchValue(note, octave) {
    return 12 + note + (octave + 1) * 12 + (note === 12 ? HIGH_C : 0);
  }

  function fromPitchValue(value) {
    const raw = value & 0x7F;
    const high = (value & HIGH_C) !== 0 || raw === 0x30;
    const octave = Math.floor(raw / 12) - 2 - (high ? 1 : 0);
    if (octave < -1 || octave > 1) return { note: raw % 12, octave: Math.min(1, Math.max(-1, octave)) };
    return { note: (raw % 12) + (high ? 12 : 0), octave };
  }

  // Semitones above the lowest note, 0 to 36, for moving notes and playing them.
  const height = (item) => (item.octave + 1) * 12 + item.note;

  // The key and octave for a height, using no octave change where it can.
  function fromHeight(value) {
    if (value <= 11) return { note: value, octave: -1 };
    if (value <= 24) return { note: value - 12, octave: 0 };
    return { note: value - 24, octave: 1 };
  }

  /* The grid shows an octave from the key's root up to the root above, as rows 0 to 12,
     and each step's Oct moves its note an octave down or up from there. For C that's the
     TD-3's own keyboard and Down and Up keys. For other keys the octave is placed as near
     the middle of the TD-3's range as it goes, so the few notes at the far end of the
     range are two octaves away from it, and a few moves at the very top or bottom don't fit. */
  const gridBase = (root) => (root <= 6 ? 12 + root : root);

  function onGrid(item, root) {
    if (root === 0) return { row: item.note, shift: item.octave };
    const offset = height(item) - gridBase(root);
    let shift = 0;
    if (offset < 0) shift = -Math.ceil(-offset / 12);
    else if (offset > 12) shift = Math.ceil((offset - 12) / 12);
    return { row: offset - shift * 12, shift };
  }

  // The key and octave for a row and octave move, or null if it's past the TD-3's range.
  function fromGrid(row, shift, root) {
    if (root === 0) return { note: row, octave: shift };
    const value = gridBase(root) + row + shift * 12;
    return value < 0 || value > 36 ? null : fromHeight(value);
  }

  const rowName = (row, root) => (row === 12 ? `${KEYS[root % 12]}'` : KEYS[(root + row) % 12]);

  // A step's pitch as MIDI, for playing it. The TD-3's middle C sounds as MIDI note 36.
  const midiNote = (item) => 24 + height(item);

  function keyName(item) {
    return `${KEYS[item.note]}${item.octave > 0 ? " up" : item.octave < 0 ? " down" : ""}`;
  }

  const slotName = (slot) => `${slot < 8 ? "A" : "B"}${(slot % 8) + 1}`;
  const placeName = (group, slot) => `Group ${group + 1} ${slotName(slot)}`;

  // The rest and tie flags are 16 bits, sent as four nibbles in the order 7-4, 3-0, 15-12, 11-8.
  const maskBytes = (mask) => [(mask >> 4) & 0x0F, mask & 0x0F, (mask >> 12) & 0x0F, (mask >> 8) & 0x0F];
  const maskFrom = (bytes) => ((bytes[0] & 0x0F) << 4) | (bytes[1] & 0x0F) | ((bytes[2] & 0x0F) << 12) | ((bytes[3] & 0x0F) << 8);

  // The steps that start a note, in order. These use the TD-3's pitches in turn.
  function starts(pattern) {
    return pattern.steps.filter((item) => item.kind === "note");
  }

  // The message that writes a pattern to a group (0-3) and slot (0-15) on the TD-3.
  function encode(input, group, slot) {
    const pattern = cleanPattern(input);
    const bytes = new Array(MESSAGE_LENGTH).fill(0);
    HEADER.forEach((value, index) => { bytes[index] = value; });
    bytes[7] = PATTERN;
    bytes[8] = group;
    bytes[9] = slot;
    const notes = starts(pattern);
    for (let index = 0; index < STEPS; index += 1) {
      const item = notes[index];
      const value = item ? pitchValue(item.note, item.octave) : EMPTY_PITCH;
      bytes[OFFSETS.pitch + index * 2] = value >> 4;
      bytes[OFFSETS.pitch + index * 2 + 1] = value & 0x0F;
      bytes[OFFSETS.accent + index * 2 + 1] = item?.accent ? 1 : 0;
      bytes[OFFSETS.slide + index * 2 + 1] = item?.slide ? 1 : 0;
    }
    bytes[OFFSETS.triplet + 1] = pattern.triplet ? 1 : 0;
    bytes[OFFSETS.length] = pattern.length >> 4;
    bytes[OFFSETS.length + 1] = pattern.length & 0x0F;
    // A tie flag clear on a step means its note is held into the next step.
    let notHeld = 0;
    let rests = 0;
    pattern.steps.forEach((item, index) => {
      const next = pattern.steps[index + 1];
      const held = item.kind !== "rest" && next?.kind === "tie";
      if (!held) notHeld |= 1 << index;
      if (item.kind === "rest") rests |= 1 << index;
    });
    maskBytes(notHeld).forEach((value, index) => { bytes[OFFSETS.tie + index] = value; });
    maskBytes(rests).forEach((value, index) => { bytes[OFFSETS.rest + index] = value; });
    bytes[MESSAGE_LENGTH - 1] = 0xF7;
    return bytes;
  }

  const isOurs = (data) => data.length > 8 && HEADER.every((value, index) => data[index] === value);

  // The pattern in a message from the TD-3, with its place, or null if it isn't one.
  function decode(data) {
    if (!isOurs(data) || data[7] !== PATTERN || data.length < MESSAGE_LENGTH) return null;
    const nibbles = (offset) => ((data[offset] & 0x0F) << 4) | (data[offset + 1] & 0x0F);
    const pitches = Array.from({ length: STEPS }, (_, index) => ({
      ...fromPitchValue(nibbles(OFFSETS.pitch + index * 2)),
      accent: (data[OFFSETS.accent + index * 2 + 1] & 1) === 1,
      slide: (data[OFFSETS.slide + index * 2 + 1] & 1) === 1,
    }));
    const notHeld = maskFrom(data.slice(OFFSETS.tie, OFFSETS.tie + 4));
    const rests = maskFrom(data.slice(OFFSETS.rest, OFFSETS.rest + 4));
    const pattern = emptyPattern();
    let used = 0;
    for (let index = 0; index < STEPS; index += 1) {
      const before = pattern.steps[index - 1];
      if (rests & (1 << index)) {
        pattern.steps[index] = step({ kind: "rest" });
      } else if (before && before.kind !== "rest" && !(notHeld & (1 << (index - 1)))) {
        pattern.steps[index] = step({ kind: "tie", note: before.note, octave: before.octave });
      } else {
        const pitch = pitches[used] || pitches[STEPS - 1];
        used += 1;
        pattern.steps[index] = step({ kind: "note", ...pitch });
      }
    }
    pattern.length = clampInt(nibbles(OFFSETS.length), 1, STEPS, STEPS);
    pattern.triplet = (data[OFFSETS.triplet + 1] & 1) === 1;
    return { group: data[8], slot: data[9], pattern };
  }

  const requestPattern = (group, slot) => [...HEADER, REQUEST_PATTERN, group, slot, 0xF7];
  const requestConfig = () => [...HEADER, REQUEST_CONFIG, 0xF7];

  // The settings the page needs from the TD-3's configuration reply.
  function decodeConfig(data) {
    if (!isOurs(data) || data[7] !== CONFIG || data.length < 19) return null;
    return { inChannel: (data[9] & 0x0F) + 1, clockSource: data[16], accentThreshold: data[17] };
  }

  // Every SysEx message in a file, such as a .syx of patterns.
  function splitSysex(bytes) {
    const messages = [];
    let start = -1;
    bytes.forEach((value, index) => {
      if (value === 0xF0) start = index;
      else if (value === 0xF7 && start >= 0) {
        messages.push(Array.from(bytes.slice(start, index + 1)));
        start = -1;
      }
    });
    return messages;
  }

  // Moves every note up or down by semitones, keeping each in its octave where it can. Null
  // if any note would go past the TD-3's three octaves.
  function transpose(input, semitones) {
    const pattern = copyPattern(input);
    for (const item of pattern.steps) {
      if (item.kind === "rest") continue;
      const target = height(item) + semitones;
      if (target < 0 || target > 36) return null;
      const keep = target - (item.octave + 1) * 12;
      if (keep >= 0 && keep <= 12) {
        item.note = keep;
      } else {
        item.octave = Math.min(1, Math.floor(target / 12) - 1);
        item.note = target - (item.octave + 1) * 12;
      }
    }
    return pattern;
  }

  // Moves the steps round by one or more, within the steps that play.
  function rotate(input, by) {
    const pattern = copyPattern(input);
    const playing = pattern.steps.slice(0, pattern.length);
    const shift = ((by % playing.length) + playing.length) % playing.length;
    const moved = playing.slice(playing.length - shift).concat(playing.slice(0, playing.length - shift));
    pattern.steps.splice(0, playing.length, ...moved);
    return cleanPattern(pattern);
  }

  const SCALES = {
    chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    minor: [0, 2, 3, 5, 7, 8, 10],
    "minor pentatonic": [0, 3, 5, 7, 10],
    phrygian: [0, 1, 3, 5, 7, 8, 10],
    dorian: [0, 2, 3, 5, 7, 9, 10],
    major: [0, 2, 4, 5, 7, 9, 11],
  };

  // A new acid line in a key, from a random number source such as Math.random.
  function generate({ root = 0, scale = "minor", random = Math.random } = {}) {
    const degrees = SCALES[scale] || SCALES.minor;
    const pattern = emptyPattern();
    const chance = (odds) => random() < odds;
    for (let index = 0; index < STEPS; index += 1) {
      const before = pattern.steps[index - 1];
      if (before && before.kind !== "rest" && chance(0.14)) {
        pattern.steps[index] = step({ kind: "tie", note: before.note, octave: before.octave });
        continue;
      }
      if (index && chance(index % 4 === 0 ? 0.05 : 0.18)) continue;
      // The root is the most likely note, on the beat especially.
      // Rows of the grid's octave from the root, sometimes the root above, and now and then
      // an octave up or down.
      let row = chance(index % 4 === 0 ? 0.5 : 0.3) ? 0 : degrees[Math.floor(random() * degrees.length)];
      if (row === 0 && chance(0.15)) row = 12;
      const shift = chance(0.2) ? 1 : chance(0.12) ? -1 : 0;
      const pitch = fromGrid(row, shift, root) || fromGrid(row, 0, root);
      pattern.steps[index] = step({ kind: "note", ...pitch, accent: chance(index % 4 === 0 ? 0.4 : 0.2), slide: chance(0.2) });
    }
    return pattern;
  }

  return {
    GROUPS, KEYS, SCALES, SLOTS, STEPS,
    cleanPattern, copyPattern, decode, decodeConfig, emptyPattern, encode, fromGrid, fromHeight,
    fromPitchValue, generate, gridBase, height, keyName, onGrid, rowName, midiNote, pitchValue, placeName, requestConfig, requestPattern, rotate,
    slotName, splitSysex, step, transpose,
  };
})();

if (typeof module !== "undefined") module.exports = TD3;
