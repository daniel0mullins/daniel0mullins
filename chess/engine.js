/*
 * A small alpha-beta chess engine that operates on a chess.js game object.
 * Playing strength is throttled to a target ELO by limiting search depth,
 * adding evaluation noise, and occasionally playing a deliberate mistake.
 */

var PIECE_VALUES = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };

// Piece-square tables (from white's perspective, index 0 = a8).
var PST = {
  p: [
     0,  0,  0,  0,  0,  0,  0,  0,
    50, 50, 50, 50, 50, 50, 50, 50,
    10, 10, 20, 30, 30, 20, 10, 10,
     5,  5, 10, 25, 25, 10,  5,  5,
     0,  0,  0, 20, 20,  0,  0,  0,
     5, -5,-10,  0,  0,-10, -5,  5,
     5, 10, 10,-20,-20, 10, 10,  5,
     0,  0,  0,  0,  0,  0,  0,  0
  ],
  n: [
    -50,-40,-30,-30,-30,-30,-40,-50,
    -40,-20,  0,  0,  0,  0,-20,-40,
    -30,  0, 10, 15, 15, 10,  0,-30,
    -30,  5, 15, 20, 20, 15,  5,-30,
    -30,  0, 15, 20, 20, 15,  0,-30,
    -30,  5, 10, 15, 15, 10,  5,-30,
    -40,-20,  0,  5,  5,  0,-20,-40,
    -50,-40,-30,-30,-30,-30,-40,-50
  ],
  b: [
    -20,-10,-10,-10,-10,-10,-10,-20,
    -10,  0,  0,  0,  0,  0,  0,-10,
    -10,  0,  5, 10, 10,  5,  0,-10,
    -10,  5,  5, 10, 10,  5,  5,-10,
    -10,  0, 10, 10, 10, 10,  0,-10,
    -10, 10, 10, 10, 10, 10, 10,-10,
    -10,  5,  0,  0,  0,  0,  5,-10,
    -20,-10,-10,-10,-10,-10,-10,-20
  ],
  r: [
     0,  0,  0,  0,  0,  0,  0,  0,
     5, 10, 10, 10, 10, 10, 10,  5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
     0,  0,  0,  5,  5,  0,  0,  0
  ],
  q: [
    -20,-10,-10, -5, -5,-10,-10,-20,
    -10,  0,  0,  0,  0,  0,  0,-10,
    -10,  0,  5,  5,  5,  5,  0,-10,
     -5,  0,  5,  5,  5,  5,  0, -5,
      0,  0,  5,  5,  5,  5,  0, -5,
    -10,  5,  5,  5,  5,  5,  0,-10,
    -10,  0,  5,  0,  0,  0,  0,-10,
    -20,-10,-10, -5, -5,-10,-10,-20
  ],
  k: [
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -20,-30,-30,-40,-40,-30,-30,-20,
    -10,-20,-20,-20,-20,-20,-20,-10,
     20, 20,  0,  0,  0,  0, 20, 20,
     20, 30, 10,  0,  0, 10, 30, 20
  ],
  kEnd: [
    -50,-40,-30,-20,-20,-30,-40,-50,
    -30,-20,-10,  0,  0,-10,-20,-30,
    -30,-10, 20, 30, 30, 20,-10,-30,
    -30,-10, 30, 40, 40, 30,-10,-30,
    -30,-10, 30, 40, 40, 30,-10,-30,
    -30,-10, 20, 30, 30, 20,-10,-30,
    -30,-30,  0,  0,  0,  0,-30,-30,
    -50,-30,-30,-30,-30,-30,-30,-50
  ]
};

// How each ELO level translates into engine behaviour.
//   depth:   maximum search depth (iterative deepening, time-capped)
//   timeMs:  soft time budget for the search
//   noise:   random centipawns added to each root move's score
//   blunder: probability of ignoring the search and playing a random legal move
var LEVELS = {
  400:  { depth: 1, timeMs: 200,  noise: 220, blunder: 0.30 },
  600:  { depth: 1, timeMs: 250,  noise: 140, blunder: 0.20 },
  800:  { depth: 2, timeMs: 350,  noise: 100, blunder: 0.14 },
  1000: { depth: 2, timeMs: 450,  noise: 70,  blunder: 0.09 },
  1200: { depth: 2, timeMs: 600,  noise: 45,  blunder: 0.05 },
  1400: { depth: 3, timeMs: 900,  noise: 30,  blunder: 0.03 },
  1600: { depth: 3, timeMs: 1200, noise: 18,  blunder: 0.015 },
  1800: { depth: 3, timeMs: 1600, noise: 10,  blunder: 0.006 },
  2000: { depth: 4, timeMs: 2200, noise: 5,   blunder: 0 },
  2200: { depth: 4, timeMs: 3000, noise: 0,   blunder: 0 }
};

var MATE = 100000;

function isEndgame(board) {
  var queens = 0, minors = 0;
  for (var r = 0; r < 8; r++) {
    for (var f = 0; f < 8; f++) {
      var p = board[r][f];
      if (!p) continue;
      if (p.type === 'q') queens++;
      if (p.type === 'n' || p.type === 'b' || p.type === 'r') minors++;
    }
  }
  return queens === 0 || minors <= 2;
}

