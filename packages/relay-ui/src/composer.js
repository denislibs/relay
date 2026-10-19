// Поле ввода сообщения. Устроено по образцу Telegram Web (поведение, не код):
//  • contenteditable, источник правды — DOM; значение { text, entities } читается одним обходом (richtext.js);
//  • высота растёт плавно: меряем естественную высоту редактора, анимируем коробку вокруг (длительность ~ ln Δh);
//  • Enter / ⌘↵ по настройке, Shift+Enter — перевод строки, на телефоне Enter — всегда перевод строки, IME не мешаем;
//  • ↑ в пустом поле — править последнее своё, ⌘↑/⌘↓ — выбрать, на что отвечать; Esc — сначала ближайшее (панель, подсказки, ответ);
//  • оформление: ⌘B/I/U, ⌘⇧X зачёркнутый, ⌘⇧M моноширинный, ⌘⇧P скрытый, ⌘K ссылка; панель над выделением;
//  • вставка: HTML разбирается отдельно и сверяется с простым текстом; в поле попадает только наш HTML;
//  • правки оформления и вставки идут командой редактирования — ⌘Z их отменяет.
import { h } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { cx, Icon, IconButton, Presence, ReplyQuote, reducedMotion, ripple } from './kit.js';
import { AttachMenu, MentionList, Menu } from './more.js';
import { peakHub, RecordBar, voiceSession } from './media/recording.js';
import { startVoice } from './media/voiceRecorder.js';
import { RoundRecorderView } from './media/roundView.js';
import { requestMeasure, requestMutation } from './schedule.js';
import { covers, emptyValue, readDom, replaceContent, safeUrl, setSelection, splice, toggleFormat, toHtml, trimValue, valueFromClipboard } from './richtext.js';

var TOOLBAR = [
  { type: 'bold', icon: 'bold', label: 'Жирный', keys: '⌘B' },
  { type: 'italic', icon: 'italic', label: 'Курсив', keys: '⌘I' },
  { type: 'underline', icon: 'underline', label: 'Подчёркнутый', keys: '⌘U' },
  { type: 'strike', icon: 'strike', label: 'Зачёркнутый', keys: '⌘⇧X' },
  { type: 'code', icon: 'mono', label: 'Моноширинный', keys: '⌘⇧M' },
  { type: 'spoiler', icon: 'spoiler', label: 'Скрытый', keys: '⌘⇧P' },
];

