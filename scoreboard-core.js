/* =========================================================================
 * scoreboard-core.js
 * control.html / display.html が共有する状態管理ロジック。
 *
 * 同期方式:
 *   状態は localStorage(キー: scoreboard_state_v1)に JSON で保存する。
 *   OBS の複数ブラウザソースは同一の CEF(内蔵 Chromium)ストレージ領域を
 *   共有するため、control.html と display.html をそれぞれ別のブラウザソースと
 *   して OBS に追加すれば、localStorage 経由で自動的に同期される。
 *   display.html 側は storage イベント + ポーリング(500ms)の両方で
 *   変化を検知する。
 * ========================================================================= */

/* ストレージキー。データモデルに破壊的変更を入れる場合はここを v2 などに上げる */
var SCOREBOARD_STORAGE_KEY = 'scoreboard_state_v1';

/* 利用可能なフォント一覧(Google Fonts から読み込み) */
var SCOREBOARD_FONTS = [
  { label: 'Oswald',       value: "'Oswald',sans-serif" },
  { label: 'Bebas Neue',   value: "'Bebas Neue',sans-serif" },
  { label: 'Anton',        value: "'Anton',sans-serif" },
  { label: 'Russo One',    value: "'Russo One',sans-serif" },
  { label: 'Noto Sans JP', value: "'Noto Sans JP',sans-serif" },
  { label: 'Inter',        value: "'Inter',sans-serif" }
];

/*
 * 対戦フォーマット欄の入力候補。
 * この欄は自由入力で、ここに無い文字列(「Best of 9」「2本先取」など)も
 * そのまま表示できる。以下はドロップダウンに出す候補にすぎない。
 */
var SCOREBOARD_BO_OPTIONS = [
  'BO1', 'BO3', 'BO5', 'BO7', 'BO9',
  'Best of 3', 'Best of 5', 'Best of 7',
  'FT2', 'FT3', 'FT5'
];

/* 表示要素の定義(描画順・ラベル) */
var SCOREBOARD_ELEMENTS = [
  { key: 'p1name',  label: 'P1 名前' },
  { key: 'p2name',  label: 'P2 名前' },
  { key: 'p1score', label: 'P1 スコア' },
  { key: 'p2score', label: 'P2 スコア' },
  { key: 'round',   label: 'ラウンド情報' },
  { key: 'bo',      label: 'フォーマット' }
];

/*
 * 文字の揃え基準。x 座標がどの端を指すかを決める。
 *   left   : x が左端。文字が増えると右へ伸びる
 *   center : x が中心。文字が増えると左右へ均等に伸びる
 *   right  : x が右端。文字が増えると左へ伸びる
 * 右側のプレイヤー名を right にしておくと、長い名前でもバーからはみ出さない。
 */
var SCOREBOARD_ALIGNS = [
  { value: 'left',   label: '左' },
  { value: 'center', label: '中央' },
  { value: 'right',  label: '右' }
];

/* 揃え基準を CSS の translateX 量に変換する */
function scoreboardAlignShift(align) {
  if (align === 'center') return '-50%';
  if (align === 'right')  return '-100%';
  return '0';
}

/* P1/P2 スタイル連動の対象項目(位置とサイズは対象外) */
var SCOREBOARD_STYLE_KEYS = ['font', 'color', 'outline', 'outlineColor', 'widthScale'];

/* 「反対側にコピー」ボタンの対象項目。上記 5 項目 + サイズ(位置 x, y はコピーしない) */
var SCOREBOARD_COPY_KEYS = SCOREBOARD_STYLE_KEYS.concat(['size']);

/* スタイル連動の対応関係(片方を変えるともう片方へ反映) */
var SCOREBOARD_STYLE_PAIRS = { p1name: 'p2name', p2name: 'p1name', p1score: 'p2score', p2score: 'p1score' };

/* 1要素分のデフォルト位置・スタイルを生成する */
function scoreboardDefaultPosition(x, y, size) {
  return {
    x: x,
    y: y,
    size: size,
    visible: true,
    color: '#ffffff',
    outline: 0,
    outlineColor: '#000000',
    font: "'Oswald',sans-serif",
    widthScale: 1,
    align: 'left'
  };
}

