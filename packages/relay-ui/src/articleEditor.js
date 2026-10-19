// Ядро редактора «статьи» (Tiptap, MIT) — отдельный бандл articleEditor.js: грузится при первом развороте поля ввода,
// основной бандл не растёт. Интерфейс (шапка, панель, меню) — в приложении; здесь только редактор, команды и перевод
// документа Tiptap ⇄ блоки сообщения (protocol/blocks.ts: p, h, ul, ol, quote, code, hr; текст — Entity).
import { Editor, Extension, Mark } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';

/* ---------- спойлер — наша метка (как в обычных сообщениях) ---------- */
var Spoiler = Mark.create({
  name: 'spoiler',
  parseHTML: function () { return [{ tag: 'span[data-spoiler]' }]; },
  renderHTML: function () { return ['span', { 'data-spoiler': '', class: 'rl-ed-spoiler' }, 0]; },
  addCommands: function () { var name = this.name; return { toggleSpoiler: function () { return function (p) { return p.commands.toggleMark(name); }; } }; },
  addKeyboardShortcuts: function () { var self = this; return { 'Mod-p': function () { return self.editor.commands.toggleSpoiler(); } }; },
});

/* ---------- метки Tiptap ⇄ типы оформления сообщений ---------- */
var MARK_TO_TYPE = { bold: 'bold', italic: 'italic', underline: 'underline', strike: 'strike', code: 'code', spoiler: 'spoiler', link: 'link' };
var TYPE_TO_MARK = { bold: 'bold', italic: 'italic', underline: 'underline', strike: 'strike', code: 'code', spoiler: 'spoiler', link: 'link' };

/** Содержимое абзаца/заголовка (узлы text и hardBreak) → { text, entities } (соседние одинаковые метки — одним куском). */
function inlineOf(content) {
  var text = '', ents = [], open = {};
  (content || []).forEach(function (n) {
    var piece = n.type === 'hardBreak' ? '\n' : n.type === 'text' ? n.text || '' : '';
    var marks = n.type === 'text' ? (n.marks || []) : [];
    var now = {};
    marks.forEach(function (m) { var t = MARK_TO_TYPE[m.type]; if (t) now[t + (t === 'link' ? '|' + (m.attrs && m.attrs.href || '') : '')] = { type: t, url: t === 'link' ? m.attrs && m.attrs.href : undefined }; });
    // закрыть метки, которых нет у этого куска
    Object.keys(open).forEach(function (k) { if (!now[k]) { var o = open[k]; if (text.length > o.offset) ents.push(o.url ? { type: o.type, offset: o.offset, length: text.length - o.offset, url: o.url } : { type: o.type, offset: o.offset, length: text.length - o.offset }); delete open[k]; } });
    Object.keys(now).forEach(function (k) { if (!open[k]) open[k] = { type: now[k].type, url: now[k].url, offset: text.length }; });
    text += piece;
  });
  Object.keys(open).forEach(function (k) { var o = open[k]; if (text.length > o.offset) ents.push(o.url ? { type: o.type, offset: o.offset, length: text.length - o.offset, url: o.url } : { type: o.type, offset: o.offset, length: text.length - o.offset }); });
  return ents.length ? { text: text, entities: ents } : { text: text };
}

/** Документ Tiptap (JSON) → блоки. */
export function docToBlocks(doc) {
  function walk(list) {
    var out = [];
    (list || []).forEach(function (n) {
      switch (n.type) {
        case 'paragraph': out.push(Object.assign({ type: 'p' }, inlineOf(n.content))); break;
        case 'heading': out.push(Object.assign({ type: 'h', level: Math.min(3, Math.max(1, (n.attrs && n.attrs.level) || 1)) }, inlineOf(n.content))); break;
        case 'bulletList': out.push({ type: 'ul', items: (n.content || []).map(function (li) { return walk(li.content); }) }); break;
        case 'orderedList': {
          var start = n.attrs && n.attrs.start > 1 ? n.attrs.start : undefined;
          var ol = { type: 'ol', items: (n.content || []).map(function (li) { return walk(li.content); }) };
          if (start) ol.start = start;
          out.push(ol); break;
        }
        case 'blockquote': out.push({ type: 'quote', blocks: walk(n.content) }); break;
        case 'codeBlock': {
          var code = (n.content || []).map(function (t) { return t.text || ''; }).join('');
          var lang = n.attrs && n.attrs.language;
          out.push(lang ? { type: 'code', text: code, lang: lang } : { type: 'code', text: code }); break;
        }
        case 'horizontalRule': out.push({ type: 'hr' }); break;
      }
    });
    return out;
  }
  var blocks = walk(doc && doc.content);
  while (blocks.length && blocks[blocks.length - 1].type === 'p' && !blocks[blocks.length - 1].text) blocks.pop();
  return blocks;
}