function isTouchOnly() {
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches && !matchMedia('(hover: hover)').matches;
}
function selIn(el) {
  var sel = el.ownerDocument.getSelection();
  return sel && sel.rangeCount && el.contains(sel.anchorNode) && el.contains(sel.focusNode) ? sel : null;
}
function isTextTarget(t) {
  return !!(t && t.closest && t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'));
}

function Composer(props) {
  var editRef = useRef(null), boxRef = useRef(null), wrapRef = useRef(null), linkRef = useRef(null), sendRef = useRef(null);
  var info = useState({ empty: true, hasText: false, mention: null, caret: 0 });
  var st = info[0], setSt = info[1];
  var attach = useState(false);
  // как в Telegram Web A: меню вложений открывается наведением на скрепку и закрывается, когда мышь ушла
  // и со скрепки, и с меню (с паузой — чтобы успеть перевести курсор); пальцем — по нажатию
  var hoverT = useRef(null), openedAt = useRef(0);
  function hoverIn(e) {
    if (e && e.pointerType === 'touch') return;
    if (hoverT.current) { clearTimeout(hoverT.current); hoverT.current = null; }
    if (!attach[0]) hoverT.current = setTimeout(function () { hoverT.current = null; openedAt.current = performance.now(); attach[1](true); }, 120);
  }
  function hoverOut() {
    if (hoverT.current) clearTimeout(hoverT.current);
    hoverT.current = setTimeout(function () { hoverT.current = null; attach[1](false); }, 300);
  }
  useEffect(function () { return function () { if (hoverT.current) clearTimeout(hoverT.current); }; }, []);
  var bar = useState(null);          // панель оформления: { x, bottom, active, link, url, s, e, bad }
  var barNow = useRef(null);
  barNow.current = bar[0];           // свежее состояние панели для отложенных обработчиков
  var dismissed = useRef(null);      // упоминание, закрытое Esc, — пока не напечатают другое
  var height = useRef(0), maxH = useRef(0);
  var sending = useRef(false);
  var composing = useRef(false);
  var pointerDown = useRef(false);
  var barTimer = useRef(null);
  var reply = useRef(null);
  if (props.replyTo) reply.current = props.replyTo;   // при закрытии полоса уходит со старым содержимым
  var latest = useRef(props);
  latest.current = props;
  // запись голосового / кружка: { mode, session, limit }
  var rec = useState(null), recNow = useRef(null);
  recNow.current = rec[0];
  var recToken = useRef(0);
  var modeMenu = useState(false);
  var roundView = useState(null);   // { session, closing } — круг живёт чуть дольше записи, чтобы уехать
  var modes = props.recordModes || [];
  var recordMode = modes.indexOf(props.recordMode) >= 0 ? props.recordMode : modes[0] || null;

  /* ---------- высота ---------- */
  function fit(animate) {
    requestMeasure(function () {
      var el = editRef.current, box = boxRef.current;
      if (!el || !box) return;
      if (!maxH.current) maxH.current = parseFloat(getComputedStyle(box).maxHeight) || 240;
      var natural = el.offsetHeight, hgt = Math.min(natural, maxH.current);
      requestMutation(function () {
        var prev = height.current;
        box.classList.toggle('rl-composer-input-over', natural > maxH.current);
        if (hgt === prev) return;
        var d = Math.abs(hgt - prev);
        // как в Telegram: длительность растёт как логарифм перепада — мелкое мгновенно, большое не тянется
        box.style.transitionDuration = animate && prev && d > 1 && !reducedMotion() ? Math.round(Math.min(220, 50 * Math.log(d))) + 'ms' : '0ms';
        box.style.height = hgt + 'px';
        height.current = hgt;
      });
    });
  }

  /* ---------- значение ---------- */
  function sync(animate) {
    var el = editRef.current;
    if (!el) return;
    var sel = selIn(el);
    var v = readDom(el, sel);
    // пустое поле браузер оставляет с <br> или пустым блоком — чистим (иначе плейсхолдер и высота врут);
    // новое выделение сбрасывает «запомненный» стиль набора: стёрли всё — дальше пишем без оформления
    if (!v.text && !composing.current) {
      if (el.firstChild) el.innerHTML = '';
      if (sel) setSelection(el, 0);
    }
    var before = sel ? v.text.slice(0, v.end) : '';
    var m = sel && v.start === v.end ? /(^|\s)@([^\s@]*)$/.exec(before) : null;
    var mention = m ? { q: m[2], at: v.end - m[2].length - 1 } : null;
    if (mention && dismissed.current === mention.at) mention = null; else if (!mention) dismissed.current = null;
    // от трёх строк — кнопка «Открыть полный редактор» (как в Telegram)
    setSt({ empty: !v.text, hasText: !!v.text.trim(), mention: mention, caret: v.end || 0, multi: el.scrollHeight > 64 });
    fit(animate);
    if (latest.current.onChange) latest.current.onChange({ text: v.text, entities: v.entities });
  }

  function setValue(value, opts) {
    var el = editRef.current;
    if (!el) return;
    el.innerHTML = toHtml(value || emptyValue());   // загрузка черновика/правки — не в историю ⌘Z (как в Telegram)
    closeBar();
    if (opts && opts.focus) focusEnd();
    sync(!(opts && opts.instant));
  }
  function focusEnd() {
    var el = editRef.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    var v = readDom(el);
    setSelection(el, v.text.length);
  }

  useLayoutEffect(function () {
    if (props.initialValue) editRef.current.innerHTML = toHtml(props.initialValue);
    sync(false);
  }, []);
  useLayoutEffect(function () {
    if (!props.apiRef) return;
    props.apiRef.current = {
      getValue: function () { return editRef.current ? readDom(editRef.current) : emptyValue(); },
      setValue: setValue,
      focus: function (opts) { if (opts && opts.end) focusEnd(); else if (editRef.current) editRef.current.focus({ preventScroll: true }); },
      element: function () { return editRef.current; },
    };
  });

  /* ---------- отправка ---------- */
  /* ---------- запись ---------- */
  function startRecording(mode) {
    var token = ++recToken.current;
    var p = latest.current;
    if (editRef.current) editRef.current.blur();
    var hub = peakHub();
    var start = mode === 'round' && p.startRound ? p.startRound({ onPeak: hub.emit }) : startVoice({ onPeak: hub.emit }).then(function (r) { return voiceSession(r, hub); });
    start.then(function (session) {
      if (session.kind === 'round') session.onPeak = hub.subscribe;
      // пока ждали разрешения, запись отменили или начали другую — выключаем микрофон/камеру
      if (token !== recToken.current) { session.stop(true); return; }
      rec[1]({ mode: mode, session: session, limit: false });
      if (session.kind === 'round') roundView[1]({ session: session, closing: false });
      if (session.onLimit) session.onLimit(function () { if (recNow.current && recNow.current.session === session) rec[1](Object.assign({}, recNow.current, { limit: true })); });
      if (latest.current.onRecording) latest.current.onRecording(mode);
    }, function (err) {
      if (token !== recToken.current) return;
      if (latest.current.onRecordError) latest.current.onRecordError(err, mode);
    });
  }
  function endRecording(cancel) {
    var r = recNow.current;
    recToken.current++;
    if (!r) return;
    rec[1](null);
    if (latest.current.onRecording) latest.current.onRecording(null);
    if (r.session.kind === 'round') { roundView[1]({ session: r.session, closing: true }); setTimeout(function () { roundView[1](function (v) { return v && v.session === r.session ? null : v; }); }, 300); }
    r.session.stop(cancel).then(function (res) {
      if (cancel || !res) return;
      var cb = r.mode === 'round' ? latest.current.onSendRound : latest.current.onSendVoice;
      if (cb) cb(res);
    }, function (e) { console.warn('record stop', e); });
  }
  // ушли из чата (или поле убрали) посреди записи — запись выбрасываем, как в Telegram
  useEffect(function () { return function () { recToken.current++; var r = recNow.current; if (r) { r.session.stop(true); if (latest.current.onRecording) latest.current.onRecording(null); } }; }, []);
  useEffect(function () { if (recNow.current) endRecording(true); }, [props.chatKey]);

  function send() {
    var el = editRef.current;
    if (recNow.current) { endRecording(false); return; }
    if (!el || sending.current) return;
    var v = trimValue(readDom(el));
    // пусто: обычно — запись голосового; но пересылку можно отправить и без комментария
    if (!v.text && !latest.current.sendEmpty) { if (recordMode && !latest.current.editing) startRecording(recordMode); return; }
    var res = latest.current.onSend ? latest.current.onSend(v) : undefined;
    if (res === false) return;   // вызывающий сам решил, что останется в поле (например, конец правки)
    sending.current = true;
    closeBar();
    var sentText = readDom(el).text, done = false;
    // как в Telegram: текст уходит из поля, когда пузырь уже встаёт в ленту, а не раньше
    function clear() {
      if (done) return;
      done = true;
      requestMutation(function () {
        sending.current = false;
        var cur = readDom(el);
        // успели напечатать дальше — оставить напечатанное после отправленного
        var rest = cur.text.indexOf(sentText) === 0 ? splice(cur, 0, sentText.length, null) : cur.text === sentText ? emptyValue() : cur;
        el.innerHTML = toHtml(rest);
        if (document.activeElement === el) setSelection(el, rest.text.length);
        sync(true);
      });
    }
    Promise.resolve(res).then(clear, clear);
    setTimeout(clear, 150);
  }

  /* ---------- оформление ---------- */
  function format(type, url, range) {
    var el = editRef.current;
    var v = range ? Object.assign(readDom(el), range) : readDom(el, selIn(el));
    if (v.start === v.end) return;
    var next = toggleFormat(v, type, v.start, v.end, url);
    replaceContent(el, next, v.start, v.end);
    sync(false);
    refreshBar(true);
  }

  function closeBar() {
    if (barTimer.current) { clearTimeout(barTimer.current); barTimer.current = null; }
    bar[1](null);
  }
  // панель над выделением: после того как выделение «улеглось» (мышь отпущена, клавиши затихли)
  function refreshBar(now) {
    if (barTimer.current) clearTimeout(barTimer.current);
    barTimer.current = setTimeout(function () {
      barTimer.current = null;
      if (pointerDown.current || isTouchOnly()) return;
      var el = editRef.current, wrap = wrapRef.current;
      if (!el || !wrap) return;
      requestMeasure(function () {
        if (barNow.current && barNow.current.link) return;   // идёт ввод ссылки — панель не трогаем
        var sel = selIn(el);
        if (!sel || sel.isCollapsed) { bar[1](null); return; }
        var v = readDom(el, sel);
        if (v.start === v.end || !v.text.slice(v.start, v.end).trim()) { bar[1](null); return; }
        var r = sel.getRangeAt(0).getBoundingClientRect(), w = wrap.getBoundingClientRect(), box = boxRef.current.getBoundingClientRect();
        // верх выделения может уехать за край прокрученного поля — держим панель над видимой частью
        var top = Math.max(r.top, box.top);
        var half = 160, x = Math.max(half, Math.min(w.width - half, r.left + r.width / 2 - w.left));
        var active = {};
        TOOLBAR.forEach(function (b) { active[b.type] = covers(v, b.type, v.start, v.end); });
        active.link = covers(v, 'link', v.start, v.end);
        var link = v.entities.filter(function (en) { return en.type === 'link' && en.offset <= v.start && en.offset + en.length >= v.end; })[0];
        bar[1]({ x: x, bottom: w.bottom - top + 8, active: active, link: false, url: link ? link.url : '', s: v.start, e: v.end });
      });
    }, now ? 0 : pointerDown.current ? 0 : 160);
  }
  useEffect(function () {
    function onSel() {
      var el = editRef.current;
      if (!el || document.activeElement !== el) return;
      var sel = selIn(el);
      if (!sel || sel.isCollapsed) { if (barNow.current && !barNow.current.link) closeBar(); return; }
      refreshBar(false);
    }
    function down(e) { if (editRef.current && editRef.current.contains(e.target)) pointerDown.current = true; }
    function up() { if (!pointerDown.current) return; pointerDown.current = false; refreshBar(false); }
    document.addEventListener('selectionchange', onSel);
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('pointerup', up, true);
    return function () {
      document.removeEventListener('selectionchange', onSel);
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('pointerup', up, true);
    };
  }, []);
  useEffect(function () {
    if (bar[0] && bar[0].link && linkRef.current) {
      var t = setTimeout(function () { if (linkRef.current) { linkRef.current.focus(); linkRef.current.select(); } }, 60);
      return function () { clearTimeout(t); };
    }
  }, [bar[0] && bar[0].link]);
  function openLink() {
    var el = editRef.current, v = readDom(el, selIn(el));
    if (v.start === v.end) return;
    var link = v.entities.filter(function (en) { return en.type === 'link' && en.offset <= v.start && en.offset + en.length >= v.end; })[0];
    if (barTimer.current) { clearTimeout(barTimer.current); barTimer.current = null; }
    var cur = barNow.current;
    if (!cur) {
      requestMeasure(function () {
        var sel = selIn(el);
        if (!sel) return;
        var r = sel.getRangeAt(0).getBoundingClientRect(), w = wrapRef.current.getBoundingClientRect();
        bar[1]({ x: Math.max(160, Math.min(w.width - 160, r.left + r.width / 2 - w.left)), bottom: w.bottom - r.top + 8, active: {}, link: true, url: link ? link.url : '', s: v.start, e: v.end });
      });
      return;
    }
    bar[1](Object.assign({}, cur, { link: true, url: link ? link.url : '', s: v.start, e: v.end }));
  }
  function applyLink(raw) {
    var b = bar[0];
    if (!b) return;
    var url = raw.trim() ? safeUrl(raw) : null;
    if (raw.trim() && !url) { bar[1](Object.assign({}, b, { bad: (b.bad || 0) + 1 })); return; }
    var el = editRef.current;
    el.focus({ preventScroll: true });
    format('link', url, { start: b.s, end: b.e });
    closeBar();
    setSelection(el, b.e);
  }

  /* ---------- упоминания ---------- */
  var mentionList = st.mention && props.members ? props.members.filter(function (x) { return x.name.toLowerCase().indexOf(st.mention.q.toLowerCase()) >= 0; }).slice(0, 5) : null;
  function pickMention(x) {
    var el = editRef.current, mn = st.mention;
    if (!el || !mn) return;
    el.focus({ preventScroll: true });
    setSelection(el, mn.at, mn.at + mn.q.length + 1);
    document.execCommand('insertText', false, '@' + x.name + ' ');
    sync(true);
  }

  /* ---------- клавиши ---------- */
  function onKeyDown(e) {
    var p = latest.current;
    if (e.isComposing || e.keyCode === 229) return;   // IME подтверждает ввод — не трогаем
    var el = editRef.current, mod = e.metaKey || e.ctrlKey;
    if (e.key === 'Escape') {
      if (bar[0]) { e.preventDefault(); closeBar(); var s = selIn(el); if (s) s.collapseToEnd(); return; }
      if (mentionList && mentionList.length) { e.preventDefault(); dismissed.current = st.mention.at; setSt(Object.assign({}, st, { mention: null })); return; }
      if (p.replyTo && p.onCancelReply) { e.preventDefault(); p.onCancelReply(); }
      return;
    }
    if (mentionList && mentionList.length && (e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) { e.preventDefault(); pickMention(mentionList[0]); return; }
    if (e.key === 'Enter') {
      var sendNow = !isTouchOnly() && (p.sendKey === 'ctrlEnter' ? mod : !e.shiftKey && !mod);
      e.preventDefault();
      if (sendNow) { send(); return; }
      // перевод строки — <br>, а не новый <div> (так значение читается однозначно)
      if (!document.execCommand('insertLineBreak')) document.execCommand('insertHTML', false, '<br>');
      return;
    }
    if (mod && !e.altKey) {
      var code = e.code, type = null;
      if (!e.shiftKey && code === 'KeyB') type = 'bold';
      else if (!e.shiftKey && code === 'KeyI') type = 'italic';
      else if (!e.shiftKey && code === 'KeyU') type = 'underline';
      else if (!e.shiftKey && code === 'KeyK') type = 'link';
      else if (e.shiftKey && code === 'KeyX') type = 'strike';
      else if (e.shiftKey && code === 'KeyM') type = 'code';
      else if (e.shiftKey && code === 'KeyP') type = 'spoiler';
      if (type) {
        var sel = selIn(el);
        if (!sel || sel.isCollapsed) { if (type !== 'bold' && type !== 'italic' && type !== 'underline') e.preventDefault(); return; }   // B/I/U без выделения — браузер включит стиль для набора
        e.preventDefault();
        if (type === 'link') openLink(); else format(type);
        return;
      }
    }
    var empty = !readDom(el).text;
    if (empty && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      if (mod && !e.shiftKey && !e.altKey && p.onReplyNav) { e.preventDefault(); p.onReplyNav(e.key === 'ArrowUp' ? 'older' : 'newer'); return; }
      if (e.key === 'ArrowUp' && !mod && !e.shiftKey && !e.altKey && p.onEditLast) { e.preventDefault(); p.onEditLast(); }
    }
  }

  /* ---------- вставка и перетаскивание текста ---------- */
  function insertValue(val) {
    var el = editRef.current, cur = readDom(el, selIn(el));
    if (!val.text) return;
    if (!val.entities.length && val.text.indexOf('\n') < 0) { document.execCommand('insertText', false, val.text); return; }
    var next = splice(cur, cur.start, cur.end, val);
    replaceContent(el, next, cur.start + val.text.length);
  }
  function onPaste(e) {
    var dt = e.clipboardData;
    if (!dt) return;
    if (dt.files && dt.files.length) return;   // файлы — во вложения (их ловит чат)
    e.preventDefault();
    insertValue(clipboardValue(dt));
    sync(true);
  }
  function onDrop(e) {
    var dt = e.dataTransfer;
    if (!dt || (dt.files && dt.files.length)) return;
    e.preventDefault();
    var el = editRef.current;
    var pt = document.caretRangeFromPoint ? document.caretRangeFromPoint(e.clientX, e.clientY) : null;
    el.focus({ preventScroll: true });
    if (pt && el.contains(pt.startContainer)) { var s = document.getSelection(); s.removeAllRanges(); s.addRange(pt); }
    insertValue(clipboardValue(dt));
    sync(true);
  }

  /* ---------- печать «в никуда» попадает в поле ---------- */
  useEffect(function () {
    if (!props.captureTyping) return;
    function onKey(e) {
      var el = editRef.current;
      if (!el || recNow.current || e.defaultPrevented || e.isComposing || document.activeElement === el) return;
      if (isTextTarget(e.target) || isTextTarget(document.activeElement)) return;
      if (e.altKey || ((e.metaKey || e.ctrlKey) && !(e.code === 'KeyV' && !e.shiftKey))) return;
      if (!(e.metaKey || e.ctrlKey) && (e.key.length !== 1 || e.key === ' ' && document.activeElement && document.activeElement.nodeName === 'BUTTON')) return;
      if (document.querySelector('.rl-scrim, [aria-modal="true"], .rl-msgmenu, .rl-viewer')) return;
      var s = document.getSelection();
      if (s && !s.isCollapsed && !(e.metaKey || e.ctrlKey)) return;   // выделяют текст в ленте — не мешаем
      // фокус переносим прямо в keydown: сам символ браузер вставит уже в поле
      focusEnd();
    }
    window.addEventListener('keydown', onKey);
    return function () { window.removeEventListener('keydown', onKey); };
  }, [props.captureTyping]);

  /* ---------- кнопка: микрофон / отправить / готово ---------- */
  var mode = rec[0] ? 'send' : props.editing ? 'edit' : st.hasText || props.sendEmpty ? 'send' : recordMode === 'round' ? 'round' : recordMode ? 'mic' : 'send';
  var canSwitch = modes.length > 1 && (mode === 'mic' || mode === 'round');
  var pressTimer = useRef(null);
  var ready = useRef(false);
  useEffect(function () { var t = setTimeout(function () { ready.current = true; if (sendRef.current) sendRef.current.setAttribute('data-ready', ''); }, 0); return function () { clearTimeout(t); }; }, []);

  var id = props.id || 'rl-composer';
  var b = bar[0];
  return h('div', { class: cx('rl-composer-wrap', props.className || props.class), ref: wrapRef },
    h(Presence, { show: !!(mentionList && mentionList.length), exitMs: 120 },
      h(MentionList, { items: mentionList || [], onPick: pickMention })),
    h(Presence, { show: attach[0], exitMs: 160 },
      h(AttachMenu, { items: props.attachItems, onPick: function (k) { attach[1](false); if (props.onAttach) props.onAttach(k); }, onMouseEnter: hoverIn, onMouseLeave: hoverOut })),
    h(Presence, { show: !!b, exitMs: 140 }, b ? h('div', {
      class: cx('rl-fmtbar', b.link && 'rl-fmtbar-link', b.bad && 'rl-fmtbar-bad'), 'data-shake': b.bad ? b.bad % 2 : undefined, role: 'toolbar', 'aria-label': 'Оформление',
      style: { left: b.x + 'px', bottom: b.bottom + 'px' },
      onMouseDown: function (e) { if (e.target.nodeName !== 'INPUT') e.preventDefault(); },   // выделение и фокус остаются в поле
    }, b.link ? [
      h(IconButton, { key: 'back', icon: 'arrowLeft', label: 'Назад', size: 20, onClick: function () { bar[1](Object.assign({}, b, { link: false, bad: 0 })); editRef.current.focus({ preventScroll: true }); setSelection(editRef.current, b.s, b.e); } }),
      h('input', { key: 'url', ref: linkRef, class: 'rl-fmtbar-url', type: 'url', placeholder: 'Вставьте ссылку', value: b.url, 'aria-label': 'Адрес ссылки',
        onInput: function (e) { bar[1](Object.assign({}, b, { url: e.target.value, bad: 0 })); },
        onBlur: function (e) { var to = e.relatedTarget; if (!(to && wrapRef.current && wrapRef.current.contains(to))) closeBar(); },
        onKeyDown: function (e) {
          if (e.key === 'Enter') { e.preventDefault(); applyLink(e.target.value); }
          if (e.key === 'Escape') { e.preventDefault(); closeBar(); editRef.current.focus({ preventScroll: true }); setSelection(editRef.current, b.e); }
        } }),
      h(IconButton, { key: 'ok', icon: 'check', label: 'Применить ссылку', size: 20, onClick: function () { applyLink(linkRef.current ? linkRef.current.value : b.url); } }),
    ] : TOOLBAR.map(function (t) {
      return h('button', { key: t.type, type: 'button', class: cx('rl-fmtbtn', b.active[t.type] && 'rl-fmtbtn-on'), 'aria-pressed': String(!!b.active[t.type]), 'aria-label': t.label, title: t.label + ' ' + t.keys,
        onClick: function () { format(t.type); } }, h(Icon, { name: t.icon, size: 20 }));
    }).concat([
      h('span', { key: 'sep', class: 'rl-fmtbar-sep', 'aria-hidden': 'true' }),
      h('button', { key: 'link', type: 'button', class: cx('rl-fmtbtn', b.active.link && 'rl-fmtbtn-on'), 'aria-pressed': String(!!b.active.link), 'aria-label': b.active.link ? 'Убрать ссылку' : 'Ссылка', title: 'Ссылка ⌘K',
        onClick: function () { if (b.active.link) format('link', null); else openLink(); } }, h(Icon, { name: 'link', size: 20 })),
    ])) : null),
    h(Presence, { show: modeMenu[0], exitMs: 140 },
      h('div', { class: 'rl-recmode' },
        h('div', { class: 'rl-recmode-scrim', onClick: function () { modeMenu[1](false); } }),
        h(Menu, { label: 'Тип сообщения', onClose: function () { modeMenu[1](false); }, items: [
          { icon: 'mic', label: 'Голосовое сообщение', onClick: function () { modeMenu[1](false); if (props.onRecordModeChange) props.onRecordModeChange('voice'); } },
          { icon: 'roundVideo', label: 'Видеосообщение', onClick: function () { modeMenu[1](false); if (props.onRecordModeChange) props.onRecordModeChange('round'); } },
        ] }))),
    h('div', { class: cx('rl-composer', rec[0] && 'rl-composer-recording', props.replyTo && 'has-reply') },
      // ответ/редактирование — первой строкой внутри поля, как в Telegram: значок (стрелка или карандаш) цветом автора,
      // цитата, крестик; поле плавно раздвигается по высоте
      h(Presence, { show: !!props.replyTo, exitMs: 180 }, (function () {
        // icon: 'pencil' — правка, 'forward' — пересылка (клик по цитате — её опции), иначе ответ
        var r = reply.current || {}, n = r.tone != null ? r.tone : 5, edit = r.icon === 'pencil', fwd = r.icon === 'forward', link = r.icon === 'link';
        return h('div', { class: cx('rl-composer-reply', fwd && 'rl-composer-reply-fwd'), style: { '--quote-tone': 'var(--peer-' + n + ')' } },
          h('span', { class: 'rl-composer-reply-icon', 'aria-hidden': 'true' }, h(Icon, { name: edit ? 'pencil' : fwd ? 'forward' : link ? 'link' : 'reply', size: 22 })),
          h(ReplyQuote, Object.assign({}, r, { icon: undefined, onCancel: undefined })),
          h(IconButton, { icon: 'close', label: edit ? 'Отменить редактирование' : fwd ? 'Отменить пересылку' : link ? 'Без превью ссылки' : 'Отменить ответ', onClick: props.onCancelReply, class: 'rl-composer-reply-x' }));
      })()),
      roundView[0] ? h(RoundRecorderView, { key: 'round', session: roundView[0].session, closing: roundView[0].closing }) : null,
      rec[0] ? h(RecordBar, { key: 'rec', session: rec[0].session, limitReached: rec[0].limit, forcePaused: rec[0].limit, onDelete: function () { endRecording(true); }, onPaused: props.onRecordPaused }) : null,
      h('div', { class: cx('rl-composer-field', st.empty && 'rl-composer-empty'), hidden: !!rec[0] },
        h(IconButton, { icon: 'attach', label: 'Прикрепить', active: attach[0], class: 'rl-attach-toggle', onClick: function () {
          // наведение уже открыло меню — клик следом не закрывает его
          if (hoverT.current) { clearTimeout(hoverT.current); hoverT.current = null; }
          if (attach[0] && performance.now() - openedAt.current < 500) return;
          openedAt.current = performance.now(); attach[1](!attach[0]);
        }, onMouseEnter: hoverIn, onMouseLeave: hoverOut }),
        props.onExpand ? h(IconButton, { icon: 'expand', label: 'Открыть полный редактор', size: 18, class: cx('rl-composer-expand', st.multi && 'rl-composer-expand-on'), onClick: props.onExpand, tabIndex: st.multi ? undefined : -1 }) : null,
        h('div', { class: 'rl-composer-input', ref: boxRef },
          h('div', {
            id: id, ref: editRef, class: 'rl-composer-editable', contentEditable: props.disabled ? 'false' : 'true',
            role: 'textbox', 'aria-multiline': 'true', 'aria-label': props.placeholder || 'Сообщение', dir: 'auto', translate: 'no', spellcheck: true,
            onInput: function () { sync(true); },
            onKeyDown: onKeyDown,
            onPaste: onPaste,
            onDrop: onDrop,
            onBlur: function (e) { if (!(e.relatedTarget && wrapRef.current && wrapRef.current.contains(e.relatedTarget))) closeBar(); },
            onCompositionStart: function () { composing.current = true; },
            onCompositionEnd: function () { composing.current = false; sync(true); },
          }),
          h('span', { class: 'rl-composer-ph', 'aria-hidden': 'true' }, props.placeholder || 'Сообщение')),
        h(IconButton, { icon: 'smile', label: 'Эмодзи', class: 'rl-emoji-toggle' })),
      h('button', {
        type: 'button', ref: sendRef, class: cx('rl-composer-send', 'rl-send-' + mode), 'aria-label': mode === 'edit' ? 'Сохранить' : mode === 'send' ? 'Отправить' : mode === 'round' ? 'Записать видеосообщение' : 'Записать голосовое',
        onPointerDown: function (e) {
          ripple(e);
          // долгое нажатие пальцем — выбор: голосовое или кружок (мышью — правая кнопка)
          if (canSwitch && e.pointerType === 'touch') pressTimer.current = setTimeout(function () { pressTimer.current = 'fired'; modeMenu[1](true); }, 200);
        },
        onPointerUp: function () { if (pressTimer.current && pressTimer.current !== 'fired') clearTimeout(pressTimer.current); },
        onMouseDown: function (e) { e.preventDefault(); },   // фокус остаётся в поле (клавиатура телефона не прячется)
        onContextMenu: function (e) { if (!canSwitch) return; e.preventDefault(); modeMenu[1](true); },
        onClick: function () { if (pressTimer.current === 'fired') { pressTimer.current = null; return; } send(); },
      },
        h(Icon, { name: 'send', size: 22, class: cx('rl-sendicon', mode === 'send' && 'rl-sendicon-on') }),
        h(Icon, { name: 'mic', size: 22, class: cx('rl-sendicon', mode === 'mic' && 'rl-sendicon-on') }),
        h(Icon, { name: 'roundVideo', size: 22, class: cx('rl-sendicon', mode === 'round' && 'rl-sendicon-on') }),
        h(Icon, { name: 'check', size: 22, class: cx('rl-sendicon', mode === 'edit' && 'rl-sendicon-on') }))));
}

function clipboardValue(dt) {
  return valueFromClipboard(dt.getData('text/html'), dt.getData('text/plain'));
}

export { Composer };
