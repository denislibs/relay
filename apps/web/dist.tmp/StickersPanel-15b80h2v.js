import {
  d,
  h,
  A,
  onHeavyAnimationEnd,
  IconButton,
  ProgressRing,
  useMinVisible,
  StickerView,
  plural3,
  u,
  loadStickerSet,
  featuredSets,
  searchSets,
  installSet,
  useMyStickers,
  sendStickerHere,
  openStickerSet
} from "./main-s48bdnny.js";
import {
  StickerPreviewHold
} from "./main-kapbmf3z.js";

// apps/web/src/ui/stickers/StickersPanel.tsx
function StickersPanel({ onBack }) {
  const [q, setQ] = d("");
  const [list, setList] = d(null);
  const [more, setMore] = d(true);
  const loading = useMinVisible(list === null, { delay: 200, min: 500 });
  const mine = useMyStickers();
  const busyMore = A(false);
  const [settled, setSettled] = d(false);
  const input = A(null);
  h(() => {
    let live = true;
    onHeavyAnimationEnd(() => requestAnimationFrame(() => {
      if (!live)
        return;
      setSettled(true);
      input.current?.focus({ preventScroll: true });
    }));
    return () => {
      live = false;
    };
  }, []);
  const bottom = A(null), scroller = A(null);
  h(() => {
    let live = true;
    const t = setTimeout(() => {
      const text = q.trim();
      (text ? searchSets(text) : featuredSets(0)).then((r) => {
        if (live) {
          setList(r);
          setMore(!text && r.length >= 20);
        }
      }, () => {
        if (live)
          setList([]);
      });
    }, q ? 250 : 0);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q]);
  h(() => {
    if (!more || !bottom.current)
      return;
    const io = new IntersectionObserver((es) => {
      if (!es.some((e) => e.isIntersecting) || busyMore.current || !list)
        return;
      busyMore.current = true;
      featuredSets(list.length).then((r) => {
        setList((prev) => [...prev ?? [], ...r.filter((x) => !(prev ?? []).some((y) => y.id === x.id))]);
        setMore(r.length >= 20);
      }).finally(() => {
        busyMore.current = false;
      });
    }, { root: scroller.current, rootMargin: "0px 0px 500px 0px" });
    io.observe(bottom.current);
    return () => io.disconnect();
  }, [more, list?.length]);
  return /* @__PURE__ */ u("div", {
    class: "app-stkpanel",
    "aria-label": "Стикеры",
    children: [
      /* @__PURE__ */ u("div", {
        class: "app-stkpanel-head",
        children: [
          /* @__PURE__ */ u(IconButton, {
            icon: "arrowLeft",
            label: "Назад",
            onClick: onBack
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u("div", {
            class: "app-stkpanel-search",
            children: [
              /* @__PURE__ */ u("input", {
                ref: input,
                type: "text",
                placeholder: "Поиск стикеров",
                value: q,
                onInput: (e) => setQ(e.target.value),
                "aria-label": "Поиск стикеров"
              }, undefined, false, undefined, this),
              q ? /* @__PURE__ */ u(IconButton, {
                icon: "close",
                label: "Очистить",
                size: 18,
                onClick: () => setQ("")
              }, undefined, false, undefined, this) : null
            ]
          }, undefined, true, undefined, this)
        ]
      }, undefined, true, undefined, this),
      /* @__PURE__ */ u("div", {
        class: "app-stkpanel-list",
        ref: scroller,
        children: [
          !settled ? Array.from({ length: 6 }, (_, i) => /* @__PURE__ */ u("div", {
            class: "app-stkrow app-stkrow-skel",
            "aria-hidden": "true",
            children: [
              /* @__PURE__ */ u("div", {
                class: "app-stkrow-head",
                children: /* @__PURE__ */ u("div", {
                  class: "app-stkrow-title",
                  children: [
                    /* @__PURE__ */ u("i", {}, undefined, false, undefined, this),
                    /* @__PURE__ */ u("i", {}, undefined, false, undefined, this)
                  ]
                }, undefined, true, undefined, this)
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u("div", {
                class: "app-stkrow-strip"
              }, undefined, false, undefined, this)
            ]
          }, i, true, undefined, this)) : null,
          settled && loading ? /* @__PURE__ */ u("div", {
            class: "app-stkpanel-load",
            children: /* @__PURE__ */ u(ProgressRing, {
              size: 32,
              label: "Загрузка паков"
            }, undefined, false, undefined, this)
          }, undefined, false, undefined, this) : null,
          settled ? list?.map((set) => /* @__PURE__ */ u(SetRow, {
            set,
            installed: mine.sets.some((s) => s.id === set.id),
            root: scroller
          }, set.id, false, undefined, this)) : null,
          list && !list.length ? /* @__PURE__ */ u("p", {
            class: "app-stkpanel-empty",
            children: "Ничего не найдено"
          }, undefined, false, undefined, this) : null,
          /* @__PURE__ */ u("div", {
            ref: bottom,
            class: "app-stkpanel-end"
          }, undefined, false, undefined, this)
        ]
      }, undefined, true, undefined, this)
    ]
  }, undefined, true, undefined, this);
}
function SetRow({ set, installed, root }) {
  const el = A(null);
  const [first, setFirst] = d(null);
  const [busy, setBusy] = d(false);
  h(() => {
    if (!el.current)
      return;
    let live = true;
    const io = new IntersectionObserver((es) => {
      if (!es.some((e) => e.isIntersecting))
        return;
      io.disconnect();
      loadStickerSet(set.id, set.hash).then((full) => {
        if (live && full)
          setFirst(full.stickers.slice(0, 5));
      }, () => {});
    }, { root: root.current, rootMargin: "400px 0px" });
    io.observe(el.current);
    return () => {
      live = false;
      io.disconnect();
    };
  }, [set.id]);
  const toggle = async (e) => {
    e.stopPropagation();
    if (busy)
      return;
    setBusy(true);
    try {
      await installSet(set.id, !installed, installed ? undefined : set);
    } finally {
      setBusy(false);
    }
  };
  return /* @__PURE__ */ u("div", {
    ref: el,
    class: "app-stkrow",
    role: "button",
    tabIndex: 0,
    onClick: () => openStickerSet(set.id),
    onKeyDown: (e) => {
      if (e.key === "Enter")
        openStickerSet(set.id);
    },
    children: [
      /* @__PURE__ */ u("div", {
        class: "app-stkrow-head",
        children: [
          /* @__PURE__ */ u("div", {
            class: "app-stkrow-title",
            children: [
              /* @__PURE__ */ u("b", {
                children: set.title
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u("small", {
                children: [
                  set.count,
                  " ",
                  plural3(set.count, "стикер", "стикера", "стикеров")
                ]
              }, undefined, true, undefined, this)
            ]
          }, undefined, true, undefined, this),
          /* @__PURE__ */ u("button", {
            type: "button",
            class: "app-stkrow-btn" + (installed ? " is-added" : ""),
            disabled: busy,
            onClick: toggle,
            children: installed ? "ДОБАВЛЕНО" : "ДОБАВИТЬ"
          }, undefined, false, undefined, this)
        ]
      }, undefined, true, undefined, this),
      /* @__PURE__ */ u("div", {
        class: "app-stkrow-strip",
        children: (first ?? []).map((s) => /* @__PURE__ */ u(StickerPreviewHold, {
          sticker: s,
          children: /* @__PURE__ */ u("span", {
            class: "app-stkrow-cell",
            onClick: (e) => {
              if (sendStickerHere(s))
                e.stopPropagation();
            },
            children: /* @__PURE__ */ u(StickerView, {
              src: s.url,
              outline: s.outline,
              w: s.w,
              h: s.h,
              size: 64,
              group: "aside",
              loop: true,
              title: s.emoji
            }, undefined, false, undefined, this)
          }, undefined, false, undefined, this)
        }, s.id, false, undefined, this))
      }, undefined, false, undefined, this)
    ]
  }, undefined, true, undefined, this);
}
export {
  StickersPanel
};

//# debugId=F109E9124AD41C6564756E2164756E21
//# sourceMappingURL=StickersPanel-15b80h2v.js.map
