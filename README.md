# TD-3 Grid

**[Open TD-3 Grid](https://pzuzarte.github.io/td3-grid/)**

A pattern grid, library and transfer tool for the Behringer TD-3 and TD-3-MO. It runs in
your browser and talks to the TD-3 over USB MIDI.

Unofficial and not affiliated with or endorsed by Behringer. It doesn't change the TD-3's
firmware or settings. Your patterns stay in your browser.

Visits to the page are counted anonymously with
[GoatCounter](https://www.goatcounter.com/help/privacy), which uses no cookies and
never receives your patterns.

**Requires a current version of Google Chrome or Microsoft Edge.**

## What it does

- **Draw patterns on a grid:** the TD-3's 13 keys, C to the high C, across 16 steps, with
  the notes of your key shaded.
- **Every step setting:** octave down or up, accent, slide, and note, tie or rest, one
  click each under the grid. Up to 16 steps, and triplets.
- **Change a whole pattern:** move every note by a semitone or an octave, shift the steps
  round, or generate a new acid line in a key. Undo and redo.
- **Hear it:** play the pattern on the TD-3 from the page, with its slides, ties and
  accents, before sending it.
- **Library folder:** keep patterns as .syx files in a folder you choose, on this computer
  or in Google Drive or the like, search them, and back them up to a file. Import backups and
  .syx files. The page remembers the folder, and Song Grid lists its patterns by name.
- **Hear before loading:** play any library pattern on the TD-3 without changing
  the grid.
- **Transfer:** read any of the TD-3's 64 patterns into the grid, send the grid's pattern
  to any of them, or copy a whole group into the library. Before sending, the page reads
  what's there so it can be put back, and afterwards it reads the pattern again to check
  it arrived.

The **Help** button in the page, or the ? key, explains everything.

## Running it yourself

The page is plain HTML, CSS and JavaScript, with nothing to build. Serve the folder from a
local web server, as browsers only allow MIDI on secure pages and localhost:

```bash
python3 -m http.server 8780 --bind 127.0.0.1
```

Then open http://localhost:8780 in Chrome and allow MIDI access, including SysEx.

## Tests

```bash
node --test "test/*.test.js"
```

## Credits

The TD-3's pattern format is from Brad Isbell's
[unofficial notes on the TD-3's MIDI](https://303patterns.com/td3-midi.html). How ties play
back is from the notes of the [td3-pattern](https://github.com/beholder-d/td3-pattern)
utility. No code from either is used.
