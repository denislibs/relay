import {
  S,
  d,
  h,
  _,
  A,
  T,
  N,
  requestMeasure,
  requestMutation,
  beginHeavyAnimation,
  onHeavyAnimationEnd,
  MenuPopover,
  reducedMotion,
  Icon,
  IconButton,
  videoObserve,
  EmptyState,
  StickerView,
  confirmModal,
  u,
  loadStickerSet,
  searchSets,
  stickersByEmoji,
  faveSticker,
  clearRecentStickers,
  useMyStickers,
  openStickerSet,
  useSavedGifs,
  removeSavedGif,
  gifSendOptions,
  animatedEmojiUrl,
  useAnimatedEmoji
} from "./main-s48bdnny.js";
import {
  EMOJI,
  emojiTones,
  savedTones,
  saveTone,
  recentEmoji,
  pushRecentEmoji,
  QUICK,
  searchEmoji
} from "./main-08q0j2r0.js";
import {
  StickerPreviewHold
} from "./main-kapbmf3z.js";

// apps/web/src/emojiGroups.ts
var cat = null;
var state = "idle";
var listeners = new Set;
function load() {
  if (state !== "idle")
    return;
  state = "loading";
  fetch("/emoji-groups", { credentials: "include" }).then((r) => r.ok ? r.json() : Promise.reject(new Error(String(r.status)))).then((j) => {
    cat = j;
  }, () => {
    cat = null;
  }).finally(() => {
    state = "done";
    for (const fn of listeners)
      fn();
  });
}
function useEmojiGroups(kind) {
  const [, redraw] = d(0);
  h(() => {
    load();
    const fn = () => redraw((n) => n + 1);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);
  return state === "done" ? cat?.[kind] ?? [] : undefined;
}

// apps/web/src/ui/stickers/emojiImage.tsx
var NATIVE = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
var FADE_MS = 200;
function emojiFile(e) {
  return [...e].map((c) => c.codePointAt(0).toString(16).padStart(4, "0")).filter((h) => h !== "fe0f").join("-");
}
var loaded = new Set;
function EmojiGlyph({ e }) {
  const src = `/emoji/apple/${emojiFile(e)}.png`;
  const [state, setState] = d(() => loaded.has(src) ? "done" : "wait");
  h(() => {
    if (state !== "fade")
      return;
    const t = setTimeout(() => setState("done"), FADE_MS + 50);
    return () => clearTimeout(t);
  }, [state]);
  if (NATIVE || state === "fail")
    return /* @__PURE__ */ u(S, {
      children: e
    }, undefined, false, undefined, this);
  const onLoad = () => {
    loaded.add(src);
    if (state !== "wait")
      return;
    if (reducedMotion())
      setState("done");
    else
      requestAnimationFrame(() => setState("fade"));
  };
  return /* @__PURE__ */ u("span", {
    class: "app-emoji-pic is-" + state,
    children: /* @__PURE__ */ u("img", {
      src,
      alt: e,
      width: 34,
      height: 34,
      loading: "lazy",
      decoding: "async",
      draggable: false,
      onLoad,
      onError: () => setState("fail")
    }, undefined, false, undefined, this)
  }, undefined, false, undefined, this);
}

// apps/web/src/ui/stickers/gifLayout.ts
var GIF_GAP = 3;
var ROW_H = 104;
var MIN_RATIO = 0.6;
var MAX_RATIO = 2.2;
var ratioOf = (g) => Math.min(MAX_RATIO, Math.max(MIN_RATIO, g.w && g.h ? g.w / g.h : 1));
function gifLayout(items, width) {
  const boxes = [];
  if (width <= 0)
    return { boxes, height: 0 };
  let y = 0, row = [], sum = 0;
  const flush = (full) => {
    if (!row.length)
      return;
    const free = width - GIF_GAP * (row.length - 1);
    const h = full ? Math.round(free / sum) : ROW_H;
    let x = 0;
    row.forEach((t, i) => {
      const w = full && i === row.length - 1 ? width - x : Math.round(t.r * h);
      boxes.push({ id: t.g.id, x, y, w, h });
      x += w + GIF_GAP;
    });
    y += h + GIF_GAP;
    row = [];
    sum = 0;
  };
  for (const g of items) {
    const r = ratioOf(g);
    row.push({ g, r });
    sum += r;
    if (sum * ROW_H + GIF_GAP * (row.length - 1) >= width)
      flush(true);
  }
  flush(false);
  return { boxes, height: Math.max(0, y - GIF_GAP) };
}
function gifWindow(boxes, top, bottom, margin) {
  const hi = bottom + margin, lo = top - margin;
  let from = 0;
  while (from < boxes.length && boxes[from].y + boxes[from].h < lo)
    from++;
  let to = from;
  while (to < boxes.length && boxes[to].y <= hi)
    to++;
  return [from, to];
}

// apps/web/src/ui/stickers/GifsTab.tsx
var WINDOW_PX = 300;
var ATTACH_PER_FRAME = 2;
var HOLD_MS = 400;
var SCROLL_QUIET_MS = 120;
var queue = [];
var raf = 0;
var scrolledAt = 0;
function run() {
  raf = 0;
  if (performance.now() - scrolledAt < SCROLL_QUIET_MS) {
    raf = requestAnimationFrame(run);
    return;
  }
  let n = 0;
  while (queue.length && n < ATTACH_PER_FRAME) {
    const j = queue.shift();
    if (j.live) {
      j.fn();
      n++;
    }
  }
  if (queue.length)
    next();
}
function next() {
  onHeavyAnimationEnd(() => {
    if (!raf && queue.length)
      raf = requestAnimationFrame(run);
  });
}
function queueAttach(fn) {
  const job = { fn, live: true };
  queue.push(job);
  next();
  return () => {
    job.live = false;
  };
}
var h264 = null;
var canH264 = () => h264 ??= !!document.createElement("video").canPlayType('video/mp4; codecs="avc1.4D401E"');
var hasLoop = (g) => !!g.variants?.some((v) => v.name === "loop");
function GifTile({ gif, x, y, w, h: h2, active }) {
  const el = A(null), video = A(null);
  const [visible, setVisible] = d(false);
  const [attached, setAttached] = d(false);
  const [still, setStill] = d(false);
  const [drawn, setDrawn] = d(false);
  const [broken, setBroken] = d(false);
  const asVideo = hasLoop(gif) && canH264() && !broken;
  const want = active && visible && !reducedMotion();
  h(() => el.current ? videoObserve(el.current, setVisible) : undefined, []);
  h(() => {
    if (attached || !want)
      return;
    return queueAttach(() => setAttached(true));
  }, [want, attached]);
  h(() => {
    if (want || asVideo || !attached)
      return;
    setAttached(false);
    setDrawn(false);
  }, [want, asVideo, attached]);
  h(() => {
    const v = video.current;
    if (!v)
      return;
    if (want)
      v.play().catch(() => {});
    else
      v.pause();
  }, [want, attached, asVideo]);
  h(() => () => {
    const v = video.current;
    if (v) {
      v.pause();
      v.removeAttribute("src");
      v.load();
    }
  }, []);
  return /* @__PURE__ */ u("button", {
    ref: el,
    type: "button",
    class: "app-gif-tile" + (still ? " has-still" : "") + (drawn ? " is-drawn" : ""),
    "data-gif": gif.id,
    "aria-label": "GIF",
    style: { left: x + "px", top: y + "px", width: w + "px", height: h2 + "px" },
    children: [
      gif.thumb ? /* @__PURE__ */ u("img", {
        class: "app-gif-thumb",
        src: gif.thumb,
        alt: "",
        "aria-hidden": "true",
        draggable: false
      }, undefined, false, undefined, this) : null,
      gif.preview ? /* @__PURE__ */ u("img", {
        class: "app-gif-still",
        src: `/files/${gif.id}/preview`,
        alt: "",
        "aria-hidden": "true",
        decoding: "async",
        fetchpriority: "low",
        draggable: false,
        onLoad: () => setStill(true)
      }, undefined, false, undefined, this) : null,
      attached && asVideo ? /* @__PURE__ */ u("video", {
        ref: video,
        class: "app-gif-anim",
        src: `/files/${gif.id}/loop`,
        muted: true,
        loop: true,
        playsInline: true,
        disablePictureInPicture: true,
        preload: "auto",
        "aria-hidden": "true",
        onLoadedData: () => setDrawn(true),
        onError: () => {
          setBroken(true);
          setDrawn(false);
        }
      }, undefined, false, undefined, this) : attached ? /* @__PURE__ */ u("img", {
        class: "app-gif-anim",
        src: `/files/${gif.id}`,
        alt: "",
        "aria-hidden": "true",
        decoding: "async",
        draggable: false,
        onLoad: () => setDrawn(true)
      }, undefined, false, undefined, this) : null
    ]
  }, undefined, true, undefined, this);
}
var GifTileMemo = N(GifTile);
function GifGrid({ items, active, onPick, onMenu }) {
  const scroller = A(null);
  const [width, setWidth] = d(0);
  const [view, setView] = d([0, 900]);
  const layout = T(() => gifLayout(items, width), [items, width]);
  const byId = T(() => new Map(items.map((g) => [g.id, g])), [items]);
  _(() => {
    const s = scroller.current;
    if (!s)
      return;
    const measure = () => requestMeasure(() => {
      if (!s.clientWidth)
        return;
      const cs = getComputedStyle(s), inner = s.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const top = s.scrollTop, bottom = top + s.clientHeight;
      requestMutation(() => {
        setWidth(inner);
        setView((v) => v[0] === top && v[1] === bottom ? v : [top, bottom]);
      });
    });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(s);
    return () => ro.disconnect();
  }, []);
  const onScroll = () => {
    scrolledAt = performance.now();
    requestMeasure(() => {
      const s = scroller.current;
      if (!s)
        return;
      const top = s.scrollTop, bottom = top + s.clientHeight;
      requestMutation(() => setWindow(top, bottom));
    });
  };
  const shown = A([0, 0]);
  const setWindow = (top, bottom) => {
    const [a, b] = gifWindow(layout.boxes, top, bottom, WINDOW_PX);
    if (a !== shown.current[0] || b !== shown.current[1])
      setView([top, bottom]);
  };
  const [from, to] = gifWindow(layout.boxes, view[0], view[1], WINDOW_PX);
  shown.current = [from, to];
  const tile = (e) => {
    const b = e.target.closest("[data-gif]");
    const g = b && byId.get(b.dataset.gif);
    return g ? { g, b } : null;
  };
  const hold = A(null);
  const cancel = () => {
    if (hold.current)
      clearTimeout(hold.current.timer);
    hold.current = null;
  };
  h(() => cancel, []);
  return /* @__PURE__ */ u("div", {
    class: "app-sym-scroll app-gif-scroll",
    ref: scroller,
    onScroll,
    onClick: (e) => {
      if (hold.current?.fired) {
        hold.current = null;
        return;
      }
      const t = tile(e);
      if (t)
        onPick(t.g);
    },
    onContextMenu: (e) => {
      const t = tile(e);
      if (t) {
        e.preventDefault();
        cancel();
        onMenu(t.g, t.b);
      }
    },
    onPointerDown: (e) => {
      if (e.pointerType === "mouse")
        return;
      const t = tile(e);
      if (!t)
        return;
      cancel();
      const st = { timer: 0, x: e.clientX, y: e.clientY, fired: false };
      st.timer = window.setTimeout(() => {
        st.fired = true;
        onMenu(t.g, t.b);
      }, HOLD_MS);
      hold.current = st;
    },
    onPointerMove: (e) => {
      const st = hold.current;
      if (st && !st.fired && Math.hypot(e.clientX - st.x, e.clientY - st.y) > 8)
        cancel();
    },
    onPointerUp: () => {
      if (hold.current && !hold.current.fired)
        cancel();
    },
    onPointerCancel: cancel,
    children: /* @__PURE__ */ u("div", {
      class: "app-gif-grid",
      style: { height: layout.height + "px" },
      children: layout.boxes.slice(from, to).map((b) => /* @__PURE__ */ u(GifTileMemo, {
        gif: byId.get(b.id),
        x: b.x,
        y: b.y,
        w: b.w,
        h: b.h,
        active
      }, b.id, false, undefined, this))
    }, undefined, false, undefined, this)
  }, undefined, false, undefined, this);
}
function GifsTab({ active, onPick }) {
  const { list, loaded } = useSavedGifs();
  const [menu, setMenu] = d(null);
  h(() => {
    if (!active)
      setMenu(null);
  }, [active]);
  const opts = menu ? gifSendOptions() : null;
  return /* @__PURE__ */ u("div", {
    class: "app-sym-pane",
    children: [
      list.length ? /* @__PURE__ */ u(GifGrid, {
        items: list,
        active,
        onPick,
        onMenu: (g, el) => setMenu({ g, el })
      }, undefined, false, undefined, this) : loaded ? /* @__PURE__ */ u("div", {
        class: "app-gif-empty",
        children: /* @__PURE__ */ u(EmptyState, {
          kind: "gifs",
          title: "Здесь будут ваши GIF",
          text: "Сохраняйте GIF из сообщений: нажмите на GIF правой кнопкой"
        }, undefined, false, undefined, this)
      }, undefined, false, undefined, this) : null,
      /* @__PURE__ */ u(MenuPopover, {
        class: "app-sym-keep",
        open: !!menu,
        anchor: menu?.el ?? null,
        placement: "top-start",
        onClose: () => setMenu(null),
        items: menu && opts ? [
          opts.silent ? { icon: "bellOff", label: "Отправить без звука", onClick: () => onPick(menu.g, { silent: true }) } : null,
          opts.later ? { icon: "calendar", label: opts.laterLabel, onClick: () => onPick(menu.g, { later: true }) } : null,
          { icon: "trash", label: "Удалить из GIF", onClick: () => removeSavedGif(menu.g.id) }
        ].filter(Boolean) : []
      }, undefined, false, undefined, this)
    ]
  }, undefined, true, undefined, this);
}

// apps/web/src/ui/stickers/SymbolMenu.tsx
var TABS = ["emoji", "stickers", "gifs"];
var TAB_KEY = "relay.symbols.tab";
var CLOSE_MS = 180;
var SLIDE_MS = 200;
var EMOJI_COLS = 8;
var EMOJI_ROW = 42;
var STK_COLS = 5;
var STK_ROW = 76;
var PREBUILD_MS = 400;
var UNLOAD_MS = 500;
var WARM_MS = 150;
var WARM_MAX_MS = 1500;
var WARM_STICKERS = 20;
function SymbolMenu2(p) {
  const [tab, setTab] = d(() => {
    try {
      return localStorage.getItem(TAB_KEY) || "emoji";
    } catch {
      return "emoji";
    }
  });
  const [built, setBuilt] = d(() => ({ emoji: tab === "emoji", stickers: tab === "stickers", gifs: tab === "gifs" }));
  const [prep, setPrep] = d(null);
  const [slide, setSlide] = d(null);
  const bodies = A({ emoji: null, stickers: null, gifs: null });
  const [warm, setWarm] = d({ emoji: false, stickers: false, gifs: false });
  h(() => {
    const cold = TABS.filter((t) => built[t] && !warm[t]);
    if (!cold.length)
      return;
    const t0 = performance.now();
    let timer = 0;
    const ready = (t) => {
      const first = [...bodies.current[t]?.querySelectorAll(".rl-sticker") ?? []].slice(0, WARM_STICKERS);
      return !first.some((x) => !x.classList.contains("rl-sticker-ready"));
    };
    const check = () => {
      const done = cold.filter((t) => performance.now() - t0 >= WARM_MAX_MS || ready(t));
      if (done.length)
        setWarm((w) => ({ ...w, ...Object.fromEntries(done.map((k) => [k, true])) }));
      if (done.length < cold.length)
        timer = window.setTimeout(check, WARM_MS);
    };
    timer = window.setTimeout(check, WARM_MS);
    return () => clearTimeout(timer);
  }, [built.emoji, built.stickers, built.gifs]);
  const leaving = A(null);
  const [epoch, setEpoch] = d(0);
  const wasOpen = A(p.open);
  h(() => {
    const closed = wasOpen.current && !p.open;
    wasOpen.current = p.open;
    if (!closed)
      return;
    const t = setTimeout(() => {
      setSlide(null);
      setEpoch((n) => n + 1);
    }, CLOSE_MS + 50);
    return () => clearTimeout(t);
  }, [p.open]);
  h(() => {
    const other = TABS.find((x) => !built[x]);
    if (!p.open || !other)
      return;
    const t = setTimeout(() => setBuilt((b) => b[other] ? b : { ...b, [other]: true }), PREBUILD_MS);
    return () => clearTimeout(t);
  }, [p.open, built.emoji, built.stickers, built.gifs]);
  const pick = (t) => {
    if (t === tab || t === prep)
      return;
    setBuilt((b) => b[t] ? b : { ...b, [t]: true });
    try {
      localStorage.setItem(TAB_KEY, t);
    } catch {}
    if (reducedMotion()) {
      setSlide(null);
      setTab(t);
      return;
    }
    setPrep(t);
  };
  const shift = (t) => TABS.indexOf(t) > TABS.indexOf(tab) ? 100 : -100;
  _(() => {
    const el = prep && bodies.current[prep];
    if (el)
      el.style.zIndex = "-1";
  }, [prep]);
  h(() => {
    if (!prep)
      return;
    let live = true;
    requestMeasure(() => requestMutation(() => {
      if (!live)
        return;
      beginHeavyAnimation(SLIDE_MS + 50);
      const x = shift(prep), opts = { duration: SLIDE_MS, easing: "ease-in-out" };
      const inc = bodies.current[prep], out = bodies.current[tab];
      if (inc) {
        inc.animate([{ transform: `translateX(${x}%)` }, { transform: "none" }], opts);
        inc.style.zIndex = "";
      }
      leaving.current = out ? out.animate([{ transform: "none" }, { transform: `translateX(${-x}%)` }], { ...opts, fill: "forwards" }) : null;
      setSlide({ from: tab });
      setTab(prep);
      setPrep(null);
    }));
    return () => {
      live = false;
    };
  }, [prep]);
  h(() => {
    if (!slide) {
      leaving.current?.cancel();
      leaving.current = null;
      return;
    }
    const t = setTimeout(() => setSlide(null), SLIDE_MS + 30);
    return () => clearTimeout(t);
  }, [slide]);
  const handlers = A(p);
  handlers.current = p;
  const stable = A({ emoji: (e) => handlers.current.onEmoji(e), sticker: (s) => handlers.current.onSticker(s), gif: (g, how) => handlers.current.onGif(g, how), animate: (e) => animatedEmojiUrl(e.replace(/\uFE0F/g, "")) }).current;
  useAnimatedEmoji(p.open);
  const body = (t) => {
    if (!built[t])
      return null;
    const off = t !== tab && t !== prep && t !== slide?.from;
    const hide = off && warm[t];
    return /* @__PURE__ */ u("div", {
      class: "app-sym-body",
      ref: (el) => {
        bodies.current[t] = el;
      },
      "data-off": hide ? "" : undefined,
      "aria-hidden": off || undefined,
      style: off && !warm[t] ? { zIndex: -1 } : undefined,
      children: t === "emoji" ? /* @__PURE__ */ u(EmojiTabMemo, {
        onPick: stable.emoji,
        animate: stable.animate,
        tones: true,
        epoch
      }, undefined, false, undefined, this) : t === "stickers" ? /* @__PURE__ */ u(StickersTabMemo, {
        onPick: stable.sticker,
        epoch
      }, undefined, false, undefined, this) : /* @__PURE__ */ u(GifsTab, {
        active: p.open && tab === "gifs",
        onPick: stable.gif
      }, undefined, false, undefined, this)
    }, t, false, undefined, this);
  };
  return /* @__PURE__ */ u("div", {
    class: "app-sym",
    children: [
      body("emoji"),
      body("stickers"),
      body("gifs"),
      prep || slide ? /* @__PURE__ */ u("div", {
        class: "app-sym-shield"
      }, undefined, false, undefined, this) : null,
      /* @__PURE__ */ u("div", {
        class: "app-sym-bar",
        children: [
          tab === "stickers" ? /* @__PURE__ */ u(IconButton, {
            class: "app-sym-bar-btn app-sym-bar-left",
            icon: "search",
            size: 20,
            label: "Найти стикеры",
            onClick: p.onSearch
          }, undefined, false, undefined, this) : null,
          /* @__PURE__ */ u("div", {
            class: "app-sym-tabs",
            role: "tablist",
            style: { "--sym-at": TABS.indexOf(tab) },
            children: [
              /* @__PURE__ */ u("span", {
                class: "app-sym-tabs-pill",
                "aria-hidden": "true"
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u("button", {
                type: "button",
                role: "tab",
                "aria-selected": tab === "emoji",
                class: "app-sym-tab" + (tab === "emoji" ? " is-on" : ""),
                onClick: () => pick("emoji"),
                children: "Эмодзи"
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u("button", {
                type: "button",
                role: "tab",
                "aria-selected": tab === "stickers",
                class: "app-sym-tab" + (tab === "stickers" ? " is-on" : ""),
                onClick: () => pick("stickers"),
                children: "Стикеры"
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u("button", {
                type: "button",
                role: "tab",
                "aria-selected": tab === "gifs",
                class: "app-sym-tab" + (tab === "gifs" ? " is-on" : ""),
                onClick: () => pick("gifs"),
                children: "GIF"
              }, undefined, false, undefined, this)
            ]
          }, undefined, true, undefined, this),
          tab === "emoji" ? /* @__PURE__ */ u(IconButton, {
            class: "app-sym-bar-btn app-sym-bar-right",
            icon: "backspace",
            size: 20,
            label: "Стереть",
            onClick: p.onBackspace
          }, undefined, false, undefined, this) : null
        ]
      }, undefined, true, undefined, this)
    ]
  }, undefined, true, undefined, this);
}
var SEC_SHOW = "app-sym-show";
var tabOff = (el) => !el || !!el.closest("[data-off]") || !el.getClientRects().length;
var JUMP_PX = 150;
var JUMP_MS = 150;
var easeInOut = (t) => t < 0.5 ? 2 * t * t : 1 - (2 - 2 * t) ** 2 / 2;
function useSections(count) {
  const scroller = A(null);
  const state = A({ active: 0, top: true, subs: new Set, jump: null }).current;
  const set = (active, top) => {
    if (active === state.active && top === state.top)
      return;
    state.active = active;
    state.top = top;
    state.subs.forEach((f) => f());
  };
  const onScroll = () => requestMeasure(() => {
    const el = scroller.current;
    if (!el)
      return;
    const j = state.jump;
    if (j?.anim)
      return;
    if (j && Math.abs(el.scrollTop - j.at) <= 1)
      return;
    state.jump = null;
    const secs = el.querySelectorAll("[data-sec]");
    let cur = 0;
    secs.forEach((s, i) => {
      if (s.offsetTop - el.offsetTop <= el.scrollTop + 8)
        cur = i;
    });
    const atTop = el.scrollTop <= 0;
    requestMutation(() => set(cur, atTop));
  });
  const stop = A(() => {});
  const go = (i) => {
    const el = scroller.current;
    const secs = el?.querySelectorAll("[data-sec]");
    if (!el || !secs?.[i])
      return;
    stop.current();
    const show = (k, fill, n) => secs[k]?.dispatchEvent(new CustomEvent(SEC_SHOW, { detail: { fill, n } }));
    show(i, "head", CHUNK);
    show(i - 1, "tail", CHUNK / 2);
    show(i + 1, "head", CHUNK / 2);
    const jump = { i, at: -1, anim: true };
    state.jump = jump;
    set(i, state.top);
    requestMeasure(() => {
      if (state.jump !== jump)
        return;
      const max = el.scrollHeight - el.clientHeight;
      const to = Math.max(0, Math.min(max, i === 0 ? 0 : secs[i].offsetTop - el.offsetTop));
      const from = el.scrollTop;
      jump.at = to;
      const far = Math.abs(to - from) > JUMP_PX;
      const start = far ? to - Math.sign(to - from) * JUMP_PX : from;
      requestMutation(() => {
        if (state.jump !== jump)
          return;
        const land = () => {
          jump.anim = false;
          set(i, to <= 0);
        };
        if (reducedMotion() || to === from) {
          el.scrollTop = to;
          land();
          return;
        }
        el.scrollTop = start;
        beginHeavyAnimation(JUMP_MS + 50);
        let raf = 0;
        const t0 = performance.now();
        const step = (now) => {
          const t = Math.min(1, (now - t0) / JUMP_MS);
          el.scrollTop = start + (to - start) * easeInOut(t);
          if (t < 1)
            raf = requestAnimationFrame(step);
          else {
            off();
            land();
          }
        };
        const cut = () => {
          cancelAnimationFrame(raf);
          off();
          if (state.jump === jump)
            state.jump = null;
        };
        const off = () => {
          el.removeEventListener("wheel", cut);
          el.removeEventListener("pointerdown", cut);
          el.removeEventListener("touchstart", cut);
          stop.current = () => {};
        };
        el.addEventListener("wheel", cut, { passive: true });
        el.addEventListener("pointerdown", cut);
        el.addEventListener("touchstart", cut, { passive: true });
        stop.current = cut;
        raf = requestAnimationFrame(step);
      });
    });
  };
  h(() => () => stop.current(), []);
  h(() => {
    if (state.active >= count)
      set(0, state.top);
  }, [count]);
  return { scroller, state, onScroll, go };
}
function Strip({ items, group, state, go }) {
  const ref = A(null);
  const [, redraw] = d(0);
  h(() => {
    const f = () => redraw((n) => n + 1);
    state.subs.add(f);
    return () => {
      state.subs.delete(f);
    };
  }, [state]);
  const { active, top } = state;
  h(() => requestMeasure(() => {
    const strip = ref.current, el = strip?.querySelectorAll(".app-sym-strip-btn")[active];
    if (!strip || !el || !strip.clientWidth)
      return;
    const left = Math.max(0, el.offsetLeft - (strip.clientWidth - el.offsetWidth) / 2);
    if (Math.abs(strip.scrollLeft - left) > 1)
      requestMutation(() => strip.scrollTo({ left, behavior: "smooth" }));
  }), [active]);
  const btn = (i, folded = false) => /* @__PURE__ */ u("button", {
    type: "button",
    role: "tab",
    "aria-selected": i === active,
    tabIndex: folded ? -1 : undefined,
    class: "app-sym-strip-btn" + (i === active ? " is-on" : ""),
    onClick: () => go(i),
    children: items[i]
  }, i, false, undefined, this);
  return /* @__PURE__ */ u("div", {
    class: "app-sym-strip" + (!top ? " has-border" : ""),
    ref,
    role: "tablist",
    children: group == null ? items.map((_, i) => btn(i)) : /* @__PURE__ */ u(S, {
      children: [
        items.slice(0, group).map((_, i) => btn(i)),
        /* @__PURE__ */ u("div", {
          class: "app-sym-strip-group" + (active >= group ? " is-open" : ""),
          style: { "--n": items.length - group },
          children: items.slice(group).map((_, k) => btn(group + k, active < group && k > 0))
        }, undefined, false, undefined, this)
      ]
    }, undefined, true, undefined, this)
  }, undefined, false, undefined, this);
}
function useChips(kind) {
  const groups = useEmojiGroups(kind);
  if (groups === undefined)
    return;
  if (groups.length)
    return groups.map((g) => ({ key: g.icon, label: g.title, tg: g.icon, emoticons: g.emoticons, query: g.emoticons.join("") }));
  return QUICK.map((c) => ({ key: c.icon, label: c.label, icon: c.icon, emoticons: c.group, query: c.emoji }));
}
function ChipIcon({ src }) {
  const [replay, setReplay] = d(0);
  return /* @__PURE__ */ u("span", {
    class: "app-sym-chip-tg",
    onPointerEnter: () => setReplay((n) => n + 1),
    children: /* @__PURE__ */ u(StickerView, {
      src,
      w: 512,
      h: 512,
      size: 20,
      group: "panel",
      play: replay > 0,
      loop: false,
      replay,
      atEnd: true,
      shared: false
    }, undefined, false, undefined, this)
  }, undefined, false, undefined, this);
}
function SearchRow({ placeholder, q, setQ, group, setGroup, chips, onFocus }) {
  return /* @__PURE__ */ u("div", {
    class: "app-sym-search" + (q ? " is-typing" : ""),
    children: [
      group != null ? /* @__PURE__ */ u("button", {
        type: "button",
        class: "app-sym-search-icon is-back",
        "aria-label": "Назад",
        onClick: () => setGroup(null),
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
        type: "text",
        placeholder,
        value: q,
        "aria-label": placeholder,
        onFocus: () => onFocus(true),
        onBlur: () => onFocus(false),
        onInput: (e) => {
          setGroup(null);
          setQ(e.target.value);
        }
      }, undefined, false, undefined, this),
      q ? /* @__PURE__ */ u(IconButton, {
        icon: "close",
        label: "Очистить",
        size: 18,
        onClick: () => setQ("")
      }, undefined, false, undefined, this) : chips ? /* @__PURE__ */ u("div", {
        class: "app-sym-chips",
        children: chips.map((c, i) => /* @__PURE__ */ u("button", {
          type: "button",
          class: "app-sym-chip" + (group === i ? " is-on" : ""),
          "aria-label": c.label,
          title: c.label,
          onClick: () => setGroup(group === i ? null : i),
          children: c.tg ? /* @__PURE__ */ u(ChipIcon, {
            src: c.tg
          }, undefined, false, undefined, this) : /* @__PURE__ */ u(Icon, {
            name: c.icon,
            size: 20
          }, undefined, false, undefined, this)
        }, c.key, false, undefined, this))
      }, undefined, false, undefined, this) : null
    ]
  }, undefined, true, undefined, this);
}
function EmojiTab2({ onPick, animate, selected, epoch, tones = false }) {
  const [recent, setRecent] = d(recentEmoji);
  h(() => {
    if (epoch)
      setRecent(recentEmoji());
  }, [epoch]);
  const [q, setQ] = d("");
  const [group, setGroup] = d(null);
  const [focused, setFocused] = d(false);
  const [toneOf, setToneOf] = d(() => tones ? savedTones() : {});
  const [toneMenu, setToneMenu] = d(null);
  const chips = useChips("emoji");
  const chip = group != null ? chips?.[group] : undefined;
  const found = chip ? chip.emoticons : q.trim() ? searchEmoji(q) : null;
  const base = recent.length ? [{ id: "recent", title: "Часто используемые", icon: "clock", list: recent }, ...EMOJI] : EMOJI;
  const cats = found ? [{ id: "found", title: chip ? chip.label : "Найдено", icon: "search", list: found }] : base;
  const s = useSections(cats.length);
  const sections = A(null);
  const ctx = A(null);
  ctx.current = { pick: (e) => {
    pushRecentEmoji(e);
    onPick(e);
  }, animate, tones, toneOf };
  const layer = (qq, g) => g != null ? "chip" + g : qq.trim() ? "found" : "base";
  const change = (qq, g) => {
    if (layer(qq, g) !== layer(q, group))
      crossfade(s.scroller.current, sections.current);
    setGroup(g);
    setQ(qq);
  };
  const chooseTone = (base, t) => {
    saveTone(base, t);
    setToneOf((m) => {
      const n = { ...m };
      if (t == null)
        delete n[base];
      else
        n[base] = t;
      return n;
    });
    ctx.current.pick(t == null ? base : emojiTones(base)[t]);
    setToneMenu(null);
  };
  const hold = useToneHold(tones, (btn) => {
    const e = btn.dataset.e;
    if (emojiTones(e))
      setToneMenu(toneMenuAt(btn, e));
  });
  return /* @__PURE__ */ u("div", {
    class: "app-sym-pane" + (focused || found ? " is-searching" : ""),
    children: [
      /* @__PURE__ */ u(Strip, {
        items: base.map((c) => /* @__PURE__ */ u(Icon, {
          name: c.icon,
          size: 24
        }, undefined, false, undefined, this)),
        group: recent.length ? 1 : 0,
        state: s.state,
        go: s.go
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u("div", {
        class: "app-sym-scroll",
        ref: s.scroller,
        onScroll: () => {
          s.onScroll();
          if (toneMenu)
            setToneMenu(null);
        },
        ...hold,
        children: [
          /* @__PURE__ */ u(SearchRow, {
            placeholder: "Поиск эмодзи",
            q,
            setQ: (v) => change(v, null),
            group,
            setGroup: (g) => change(g == null ? q : "", g),
            chips,
            onFocus: setFocused
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u("div", {
            ref: sections,
            children: [
              cats.map((c, i) => /* @__PURE__ */ u(EmojiSectionMemo, {
                cat: c,
                eager: i < 2,
                root: s.scroller,
                ctx,
                selected,
                toneOf
              }, c.id, false, undefined, this)),
              found && !found.length ? /* @__PURE__ */ u("p", {
                class: "app-sym-empty",
                children: "Эмодзи не найдены"
              }, undefined, false, undefined, this) : null
            ]
          }, undefined, true, undefined, this)
        ]
      }, undefined, true, undefined, this),
      /* @__PURE__ */ u(ToneMenu, {
        at: toneMenu,
        chosen: toneMenu ? toneOf[toneMenu.e] ?? null : null,
        onChoose: chooseTone,
        onClose: () => setToneMenu(null)
      }, undefined, false, undefined, this)
    ]
  }, undefined, true, undefined, this);
}
var lastGhost = 0;
function crossfade(scroller, content) {
  if (!scroller || !content || reducedMotion() || performance.now() - lastGhost < 50)
    return;
  lastGhost = performance.now();
  const pane = scroller.parentElement;
  const frame = document.createElement("div");
  frame.className = "app-sym-ghost";
  frame.setAttribute("aria-hidden", "true");
  frame.style.top = scroller.offsetTop + "px";
  frame.style.height = scroller.clientHeight + "px";
  frame.style.transform = getComputedStyle(scroller).transform;
  const ghost = content.cloneNode(true);
  ghost.style.transform = `translateY(${content.offsetTop - scroller.offsetTop - scroller.scrollTop}px)`;
  frame.appendChild(ghost);
  pane.appendChild(frame);
  const opts = { duration: 200, easing: "cubic-bezier(.4, 0, .2, 1)" };
  frame.animate([{ opacity: 1 }, { opacity: 0 }], opts).finished.then(() => frame.remove(), () => frame.remove());
  content.animate([{ opacity: 0 }, { opacity: 1 }], opts);
}
var CHUNK = 64;
function opened(len, fill, n = CHUNK) {
  return fill === "tail" ? { from: Math.max(0, len - n), to: len, fill } : { from: 0, to: Math.min(len, n), fill };
}
var fillers = [];
var fillRaf = 0;
function runFill() {
  fillRaf = 0;
  fillers.shift()?.();
  if (fillers.length)
    nextFill();
}
function nextFill() {
  onHeavyAnimationEnd(() => {
    if (!fillRaf && fillers.length)
      fillRaf = requestAnimationFrame(runFill);
  });
}
function queueFill(fn) {
  fillers.push(fn);
  nextFill();
  return () => {
    const i = fillers.indexOf(fn);
    if (i >= 0)
      fillers.splice(i, 1);
  };
}
function grown(w, len) {
  if (w.fill === "head")
    return w.to < len ? { ...w, to: Math.min(len, w.to + CHUNK) } : { ...w, from: Math.max(0, w.from - CHUNK) };
  return w.from > 0 ? { ...w, from: Math.max(0, w.from - CHUNK) } : { ...w, to: Math.min(len, w.to + CHUNK) };
}
function EmojiSection({ cat, eager, root, ctx, selected, toneOf }) {
  const el = A(null);
  const len = cat.list.length;
  const [win, setWin] = d(() => eager ? opened(len, "head") : null);
  const shown = !!win;
  h(() => {
    const sec = el.current;
    if (!sec)
      return;
    if (!shown) {
      const io = new IntersectionObserver((es) => {
        const e = es[es.length - 1];
        if (!e.isIntersecting)
          return;
        setWin((w) => w ?? opened(len, e.boundingClientRect.top < (e.rootBounds?.top ?? 0) ? "tail" : "head"));
      }, { root: root.current, rootMargin: "300px 0px" });
      io.observe(sec);
      const show = (ev) => {
        const d = ev.detail;
        setWin((w) => w ?? opened(len, d.fill, d.n));
      };
      sec.addEventListener(SEC_SHOW, show);
      return () => {
        io.disconnect();
        sec.removeEventListener(SEC_SHOW, show);
      };
    }
    let t = 0;
    const io = new IntersectionObserver((es) => {
      const e = es[es.length - 1];
      clearTimeout(t);
      if (!e.isIntersecting && !tabOff(root.current))
        t = window.setTimeout(() => setWin(null), UNLOAD_MS);
    }, { root: root.current, rootMargin: "1200px 0px" });
    io.observe(sec);
    const extend = (ev) => {
      const d = ev.detail;
      setWin((w) => !w ? opened(len, d.fill, d.n) : d.fill === "head" && w.from > 0 ? { ...w, from: 0 } : d.fill === "tail" && w.to < len ? { ...w, to: len } : w);
    };
    sec.addEventListener(SEC_SHOW, extend);
    return () => {
      clearTimeout(t);
      io.disconnect();
      sec.removeEventListener(SEC_SHOW, extend);
    };
  }, [shown]);
  h(() => {
    if (!win || win.from === 0 && win.to === len)
      return;
    return queueFill(() => setWin((w) => w && grown(w, len)));
  }, [win, len]);
  const place = win && win.from ? { gridRowStart: Math.floor(win.from / EMOJI_COLS) + 1, gridColumnStart: win.from % EMOJI_COLS + 1 } : undefined;
  return /* @__PURE__ */ u("section", {
    ref: el,
    "data-sec": true,
    class: "app-sym-sec",
    children: [
      /* @__PURE__ */ u("h4", {
        children: cat.title
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u("div", {
        class: "app-emoji-grid",
        style: { minHeight: Math.ceil(len / EMOJI_COLS) * EMOJI_ROW + "px" },
        children: win ? cat.list.slice(win.from, win.to).map((e, k) => /* @__PURE__ */ u(EmojiCellMemo, {
          e,
          v: toneOf[e] != null ? emojiTones(e)?.[toneOf[e]] ?? e : e,
          on: selected === e,
          ctx,
          place: k === 0 ? place : undefined
        }, e, false, undefined, this)) : null
      }, undefined, false, undefined, this)
    ]
  }, undefined, true, undefined, this);
}
var EmojiSectionMemo = N(EmojiSection);
function EmojiCell({ e, v, on, ctx, place }) {
  const [hover, setHover] = d(false);
  const [drawn, setDrawn] = d(false);
  const { animate, tones } = ctx.current;
  const src = hover && animate && !reducedMotion() ? animate(v) : undefined;
  return /* @__PURE__ */ u("button", {
    type: "button",
    class: "app-emoji" + (on ? " is-on" : ""),
    style: place,
    "data-e": e,
    "data-tones": tones && emojiTones(e) ? "" : undefined,
    "aria-label": v,
    "aria-pressed": on || undefined,
    onClick: () => ctx.current.pick(v),
    onMouseEnter: animate ? () => {
      if (animate(v)) {
        setDrawn(false);
        setHover(true);
      }
    } : undefined,
    onMouseLeave: animate ? () => setHover(false) : undefined,
    children: [
      /* @__PURE__ */ u("span", {
        class: src && drawn ? "is-under" : undefined,
        children: /* @__PURE__ */ u(EmojiGlyph, {
          e: v
        }, undefined, false, undefined, this)
      }, undefined, false, undefined, this),
      src ? /* @__PURE__ */ u(StickerView, {
        src,
        w: 512,
        h: 512,
        size: 34,
        group: "menu",
        force: true,
        loop: false,
        onFirstFrame: () => setDrawn(true),
        onEnded: () => setHover(false)
      }, undefined, false, undefined, this) : null
    ]
  }, undefined, true, undefined, this);
}
var EmojiCellMemo = N(EmojiCell);
var TONE_W = 6 * 32 + 12;
var TONE_H = 32 + 12;
var TONE_HOLD_MS = 400;
function toneMenuAt(btn, e) {
  const pane = btn.closest(".app-sym-pane").getBoundingClientRect(), r = btn.getBoundingClientRect();
  const x = Math.max(8, Math.min(pane.width - TONE_W - 8, r.left + r.width / 2 - pane.left - TONE_W / 2));
  const above = r.top - pane.top - TONE_H - 8;
  return above >= 8 ? { e, x, y: above, below: false } : { e, x, y: r.bottom - pane.top + 8, below: true };
}
function useToneHold(on, open) {
  const t = A(null);
  if (!on)
    return {};
  const target = (e) => e.target.closest(".app-emoji[data-tones]");
  const cancel = () => {
    if (t.current)
      clearTimeout(t.current.timer);
    t.current = null;
  };
  return {
    onContextMenu: (e) => {
      const b = target(e);
      if (b) {
        e.preventDefault();
        open(b);
      }
    },
    onPointerDown: (e) => {
      const b = target(e);
      if (!b || e.pointerType === "mouse")
        return;
      cancel();
      const st = { timer: 0, x: e.clientX, y: e.clientY, fired: false };
      st.timer = window.setTimeout(() => {
        st.fired = true;
        open(b);
      }, TONE_HOLD_MS);
      t.current = st;
    },
    onPointerMove: (e) => {
      const st = t.current;
      if (st && !st.fired && Math.hypot(e.clientX - st.x, e.clientY - st.y) > 8)
        cancel();
    },
    onPointerUp: () => {
      if (t.current && !t.current.fired)
        cancel();
    },
    onPointerCancel: cancel,
    onClickCapture: (e) => {
      if (t.current?.fired) {
        e.stopPropagation();
        e.preventDefault();
        t.current = null;
      }
    }
  };
}
function ToneMenu({ at, chosen, onChoose, onClose }) {
  const [shownAt, setShownAt] = d(at);
  const [on, setOn] = d(false);
  const ref = A(null);
  h(() => {
    if (at) {
      setShownAt(at);
      const r = requestAnimationFrame(() => requestAnimationFrame(() => setOn(true)));
      return () => cancelAnimationFrame(r);
    }
    setOn(false);
    const t = setTimeout(() => setShownAt(null), reducedMotion() ? 0 : 200);
    return () => clearTimeout(t);
  }, [at]);
  h(() => {
    if (!at)
      return;
    const away = (e) => {
      if (!ref.current?.contains(e.target))
        onClose();
    };
    const esc = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", esc, true);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", esc, true);
    };
  }, [at]);
  if (!shownAt)
    return null;
  const variants = [shownAt.e, ...emojiTones(shownAt.e) ?? []];
  return /* @__PURE__ */ u("div", {
    ref,
    class: "app-sym-tones" + (on && at ? " is-on" : "") + (shownAt.below ? " is-below" : ""),
    role: "menu",
    "aria-label": "Оттенок кожи",
    style: { left: shownAt.x + "px", top: shownAt.y + "px" },
    children: variants.map((v, i) => /* @__PURE__ */ u("button", {
      type: "button",
      role: "menuitemradio",
      "aria-checked": (i === 0 ? null : i - 1) === chosen,
      class: "app-sym-tone" + ((i === 0 ? null : i - 1) === chosen ? " is-on" : ""),
      "aria-label": v,
      onClick: () => onChoose(shownAt.e, i === 0 ? null : i - 1),
      children: /* @__PURE__ */ u(EmojiGlyph, {
        e: v
      }, undefined, false, undefined, this)
    }, v, false, undefined, this))
  }, undefined, false, undefined, this);
}
function StickersTab({ onPick, epoch }) {
  const mine = useMyStickers();
  const frozen = A(null);
  const seen = A(epoch);
  if (seen.current !== epoch) {
    seen.current = epoch;
    frozen.current = null;
  }
  if (!frozen.current && (mine.recent.length || mine.sets.length))
    frozen.current = mine.recent;
  const recent = frozen.current ?? mine.recent;
  const [q, setQ] = d("");
  const [group, setGroup] = d(null);
  const [focused, setFocused] = d(false);
  const chips = useChips("sticker");
  const chip = group != null ? chips?.[group] : undefined;
  const [found, setFound] = d(null);
  const [menu, setMenu] = d(null);
  h(() => {
    const text = chip ? chip.query : q.trim();
    if (!text) {
      setFound(null);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      const isEmoji = /\p{Extended_Pictographic}/u.test(text);
      (isEmoji ? stickersByEmoji(text).then((stickers) => ({ stickers })) : searchSets(text).then((sets) => ({ sets }))).then((r) => {
        if (live)
          setFound(r);
      }, () => {
        if (live)
          setFound({ stickers: [] });
      });
    }, group != null ? 0 : 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, group, chip?.query]);
  const own = [
    ...mine.faved.length ? [{ key: "faved", title: "Избранное", stickers: mine.faved, count: mine.faved.length }] : [],
    ...recent.length ? [{ key: "recent", title: "Недавние", stickers: recent, count: recent.length, clear: true }] : []
  ];
  const setSection = (set) => ({ key: "set" + set.id, title: set.title, set, count: set.count });
  const base = [...own, ...mine.sets.filter((x) => x.kind === "sticker").map(setSection)];
  const sections = found?.stickers ? [{ key: "found", title: chip ? chip.label : "Найдено", stickers: found.stickers, count: found.stickers.length }] : found?.sets ? found.sets.filter((x) => x.kind === "sticker").map(setSection) : base;
  const s = useSections(sections.length);
  const stripItems = base.map((sec) => sec.key === "faved" ? /* @__PURE__ */ u(Icon, {
    name: "bookmark",
    size: 24
  }, undefined, false, undefined, this) : sec.key === "recent" ? /* @__PURE__ */ u(Icon, {
    name: "clock",
    size: 24
  }, undefined, false, undefined, this) : sec.set?.cover ? /* @__PURE__ */ u(StickerView, {
    src: sec.set.cover.url,
    outline: sec.set.cover.outline,
    w: 512,
    h: 512,
    size: 30,
    play: false,
    group: "panel",
    title: sec.title
  }, undefined, false, undefined, this) : /* @__PURE__ */ u(Icon, {
    name: "sticker",
    size: 24
  }, undefined, false, undefined, this));
  const clearRecent = async () => {
    if (await confirmModal({ title: "Очистить недавние стикеры?", confirm: "Очистить", danger: true })) {
      frozen.current = [];
      clearRecentStickers();
    }
  };
  return /* @__PURE__ */ u("div", {
    class: "app-sym-pane" + (focused || q.trim() || group != null ? " is-searching" : ""),
    children: [
      /* @__PURE__ */ u(Strip, {
        items: stripItems,
        state: s.state,
        go: s.go
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u("div", {
        class: "app-sym-scroll",
        ref: s.scroller,
        onScroll: s.onScroll,
        children: [
          /* @__PURE__ */ u(SearchRow, {
            placeholder: "Поиск стикеров",
            q,
            setQ,
            group,
            setGroup,
            chips,
            onFocus: setFocused
          }, undefined, false, undefined, this),
          sections.map((sec, i) => /* @__PURE__ */ u(StickerSection, {
            sec,
            root: s.scroller,
            eager: i < 2,
            onPick,
            onClear: sec.clear ? clearRecent : undefined,
            onMenu: (st, el) => setMenu({ s: st, el, recent: sec.key === "recent" })
          }, sec.key, false, undefined, this)),
          found && !sections.some((x) => x.count) ? /* @__PURE__ */ u("p", {
            class: "app-sym-empty",
            children: "Стикеры не найдены"
          }, undefined, false, undefined, this) : null
        ]
      }, undefined, true, undefined, this),
      /* @__PURE__ */ u(MenuPopover, {
        open: !!menu,
        anchor: menu?.el ?? null,
        placement: "top-start",
        onClose: () => setMenu(null),
        items: menu ? [
          mine.faved.some((f) => f.id === menu.s.id) ? { icon: "star", label: "Убрать из избранного", onClick: () => void faveSticker(menu.s, false) } : { icon: "star", label: "В избранное", onClick: () => void faveSticker(menu.s, true) },
          menu.recent ? { icon: "trash", label: "Убрать из недавних", onClick: () => {
            frozen.current = (frozen.current ?? []).filter((x) => x.id !== menu.s.id);
            clearRecentStickers(menu.s.id);
          } } : null,
          { icon: "sticker", label: "Открыть пак", onClick: () => openStickerSet(menu.s.setId) }
        ].filter(Boolean) : []
      }, undefined, false, undefined, this)
    ]
  }, undefined, true, undefined, this);
}
function useNear(el, root, initial) {
  const [near, setNear] = d(initial);
  h(() => {
    if (!el.current)
      return;
    const io = new IntersectionObserver((es) => {
      const e = es[es.length - 1];
      if (!e.isIntersecting && tabOff(root.current))
        return;
      setNear(e.isIntersecting);
    }, { root: root.current, rootMargin: "300px 0px" });
    io.observe(el.current);
    return () => io.disconnect();
  }, []);
  return near;
}
function StickerSection({ sec, root, eager, onPick, onClear, onMenu }) {
  const el = A(null);
  const near = useNear(el, root, eager);
  const [stickers, setStickers] = d(sec.stickers ?? null);
  h(() => {
    if (sec.stickers)
      setStickers(sec.stickers);
  }, [sec.stickers]);
  h(() => {
    if (sec.stickers || !sec.set || !el.current)
      return;
    const set = sec.set;
    let live = true;
    const load = () => loadStickerSet(set.id, set.hash).then((full) => {
      if (live && full)
        setStickers(full.stickers);
    }, () => {});
    if (eager) {
      load();
      return () => {
        live = false;
      };
    }
    const io = new IntersectionObserver((es) => {
      if (!es.some((e) => e.isIntersecting))
        return;
      io.disconnect();
      load();
    }, { root: root.current, rootMargin: "500px 0px" });
    io.observe(el.current);
    return () => {
      live = false;
      io.disconnect();
    };
  }, [sec.key]);
  const rows = Math.ceil(sec.count / STK_COLS);
  return /* @__PURE__ */ u("section", {
    ref: el,
    "data-sec": true,
    class: "app-sym-sec",
    children: [
      /* @__PURE__ */ u("h4", {
        class: sec.set ? "is-link" : undefined,
        onClick: sec.set ? () => openStickerSet(sec.set.id) : undefined,
        children: [
          sec.title,
          onClear ? /* @__PURE__ */ u(IconButton, {
            class: "app-sym-clear",
            icon: "close",
            label: "Очистить недавние",
            size: 20,
            onClick: (e) => {
              e.stopPropagation();
              onClear();
            }
          }, undefined, false, undefined, this) : null
        ]
      }, undefined, true, undefined, this),
      /* @__PURE__ */ u("div", {
        class: "app-stk-grid",
        style: { minHeight: rows * STK_ROW + "px" },
        children: near && stickers?.map((s) => /* @__PURE__ */ u(StickerPreviewHold, {
          sticker: s,
          children: /* @__PURE__ */ u("button", {
            type: "button",
            class: "app-stk-cell",
            onClick: () => onPick(s),
            title: s.emoji,
            onContextMenu: (e) => {
              e.preventDefault();
              onMenu(s, e.currentTarget);
            },
            children: /* @__PURE__ */ u(StickerView, {
              src: s.url,
              outline: s.outline,
              w: s.w,
              h: s.h,
              size: 64,
              group: "panel",
              loop: true
            }, undefined, false, undefined, this)
          }, undefined, false, undefined, this)
        }, s.id, false, undefined, this))
      }, undefined, false, undefined, this)
    ]
  }, undefined, true, undefined, this);
}
var EmojiTabMemo = N(EmojiTab2);
var StickersTabMemo = N(StickersTab);

export { SymbolMenu2, EmojiTab2 };

//# debugId=CAC20F1BC234B45F64756E2164756E21
//# sourceMappingURL=main-e2tesbyd.js.map
