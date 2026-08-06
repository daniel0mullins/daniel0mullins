import { Chess } from './lib/chess.js';
import { pickMove, levels as ELO_LEVELS } from './engine.js';

// Both colours use the solid (filled) glyph set and are told apart by CSS fill
// and outline. The hollow white glyphs (♔♕♖) read as thin outlines on a board.
var GLYPHS = {
  w: { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' },
  b: { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' }
};

var ELO_HINTS = {
  400:  'Beginner: knows the rules, hangs pieces freely.',
  600:  'Novice: plays reasonable-looking moves, misses most threats.',
  800:  'Casual: punishes obvious blunders, little planning.',
  1000: 'Improving: sees one-move tactics, still drops material.',
  1200: 'Club-level: solid basics, still misses tactics.',
  1400: 'Steady club player: consistent, punishes loose pieces.',
  1600: 'Strong club player: few free gifts, decent tactics.',
  1800: 'Tough: calculates short tactics reliably.',
  2000: 'Expert: deep enough to hurt; mistakes get punished.',
  2200: 'Master-ish: plays the best move it can find, every time.'
};

var FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

var game = null;
var playerColor = 'w';
var elo = 1200;
var orientation = 'w';      // which colour is at the bottom
var selected = null;         // currently selected square
var legalTargets = {};       // square -> move object(s) from the selected square
var lastMove = null;         // { from, to }
var thinking = false;
var gameOver = false;
var pendingPromotion = null;

var el = {};

function $(id) { return document.getElementById(id); }

function init() {
  el.setup = $('setup');
  el.game = $('game');
  el.board = $('board');
  el.status = $('status');
  el.moves = $('moves');
  el.eloInput = $('elo');
  el.eloValue = $('elo-value');
  el.eloHint = $('elo-hint');
  el.promotion = $('promotion');
  el.promotionChoices = $('promotion-choices');
  el.playerTop = $('player-top');
  el.playerBottom = $('player-bottom');
  el.capturedTop = $('captured-top');
  el.capturedBottom = $('captured-bottom');

  el.eloInput.max = String(ELO_LEVELS.length - 1);
  el.eloInput.addEventListener('input', syncElo);
  syncElo();

  var sideChoices = $('side-choices');
  sideChoices.addEventListener('click', function (e) {
    var btn = e.target.closest('.choice');
    if (!btn) return;
    Array.prototype.forEach.call(sideChoices.children, function (c) {
      var on = c === btn;
      c.classList.toggle('selected', on);
      c.setAttribute('aria-checked', on ? 'true' : 'false');
    });
  });

  $('start').addEventListener('click', startGame);
  $('undo').addEventListener('click', undoMove);
  $('flip').addEventListener('click', function () {
    orientation = orientation === 'w' ? 'b' : 'w';
    render();
  });
  $('resign').addEventListener('click', resign);
  $('new-game').addEventListener('click', backToSetup);

  el.board.addEventListener('click', onBoardClick);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      if (pendingPromotion) cancelPromotion();
      else clearSelection();
    }
  });

  buildBoardCells();
}

function syncElo() {
  elo = ELO_LEVELS[Number(el.eloInput.value)];
  el.eloValue.textContent = elo + ' ELO';
  el.eloHint.textContent = ELO_HINTS[elo] || '';
}

function selectedSide() {
  var btn = document.querySelector('#side-choices .choice.selected');
  return btn ? btn.dataset.side : 'w';
}

/* ---------- Board construction ---------- */

function buildBoardCells() {
  el.board.innerHTML = '';
  for (var i = 0; i < 64; i++) {
    var cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'sq';
    cell.appendChild(document.createElement('span'));   // piece glyph
    el.board.appendChild(cell);
  }
}

// Board cells are laid out top-left to bottom-right for the current orientation.
function squareAt(index) {
  var row = Math.floor(index / 8);
  var col = index % 8;
  if (orientation === 'w') {
    return FILES[col] + (8 - row);
  }
  return FILES[7 - col] + (row + 1);
}

/* ---------- Game flow ---------- */

// An optional ?fen=... in the URL starts from a given position instead of the
// initial one, which is handy for practising a specific endgame.
function startingPosition() {
  var fen = new URLSearchParams(window.location.search).get('fen');
  if (!fen) return new Chess();
  var probe = new Chess();
  if (!probe.load(fen)) {
    console.warn('Ignoring invalid ?fen= position:', fen);
    return new Chess();
  }
  return probe;
}

function startGame() {
  var side = selectedSide();
  playerColor = side === 'random' ? (Math.random() < 0.5 ? 'w' : 'b') : side;
  orientation = playerColor;
  game = startingPosition();
  selected = null;
  legalTargets = {};
  lastMove = null;
  gameOver = false;
  thinking = false;

  el.setup.classList.add('hidden');
  el.game.classList.remove('hidden');
  render();

  if (game.turn() !== playerColor) computerMove();
}

