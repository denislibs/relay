import {
  R,
  setStickerGroupExclusive,
  stickerGroupExclusive,
  StickerView,
  u
} from "./main-s48bdnny.js";

// apps/web/src/ui/stickers/StickerPreview.tsx
var HOLD_MS = 125;
var SIZE = 360;
var known = new Map;
var host = null;
var shown = null;
var prevGroup = null;
function show(s) {
  if (shown?.id === s?.id)
    return;
  shown = s;
  host ??= Object.assign(document.createElement("div"), { className: "app-stkview-host" });
  if (!host.isConnected)
    document.body.append(host);
  R(s ? /* @__PURE__ */ u("div", {
    class: "app-stkview",
    role: "dialog",
    "aria-label": "Стикер " + s.emoji,
    children: /* @__PURE__ */ u("div", {
      class: "app-stkview-card",
      children: [
        /* @__PURE__ */ u(StickerView, {
          src: s.url,
          outline: s.outline,
          w: s.w,
          h: s.h,
          size: SIZE,
          group: "preview",
          loop: true
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u("div", {
          class: "app-stkview-emoji",
          children: s.emoji
        }, undefined, false, undefined, this)
      ]
    }, s.id, true, undefined, this)
  }, undefined, false, undefined, this) : null, host);
}
function start(e, s) {
  if (e.button !== 0)
    return;
  let opened = false;
  const timer = setTimeout(() => {
    opened = true;
    prevGroup = stickerGroupExclusive();
    setStickerGroupExclusive("preview");
    show(s);
  }, HOLD_MS);
  const move = (ev) => {
    if (!opened)
      return;
    const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest("[data-stk]");
    const next = el ? known.get(el.dataset.stk) : null;
    if (next)
      show(next);
  };
  const end = () => {
    clearTimeout(timer);
    removeEventListener("pointermove", move);
    removeEventListener("pointerup", end);
    removeEventListener("pointercancel", end);
    if (!opened)
      return;
    show(null);
    setStickerGroupExclusive(prevGroup);
    const eat = (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
    };
    addEventListener("click", eat, { capture: true, once: true });
    setTimeout(() => removeEventListener("click", eat, { capture: true }), 50);
  };
  addEventListener("pointermove", move);
  addEventListener("pointerup", end);
  addEventListener("pointercancel", end);
}
function StickerPreviewHold({ sticker, children }) {
  const key = String(sticker.id);
  known.set(key, sticker);
  return /* @__PURE__ */ u("div", {
    class: "app-stkhold",
    "data-stk": key,
    onPointerDown: (e) => start(e, sticker),
    onContextMenu: (e) => e.preventDefault(),
    children
  }, undefined, false, undefined, this);
}

export { StickerPreviewHold };

//# debugId=7B2EA4B5F635248064756E2164756E21
//# sourceMappingURL=main-kapbmf3z.js.map
