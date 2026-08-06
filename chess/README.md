# Chess

Play chess against the computer in the browser. Pick your colour and the
computer's strength before the game starts.

## Running it

The app is written as ES modules, and browsers refuse to load modules from
`file://` URLs, so it has to be opened through a web server rather than by
double-clicking `index.html`. Any static server works:

```sh
cd chess
python3 -m http.server 8000
```

Then open <http://localhost:8000/>.

There is no build step and no install step — the only dependency, `chess.js`,
is vendored in `lib/`.

## Playing

- **Choose a side** — white, black, or random. Playing black flips the board and
  the computer opens.
- **Choose a strength** — the slider runs from 400 to 2200 ELO. The blurb under
  it describes how that level plays.
- **Move** by clicking a piece and then its destination. Legal destinations are
  shown as dots; captures are ringed. Clicking elsewhere deselects, as does
  <kbd>Esc</kbd>.
- **Promoting a pawn** opens a picker — you are not forced to take a queen.
- **Undo** rolls back to your previous turn (your move and the computer's
  reply). **Flip board** changes the view without affecting the game.

Adding `?fen=<position>` to the URL starts from a given FEN instead of the
initial position, which is useful for practising an endgame. An unparseable FEN
is ignored and the standard position is used.

## How the strength levels work

`engine.js` is an alpha-beta search with a piece-square-table evaluation and a
quiescence search over captures. Each ELO level maps to four settings:

| Setting | Effect |
| --- | --- |
| `depth` | How many plies the search looks ahead (1 at 400, 4 at 2200) |
| `timeMs` | Time budget per move; the search aborts and uses the last completed depth |
| `noise` | Random centipawns added to each root move's score, so weaker levels pick a "good enough" move rather than the best one |
| `blunder` | Probability of skipping the search entirely and playing a random legal move |

The ELO numbers are approximate targets, not measured ratings — they describe
roughly how the opponent feels to play, not a calibrated strength.

The search runs on the main thread between animation frames, so the top levels
pause the page for up to about three seconds while thinking.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Markup for the setup screen, board, and sidebar |
| `style.css` | All styling |
| `app.js` | UI: board rendering, move input, game state, status messages |
| `engine.js` | Search, evaluation, and the ELO-to-behaviour mapping |
| `lib/chess.js` | Vendored [chess.js](https://github.com/jhlywa/chess.js) 0.13.4 (BSD-2-Clause) for move generation and rules |