function backToSetup() {
  game = null;
  gameOver = false;
  thinking = false;
  cancelPromotion();
  el.game.classList.add('hidden');
  el.setup.classList.remove('hidden');
}

function resign() {
  if (!game || gameOver) return;
  gameOver = true;
  clearSelection();
  render();
  setStatus('You resigned. The computer (' + elo + ') wins.', true);
}

function undoMove() {
  if (!game || thinking) return;
  var history = game.history();
  if (history.length === 0) return;

  // Roll back to the player's previous turn: undo the computer's reply too.
  game.undo();
  if (game.turn() !== playerColor && game.history().length > 0) game.undo();
  // If undoing left the computer on move (player is black, first move undone),
  // step back one more so the player is always the one to move.
  if (game.turn() !== playerColor && game.history().length > 0) game.undo();

  gameOver = false;
  clearSelection();
  lastMove = lastMoveFromHistory();
  render();

  if (game.turn() !== playerColor) computerMove();
}

function lastMoveFromHistory() {
  var h = game.history({ verbose: true });
  if (h.length === 0) return null;
  var m = h[h.length - 1];
  return { from: m.from, to: m.to };
}

/* ---------- Interaction ---------- */

function onBoardClick(e) {
  if (!game || gameOver || thinking || pendingPromotion) return;
  if (game.turn() !== playerColor) return;

  var cell = e.target.closest('.sq');
  if (!cell) return;
  var square = squareAt(Array.prototype.indexOf.call(el.board.children, cell));

  // Completing a move.
  if (selected && legalTargets[square]) {
    var moves = legalTargets[square];
    var promo = moves.filter(function (m) { return m.promotion; });
    if (promo.length > 0) {
      askPromotion(selected, square);
      return;
    }
    applyPlayerMove({ from: selected, to: square });
    return;
  }

  // Selecting / re-selecting a piece.
  var piece = game.get(square);
  if (piece && piece.color === playerColor) {
    selectSquare(square);
  } else {
    clearSelection();
  }
  render();
}

function selectSquare(square) {
  selected = square;
  legalTargets = {};
  game.moves({ square: square, verbose: true }).forEach(function (m) {
    (legalTargets[m.to] = legalTargets[m.to] || []).push(m);
  });
}

function clearSelection() {
  selected = null;
  legalTargets = {};
  if (game) render();
}

function applyPlayerMove(move) {
  var made = game.move({ from: move.from, to: move.to, promotion: move.promotion || 'q' });
  if (!made) return;
  lastMove = { from: made.from, to: made.to };
  selected = null;
  legalTargets = {};
  render();

  if (checkGameOver()) return;
  computerMove();
}

function askPromotion(from, to) {
  pendingPromotion = { from: from, to: to };
  el.promotionChoices.innerHTML = '';
  ['q', 'r', 'b', 'n'].forEach(function (type) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = GLYPHS[playerColor][type];
    btn.style.color = playerColor === 'w' ? '#fff' : '#262421';
    btn.setAttribute('aria-label', { q: 'Queen', r: 'Rook', b: 'Bishop', n: 'Knight' }[type]);
    btn.addEventListener('click', function () {
      var choice = pendingPromotion;
      pendingPromotion = null;
      el.promotion.classList.add('hidden');
      applyPlayerMove({ from: choice.from, to: choice.to, promotion: type });
    });
    el.promotionChoices.appendChild(btn);
  });
  el.promotion.classList.remove('hidden');
}

function cancelPromotion() {
  pendingPromotion = null;
  el.promotion.classList.add('hidden');
}

/* ---------- Computer ---------- */

function computerMove() {
  if (gameOver || !game) return;
  thinking = true;
  setStatus('Computer (' + elo + ') is thinking…');
  updateControls();

  // Let the browser paint the "thinking" state before the search blocks.
  requestAnimationFrame(function () {
    requestAnimationFrame(function () {
      var move = pickMove(game, elo);
      thinking = false;
      if (!move || gameOver || !game) { render(); return; }
      var made = game.move(move);
      lastMove = { from: made.from, to: made.to };
      render();
      checkGameOver();
    });
  });
}

/* ---------- Status ---------- */

function checkGameOver() {
  if (game.in_checkmate()) {
    gameOver = true;
    render();
    var winner = game.turn() === playerColor ? 'Computer (' + elo + ')' : 'You';
    setStatus('Checkmate. ' + winner + ' win' + (winner === 'You' ? '' : 's') + '.', true);
    return true;
  }
  if (game.in_stalemate()) { endDraw('Stalemate — draw.'); return true; }
  if (game.in_threefold_repetition()) { endDraw('Draw by threefold repetition.'); return true; }
  if (game.insufficient_material()) { endDraw('Draw — insufficient material.'); return true; }
  if (game.in_draw()) { endDraw('Draw by the fifty-move rule.'); return true; }
  return false;
}

function endDraw(text) {
  gameOver = true;
  render();
  setStatus(text, true);
}

function setStatus(text, over) {
  el.status.textContent = text;
  el.status.classList.toggle('over', !!over);
}

