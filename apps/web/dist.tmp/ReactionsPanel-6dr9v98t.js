import {
  d,
  h,
  _,
  A,
  T,
  $,
  beginHeavyAnimation,
  reducedMotion,
  Icon,
  IconButton,
  StickerView,
  u,
  catalogFor,
  quickReactions
} from "./main-s48bdnny.js";
import {
  emojiKey
} from "./main-p1twxvxz.js";
import {
  EMOJI,
  searchEmoji
} from "./main-08q0j2r0.js";

// apps/web/src/reactionsPanelModel.ts
var PANEL_W = 382;
var PANEL_H = 420;
var PANEL_MARGIN = 8;
var TOP_COUNT = 16;
function panelSections(catalog, quick, opts) {
  const ok = opts.allowed ? new Set(opts.allowed.map(emojiKey)) : null;
  const pool = ok ? catalog.filter((r) => ok.has(r.key)) : catalog;
  const byKey = new Map(pool.map((r) => [r.key, r]));
  const q = (opts.q ?? "").trim().toLowerCase();
  if (opts.category) {
    const want = new Set(opts.category.map(emojiKey));
    return [{ items: pool.filter((r) => want.has(r.key)) }];
  }
  if (q) {
    const hit = new Set((opts.found ?? []).map(emojiKey));
    return [{ items: pool.filter((r) => hit.has(r.key) || r.title.toLowerCase().includes(q)) }];
  }
  const top = [];
  for (const k of quick) {
    const r = byKey.get(k);
    if (r && !top.includes(r) && top.length < TOP_COUNT)
      top.push(r);
  }
  const rest = pool.filter((r) => !top.includes(r));
  if (ok)
    return [{ items: [...top, ...rest] }];
  return rest.length ? [{ items: top }, { title: "Часто используемые", items: rest }] : [{ items: top }];
}
function panelPosition(bar, vw, vh, w = PANEL_W, h = PANEL_H) {
  const narrow = vw < w + 2 * PANEL_MARGIN;
  const width = narrow ? vw - 2 * PANEL_MARGIN : w;
  let left = narrow ? PANEL_MARGIN : bar.left - 10.5;
  let top = bar.top - 60.5;
  left = Math.max(PANEL_MARGIN, Math.min(left, vw - width - PANEL_MARGIN));
  top = Math.max(PANEL_MARGIN, Math.min(top, vh - h - PANEL_MARGIN));
  return { left: Math.round(left), top: Math.round(top), width };
}
function moveFocus(i, key, cols, n) {
  if (!n)
    return -1;
  let j = i;
  if (key === "ArrowRight")
    j = i + 1;
  else if (key === "ArrowLeft")
    j = i - 1;
  else if (key === "ArrowDown")
    j = i + cols;
  else if (key === "ArrowUp")
    j = i - cols;
  else
    return i;
  return Math.max(0, Math.min(n - 1, j));
}