// Static evaluation in centipawns, positive = good for the side to move.
function evaluate(game) {
  var board = game.board();
  var endgame = isEndgame(board);
  var score = 0;
  for (var r = 0; r < 8; r++) {
    for (var f = 0; f < 8; f++) {
      var p = board[r][f];
      if (!p) continue;
      var idx = r * 8 + f;
      var table = (p.type === 'k' && endgame) ? PST.kEnd : PST[p.type];
      var pst = p.color === 'w' ? table[idx] : table[63 - idx];
      var val = PIECE_VALUES[p.type] + pst;
      score += p.color === 'w' ? val : -val;
    }
  }
  return game.turn() === 'w' ? score : -score;
}

function orderMoves(moves) {
  // Captures first, most valuable victim / least valuable attacker.
  moves.sort(function (a, b) {
    var sa = a.captured ? 10 * PIECE_VALUES[a.captured] - PIECE_VALUES[a.piece] : 0;
    var sb = b.captured ? 10 * PIECE_VALUES[b.captured] - PIECE_VALUES[b.piece] : 0;
    if (a.promotion) sa += 800;
    if (b.promotion) sb += 800;
    return sb - sa;
  });
  return moves;
}

// True once the search has run past its time budget. Checked cheaply, every
// 256 nodes, so a long search can always be cut short mid-way.
function outOfTime(state) {
  if (state.aborted) return true;
  if ((++state.nodes & 255) === 0 && Date.now() > state.deadline) {
    state.aborted = true;
  }
  return state.aborted;
}

// Quiescence search: only explore captures so leaf evals are tactically stable.
function quiesce(game, alpha, beta, depth, state) {
  if (outOfTime(state)) return alpha;

  var all = game.moves({ verbose: true });
  if (all.length === 0) return game.in_check() ? -MATE + state.ply : 0;

  var stand = evaluate(game);
  if (depth <= 0) return stand;
  if (stand >= beta) return beta;
  if (stand > alpha) alpha = stand;

  var best = stand;
  var moves = orderMoves(all.filter(function (m) { return m.captured; }));
  for (var i = 0; i < moves.length; i++) {
    game.move(moves[i]);
    var score = -quiesce(game, -beta, -alpha, depth - 1, state);
    game.undo();
    if (score > best) best = score;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}

function search(game, depth, alpha, beta, state) {
  if (outOfTime(state)) return alpha;

  if (depth <= 0) return quiesce(game, alpha, beta, 5, state);

  // Generate once and infer terminal states from the move list: chess.js's
  // in_checkmate()/in_stalemate()/in_draw() each regenerate every move, which
  // would dominate the search cost if called at every node.
  var moves = game.moves({ verbose: true });
  if (moves.length === 0) return game.in_check() ? -MATE + state.ply : 0;

  orderMoves(moves);
  var best = -Infinity;
  for (var i = 0; i < moves.length; i++) {
    game.move(moves[i]);
    state.ply++;
    var score = -search(game, depth - 1, -beta, -alpha, state);
    state.ply--;
    game.undo();
    if (state.aborted) return best === -Infinity ? alpha : best;
    // Fail-soft: return the true best score, not the alpha/beta bound. The
    // root compares these scores directly, so bounds would make distinct
    // moves look equal.
    if (score > best) best = score;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}

/*
 * Pick a move for the side to move at the given ELO level.
 * Returns a verbose move object from chess.js, or null if no legal moves.
 */
function pickMove(game, elo) {
  var cfg = LEVELS[elo] || LEVELS[1200];
  var moves = game.moves({ verbose: true });
  if (moves.length === 0) return null;
  if (moves.length === 1) return moves[0];

  // Deliberate mistake: low-rated play sometimes ignores the search entirely.
  if (Math.random() < cfg.blunder) {
    return moves[Math.floor(Math.random() * moves.length)];
  }

  var deadline = Date.now() + cfg.timeMs;
  var bestScores = null;

  // Iterative deepening; keep results from the last fully completed depth.
  for (var depth = 1; depth <= cfg.depth; depth++) {
    var state = { nodes: 0, ply: 0, deadline: deadline, aborted: false };
    var scores = [];
    var ordered = orderMoves(moves.slice());
    for (var i = 0; i < ordered.length; i++) {
      game.move(ordered[i]);
      state.ply = 1;
      // Every root move gets a full window so its score is exact. A narrowed
      // window would clamp inferior moves to the current best score, and the
      // handicap noise below would then pick between them at random.
      var score;
      if (game.in_draw() || game.in_threefold_repetition()) {
        // The deep search skips draw detection for speed, so score draws here —
        // otherwise a winning engine happily shuffles into a repetition.
        score = 0;
      } else {
        score = -search(game, depth - 1, -Infinity, Infinity, state);
      }
      game.undo();
      if (state.aborted) break;
      scores.push({ move: ordered[i], score: score });
    }
    if (!state.aborted && scores.length === ordered.length) {
      bestScores = scores;
    }
    if (state.aborted || Date.now() > deadline) break;
  }

  if (!bestScores) {
    // Time ran out before depth 1 finished (shouldn't happen) — random move.
    return moves[Math.floor(Math.random() * moves.length)];
  }

  // Add per-move noise so weaker levels pick "good enough" rather than best.
  var best = null, bestVal = -Infinity;
  for (var j = 0; j < bestScores.length; j++) {
    var noisy = bestScores[j].score + (Math.random() * 2 - 1) * cfg.noise;
    if (noisy > bestVal) {
      bestVal = noisy;
      best = bestScores[j].move;
    }
  }
  return best;
}

export { pickMove };
export const levels = Object.keys(LEVELS)
  .map(Number)
  .sort(function (a, b) { return a - b; });