/* 状態のデフォルト値。毎回新しいオブジェクトを返す(参照共有を避けるため) */
function scoreboardDefaultState() {
  return {
    bg: null,              // 背景画像の data URL
    canvasW: 1920,
    canvasH: 300,
    p1name: 'PLAYER 1',
    p2name: 'PLAYER 2',
    p1score: 0,
    p2score: 0,
    round: 'ROUND 1',
    bo: 'BO3',
    linkP1P2Style: false,  // P1/P2 スタイル連動トグル
    playerNames: [],       // プレイヤー名の登録リスト(入力補完に使う。表示には出ない)
    sheetSyncUrl: '',      // Google Apps Script WebアプリのURL
    sheetSyncEnabled: false,
    positions: {
      /* 1920x300 キャンバス基準。P1 は左寄り、P2 は右寄り */
      p1name:  scoreboardDefaultPosition(180,  60, 64),
      p2name:  scoreboardDefaultPosition(1240, 60, 64),
      p1score: scoreboardDefaultPosition(820,  40, 96),
      p2score: scoreboardDefaultPosition(1040, 40, 96),
      round:   scoreboardDefaultPosition(860, 180, 32),
      bo:      scoreboardDefaultPosition(880, 230, 28)
    }
  };
}

/* プレーンオブジェクト判定(配列・null を除外) */
function scoreboardIsPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/*
 * ディープマージ。base(デフォルト)を土台に override(保存済み)を重ねる。
 * 将来フィールドが増えても、古い保存データを読み込んだ際に欠損しないようにする。
 */
function scoreboardDeepMerge(base, override) {
  if (!scoreboardIsPlainObject(override)) return base;
  var out = {};
  var k;
  for (k in base) {
    if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k];
  }
  for (k in override) {
    if (!Object.prototype.hasOwnProperty.call(override, k)) continue;
    var ov = override[k];
    if (ov === undefined) continue;
    if (scoreboardIsPlainObject(out[k]) && scoreboardIsPlainObject(ov)) {
      out[k] = scoreboardDeepMerge(out[k], ov);
    } else {
      out[k] = ov;
    }
  }
  return out;
}

/* localStorage から状態を読み込み、デフォルト値とディープマージして返す */
function loadState() {
  var defaults = scoreboardDefaultState();
  var raw = null;
  try {
    raw = localStorage.getItem(SCOREBOARD_STORAGE_KEY);
  } catch (e) {
    /* プライベートモード等で localStorage が使えない場合はデフォルトで動かす */
    return defaults;
  }
  if (!raw) return defaults;
  var parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return defaults;
  }
  return scoreboardDeepMerge(defaults, parsed);
}

/* localStorage へ状態を保存する。保存できたら true */
function saveState(state) {
  try {
    localStorage.setItem(SCOREBOARD_STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch (e) {
    /* 背景画像の data URL が大きすぎて容量超過した場合などにここへ来る */
    console.warn('[scoreboard] 状態の保存に失敗しました:', e);
    return false;
  }
}

/* 保存済み状態を消してデフォルトに戻す(全消し。通常のリセットボタンとは別) */
function clearState() {
  try {
    localStorage.removeItem(SCOREBOARD_STORAGE_KEY);
  } catch (e) { /* noop */ }
}

/* 要素の表示テキストを状態から組み立てる */
function scoreboardTextFor(key, state) {
  switch (key) {
    case 'p1name':  return String(state.p1name);
    case 'p2name':  return String(state.p2name);
    case 'p1score': return String(state.p1score);
    case 'p2score': return String(state.p2score);
    case 'round':   return String(state.round);
    case 'bo':      return String(state.bo);
    default:        return '';
  }
}

/*
 * 要素 DOM(外側 div + 内側 span)へ位置・スタイルを適用する。
 * 外側 div = 位置とフォントサイズ、内側 span = 色・縁取り・横幅スケール。
 * control.html / display.html で共通に使う。
 */
function scoreboardApplyStyle(box, span, pos) {
  box.style.left = pos.x + 'px';
  box.style.top = pos.y + 'px';
  /* x が左端 / 中心 / 右端 のどれを指すかを translateX で表現する */
  box.style.transform = 'translateX(' + scoreboardAlignShift(pos.align) + ')';
  box.style.fontSize = pos.size + 'px';
  box.style.fontFamily = pos.font;
  box.style.display = pos.visible ? 'block' : 'none';

  span.style.color = pos.color;
  span.style.webkitTextStrokeWidth = pos.outline + 'px';
  span.style.webkitTextStrokeColor = pos.outlineColor;
  /* 縁取りが文字を侵食しないよう stroke を先に塗る */
  span.style.paintOrder = 'stroke fill';
  span.style.transform = 'scaleX(' + pos.widthScale + ')';
  span.style.transformOrigin = 'center center';
}

/* スコアのみを 0 に戻す(位置やスタイルは保持) */
function scoreboardResetScores(state) {
  state.p1score = 0;
  state.p2score = 0;
}

/* 0 未満にならないクランプ付きの加算 */
function scoreboardBump(value, delta) {
  var n = Number(value) + delta;
  return n < 0 ? 0 : n;
}