function normalStatus() {
  if (gameOver || thinking) return;
  var yourTurn = game.turn() === playerColor;
  var check = game.in_check() ? (yourTurn ? 'You are in check. ' : 'Computer is in check. ') : '';
  setStatus(check + (yourTurn ? 'Your move.' : 'Computer to move.'), false);
}

/* ---------- Rendering ---------- */

function render() {
  if (!game) return;
  renderBoard();
  renderMoves();
  renderPlayers();
  updateControls();
  normalStatus();
}

function renderBoard() {
  var checkedKing = null;
  if (game.in_check()) checkedKing = findKing(game.turn());
  var yourTurn = !gameOver && !thinking && game.turn() === playerColor;

  for (var i = 0; i < 64; i++) {
    var cell = el.board.children[i];
    var square = squareAt(i);
    var row = Math.floor(i / 8);
    var col = i % 8;
    var piece = game.get(square);

    cell.className = 'sq' + ((row + col) % 2 ? ' dark' : '');
    if (selected === square) cell.classList.add('selected');
    if (lastMove && (lastMove.from === square || lastMove.to === square)) cell.classList.add('last');
    if (checkedKing === square) cell.classList.add('check');
    if (legalTargets[square]) {
      cell.classList.add('target');
      if (piece || legalTargets[square][0].flags.indexOf('e') !== -1) cell.classList.add('capture');
    }
    if (yourTurn && ((piece && piece.color === playerColor) || legalTargets[square])) {
      cell.classList.add('selectable');
    }

    var glyph = cell.firstChild;
    glyph.className = piece ? 'piece ' + piece.color : 'piece';
    glyph.textContent = piece ? GLYPHS[piece.color][piece.type] : '';
    cell.setAttribute('aria-label', square + (piece ? ': ' + colorName(piece.color) + ' ' + pieceName(piece.type) : ': empty'));

    // Coordinate labels along the outer edges.
    var extras = cell.querySelectorAll('.coord');
    Array.prototype.forEach.call(extras, function (n) { n.remove(); });
    if (row === 7) cell.appendChild(coord('file', square[0]));
    if (col === 0) cell.appendChild(coord('rank', square[1]));
  }
}

function coord(kind, text) {
  var s = document.createElement('span');
  s.className = 'coord ' + kind;
  s.textContent = text;
  return s;
}

function colorName(c) { return c === 'w' ? 'white' : 'black'; }
function pieceName(t) {
  return { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' }[t];
}

function findKing(color) {
  var board = game.board();
  for (var r = 0; r < 8; r++) {
    for (var f = 0; f < 8; f++) {
      var p = board[r][f];
      if (p && p.type === 'k' && p.color === color) return FILES[f] + (8 - r);
    }
  }
  return null;
}

function renderMoves() {
  var history = game.history();
  el.moves.innerHTML = '';
  for (var i = 0; i < history.length; i += 2) {
    var li = document.createElement('li');
    var white = document.createElement('span');
    white.textContent = history[i];
    li.appendChild(white);
    if (history[i + 1]) {
      var black = document.createElement('span');
      black.textContent = history[i + 1];
      li.appendChild(black);
    }
    el.moves.appendChild(li);
  }
  el.moves.parentNode.scrollTop = el.moves.parentNode.scrollHeight;
}

function renderPlayers() {
  var topColor = orientation === 'w' ? 'b' : 'w';
  var bottomColor = topColor === 'w' ? 'b' : 'w';

  label(el.playerTop, topColor, topColor === playerColor);
  label(el.playerBottom, bottomColor, bottomColor === playerColor);

  // Show next to each player the pieces that player has captured.
  var captured = capturedPieces();
  el.capturedTop.textContent = captured[topColor];
  el.capturedBottom.textContent = captured[bottomColor];

  var turn = game.turn();
  el.playerTop.classList.toggle('active', !gameOver && turn === topColor);
  el.playerBottom.classList.toggle('active', !gameOver && turn === bottomColor);
}

function label(node, color, isPlayer) {
  node.classList.toggle('is-black', color === 'b');
  node.querySelector('.player-name').textContent =
    isPlayer ? 'You (' + colorName(color) + ')' : 'Computer ' + elo + ' (' + colorName(color) + ')';
}

// Returns { w: "glyphs black pieces white captured", b: ... }
function capturedPieces() {
  var taken = { w: [], b: [] };
  game.history({ verbose: true }).forEach(function (m) {
    if (!m.captured) return;
    var victimColor = m.color === 'w' ? 'b' : 'w';
    taken[m.color].push(GLYPHS[victimColor][m.captured]);
  });
  return { w: taken.w.join(''), b: taken.b.join('') };
}

function updateControls() {
  var busy = thinking || !game;
  $('undo').disabled = busy || game.history().length === 0;
  $('resign').disabled = busy || gameOver;
  $('flip').disabled = !game;
}

document.addEventListener('DOMContentLoaded', init);