/** { text, entities } → содержимое абзаца (куски текста с метками; \n — hardBreak). */
function contentOf(text, entities) {
  if (!text) return undefined;
  var cuts = { 0: true }; cuts[text.length] = true;
  (entities || []).forEach(function (e) { cuts[e.offset] = true; cuts[e.offset + e.length] = true; });
  for (var i = 0; i < text.length; i++) if (text[i] === '\n') { cuts[i] = true; cuts[i + 1] = true; }
  var pts = Object.keys(cuts).map(Number).filter(function (x) { return x >= 0 && x <= text.length; }).sort(function (a, b) { return a - b; });
  var out = [];
  for (var k = 0; k < pts.length - 1; k++) {
    var s = pts[k], f = pts[k + 1], piece = text.slice(s, f);
    if (!piece) continue;
    if (piece === '\n') { out.push({ type: 'hardBreak' }); continue; }
    var marks = (entities || []).filter(function (e) { return e.offset <= s && e.offset + e.length >= f && TYPE_TO_MARK[e.type]; })
      .map(function (e) { return e.type === 'link' ? { type: 'link', attrs: { href: e.url } } : { type: TYPE_TO_MARK[e.type] }; });
    out.push(marks.length ? { type: 'text', text: piece, marks: marks } : { type: 'text', text: piece });
  }
  return out.length ? out : undefined;
}

/** Блоки → документ Tiptap (JSON). */
export function blocksToDoc(blocks) {
  function walk(list) {
    return (list || []).map(function (b) {
      switch (b.type) {
        case 'p': return { type: 'paragraph', content: contentOf(b.text, b.entities) };
        case 'h': return { type: 'heading', attrs: { level: b.level }, content: contentOf(b.text, b.entities) };
        case 'ul': return { type: 'bulletList', content: b.items.map(function (it) { return { type: 'listItem', content: walk(it) }; }) };
        case 'ol': return { type: 'orderedList', attrs: { start: b.start || 1 }, content: b.items.map(function (it) { return { type: 'listItem', content: walk(it) }; }) };
        case 'quote': return { type: 'blockquote', content: walk(b.blocks) };
        case 'code': return { type: 'codeBlock', attrs: { language: b.lang || null }, content: b.text ? [{ type: 'text', text: b.text }] : undefined };
        case 'hr': return { type: 'horizontalRule' };
      }
      return { type: 'paragraph' };
    });
  }
  var content = walk(blocks);
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] };
}

/**
 * Редактор в element. opts: { blocks?, placeholder?, onUpdate(state), onSubmit(), onEscape() }.
 * state: { canUndo, canRedo, empty, active: { h1,h2,h3, ul, ol, quote, code, bold, italic, link } }.
 */
export function createArticleEditor(opts) {
  var Keys = Extension.create({
    name: 'relayKeys',
    addKeyboardShortcuts: function () {
      return {};
    },
  });
  var editor = new Editor({
    element: opts.element,
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: { openOnClick: false, autolink: true, protocols: ['http', 'https', 'mailto', 'tg'] }, trailingNode: false }),
      Placeholder.configure({ placeholder: opts.placeholder || 'Сообщение' }),
      Spoiler, Keys,
    ],
    content: blocksToDoc(opts.blocks || []),
    autofocus: 'end',
    // Esc и Ctrl/Cmd+Enter — здесь и только здесь: дальше по странице не всплывают (Esc не закроет чат)
    editorProps: { handleKeyDown: function (_view, e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (opts.onEscape) opts.onEscape(); return true; }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); if (opts.onSubmit) opts.onSubmit(); return true; }
      return false;
    }, attributes: { class: 'rl-ed', spellcheck: 'true', 'aria-label': 'Статья', 'aria-multiline': 'true', role: 'textbox' } },
  });
  function state() {
    var e = editor;
    return {
      canUndo: e.can().undo(), canRedo: e.can().redo(), empty: e.isEmpty,
      active: { h1: e.isActive('heading', { level: 1 }), h2: e.isActive('heading', { level: 2 }), h3: e.isActive('heading', { level: 3 }),
        ul: e.isActive('bulletList'), ol: e.isActive('orderedList'), quote: e.isActive('blockquote'), code: e.isActive('codeBlock'),
        bold: e.isActive('bold'), italic: e.isActive('italic'), link: e.isActive('link') },
    };
  }
  var emit = function () { if (opts.onUpdate) opts.onUpdate(state()); };
  editor.on('transaction', emit);
  emit();
  var chain = function () { return editor.chain().focus(); };
  return {
    getBlocks: function () { return docToBlocks(editor.getJSON()); },
    setBlocks: function (b) { editor.commands.setContent(blocksToDoc(b), { emitUpdate: false }); },
    state: state,
    focus: function () { editor.commands.focus(); },
    heading: function (level) { chain().toggleHeading({ level: level }).run(); },
    paragraph: function () { chain().setParagraph().run(); },
    bulletList: function () { chain().toggleBulletList().run(); },
    orderedList: function () { chain().toggleOrderedList().run(); },
    quote: function () { chain().toggleBlockquote().run(); },
    codeBlock: function () { chain().toggleCodeBlock().run(); },
    divider: function () { chain().setHorizontalRule().run(); },
    /** Ссылка: с выделением — на выделенное; без — вставить text со ссылкой. */
    link: function (url, text) {
      if (!url) { chain().unsetLink().run(); return; }
      if (editor.state.selection.empty && text) chain().insertContent({ type: 'text', text: text, marks: [{ type: 'link', attrs: { href: url } }] }).run();
      else chain().extendMarkRange('link').setLink({ href: url }).run();
    },
    undo: function () { chain().undo().run(); },
    redo: function () { chain().redo().run(); },
    destroy: function () { editor.destroy(); },
  };
}
