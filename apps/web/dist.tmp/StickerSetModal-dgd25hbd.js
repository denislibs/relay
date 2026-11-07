import {
  d,
  h,
  Icon,
  IconButton,
  useMinVisible,
  setStickerGroupExclusive,
  StickerView,
  openModal,
  showToast2,
  plural3,
  u,
  loadStickerSet,
  installSet,
  useMyStickers,
  sendStickerHere
} from "./main-s48bdnny.js";
import {
  StickerPreviewHold
} from "./main-kapbmf3z.js";

// apps/web/src/ui/stickers/StickerSetModal.tsx
function showStickerSet(idOrShort) {
  setStickerGroupExclusive("modal");
  openModal((close) => /* @__PURE__ */ u(SetBody, {
    id: idOrShort,
    close
  }, undefined, false, undefined, this), {
    size: "slim",
    header: null,
    label: "Стикеры",
    class: "app-stkset",
    bodyClass: "app-stkset-body",
    onClose: () => setStickerGroupExclusive(null)
  });
}
var count = (n) => `${n} ${plural3(n, "стикер", "стикера", "стикеров")}`.toUpperCase();
function SetBody({ id, close }) {
  const [set, setSet] = d(undefined);
  const [busy, setBusy] = d(false);
  const mine = useMyStickers();
  const loading = useMinVisible(set === undefined, { delay: 200, min: 400 });
  h(() => {
    let live = true;
    loadStickerSet(id).then((s) => {
      if (live)
        setSet(s);
    }, () => {
      if (live)
        setSet(null);
    });
    return () => {
      live = false;
    };
  }, [id]);
  const installed = !!set && mine.sets.some((s) => s.id === set.id);
  const toggle = async () => {
    if (!set || busy)
      return;
    setBusy(true);
    try {
      await installSet(set.id, !installed, installed ? undefined : { id: set.id, shortName: set.shortName, title: set.title, kind: set.kind, count: set.count, cover: set.cover, hash: set.hash });
      showToast2(installed ? "Набор удалён" : "Набор добавлен");
      close();
    } finally {
      setBusy(false);
    }
  };
  const copy = () => {
    if (!set)
      return;
    navigator.clipboard?.writeText(`${location.origin}/addstickers/${set.shortName}`).then(() => showToast2("Ссылка скопирована"), () => {});
  };
  const pick = (s) => {
    if (sendStickerHere(s))
      close();
  };
  return /* @__PURE__ */ u("div", {
    class: "app-stkset-wrap",
    children: [
      /* @__PURE__ */ u("div", {
        class: "app-stkset-head",
        children: [
          /* @__PURE__ */ u(IconButton, {
            icon: "close",
            label: "Закрыть",
            onClick: close
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u("h2", {
            children: set ? set.title : set === null ? "Набор не найден" : loading ? "Загрузка…" : " "
          }, undefined, false, undefined, this),
          set ? /* @__PURE__ */ u(IconButton, {
            icon: "link",
            label: "Скопировать ссылку",
            onClick: copy
          }, undefined, false, undefined, this) : /* @__PURE__ */ u("span", {
            class: "app-stkset-gap"
          }, undefined, false, undefined, this)
        ]
      }, undefined, true, undefined, this),
      /* @__PURE__ */ u("div", {
        class: "app-stkset-grid",
        role: "list",
        children: set?.stickers.map((s) => /* @__PURE__ */ u(StickerPreviewHold, {
          sticker: s,
          children: /* @__PURE__ */ u("div", {
            class: "app-stkset-cell",
            role: "listitem",
            children: /* @__PURE__ */ u(StickerView, {
              src: s.url,
              outline: s.outline,
              w: s.w,
              h: s.h,
              size: 72,
              group: "modal",
              loop: true,
              title: s.emoji,
              onClick: () => pick(s)
            }, undefined, false, undefined, this)
          }, undefined, false, undefined, this)
        }, s.id, false, undefined, this))
      }, undefined, false, undefined, this),
      set ? /* @__PURE__ */ u("button", {
        type: "button",
        class: "app-stkset-pill" + (installed ? " app-stkset-pill-danger" : ""),
        disabled: busy,
        onClick: toggle,
        children: [
          installed ? "УДАЛИТЬ " : "ДОБАВИТЬ ",
          count(set.count)
        ]
      }, undefined, true, undefined, this) : null,
      set === null ? /* @__PURE__ */ u("p", {
        class: "app-stkset-empty",
        children: [
          /* @__PURE__ */ u(Icon, {
            name: "info",
            size: 20
          }, undefined, false, undefined, this),
          " Пак удалён или переименован"
        ]
      }, undefined, true, undefined, this) : null
    ]
  }, undefined, true, undefined, this);
}
export {
  showStickerSet
};

//# debugId=F5B788F9D7AC7C5564756E2164756E21
//# sourceMappingURL=StickerSetModal-dgd25hbd.js.map