// apps/web/src/ui/ReactionsPanel.tsx
var coarse = () => {
  try {
    return matchMedia("(pointer: coarse)").matches;
  } catch {
    return false;
  }
};
function ReactionsPanel({ bar, allowed, selected, animated, onPick, onClose }) {
  const [q, setQ] = d("");
  const [cat, setCat] = d(null);
  const [replay, setReplay] = d({});
  const root = A(null);
  const input = A(null);
  const catalog = T(() => catalogFor(allowed), [allowed]);
  const quick = T(() => quickReactions(allowed, 32), [allowed]);
  const limited = !!allowed;
  const sections = T(() => panelSections(catalog, quick, {
    allowed,
    q: limited ? "" : q,
    category: !limited && cat != null ? EMOJI[cat].list : null,
    found: q ? searchEmoji(q) : null
  }), [catalog, quick, allowed, q, cat, limited]);
  const pos = panelPosition(bar, document.documentElement.clientWidth, window.innerHeight);
  const cells = sections.flatMap((s) => s.items);
  h(() => {
    const end = beginHeavyAnimation(200);
    if (!coarse() && !limited)
      input.current?.focus();
    return end;
  }, []);
  _(() => {
    root.current?.style.setProperty("--rpanel-h", limited ? "auto" : PANEL_H + "px");
  }, [limited]);
  h(() => {
    const onEsc = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onEsc, true);
    return () => window.removeEventListener("keydown", onEsc, true);
  }, [onClose]);
  const onKey = (e) => {
    if (!e.key.startsWith("Arrow"))
      return;
    const btns = [...root.current?.querySelectorAll(".app-rpanel-cell") ?? []];
    if (!btns.length)
      return;
    const fromInput = e.target === input.current;
    if (fromInput && e.key !== "ArrowDown")
      return;
    const top0 = btns[0].offsetTop;
    const cols = Math.max(1, btns.filter((b) => b.offsetTop === top0).length);
    const i = fromInput ? -1 : btns.indexOf(document.activeElement);
    const j = fromInput ? 0 : moveFocus(i < 0 ? 0 : i, e.key, cols, btns.length);
    if (j >= 0) {
      e.preventDefault();
      btns[j].focus();
    }
  };
  const cell = (r) => /* @__PURE__ */ u("button", {
    type: "button",
    class: "app-rpanel-cell" + (selected === r.key ? " is-on" : ""),
    title: r.title,
    "aria-label": "Реакция " + r.title,
    "aria-pressed": selected === r.key,
    onClick: () => onPick(r.key),
    onMouseEnter: () => {
      if (animated && r.select)
        setReplay((m) => ({ ...m, [r.key]: (m[r.key] ?? 0) + 1 }));
    },
    children: [
      animated && r.select ? /* @__PURE__ */ u(StickerView, {
        src: r.select,
        w: 512,
        h: 512,
        size: 36,
        group: "menu",
        loop: false,
        play: !reducedMotion(),
        replay: replay[r.key]
      }, undefined, false, undefined, this) : null,
      r.static ? /* @__PURE__ */ u("img", {
        src: r.static,
        alt: "",
        draggable: false,
        decoding: "async",
        onLoad: (e) => e.currentTarget.classList.add("is-loaded")
      }, undefined, false, undefined, this) : /* @__PURE__ */ u("span", {
        children: r.key
      }, undefined, false, undefined, this),
      r.silhouette ? /* @__PURE__ */ u("i", {
        class: "app-rpanel-sil",
        "aria-hidden": "true",
        style: { WebkitMaskImage: `url(${r.silhouette})`, maskImage: `url(${r.silhouette})` }
      }, undefined, false, undefined, this) : null
    ]
  }, r.key, true, undefined, this);
  return $(/* @__PURE__ */ u("div", {
    class: "rl app-rpanel-root",
    onKeyDown: onKey,
    children: [
      /* @__PURE__ */ u("div", {
        class: "rl-pop-scrim",
        onClick: onClose,
        onContextMenu: (e) => {
          e.preventDefault();
          onClose();
        }
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u("div", {
        ref: root,
        class: "app-sym app-rpanel" + (limited ? " is-shrink" : ""),
        role: "dialog",
        "aria-modal": "true",
        "aria-label": "Реакции",
        "data-esc-layer": true,
        style: { left: pos.left + "px", top: pos.top + "px", width: pos.width + "px" },
        children: [
          !limited ? /* @__PURE__ */ u("div", {
            class: "app-sym-search" + (q ? " is-typing" : ""),
            children: [
              cat != null ? /* @__PURE__ */ u("button", {
                type: "button",
                class: "app-sym-search-icon is-back",
                "aria-label": "Назад",
                onClick: () => setCat(null),
                children: /* @__PURE__ */ u(Icon, {
                  name: "arrowLeft",
                  size: 20
                }, undefined, false, undefined, this)
              }, undefined, false, undefined, this) : /* @__PURE__ */ u("span", {
                class: "app-sym-search-icon",
                "aria-hidden": "true",
                children: /* @__PURE__ */ u(Icon, {
                  name: "search",
                  size: 20
                }, undefined, false, undefined, this)
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u("input", {
                ref: input,
                type: "text",
                placeholder: "Поиск",
                value: q,
                "aria-label": "Поиск реакций",
                onInput: (e) => {
                  setCat(null);
                  setQ(e.target.value);
                }
              }, undefined, false, undefined, this),
              q ? /* @__PURE__ */ u(IconButton, {
                icon: "close",
                label: "Очистить",
                size: 18,
                onClick: () => setQ("")
              }, undefined, false, undefined, this) : /* @__PURE__ */ u("div", {
                class: "app-sym-chips",
                children: EMOJI.map((c, i) => /* @__PURE__ */ u("button", {
                  type: "button",
                  class: "app-sym-chip" + (cat === i ? " is-on" : ""),
                  "aria-label": c.title,
                  title: c.title,
                  onClick: () => setCat(cat === i ? null : i),
                  children: /* @__PURE__ */ u(Icon, {
                    name: c.icon,
                    size: 20
                  }, undefined, false, undefined, this)
                }, c.id, false, undefined, this))
              }, undefined, false, undefined, this)
            ]
          }, undefined, true, undefined, this) : null,
          /* @__PURE__ */ u("div", {
            class: "app-rpanel-body",
            children: cells.length ? sections.map((s, i) => /* @__PURE__ */ u("section", {
              class: "app-rpanel-sec",
              children: [
                s.title ? /* @__PURE__ */ u("h4", {
                  children: s.title
                }, undefined, false, undefined, this) : null,
                /* @__PURE__ */ u("div", {
                  class: "app-emoji-grid",
                  children: s.items.map(cell)
                }, undefined, false, undefined, this)
              ]
            }, i, true, undefined, this)) : /* @__PURE__ */ u("p", {
              class: "app-sym-empty",
              children: "Ничего не найдено"
            }, undefined, false, undefined, this)
          }, undefined, false, undefined, this)
        ]
      }, undefined, true, undefined, this)
    ]
  }, undefined, true, undefined, this), document.body);
}
export {
  ReactionsPanel
};

//# debugId=944E9F358884218364756E2164756E21
//# sourceMappingURL=ReactionsPanel-6dr9v98t.js.map
