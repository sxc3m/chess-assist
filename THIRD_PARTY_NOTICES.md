# Third-party notices

Chess Assist bundles the following third-party components.

## Stockfish 19 NNUE (full, WASM)

- Files: `engine/stockfish-19-single.js`, `engine/stockfish-19-single.wasm`
- Build: `stockfish-19-single` (full NNUE net, single-threaded) from
  <https://github.com/nmrugg/stockfish.js> (v19.0.1)
- Engine: <https://github.com/official-stockfish/Stockfish>
- License: GNU General Public License v3.0 (GPL-3.0)

This is the default engine. It embeds the complete NNUE evaluation network,
which is why the WASM file is about 95 MB. It is the strongest build that runs
in a browser page without special headers.

## Stockfish 19 Lite (WASM, fallback)

- Files: `engine/stockfish.js`, `engine/stockfish.wasm`
- Build: `stockfish-19-lite-single` from
  <https://github.com/nmrugg/stockfish.js> (v19.0.1)
- Engine: <https://github.com/official-stockfish/Stockfish>
- License: GNU General Public License v3.0 (GPL-3.0)

The Lite build is kept as a fallback. If the full build cannot be loaded (for
example, there is not enough memory), the background page switches to Lite
automatically and the popup shows a note about it.

Stockfish is free software: you can redistribute it and/or modify it under
the terms of the GNU General Public License as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later
version.

Because the extension distributes a GPL-licensed engine, the extension as a
whole is distributed under GPL-3.0. The full license text is in `LICENSE`.

## chess.js 1.4.0

- File: `content/vendor/chess.global.js` (browser-global wrapper around the
  official CommonJS build)
- Source: <https://github.com/jhlywa/chess.js>
- License: BSD 2-Clause

The full license text is in `licenses/chess.js-LICENSE.txt`.
