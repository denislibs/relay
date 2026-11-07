import {
  S,
  d,
  h,
  _,
  A,
  T,
  $,
  requestMeasure,
  requestMutation,
  beginHeavyAnimation,
  isHeavyAnimating,
  onHeavyAnimationEnd,
  SearchInput,
  MenuPopover,
  plural,
  ContactPicker,
  WindowList,
  SlideStack,
  FolderTabs,
  Fab,
  reducedMotion,
  ripple,
  Icon,
  Button,
  IconButton,
  peerTone,
  Avatar,
  Chip,
  ChatRow,
  ChatRowSkeleton,
  Bubble,
  Toast,
  ProgressRing,
  Switch,
  PanelHeader,
  ProfileHeader,
  SettingsIcon,
  InfoRow,
  Presence,
  useMinVisible,
  EmptyState,
  lottieStats,
  stickerStats,
  stickerDetail,
  StickerView,
  Modal,
  Section,
  RadioRow,
  CheckRow,
  RangeRow,
  TextField,
  SelectRow,
  ConfirmDialog,
  RichText,
  IS_APPLE,
  comboKeys,
  Owl,
  strictDomEnabled,
  strictDomReport,
  strictDomReset,
  subscribeStrictDom,
  enableStrictDom,
  Sticker,
  SelectField,
  BASE_ACCENT,
  PRESETS,
  defaultPrefs,
  KEEP_DAYS,
  RINGTONES,
  CACHE_MB,
  levelOf,
  localeTimeFormat,
  setPrefs,
  setPref,
  getGlobal,
  setGlobal,
  useGlobal,
  warmBackground,
  failureOf,
  getMic,
  getCamera,
  listDevices,
  canPickSpeaker,
  levelMeter,
  soundSink,
  sounds,
  hm,
  birthdayText,
  sessionTime,
  fullDateTime,
  chatTone,
  isSystemChat,
  isSavedChat,
  activeDrives,
  formatBytes,
  plural2,
  dbRowsLabel,
  within,
  clearMediaCaches,
  readStorage,
  releaseMediaCache,
  sessionsSeen,
  soundOn,
  toggleSound,
  volumeFromSlider,
  volumePct,
  playNotifySound,
  bgWanted,
  dropSubscription,
  setNotify,
  setBackground,
  getPendingOps2,
  registerPrefetch2,
  prefetch2,
  prefetchAll2,
  failText2,
  showToast2,
  loadSessions2,
  terminateSession2,
  confirmSession2,
  terminateOtherSessions2,
  setSessionsTtl2,
  markSelfLogout2,
  updateProfile2,
  setLinks2,
  setUsername2,
  setPersonalChannel2,
  checkUsername2,
  saveFolder2,
  deleteFolder2,
  reorderFolders2,
  refreshSettings2,
  setNotifyDefault2,
  setPrivacy2,
  blockUser2,
  unblockUser2,
  resetLocal2,
  storageStats2,
  devCall2,
  u,
  setLeaveGuard,
  go,
  back,
  loadPersonalChannels,
  knownPersonalChannels,
  useChannelPost,
  subscribersText,
  avatarPhoto,
  rowAvatar,
  senderAvatar,
  useProfilePhotos,
  START,
  isAfter,
  cursorAt,
  eventKey,
  getErrors2,
  newErrorCount2,
  markErrorsSeen2,
  subscribeErrors2,
  clearErrors2,
  useBase,
  useWallpaper,
  folderChats,
  folderIcon,
  folderSubtitle,
  recommendedFor,
  moveItem,
  useWide,
  useFolderCtx,
  shortcutSections,
  useWallpaperImage,
  RULE_KEYS,
  MODE_LABEL,
  RULE_TITLE,
  RULE_QUESTION,
  EXCEPTION_TITLE,
  ruleCaption,
  DISCOVERY_TITLE,
  discoveryCaption,
  EXCEPTIONS_FOOTER,
  ruleSubtitle,
  peopleCount,
  candidates,
  withPeople,
  samePeople,
  parseRulePath,
  useScrollMemory,
  swatchBackground,
  Swatch,
  Wallpaper3,
  WallpaperColor2,
  ThemeTiles,
  animatedEmojiUrl,
  useAnimatedEmoji,
  PhotoViewer,
  autoloadSubtitle,
  isDefaultAutoload,
  moveLink,
  dropIndex,
  shiftFor,
  ServiceIcon,
  LINK_TITLE,
  LinkEdit2,
  ProfileLinks,
  Expand,
  PersonalChannelRow,
  PersonalChannelBlock,
  NAME_MAX,
  BIO_MAX,
  cpLen,
  clip,
  USERNAME_TEXT,
  formFromMe,
  normUsername,
  usernameShapeOk,
  profilePatch,
  usernameChanged,
  channelChanged,
  isDirty,
  filterChannels,
  canSave,
  daysIn,
  usePhotoPicker,
  getPassword,
  savePassword,
  removePassword,
  passkeysSupported,
  listPasskeys,
  deletePasskey,
  createPasskey,
  QrScanner
} from "./main-s48bdnny.js";
import {
  MAX_LINKS,
  linkLabel,
  FOLDER_LIMITS,
  FOLDER_COLORS,
  graphemes,
  normalizeFolder,
  folderError,
  nextFolderId,
  sessionsView
} from "./main-p1twxvxz.js";
import {
  openDevSession2,
  setServerPolling2,
  useDevStats2,
  useMainMetrics2,
  useServerStats2,
  useDevLog2,
  devSnapshot2
} from "./main-kvw7vkbq.js";
import"./main-08q0j2r0.js";
import {
  EmojiTab2
} from "./main-e2tesbyd.js";
import"./main-kapbmf3z.js";

// apps/web/src/ui/settings/Autoload.tsx
var TITLE = { photo: "Фото", video: "Видео", file: "Файлы" };
var STEPS = [1, 5, 10, 50, 100];
function Autoload({ path }) {
  const kind = path.split("/").pop();
  const al = useGlobal((s) => s.prefs.autoload);
  const scroll = useScrollMemory(path);
  const v = al[kind];
  const set = (field) => (on) => setPref(`autoload.${kind}.${field}`, on);
  const idx = STEPS.reduce((best, m, i) => Math.abs(m - al.fileMaxMb) < Math.abs(STEPS[best] - al.fileMaxMb) ? i : best, 0);
  return /* @__PURE__ */ u("div", {
    class: "rl-sidepage",
    "aria-label": TITLE[kind],
    children: [
      /* @__PURE__ */ u(PanelHeader, {
        icon: "arrowLeft",
        closeLabel: "Назад",
        title: TITLE[kind],
        onClose: () => void back()
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u("div", {
        class: "rl-settings",
        ref: scroll.ref,
        onScroll: scroll.onScroll,
        children: [
          /* @__PURE__ */ u(Section, {
            title: "Автозагрузка",
            footer: "Без автозагрузки вложение скачивается по нажатию.",
            children: [
              /* @__PURE__ */ u(CheckRow, {
                setting: "autoload.contacts",
                label: "Контакты",
                checked: v.contacts,
                onChange: set("contacts")
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u(CheckRow, {
                setting: "autoload.private",
                label: "Личные чаты",
                checked: v.private,
                onChange: set("private")
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u(CheckRow, {
                setting: "autoload.groups",
                label: "Группы",
                checked: v.groups,
                onChange: set("groups")
              }, undefined, false, undefined, this)
            ]
          }, undefined, true, undefined, this),
          kind === "file" ? /* @__PURE__ */ u(Section, {
            footer: "Файлы больше этого размера не загружаются сами.",
            children: /* @__PURE__ */ u(RangeRow, {
              setting: "autoload.maxSize",
              label: "Максимальный размер файла",
              min: 0,
              max: STEPS.length - 1,
              step: 1,
              value: idx,
              format: (i) => `до ${STEPS[i]} МБ`,
              marks: STEPS.map((m, i) => ({ value: i, label: String(m) })),
              onChange: (i) => setPref("autoload.fileMaxMb", STEPS[i])
            }, undefined, false, undefined, this)
          }, undefined, false, undefined, this) : null
        ]
      }, undefined, true, undefined, this)
    ]
  }, undefined, true, undefined, this);
}
// apps/web/src/ui/settings/Blocked.tsx
registerPrefetch2("settings/privacy/blocked", () => {});
var FOOTER = "Заблокированные пользователи не могут писать вам и не видят, когда вы были в сети.";
var about = (b) => b.username ? "@" + String(b.username) : b.phone ? String(b.phone) : "";
function Blocked() {
  const list = useGlobal((s) => s.blocked);
  const loaded = useGlobal((s) => s.blockedLoaded);
  const phase = useGlobal((s) => s.status.phase);
  const me = useGlobal((s) => s.me.userId);
  const contacts = useGlobal((s) => s.contacts);
  const chats = useGlobal((s) => s.chats);
  const [menu, setMenu] = d(null);
  const [picking, setPicking] = d(false);
  const waiting = !loaded && !list.length && phase !== "offline";
  const skeleton = useMinVisible(waiting, { delay: 150, min: 600 });
  const ids = new Set(list.map((b) => b.userId));
  const people = candidates(contacts, chats.filter((c) => !isSystemChat(c)), me).filter((p) => !ids.has(p.id));
  return /* @__PURE__ */ u("div", {
    class: "rl-sidepage",
    "aria-label": "Заблокированные",
    children: [
      /* @__PURE__ */ u(PanelHeader, {
        icon: "arrowLeft",
        closeLabel: "Назад",
        title: "Заблокированные",
        onClose: () => void back()
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u("div", {
        class: "rl-settings",
        children: /* @__PURE__ */ u("div", {
          class: "app-listwrap",
          children: [
            /* @__PURE__ */ u(Presence, {
              show: skeleton,
              exitMs: 280,
              children: /* @__PURE__ */ u("div", {
                class: "app-skel",
                "aria-busy": "true",
                "aria-label": "Загрузка списка",
                children: /* @__PURE__ */ u(Section, {
                  children: [0, 1, 2].map((i) => /* @__PURE__ */ u("div", {
                    style: { "--i": i },
                    children: /* @__PURE__ */ u(ChatRowSkeleton, {}, undefined, false, undefined, this)
                  }, i, false, undefined, this))
                }, undefined, false, undefined, this)
              }, undefined, false, undefined, this)
            }, undefined, false, undefined, this),
            waiting || skeleton ? null : list.length ? /* @__PURE__ */ u(Section, {
              footer: FOOTER,
              children: /* @__PURE__ */ u("div", {
                role: "list",
                children: list.map((b) => /* @__PURE__ */ u("div", {
                  role: "listitem",
                  children: /* @__PURE__ */ u(ChatRow, {
                    name: String(b.name || "Пользователь"),
                    avatarTone: peerTone(b.userId),
                    ...rowAvatar(b.photo),
                    preview: about(b),
                    "aria-haspopup": "menu",
                    onClick: (e) => setMenu({ x: e.clientX, y: e.clientY, userId: b.userId }),
                    onContextMenu: (e) => {
                      e.preventDefault();
                      setMenu({ x: e.clientX, y: e.clientY, userId: b.userId });
                    }
                  }, undefined, false, undefined, this)
                }, b.key, false, undefined, this))
              }, undefined, false, undefined, this)
            }, undefined, false, undefined, this) : /* @__PURE__ */ u(S, {
              children: [
                /* @__PURE__ */ u(EmptyState, {
                  kind: "contacts",
                  title: "Никого нет",
                  text: "Здесь появятся люди, которых вы заблокируете."
                }, undefined, false, undefined, this),
                /* @__PURE__ */ u("p", {
                  class: "rl-sect-footer app-blocked-footer",
                  children: FOOTER
                }, undefined, false, undefined, this)
              ]
            }, undefined, true, undefined, this)
          ]
        }, undefined, true, undefined, this)
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u(MenuPopover, {
        open: !!menu,
        anchor: menu ?? undefined,
        label: "Действия",
        onClose: () => setMenu(null),
        items: menu ? [{ icon: "block", label: "Разблокировать", onClick: () => {
          unblockUser2(menu.userId);
          setMenu(null);
        } }] : []
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u("div", {
        class: "rl-fab-slot",
        children: /* @__PURE__ */ u(Fab, {
          icon: "plus",
          label: "Заблокировать пользователя",
          onClick: () => setPicking(true)
        }, undefined, false, undefined, this)
      }, undefined, false, undefined, this),
      picking ? /* @__PURE__ */ u(Modal, {
        title: "Заблокировать пользователя",
        size: "slim",
        onClose: () => setPicking(false),
        children: /* @__PURE__ */ u("div", {
          class: "app-block-pick",
          children: /* @__PURE__ */ u(ContactPicker, {
            contacts: people.map((p) => ({ ...p, tone: peerTone(p.id), avatar: senderAvatar(p.id) })),
            searchLabel: "Поиск людей",
            placeholder: "Имя или @имя пользователя",
            empty: "Заблокировать можно собеседника или человека из контактов.",
            onPick: (p) => {
              setPicking(false);
              blockUser2(p.id);
            }
          }, undefined, false, undefined, this)
        }, undefined, false, undefined, this)
      }, undefined, false, undefined, this) : null
    ]
  }, undefined, true, undefined, this);
}
// apps/web/src/ui/settings/Calls.tsx
registerPrefetch2("settings/calls", () => {
  refreshSettings2();
});
var RING_LABEL = { classic: "Стандартная", chime: "Колокольчики", pulse: "Пульс" };
var IDLE_MS = 60000;
function Calls() {
  const p = useGlobal((s) => s.prefs.calls);
  const privacy = useGlobal((s) => s.settings.privacy);
  const scroll = useScrollMemory("settings/calls");
  const [lists, setLists] = d({ mic: [], speaker: [], camera: [] });
  const [micOn, setMicOn] = d(false), [camOn, setCamOn] = d(false);
  const [level, setLevel] = d(0);
  const [fail, setFail] = d({});
  const [camShown, setCamShown] = d(false);
  const video = A(null);
  const live = A({});
  const refresh = () => void listDevices().then(setLists);
  const stopMic = () => {
    live.current.meter?.stop();
    live.current.mic?.stop();
    live.current.mic = undefined;
    live.current.meter = undefined;
    setMicOn(false);
    setLevel(0);
  };
  const stopCam = () => {
    live.current.cam?.stop();
    live.current.cam = undefined;
    setCamOn(false);
    setCamShown(false);
    if (video.current)
      video.current.srcObject = null;
  };
  const stopAll = () => {
    stopMic();
    stopCam();
    if (live.current.idle)
      clearTimeout(live.current.idle);
  };
  const touch = () => {
    if (live.current.idle)
      clearTimeout(live.current.idle);
    live.current.idle = setTimeout(stopAll, IDLE_MS);
  };
  h(() => {
    refresh();
    navigator.mediaDevices?.addEventListener("devicechange", refresh);
    const hide = () => {
      if (document.visibilityState === "hidden")
        stopAll();
    };
    document.addEventListener("visibilitychange", hide);
    return () => {
      navigator.mediaDevices?.removeEventListener("devicechange", refresh);
      document.removeEventListener("visibilitychange", hide);
      stopAll();
    };
  }, []);
  const startMic = async () => {
    stopMic();
    try {
      const { track } = await getMic(p);
      live.current.mic = track;
      live.current.meter = levelMeter(track, setLevel);
      setMicOn(true);
      setFail((f) => ({ ...f, mic: undefined }));
      refresh();
      touch();
    } catch (e) {
      setFail((f) => ({ ...f, mic: failureOf(e) }));
    }
  };
  const startCam = async () => {
    stopCam();
    try {
      const { track } = await getCamera(p);
      live.current.cam = track;
      setCamOn(true);
      setFail((f) => ({ ...f, camera: undefined }));
      const el = video.current;
      if (el) {
        el.srcObject = new MediaStream([track]);
        el.onloadeddata = () => setCamShown(true);
      }
      refresh();
      touch();
    } catch (e) {
      setFail((f) => ({ ...f, camera: failureOf(e) }));
    }
  };
  h(() => {
    if (micOn)
      startMic();
  }, [p.mic, p.noise, p.agc]);
  h(() => {
    if (camOn)
      startCam();
  }, [p.camera, p.video, p.background]);
  const name = (d, i, what) => d.label || `${what} ${i + 1}`;
  const deviceRow = (key, label, what) => /* @__PURE__ */ u(SelectRow, {
    setting: "calls." + key,
    label,
    value: p[key] ?? "",
    options: [{ value: "", label: "Как в системе" }, ...lists[key].map((d, i) => ({ value: d.deviceId, label: name(d, i, what) }))],
    onChange: (v) => {
      setPrefs({ ["calls." + key]: v === "" ? null : String(v) });
      touch();
    }
  }, undefined, false, undefined, this);
  const failText = (f, what) => !f ? undefined : f === "denied" ? `Нет доступа к ${what}: разрешите его в настройках браузера (значок слева от адреса)` : f === "missing" ? "Устройство не найдено" : f === "busy" ? "Устройство занято другим приложением" : f === "insecure" ? "Нужно защищённое соединение (https)" : "Не удалось включить";
  return /* @__PURE__ */ u("div", {
    class: "rl-sidepage",
    "aria-label": "Звонки",
    children: [
      /* @__PURE__ */ u(PanelHeader, {
        icon: "arrowLeft",
        closeLabel: "Назад",
        title: "Звонки",
        onClose: () => void back()
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u("div", {
        class: "rl-settings",
        ref: scroll.ref,
        onScroll: scroll.onScroll,
        children: [
          /* @__PURE__ */ u(Section, {
            setting: "calls.mic",
            title: "Микрофон",
            footer: failText(fail.mic, "микрофону") ?? "Эхоподавление включено всегда.",
            children: [
              deviceRow("mic", "Микрофон", "Микрофон"),
              /* @__PURE__ */ u("div", {
                class: "app-calls-meter",
                "aria-label": "Уровень микрофона",
                role: "meter",
                "aria-valuemin": 0,
                "aria-valuemax": 100,
                "aria-valuenow": Math.round(level * 100),
                children: /* @__PURE__ */ u("i", {
                  style: { transform: `scaleX(${micOn ? level : 0})` }
                }, undefined, false, undefined, this)
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u(InfoRow, {
                icon: micOn ? "micOff" : "mic",
                title: micOn ? "Остановить проверку" : "Проверить микрофон",
                onClick: () => void (micOn ? stopMic() : startMic())
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u(CheckRow, {
                setting: "calls.noise",
                label: "Шумоподавление",
                checked: p.noise,
                onChange: (on) => setPrefs({ "calls.noise": on })
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u(CheckRow, {
                setting: "calls.agc",
                label: "Автоматическая громкость",
                checked: p.agc,
                onChange: (on) => setPrefs({ "calls.agc": on })
              }, undefined, false, undefined, this)
            ]
          }, undefined, true, undefined, this),
          canPickSpeaker() ? /* @__PURE__ */ u(Section, {
            setting: "calls.speaker",
            title: "Динамики",
            children: [
              deviceRow("speaker", "Динамики", "Динамик"),
              /* @__PURE__ */ u(InfoRow, {
                icon: "volume",
                title: "Проверить звук",
                onClick: () => {
                  soundSink(p.speaker).then(() => sounds.test(p.volume));
                }
              }, undefined, false, undefined, this)
            ]
          }, undefined, true, undefined, this) : null,
          /* @__PURE__ */ u(Section, {
            setting: "calls.camera",
            title: "Камера",
            footer: failText(fail.camera, "камере"),
            children: [
              deviceRow("camera", "Камера", "Камера"),
              /* @__PURE__ */ u("div", {
                class: "app-calls-preview" + (camOn ? " is-open" : ""),
                children: /* @__PURE__ */ u("video", {
                  ref: video,
                  class: camShown ? "is-on" : "",
                  autoplay: true,
                  playsInline: true,
                  muted: true,
                  "aria-label": "Предпросмотр камеры"
                }, undefined, false, undefined, this)
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u(InfoRow, {
                icon: camOn ? "videoOff" : "video",
                title: camOn ? "Выключить камеру" : "Показать камеру",
                onClick: () => void (camOn ? stopCam() : startCam())
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u(SelectRow, {
                setting: "calls.background",
                label: "Фон",
                value: p.background,
                options: [{ value: "none", label: "Обычный" }, { value: "blur", label: "Размытый" }],
                onChange: (v) => {
                  if (v === "blur")
                    warmBackground();
                  setPrefs({ "calls.background": v });
                }
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u(SelectRow, {
                setting: "calls.video",
                label: "Качество видео",
                value: p.video,
                options: [{ value: "auto", label: "Обычное" }, { value: "saver", label: "Экономия трафика" }, { value: "high", label: "Высокое" }],
                onChange: (v) => setPrefs({ "calls.video": v })
              }, undefined, false, undefined, this)
            ]
          }, undefined, true, undefined, this),
          /* @__PURE__ */ u(Section, {
            setting: "calls.ring",
            title: "Входящие",
            footer: "Если выключить, это устройство не будет звонить; пропущенные звонки останутся в чате.",
            children: [
              /* @__PURE__ */ u(CheckRow, {
                setting: "calls.accept",
                label: "Принимать звонки на этом устройстве",
                checked: p.accept,
                onChange: (on) => setPrefs({ "calls.accept": on })
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u(SelectRow, {
                setting: "calls.ringtone",
                label: "Мелодия",
                value: p.ringtone,
                options: RINGTONES.map((r) => ({ value: r, label: RING_LABEL[r] ?? r })),
                onChange: (v) => {
                  setPrefs({ "calls.ringtone": String(v) });
                  soundSink(p.speaker).then(() => sounds.preview(String(v), p.volume));
                }
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u(RangeRow, {
                setting: "calls.volume",
                label: "Громкость звонка",
                min: 0,
                max: 100,
                step: 1,
                value: Math.round(p.volume * 100),
                format: (v) => v + " %",
                onChange: (v) => setPrefs({ "calls.volume": v / 100 }),
                onCommit: (v) => {
                  soundSink(p.speaker).then(() => sounds.preview(p.ringtone, v / 100));
                }
              }, undefined, false, undefined, this)
            ]
          }, undefined, true, undefined, this),
          /* @__PURE__ */ u(Section, {
            title: "Конфиденциальность",
            footer: "Звонки защищены сквозным шифрованием: сверьте 4 эмодзи с собеседником.",
            children: [
              /* @__PURE__ */ u(InfoRow, {
                tile: "green",
                icon: "phone",
                title: "Кто может мне звонить",
                subtitle: ruleSubtitle(privacy.calls),
                onClick: () => void go("settings/privacy/rule/calls")
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u(InfoRow, {
                tile: "blue",
                icon: "shield",
                title: "Пиринговые соединения",
                subtitle: ruleSubtitle(privacy.p2p),
                onClick: () => void go("settings/privacy/rule/p2p")
              }, undefined, false, undefined, this)
            ]
          }, undefined, true, undefined, this)
        ]
      }, undefined, true, undefined, this)
    ]
  }, undefined, true, undefined, this);
}
// apps/web/src/ui/settings/clearLocal.ts
function clearLocalDialog(n, run) {
  return n > 0 ? {
    title: "Очистить локальные данные?",
    text: `${n} ${plural(n, "сообщение ещё не отправлено", "сообщения ещё не отправлены", "сообщений ещё не отправлено")}. Можно оставить их и отправить позже или удалить вместе с остальным. Черновики удалятся в любом случае. Чаты загрузятся с сервера заново.`,
    confirm: "Удалить всё",
    run: () => run(false),
    extra: { label: "Оставить неотправленные", onClick: () => run(true) }
  } : {
    title: "Очистить локальные данные?",
    text: "Чаты, сообщения и черновики на устройстве удалятся, чаты загрузятся с сервера заново. Неотправленного нет.",
    confirm: "Очистить",
    run: () => run(true),
    extra: undefined
  };
}

// apps/web/src/ui/settings/Data.tsx
var KEEP_LABEL = { 1: "1 день", 7: "1 неделя", 30: "1 месяц", 0: "Всегда" };
var KEEP_MARK = { 1: "1 д", 7: "1 нед", 30: "1 мес", 0: "∞" };
var filesLabel = (n) => `${n} ${plural2(n, "файл", "файла", "файлов")}`;
var ROWS_WAIT_MS = 600;
var mbLabel = (mb) => mb === 0 ? "Без лимита" : mb >= 1000 ? `${mb / 1000} ГБ` : `${mb} МБ`;
var KINDS = [
  ["photo", "Фото", "image", "blue"],
  ["video", "Видео", "video", "purple"],
  ["file", "Файлы", "file", "orange"]
];
function Data() {
  const al = useGlobal((s) => s.prefs.autoload);
  const media = useGlobal((s) => s.prefs.media);
  const chats = useGlobal((s) => s.chats.length);
  const status = useGlobal((s) => s.status);
  const scroll = useScrollMemory("settings/data");
  const [info, setInfo] = d(null);
  const [ask, setAsk] = d(null);
  const [lastAsk, setLastAsk] = d("cache");
  const [busy, setBusy] = d(false);
  const [unsent, setUnsent] = d(0);
  const alive = A(true);
  h(() => () => {
    alive.current = false;
  }, []);
  const skeleton = useMinVisible(info == null, { delay: 150, min: 600 });
  const def = defaultPrefs().autoload;
  const isDef = isDefaultAutoload(al, def);
  const recompute = () => {
    Promise.all([readStorage(), within(storageStats2().then((s) => s.rows), ROWS_WAIT_MS)]).then(([i, rows]) => {
      if (alive.current)
        setInfo((prev) => ({ ...i, rows: rows ?? prev?.rows }));
    }).catch(() => {
      if (alive.current)
        setInfo((prev) => ({ used: 0, quota: 0, db: 0, media: 0, exact: false, approx: false, rows: prev?.rows }));
    });
  };
  h(recompute, []);
  const settleTimer = A(null);
  const settle = () => {
    if (settleTimer.current)
      clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(recompute, 1200);
  };
  h(() => () => {
    if (settleTimer.current)
      clearTimeout(settleTimer.current);
  }, []);
  const open = (k) => {
    if (k === "local")
      setUnsent(status.outbox + status.failed + getPendingOps2());
    setLastAsk(k);
    setAsk(k);
  };
  const clearCache = async () => {
    setAsk(null);
    try {
      await clearMediaCaches();
      showToast2("Кэш медиа очищен");
    } catch {
      showToast2("Не удалось очистить кэш");
    }
    recompute();
  };
  const clearLocal = async (keepOutbox) => {
    setAsk(null);
    if (busy)
      return;
    setBusy(true);
    try {
      await resetLocal2(keepOutbox);
      go("chats");
    } catch {
      showToast2("Не удалось очистить данные, попробуйте ещё раз");
    }
    if (alive.current) {
      setBusy(false);
      recompute();
    }
  };
  const pct = (n) => info && info.quota > 0 ? Math.max(n > 0 ? 1 : 0, n / info.quota * 100) : 0;
  const n = unsent;
  const dialog = {
    cache: { title: "Очистить кэш медиа?", text: "Загруженные фото, видео и файлы удалятся с устройства. При необходимости они скачаются снова.", confirm: "Очистить", run: clearCache },
    local: clearLocalDialog(n, (keep) => void clearLocal(keep)),
    autoload: { title: "Сбросить настройки автозагрузки?", text: "Для фото, видео и файлов вернутся значения по умолчанию.", confirm: "Сбросить", run: () => {
      setAsk(null);
      setPrefs({ "autoload.enabled": def.enabled, "autoload.photo": def.photo, "autoload.video": def.video, "autoload.file": def.file, "autoload.fileMaxMb": def.fileMaxMb });
    } }
  }[lastAsk];
  const extra = lastAsk === "local" ? clearLocalDialog(n, (keep) => void clearLocal(keep)).extra : undefined;
  return /* @__PURE__ */ u("div", {
    class: "rl-sidepage",
    "aria-label": "Данные и память",
    children: [
      /* @__PURE__ */ u(PanelHeader, {
        icon: "arrowLeft",
        closeLabel: "Назад",
        title: "Данные и память",
        onClose: () => void back()
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u("div", {
        class: "rl-settings",
        ref: scroll.ref,
        onScroll: scroll.onScroll,
        children: [
          /* @__PURE__ */ u(Section, {
            title: "Автозагрузка медиа",
            footer: "Настройки действуют на этом устройстве.",
            children: [
              /* @__PURE__ */ u(InfoRow, {
                setting: "data.autoload",
                tile: "green",
                icon: "download",
                title: "Автозагрузка медиа",
                trailing: /* @__PURE__ */ u(Switch, {
                  id: "al-master",
                  label: "Автозагрузка медиа",
                  checked: al.enabled,
                  onChange: (e) => setPrefs({ "autoload.enabled": e.currentTarget.checked })
                }, undefined, false, undefined, this)
              }, undefined, false, undefined, this),
              KINDS.map(([k, title, icon, tile]) => /* @__PURE__ */ u("div", {
                class: al.enabled ? "" : "app-dim",
                "aria-disabled": al.enabled ? undefined : "true",
                "data-autoload": k,
                children: /* @__PURE__ */ u(InfoRow, {
                  tile,
                  icon,
                  title,
                  subtitle: autoloadSubtitle(al, k),
                  onClick: al.enabled ? () => void go("settings/data/autoload/" + k) : undefined
                }, undefined, false, undefined, this)
              }, k, false, undefined, this))
            ]
          }, undefined, true, undefined, this),
          /* @__PURE__ */ u(Section, {
            children: /* @__PURE__ */ u("div", {
              class: isDef ? "app-dim" : "",
              "aria-disabled": isDef ? "true" : undefined,
              children: /* @__PURE__ */ u(InfoRow, {
                setting: "data.autoload.reset",
                icon: "history",
                title: "Сбросить настройки автозагрузки",
                onClick: isDef ? undefined : () => open("autoload")
              }, undefined, false, undefined, this)
            }, undefined, false, undefined, this)
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u(Section, {
            setting: "data.storage",
            title: "Память",
            children: [
              /* @__PURE__ */ u("div", {
                class: "app-storage",
                children: [
                  /* @__PURE__ */ u("div", {
                    class: "app-storebar",
                    role: "img",
                    "aria-label": info ? `Занято ${formatBytes(info.used)} из ${formatBytes(info.quota)}` : "Загрузка",
                    children: [
                      /* @__PURE__ */ u("span", {
                        class: "app-store-db",
                        style: { width: pct(info?.db ?? 0) + "%" }
                      }, undefined, false, undefined, this),
                      /* @__PURE__ */ u("span", {
                        class: "app-store-media",
                        style: { width: pct(info?.media ?? 0) + "%" }
                      }, undefined, false, undefined, this)
                    ]
                  }, undefined, true, undefined, this),
                  /* @__PURE__ */ u("div", {
                    class: "app-store-total",
                    children: info ? /* @__PURE__ */ u(S, {
                      children: [
                        /* @__PURE__ */ u("b", {
                          children: formatBytes(info.used)
                        }, undefined, false, undefined, this),
                        info.quota > 0 ? " из " + formatBytes(info.quota) : ""
                      ]
                    }, undefined, true, undefined, this) : " "
                  }, undefined, false, undefined, this)
                ]
              }, undefined, true, undefined, this),
              /* @__PURE__ */ u("div", {
                class: "app-listwrap",
                children: [
                  /* @__PURE__ */ u(Presence, {
                    show: skeleton,
                    exitMs: 280,
                    children: /* @__PURE__ */ u("div", {
                      class: "app-skel",
                      "aria-busy": "true",
                      "aria-label": "Загрузка",
                      children: [0, 1].map((i) => /* @__PURE__ */ u("div", {
                        style: { "--i": i },
                        children: /* @__PURE__ */ u(ChatRowSkeleton, {}, undefined, false, undefined, this)
                      }, i, false, undefined, this))
                    }, undefined, false, undefined, this)
                  }, undefined, false, undefined, this),
                  info == null || skeleton ? null : /* @__PURE__ */ u(S, {
                    children: [
                      /* @__PURE__ */ u(InfoRow, {
                        icon: "chats",
                        title: info.exact ? "Чаты и сообщения" : "Данные приложения",
                        subtitle: dbRowsLabel(info.rows),
                        value: formatBytes(info.db)
                      }, undefined, false, undefined, this),
                      /* @__PURE__ */ u(InfoRow, {
                        icon: "image",
                        title: "Медиа",
                        subtitle: info.files ? `${filesLabel(info.files)} — открываются без сети` : undefined,
                        value: (info.approx ? "≈ " : "") + formatBytes(info.media)
                      }, undefined, false, undefined, this),
                      info.savedFiles ? /* @__PURE__ */ u(InfoRow, {
                        icon: "download",
                        title: "Скачано вами",
                        subtitle: `${filesLabel(info.savedFiles)} — сами не удаляются`,
                        value: formatBytes(info.savedBytes ?? 0)
                      }, undefined, false, undefined, this) : null,
                      info.persisted === false ? /* @__PURE__ */ u(InfoRow, {
                        icon: "info",
                        title: "Хранилище не закреплено",
                        subtitle: "При нехватке места браузер может удалить данные Relay с устройства"
                      }, undefined, false, undefined, this) : null
                    ]
                  }, undefined, true, undefined, this)
                ]
              }, undefined, true, undefined, this),
              /* @__PURE__ */ u(InfoRow, {
                icon: "cloud",
                title: "Чаты на устройстве",
                subtitle: `${chats} — доступны без сети`
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u(InfoRow, {
                icon: "history",
                title: "Синхронизация",
                subtitle: status.phase === "ready" ? status.outbox ? `В очереди: ${status.outbox}` : "Всё сохранено на сервере" : status.phase === "offline" ? "Ждём сеть" : "Идёт обновление"
              }, undefined, false, undefined, this)
            ]
          }, undefined, true, undefined, this),
          /* @__PURE__ */ u(Section, {
            setting: "data.cache",
            title: "Кэш медиа",
            footer: "Фото, видео и файлы, к которым давно не обращались, удаляются с устройства сами. При необходимости они скачаются снова. Скачанное кнопкой не удаляется — только очисткой ниже.",
            children: [
              /* @__PURE__ */ u(RangeRow, {
                setting: "data.cache.keep",
                label: "Хранить медиа",
                min: 0,
                max: KEEP_DAYS.length - 1,
                step: 1,
                value: Math.max(0, KEEP_DAYS.indexOf(media.keepDays)),
                format: (i) => KEEP_LABEL[KEEP_DAYS[i]],
                marks: KEEP_DAYS.map((d, i) => ({ value: i, label: KEEP_MARK[d] })),
                onChange: (i) => {
                  setPref("media.keepDays", KEEP_DAYS[i]);
                  settle();
                }
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u(RangeRow, {
                setting: "data.cache.max",
                label: "Максимальный размер кэша",
                min: 0,
                max: CACHE_MB.length - 1,
                step: 1,
                value: Math.max(0, CACHE_MB.indexOf(media.maxMb)),
                format: (i) => mbLabel(CACHE_MB[i]),
                marks: CACHE_MB.map((m, i) => ({ value: i, label: m === 0 ? "∞" : mbLabel(m).replace(" ", " ") })),
                onChange: (i) => {
                  setPref("media.maxMb", CACHE_MB[i]);
                  settle();
                }
              }, undefined, false, undefined, this)
            ]
          }, undefined, true, undefined, this),
          /* @__PURE__ */ u(Section, {
            footer: "Очистка локальных данных не удаляет ничего на сервере.",
            children: [
              /* @__PURE__ */ u(InfoRow, {
                setting: "data.clearCache",
                icon: "trash",
                title: "Очистить кэш медиа",
                onClick: () => open("cache")
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u(InfoRow, {
                setting: "data.clearLocal",
                icon: "trash",
                danger: true,
                title: "Очистить локальные данные",
                onClick: busy ? undefined : () => open("local"),
                trailing: busy ? /* @__PURE__ */ u("span", {
                  class: "app-busy",
                  children: /* @__PURE__ */ u(ProgressRing, {
                    size: 22,
                    label: "Очистка"
                  }, undefined, false, undefined, this)
                }, undefined, false, undefined, this) : undefined
              }, undefined, false, undefined, this)
            ]
          }, undefined, true, undefined, this)
        ]
      }, undefined, true, undefined, this),
      /* @__PURE__ */ u(ConfirmDialog, {
        open: ask != null,
        extra,
        danger: lastAsk !== "autoload",
        title: dialog.title,
        text: dialog.text,
        confirm: dialog.confirm,
        cancel: "Отмена",
        onCancel: () => setAsk(null),
        onConfirm: () => void dialog.run()
      }, undefined, false, undefined, this)
    ]
  }, undefined, true, undefined, this);
}
// apps/web/src/devtools/diagnostics.ts
var SECRET = new Set(["body", "text", "bio", "thumb", "draft", "note", "q", "query", "phone", "birthday", "firstName", "lastName", "name", "username"]);
var MAX_DEPTH = 8;
function redact(v, depth = 0) {
  if (depth > MAX_DEPTH)
    return "…";
  if (Array.isArray(v))
    return v.map((x) => redact(x, depth + 1));
  if (!v || typeof v !== "object")
    return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    out[k] = !SECRET.has(k) || x == null ? redact(x, depth + 1) : typeof x === "string" ? `‹${x.length} симв.›` : "‹скрыто›";
  }
  return out;
}
var fileStamp = (d = new Date) => d.toISOString().slice(0, 19).replace(/:/g, "-");
function diagnosticsFile(build, data, now = new Date) {
  return { name: `relay-diagnostics-${build}-${fileStamp(now)}.json`, json: JSON.stringify(redact({ build, at: now.toISOString(), ...data }), null, 2) };
}
function downloadText(name, text, type = "application/json") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// apps/web/src/ui/settings/DevData.tsx
var PAGE = 100;
var MSG_ROW = 30;
var read = (args) => devCall2("idbRead", args);
var short = (v, n = 90) => {
  const s = JSON.stringify(v);
  return s.length > n ? s.slice(0, n) + "…" : s;
};
function Messages(props) {
  const [q, setQ] = d("");
  const [rows, setRows] = d([]);
  const [more, setMore] = d(true);
  const [open, setOpen] = d(null);
  const gen = A(0);
  const loading = A(false);
  const load = (reset, query = q) => {
    if (loading.current && !reset)
      return;
    const g = reset ? ++gen.current : gen.current;
    loading.current = true;
    read({ store: "messages", chatId: props.chatId, q: query, offset: reset ? 0 : rows.length, limit: PAGE }).then((p) => {
      if (g !== gen.current)
        return;
      setRows((r) => reset ? p.rows : r.concat(p.rows));
      setMore(p.more);
    }, () => showToast2("Не удалось прочитать IDB")).finally(() => {
      if (g === gen.current)
        loading.current = false;
    });
  };
  h(() => {
    load(true, "");
  }, [props.chatId]);
  const cur = open ? rows.find((r) => r.key === open) : null;
  return /* @__PURE__ */ u(S, {
    children: [
      /* @__PURE__ */ u(SearchInput, {
        id: "dev-msg-search",
        label: "Поиск по ключу",
        placeholder: "Ключ сообщения",
        value: q,
        onInput: (e) => {
          const v = e.currentTarget.value;
          setQ(v);
          load(true, v);
        }
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u("div", {
        class: "app-dev-idb",
        role: "list",
        "aria-label": "Сообщения в IDB",
        children: rows.length ? /* @__PURE__ */ u(WindowList, {
          items: rows,
          rowHeight: MSG_ROW,
          getKey: (r) => r.key,
          onNearEnd: more ? () => load(false) : undefined,
          render: (r) => /* @__PURE__ */ u("button", {
            type: "button",
            role: "listitem",
            class: "app-dev-idbrow" + (open === r.key ? " app-dev-ev-on" : ""),
            onClick: () => setOpen(open === r.key ? null : r.key),
            children: [
              /* @__PURE__ */ u("b", {
                children: r.key
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u("span", {
                children: short({ id: r.value.id, sort: r.value.sort, status: r.value.status, body: r.value.body })
              }, undefined, false, undefined, this)
            ]
          }, undefined, true, undefined, this)
        }, undefined, false, undefined, this) : /* @__PURE__ */ u("p", {
          class: "app-dev-empty",
          children: q ? "Ничего не найдено" : "Сообщений нет"
        }, undefined, false, undefined, this)
      }, undefined, false, undefined, this),
      cur ? /* @__PURE__ */ u("pre", {
        class: "app-dev-pre",
        children: JSON.stringify(cur.value, null, 2)
      }, undefined, false, undefined, this) : null
    ]
  }, undefined, true, undefined, this);
}
function DevData() {
  const status = useGlobal((s) => s.status);
  const [chats, setChats] = d(null);
  const [meta, setMeta] = d(null);
  const [chatId, setChatId] = d(null);
  const [ask, setAsk] = d(false);
  const [unsent, setUnsent] = d(0);
  const [busy, setBusy] = d(null);
  const refresh = () => {
    read({ store: "chats", limit: 200 }).then((p) => setChats(p.rows), () => setChats([]));
    read({ store: "meta", limit: 50 }).then((p) => setMeta(p.rows), () => setMeta([]));
  };
  h(refresh, []);
  const act = async (name, fn, ok) => {
    if (busy)
      return;
    setBusy(name);
    try {
      await fn();
      showToast2(ok);
    } catch (e) {
      showToast2(e?.message === "offline" ? "Нет сети" : "Не удалось выполнить");
    }
    setBusy(null);
    refresh();
  };
  const updateSw = () => act("sw", async () => {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (!reg)
      throw new Error("no sw");
    await reg.update();
  }, "Service Worker проверен на обновление");
  const clearLocal = async (keepOutbox) => {
    setAsk(false);
    try {
      await resetLocal2(keepOutbox);
      go("chats");
    } catch {
      showToast2("Не удалось очистить данные, попробуйте ещё раз");
    }
  };
  const diag = () => {
    const snap = devSnapshot2();
    const f = diagnosticsFile("mw6119zf", {
      overview: snap.stats,
      server: snap.server,
      main: snap.main,
      log: snap.log.slice(-2000).map(({ key: _k, ...e }) => e),
      errors: getErrors2(),
      ua: navigator.userAgent
    });
    downloadText(f.name, f.json);
  };
  const dlg = clearLocalDialog(unsent, (keep) => void clearLocal(keep));
  return /* @__PURE__ */ u("div", {
    class: "rl-settings app-dev-scroll",
    children: [
      /* @__PURE__ */ u(Section, {
        title: "Чаты в IDB",
        children: chats == null ? /* @__PURE__ */ u("p", {
          class: "app-dev-empty",
          children: "…"
        }, undefined, false, undefined, this) : chats.length ? chats.map((c) => /* @__PURE__ */ u("button", {
          type: "button",
          class: "app-dev-idbrow" + (chatId === Number(c.key) ? " app-dev-ev-on" : ""),
          onClick: () => setChatId(chatId === Number(c.key) ? null : Number(c.key)),
          children: [
            /* @__PURE__ */ u("b", {
              children: c.key
            }, undefined, false, undefined, this),
            /* @__PURE__ */ u("span", {
              children: short({ title: c.value.title, kind: c.value.kind, unread: c.value.unread, last: c.value.last?.id })
            }, undefined, false, undefined, this)
          ]
        }, c.key, true, undefined, this)) : /* @__PURE__ */ u("p", {
          class: "app-dev-empty",
          children: "Чатов нет"
        }, undefined, false, undefined, this)
      }, undefined, false, undefined, this),
      chatId != null ? /* @__PURE__ */ u(Section, {
        title: `Сообщения чата ${chatId}`,
        children: /* @__PURE__ */ u(Messages, {
          chatId
        }, undefined, false, undefined, this)
      }, undefined, false, undefined, this) : null,
      /* @__PURE__ */ u(Section, {
        title: "meta",
        children: meta?.map((r) => /* @__PURE__ */ u("div", {
          class: "app-kv",
          children: [
            /* @__PURE__ */ u("span", {
              children: r.key
            }, undefined, false, undefined, this),
            /* @__PURE__ */ u("b", {
              title: JSON.stringify(r.value.v),
              children: short(r.value.v, 60)
            }, undefined, false, undefined, this)
          ]
        }, r.key, true, undefined, this))
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u(Section, {
        title: "Действия",
        children: [
          /* @__PURE__ */ u(InfoRow, {
            icon: "history",
            title: "Пересинхронизировать",
            subtitle: "Снимок заново, без очистки",
            onClick: () => void act("resync", () => devCall2("resync"), "Снимок взят")
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u(InfoRow, {
            icon: "trash",
            danger: true,
            title: "Очистить локальные данные",
            onClick: () => {
              setUnsent(status.outbox + status.failed + getPendingOps2());
              setAsk(true);
            }
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u(InfoRow, {
            icon: "download",
            title: "Обновить Service Worker",
            onClick: () => void updateSw()
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u(InfoRow, {
            icon: "rocket",
            title: "Перезапустить воркер",
            subtitle: "Все вкладки переподключатся",
            onClick: () => void act("restart", () => devCall2("restartWorker"), "Воркер перезапущен")
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u(InfoRow, {
            icon: "file",
            title: "Скачать диагностику",
            subtitle: "Обзор, журнал и ошибки — без текстов сообщений",
            onClick: diag
          }, undefined, false, undefined, this)
        ]
      }, undefined, true, undefined, this),
      /* @__PURE__ */ u(ConfirmDialog, {
        open: ask,
        extra: dlg.extra,
        danger: true,
        title: dlg.title,
        text: dlg.text,
        confirm: dlg.confirm,
        cancel: "Отмена",
        onCancel: () => setAsk(false),
        onConfirm: () => dlg.run()
      }, undefined, false, undefined, this)
    ]
  }, undefined, true, undefined, this);
}

// apps/web/src/ui/settings/devui.tsx
function KV(props) {
  return /* @__PURE__ */ u("div", {
    class: "app-kv" + (props.warn ? " app-kv-warn" : ""),
    title: props.title,
    children: [
      /* @__PURE__ */ u("span", {
        children: props.label
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u("b", {
        children: props.value == null || props.value === "" ? "—" : props.value
      }, undefined, false, undefined, this)
    ]
  }, undefined, true, undefined, this);
}
var num = (n) => typeof n === "number" && Number.isFinite(n) ? n.toLocaleString("ru-RU") : "—";
var ms = (n) => typeof n === "number" && Number.isFinite(n) ? `${Math.round(n).toLocaleString("ru-RU")} мс` : "—";
function dur(msv) {
  if (typeof msv !== "number" || !Number.isFinite(msv))
    return "—";
  const s = Math.floor(msv / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60);
  const p2 = (x) => String(x).padStart(2, "0");
  return h ? `${h} ч ${p2(m % 60)} мин` : m ? `${m} мин ${p2(s % 60)} с` : `${s} с`;
}
function ago(t, now = Date.now()) {
  if (typeof t !== "number" || !t)
    return "—";
  return dur(Math.max(0, now - t)) + " назад";
}
function bytes(n) {
  if (typeof n !== "number" || !Number.isFinite(n))
    return "—";
  if (n < 1024)
    return `${n} Б`;
  if (n < 1024 * 1024)
    return `${(n / 1024).toFixed(1)} КБ`;
  if (n < 1024 ** 3)
    return `${(n / 1024 / 1024).toFixed(1)} МБ`;
  return `${(n / 1024 ** 3).toFixed(2)} ГБ`;
}
function stamp(t) {
  const d = new Date(t);
  const p = (x, n = 2) => String(x).padStart(n, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

// apps/web/src/ui/settings/DevErrors.tsx
var SOURCE = { window: "window.onerror", promise: "unhandledrejection", engine: "движок", host: "хост воркера", server: "сервер (err)", op: "очередь операций" };
function DevErrors() {
  const [list, setList] = d(getErrors2());
  const [open, setOpen] = d(null);
  h(() => subscribeErrors2(() => setList(getErrors2())), []);
  const rows = list.slice().reverse();
  return /* @__PURE__ */ u("div", {
    class: "rl-settings app-dev-scroll",
    children: [
      /* @__PURE__ */ u(Section, {
        title: `Ошибки: ${list.length}`,
        footer: "Последние 200. Ошибки главного потока собираются всегда, ошибки движка — из его журнала (2000 последних событий).",
        children: rows.length ? rows.map((e) => /* @__PURE__ */ u("div", {
          class: "app-dev-err",
          children: [
            /* @__PURE__ */ u("div", {
              class: "app-dev-err-head",
              children: [
                /* @__PURE__ */ u("span", {
                  class: "app-dev-ev-t",
                  children: stamp(e.t)
                }, undefined, false, undefined, this),
                /* @__PURE__ */ u("span", {
                  class: "app-dev-err-src",
                  children: SOURCE[e.source]
                }, undefined, false, undefined, this),
                e.count > 1 ? /* @__PURE__ */ u("span", {
                  class: "app-dev-err-count",
                  children: [
                    "×",
                    e.count
                  ]
                }, undefined, true, undefined, this) : null
              ]
            }, undefined, true, undefined, this),
            /* @__PURE__ */ u("div", {
              class: "app-dev-err-msg",
              children: e.message
            }, undefined, false, undefined, this),
            e.stack ? /* @__PURE__ */ u(S, {
              children: [
                /* @__PURE__ */ u("button", {
                  type: "button",
                  class: "app-dev-err-toggle",
                  "aria-expanded": open === e.id ? "true" : "false",
                  onClick: () => setOpen(open === e.id ? null : e.id),
                  children: open === e.id ? "Скрыть стек" : "Показать стек"
                }, undefined, false, undefined, this),
                open === e.id ? /* @__PURE__ */ u("pre", {
                  class: "app-dev-pre",
                  children: e.stack
                }, undefined, false, undefined, this) : null
              ]
            }, undefined, true, undefined, this) : null
          ]
        }, e.id, true, undefined, this)) : /* @__PURE__ */ u("p", {
          class: "app-dev-empty",
          children: "Ошибок нет"
        }, undefined, false, undefined, this)
      }, undefined, false, undefined, this),
      rows.length ? /* @__PURE__ */ u("div", {
        class: "app-dev-actions app-dev-actions-pad",
        children: /* @__PURE__ */ u(Button, {
          variant: "secondary",
          onClick: clearErrors2,
          children: "Очистить список"
        }, undefined, false, undefined, this)
      }, undefined, false, undefined, this) : null
    ]
  }, undefined, true, undefined, this);
}

// apps/web/src/ui/settings/DevLog.tsx
var ROW = 28;
var KINDS2 = [["all", "Все"], ["ws-out", "↑ Исходящие"], ["ws-in", "↓ Входящие"], ["engine", "Движок"], ["error", "Ошибки"]];
var DIR = { "ws-out": "↑", "ws-in": "↓", engine: "•", error: "!" };
var TOP_TYPES = 10;
var brief = new Map;
function summary(e) {
  const k = eventKey(e);
  let s = brief.get(k);
  if (s === undefined) {
    const d = e.data;
    s = d ? JSON.stringify(d.op === e.type ? { ...d, op: undefined } : d) : "";
    if (s === "{}")
      s = "";
    if (s.length > 120)
      s = s.slice(0, 120) + "…";
    if (brief.size > 4000)
      brief.clear();
    brief.set(k, s);
  }
  return s;
}
function DevLog() {
  const { list } = useDevLog2();
  const [kind, setKind] = d("all");
  const [type, setType] = d(null);
  const [query, setQuery] = d("");
  const [paused, setPaused] = d(null);
  const [cleared, setCleared] = d(START);
  const [sel, setSel] = d(null);
  const lastSel = A(null);
  if (sel)
    lastSel.current = sel;
  const scroller = A(null);
  const stuck = A(true);
  const [fresh, setFresh] = d(0);
  const source = paused ?? list;
  const types = T(() => {
    const c = new Map;
    for (const e of source)
      if (isAfter(e, cleared))
        c.set(e.type, (c.get(e.type) ?? 0) + 1);
    return [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_TYPES).map(([t]) => t);
  }, [source, cleared]);
  const q = query.trim().toLowerCase();
  const rows = T(() => source.filter((e) => isAfter(e, cleared) && (kind === "all" || e.kind === kind) && (!type || e.type === type) && (!q || e.type.toLowerCase().includes(q) || summary(e).toLowerCase().includes(q))), [source, cleared, kind, type, q]);
  const prevLen = A(0);
  _(() => {
    const delta = rows.length - prevLen.current;
    prevLen.current = rows.length;
    if (stuck.current)
      requestMutation(() => {
        const el = scroller.current;
        if (el)
          el.scrollTop = rows.length * ROW + 1e4;
      });
    else if (delta > 0)
      setFresh((n) => n + delta);
  }, [rows.length]);
  const onScroll = () => {
    requestMeasure(() => {
      const el = scroller.current;
      if (!el)
        return;
      const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < ROW / 2;
      stuck.current = atEnd;
      if (atEnd)
        requestMutation(() => setFresh(0));
    });
  };
  const toEnd = () => {
    stuck.current = true;
    setFresh(0);
    requestMutation(() => {
      const el = scroller.current;
      if (el)
        el.scrollTop = rows.length * ROW + 1e4;
    });
  };
  const copy = () => {
    const text = JSON.stringify(rows.map(({ key: _k, ...e }) => e), null, 2);
    navigator.clipboard?.writeText(text).then(() => showToast2(`Скопировано событий: ${rows.length}`), () => showToast2("Буфер обмена недоступен"));
  };
  const clear = () => {
    setCleared(cursorAt(list[list.length - 1]));
    setPaused(null);
    setSel(null);
    setFresh(0);
    stuck.current = true;
  };
  const shown = sel ?? lastSel.current;
  return /* @__PURE__ */ u("div", {
    class: "app-dev-log",
    children: [
      /* @__PURE__ */ u("div", {
        class: "app-dev-logtools",
        children: [
          /* @__PURE__ */ u(SearchInput, {
            id: "dev-log-search",
            label: "Поиск по журналу",
            placeholder: "Поиск: тип или данные",
            value: query,
            onInput: (e) => setQuery(e.currentTarget.value)
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u("div", {
            class: "rl-chips app-dev-chips",
            role: "group",
            "aria-label": "Тип события",
            children: KINDS2.map(([k, label]) => /* @__PURE__ */ u(Chip, {
              active: kind === k,
              onClick: () => setKind(k),
              children: label
            }, k, false, undefined, this))
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u("div", {
            class: "rl-chips app-dev-chips",
            role: "group",
            "aria-label": "Кадр",
            children: types.map((t) => /* @__PURE__ */ u(Chip, {
              active: type === t,
              onClick: () => setType(type === t ? null : t),
              children: t
            }, t, false, undefined, this))
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u("div", {
            class: "app-dev-actions",
            children: [
              /* @__PURE__ */ u(Button, {
                variant: "secondary",
                onClick: () => setPaused(paused ? null : list.slice()),
                children: paused ? "Продолжить" : "Пауза"
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u(Button, {
                variant: "secondary",
                onClick: clear,
                children: "Очистить"
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u(Button, {
                variant: "secondary",
                onClick: copy,
                children: "Скопировать как JSON"
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u("span", {
                class: "app-dev-count",
                children: rows.length
              }, undefined, false, undefined, this)
            ]
          }, undefined, true, undefined, this)
        ]
      }, undefined, true, undefined, this),
      /* @__PURE__ */ u("div", {
        class: "app-dev-logscroll",
        ref: scroller,
        onScroll,
        role: "log",
        "aria-live": "off",
        "aria-label": "Журнал событий",
        children: rows.length ? /* @__PURE__ */ u(WindowList, {
          items: rows,
          rowHeight: ROW,
          overscan: 10,
          getKey: (e) => e.key,
          render: (e) => /* @__PURE__ */ u("button", {
            type: "button",
            class: "app-dev-ev app-dev-ev-" + e.kind + (sel?.key === e.key ? " app-dev-ev-on" : ""),
            onClick: () => setSel(sel?.key === e.key ? null : e),
            children: [
              /* @__PURE__ */ u("span", {
                class: "app-dev-ev-t",
                children: stamp(e.t)
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u("span", {
                class: "app-dev-ev-d",
                "aria-label": e.kind,
                children: DIR[e.kind]
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u("span", {
                class: "app-dev-ev-type",
                children: e.type
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u("span", {
                class: "app-dev-ev-sum",
                children: summary(e)
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u("span", {
                class: "app-dev-ev-n",
                children: e.size != null ? `${e.size} Б` : ""
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u("span", {
                class: "app-dev-ev-n",
                children: e.ms != null ? `${e.ms} мс` : ""
              }, undefined, false, undefined, this)
            ]
          }, undefined, true, undefined, this)
        }, undefined, false, undefined, this) : /* @__PURE__ */ u("p", {
          class: "app-dev-empty",
          children: paused ? "Журнал на паузе" : "Событий пока нет"
        }, undefined, false, undefined, this)
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u(Presence, {
        show: fresh > 0,
        exitMs: 160,
        children: /* @__PURE__ */ u("button", {
          type: "button",
          class: "app-dev-fresh",
          onClick: toEnd,
          children: [
            "↓ Новые: ",
            fresh
          ]
        }, undefined, true, undefined, this)
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u(Presence, {
        show: !!sel,
        exitMs: 200,
        children: /* @__PURE__ */ u("div", {
          class: "app-dev-detail",
          children: [
            /* @__PURE__ */ u("div", {
              class: "app-dev-detail-head",
              children: [
                /* @__PURE__ */ u("b", {
                  children: shown ? `#${shown.id} · ${shown.type}` : ""
                }, undefined, false, undefined, this),
                /* @__PURE__ */ u(IconButton, {
                  icon: "close",
                  label: "Закрыть",
                  onClick: () => setSel(null)
                }, undefined, false, undefined, this)
              ]
            }, undefined, true, undefined, this),
            /* @__PURE__ */ u("pre", {
              children: shown ? JSON.stringify((({ key: _k, ...e }) => e)(shown), null, 2) : ""
            }, undefined, false, undefined, this)
          ]
        }, undefined, true, undefined, this)
      }, undefined, false, undefined, this)
    ]
  }, undefined, true, undefined, this);
}

// apps/web/src/ui/settings/DevNetwork.tsx
var PRESETS2 = {
  "3g": { latency: 300, jitter: 0, lossPct: 0, kbps: 400 },
  bad: { latency: 1500, jitter: 0, lossPct: 10, kbps: 0 }
};
var OPTIONS = [
  { value: "none", label: "Нет" },
  { value: "3g", label: "3G (300 мс, 400 Кбит/с)" },
  { value: "bad", label: "Плохая (1500 мс, 10 % потерь)" },
  { value: "custom", label: "Своя" }
];
var same = (a, b) => !!a && !!b && a.latency === b.latency && a.jitter === b.jitter && a.lossPct === b.lossPct && a.kbps === b.kbps;
var presetOf = (p) => !p ? "none" : same(p, PRESETS2["3g"]) ? "3g" : same(p, PRESETS2.bad) ? "bad" : "custom";
var clamp = (v, max) => {
  const n = Math.round(Number(v.replace(",", ".")));
  return Number.isFinite(n) ? Math.max(0, Math.min(max, n)) : 0;
};
function DevNetwork() {
  const sim = useGlobal((s) => s.devSim);
  const stats = useDevStats2();
  const persistKnown = stats?.sim?.persist;
  const [offline, setOffline] = d(!!sim?.offline);
  const [preset, setPreset] = d(presetOf(sim?.profile ?? null));
  const [custom, setCustom] = d(sim?.profile && presetOf(sim.profile) === "custom" ? sim.profile : { latency: 200, jitter: 50, lossPct: 0, kbps: 0 });
  const [persist, setPersist] = d(!!sim?.persist);
  const local = A(0);
  h(() => {
    if (Date.now() - local.current < 1500)
      return;
    setOffline(!!sim?.offline);
    const p = presetOf(sim?.profile ?? null);
    setPreset(p);
    if (p === "custom" && sim?.profile)
      setCustom(sim.profile);
  }, [sim]);
  h(() => {
    if (persistKnown !== undefined && Date.now() - local.current > 1500)
      setPersist(persistKnown);
  }, [persistKnown]);
  const run = (cmd, args, ok) => {
    local.current = Date.now();
    devCall2(cmd, args).then(() => {
      if (ok)
        showToast2(ok);
    }, () => showToast2("Не удалось выполнить команду"));
  };
  const applyProfile = (p, c = custom) => run("netProfile", { profile: p === "none" ? null : p === "custom" ? c : PRESETS2[p], persist });
  const editCustom = (k, max) => (v) => {
    const next = { ...custom, [k]: clamp(v, max) };
    setCustom(next);
    applyProfile("custom", next);
  };
  return /* @__PURE__ */ u("div", {
    class: "rl-settings app-dev-scroll",
    children: [
      /* @__PURE__ */ u(Section, {
        title: "Соединение",
        footer: "Влияет только на этот браузер. Движок закрывает сокет и не переподключается, HTTP-запросы движка отвечают ошибкой сети.",
        children: [
          /* @__PURE__ */ u(InfoRow, {
            icon: "wifiOff",
            title: "Симулировать офлайн",
            trailing: /* @__PURE__ */ u(Switch, {
              id: "dev-offline",
              label: "Симулировать офлайн",
              checked: offline,
              onChange: (e) => {
                const on = e.currentTarget.checked;
                setOffline(on);
                run("offline", { on, persist });
              }
            }, undefined, false, undefined, this)
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u(SelectRow, {
            label: "Медленная сеть",
            value: preset,
            options: OPTIONS,
            onChange: (v) => {
              setPreset(v);
              applyProfile(v);
            }
          }, undefined, false, undefined, this),
          preset === "custom" ? /* @__PURE__ */ u("div", {
            class: "app-dev-custom",
            children: [
              /* @__PURE__ */ u(TextField, {
                label: "Задержка, мс",
                inputMode: "numeric",
                value: String(custom.latency),
                onInput: editCustom("latency", 30000)
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u(TextField, {
                label: "Джиттер, мс",
                inputMode: "numeric",
                value: String(custom.jitter),
                onInput: editCustom("jitter", 1e4)
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u(TextField, {
                label: "Потери, %",
                inputMode: "numeric",
                value: String(custom.lossPct),
                onInput: editCustom("lossPct", 100)
              }, undefined, false, undefined, this)
            ]
          }, undefined, true, undefined, this) : null,
          /* @__PURE__ */ u(CheckRow, {
            label: "Сохранять после перезагрузки",
            subtitle: "Офлайн и медленная сеть останутся включёнными",
            checked: persist,
            onChange: (on) => {
              setPersist(on);
              run("persist", { on });
            }
          }, undefined, false, undefined, this)
        ]
      }, undefined, true, undefined, this),
      /* @__PURE__ */ u(Section, {
        title: "Проверки",
        footer: "Разрыв — код 4000, как обрыв: движок переподключится и догонит журнал через sync.",
        children: [
          /* @__PURE__ */ u(InfoRow, {
            icon: "close",
            title: "Разорвать сокет",
            subtitle: "Переподключение и догон",
            onClick: () => run("dropSocket", undefined, "Сокет разорван")
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u(InfoRow, {
            icon: "alert",
            title: "Дыра в журнале",
            subtitle: "Выбросить один входящий updates",
            onClick: () => run("dropNextUpdates", undefined, "Следующий updates будет выброшен")
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u(InfoRow, {
            icon: "history",
            title: "Принудительный снимок",
            subtitle: "Как будто пришёл tooLong",
            onClick: () => run("forceTooLong", undefined, "Снимок запрошен")
          }, undefined, false, undefined, this)
        ]
      }, undefined, true, undefined, this)
    ]
  }, undefined, true, undefined, this);
}

// apps/web/src/ui/settings/DevOverview.tsx
function useServiceWorker() {
  const [info, setInfo] = d(null);
  h(() => {
    if (!("serviceWorker" in navigator)) {
      setInfo({ state: "не поддерживается", update: false });
      return;
    }
    let reg, alive = true;
    const read = () => {
      if (!alive)
        return;
      if (!reg) {
        setInfo({ state: "не зарегистрирован", update: false });
        return;
      }
      setInfo({ state: reg.installing ? "installing" : reg.waiting ? "waiting" : reg.active ? "active" : "—", update: !!reg.waiting });
    };
    navigator.serviceWorker.getRegistration().then((r) => {
      reg = r;
      r?.addEventListener("updatefound", read);
      read();
    });
    return () => {
      alive = false;
      reg?.removeEventListener("updatefound", read);
    };
  }, []);
  return info;
}
function useStorage(active) {
  const [info, setInfo] = d(null);
  h(() => {
    if (!active)
      return;
    let alive = true;
    const read = async () => {
      const est = await navigator.storage?.estimate?.().catch(() => null);
      const caches_ = [];
      try {
        for (const name of await caches.keys())
          caches_.push([name, (await (await caches.open(name)).keys()).length]);
      } catch {}
      const local = [];
      try {
        for (let i = 0;i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k.startsWith("relay."))
            local.push([k, (localStorage.getItem(k) ?? "").length]);
        }
      } catch {}
      local.sort((a, b) => a[0].localeCompare(b[0]));
      if (alive)
        setInfo({ used: est?.usage ?? null, quota: est?.quota ?? null, caches: caches_, local });
    };
    read();
    const t = setInterval(read, 1e4);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [active]);
  return info;
}
var PHASE = { connecting: "connecting", loading: "loading", updating: "updating", ready: "ready", offline: "offline" };
function DevOverview(props) {
  const active = useGlobal((s) => s.devTab === "overview");
  const st = useDevStats2();
  const m = useMainMetrics2();
  const srv = useServerStats2();
  const sw = useServiceWorker();
  const store = useStorage(active);
  const [busy, setBusy] = d(null);
  const host = st?.host;
  const sync = st?.sync ?? {};
  const sock = st?.socket ?? {};
  const q = st?.queues ?? { outbox: { pending: 0, failed: 0, byChat: {} }, ops: {} };
  const subs = st?.subscriptions ?? [];
  const idb = st?.idb;
  const s = srv.stats;
  const hostName = typeof SharedWorker === "function" ? "SharedWorker" : "Dedicated" + (host?.kind === "dedicated-leader" ? " · данные от лидера (Web Locks)" : "");
  const act = async (cmd) => {
    if (busy)
      return;
    setBusy(cmd);
    try {
      const r = await devCall2(cmd);
      showToast2(cmd === "retryFailed" ? `Снова в очереди: ${r.count}` : `Отброшено: ${r.count}`);
    } catch {
      showToast2("Не удалось выполнить");
    }
    setBusy(null);
  };
  return /* @__PURE__ */ u("div", {
    class: "rl-settings app-dev-scroll",
    children: [
      /* @__PURE__ */ u(Section, {
        title: "Сборка и база",
        children: [
          /* @__PURE__ */ u(KV, {
            label: "Сборка",
            value: "mw6119zf"
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u(KV, {
            label: "Эпоха сервера",
            value: st?.epoch
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u(KV, {
            label: "userId",
            value: num(st?.userId)
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u(KV, {
            label: "Версия IDB",
            value: num(st?.idbVersion)
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u(KV, {
            label: "Service Worker",
            value: sw ? sw.state + (sw.update ? " · есть обновление" : "") : "…",
            warn: sw?.update
          }, undefined, false, undefined, this)
        ]
      }, undefined, true, undefined, this),
      /* @__PURE__ */ u(Section, {
        title: "Воркер",
        children: [
          /* @__PURE__ */ u(KV, {
            label: "Хост",
            value: hostName
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u(KV, {
            label: "Клиентов хоста (порты вкладок)",
            value: num(host?.clients),
            title: "У каждой вкладки два порта: данные и настройки"
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u(KV, {
            label: "Аптайм воркера",
            value: dur(host?.uptimeMs)
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u(KV, {
            label: "Аптайм движка",
            value: dur(st?.engineUptimeMs)
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u(KV, {
            label: "Пульс (ping → pong)",
            value: ms(st?.pingMs)
          }, undefined, false, undefined, this)
        ]
      }, undefined, true, undefined, this),
      /* @__PURE__ */ u(Section, {
        title: "Синхронизация",
        children: [
          /* @__PURE__ */ u(KV, {
            label: "lastSeq клиента",
            value: num(sync.lastSeq)
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u(KV, {
            label: "seq сервера (hello)",
            value: num(sync.serverSeq)
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u(KV, {
            label: "Отставание",
            value: num(sync.lag),
            warn: (sync.lag ?? 0) > 0
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u(KV, {
            label: "Фаза",
            value: PHASE[sync.phase] ?? sync.phase
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u(KV, {
            label: "Последний sync",
            value: ago(sync.lastSyncAt)
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u(KV, {
            label: "tooLong за сессию",
            value: num(sync.tooLongCount)
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u(KV, {
            label: "Сокет",
            value: sock.state,
            warn: sock.state && sock.state !== "open"
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u(KV, {
            label: "Попытка переподключения",
            value: num(sock.attempt)
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u(KV, {
            label: "Следующая задержка",
            value: sock.nextDelay == null ? "—" : ms(sock.nextDelay)
          }, undefined, false, undefined, this)
        ]
      }, undefined, true, undefined, this),
      /* @__PURE__ */ u(Section, {
        title: "Сервер",
        footer: srv.error === "unavailable" ? "Сервер запущен без DEV_LOGIN — статистика недоступна." : srv.error === "offline" ? "Нет ответа сервера." : "GET /dev/stats раз в 2 с, пока открыта эта вкладка.",
        children: [
          /* @__PURE__ */ u(KV, {
            label: "seq пользователя",
            value: num(s?.seq)
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u(KV, {
            label: "Сокетов (этот процесс)",
            value: num(s?.sockets)
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u(KV, {
            label: "Записей журнала",
            value: num(s?.journal.size)
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u(KV, {
            label: "min(seq) журнала",
            value: num(s?.journal.minSeq)
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u(KV, {
            label: "NOTIFY → poke",
            value: s?.notifyMs == null ? "—" : `${s.notifyMs.toFixed(1)} мс`
          }, undefined, false, undefined, this)
        ]
      }, undefined, true, undefined, this),
      /* @__PURE__ */ u(Section, {
        title: "Файлы на сервере",
        footer: "Квота загрузок — окно с первой загрузки в нём; пределы задают UPLOAD_* в окружении сервера.",
        children: [
          /* @__PURE__ */ u(KV, {
            label: "Файлов",
            value: num(s?.storage?.files)
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u(KV, {
            label: "Объём",
            value: s?.storage ? bytes(s.storage.bytes + s.storage.variantsBytes) : "—",
            title: s?.storage ? `оригиналы ${bytes(s.storage.bytes)}, копии видео ${bytes(s.storage.variantsBytes)}` : undefined
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u(KV, {
            label: "Загружается",
            value: s?.storage ? `${s.storage.pending} / ${s.storage.quota.maxPending}` : "—",
            warn: !!s?.storage && s.storage.pending >= s.storage.quota.maxPending
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u(KV, {
            label: "За час",
            value: s?.storage ? `${bytes(s.storage.quota.hourBytes)} / ${bytes(s.storage.quota.bytesPerHour)}` : "—"
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u(KV, {
            label: "За сутки",
            value: s?.storage ? `${bytes(s.storage.quota.dayBytes)} / ${bytes(s.storage.quota.bytesPerDay)}` : "—"
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u(KV, {
            label: "Загрузок за минуту",
            value: s?.storage ? `${s.storage.quota.minuteUploads} / ${s.storage.quota.perMinute}` : "—"
          }, undefined, false, undefined, this)
        ]
      }, undefined, true, undefined, this),
      /* @__PURE__ */ u(Section, {
        title: "Очереди",
        children: [
          /* @__PURE__ */ u(KV, {
            label: "Outbox: в очереди",
            value: num(q.outbox.pending)
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u(KV, {
            label: "Outbox: с ошибкой",
            value: num(q.outbox.failed),
            warn: q.outbox.failed > 0
          }, undefined, false, undefined, this),
          Object.entries(q.outbox.byChat).map(([chat, c]) => /* @__PURE__ */ u(KV, {
            label: "  чат " + chat,
            value: `${c.pending} / ${c.failed}`
          }, chat, false, undefined, this)),
          /* @__PURE__ */ u(KV, {
            label: "pendingReads",
            value: num(q.pendingReads)
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u(KV, {
            label: "Операции настроек",
            value: num(q.ops?.pending),
            title: (q.ops?.keys ?? []).join(", ")
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u(KV, {
            label: "Отказы операций",
            value: num(q.ops?.failures)
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u("div", {
            class: "app-dev-actions",
            children: [
              /* @__PURE__ */ u(Button, {
                variant: "secondary",
                disabled: !!busy,
                onClick: () => void act("retryFailed"),
                children: "Повторить все"
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u(Button, {
                variant: "secondary",
                disabled: !!busy,
                onClick: () => void act("discardFailed"),
                children: "Отбросить failed"
              }, undefined, false, undefined, this)
            ]
          }, undefined, true, undefined, this)
        ]
      }, undefined, true, undefined, this),
      /* @__PURE__ */ u(Section, {
        title: "Подписки",
        children: /* @__PURE__ */ u("div", {
          class: "app-dev-table",
          role: "table",
          "aria-label": "Подписки",
          children: [
            /* @__PURE__ */ u("div", {
              class: "app-dev-tr app-dev-th",
              role: "row",
              children: [
                /* @__PURE__ */ u("span", {
                  role: "columnheader",
                  children: "Подписка"
                }, undefined, false, undefined, this),
                /* @__PURE__ */ u("span", {
                  role: "columnheader",
                  children: "Элем."
                }, undefined, false, undefined, this),
                /* @__PURE__ */ u("span", {
                  role: "columnheader",
                  children: "Патч/с"
                }, undefined, false, undefined, this),
                /* @__PURE__ */ u("span", {
                  role: "columnheader",
                  children: "Байт"
                }, undefined, false, undefined, this),
                /* @__PURE__ */ u("span", {
                  role: "columnheader",
                  children: "Снимок"
                }, undefined, false, undefined, this)
              ]
            }, undefined, true, undefined, this),
            subs.map((x) => /* @__PURE__ */ u("div", {
              class: "app-dev-tr",
              role: "row",
              children: [
                /* @__PURE__ */ u("span", {
                  role: "cell",
                  title: x.key,
                  children: x.key
                }, undefined, false, undefined, this),
                /* @__PURE__ */ u("span", {
                  role: "cell",
                  children: num(x.items)
                }, undefined, false, undefined, this),
                /* @__PURE__ */ u("span", {
                  role: "cell",
                  children: typeof x.patchesPerSec === "number" ? x.patchesPerSec.toFixed(1) : "—"
                }, undefined, false, undefined, this),
                /* @__PURE__ */ u("span", {
                  role: "cell",
                  children: x.lastPatchBytes == null ? "—" : num(x.lastPatchBytes)
                }, undefined, false, undefined, this),
                /* @__PURE__ */ u("span", {
                  role: "cell",
                  children: x.sinceSnapshotMs == null ? "—" : dur(x.sinceSnapshotMs)
                }, undefined, false, undefined, this)
              ]
            }, x.id, true, undefined, this))
          ]
        }, undefined, true, undefined, this)
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u(Section, {
        title: "Хранилище",
        children: [
          /* @__PURE__ */ u(KV, {
            label: "Использовано",
            value: store ? bytes(store.used) : "…"
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u(KV, {
            label: "Квота",
            value: store ? bytes(store.quota) : "…"
          }, undefined, false, undefined, this),
          idb ? Object.entries(idb).map(([k, n]) => /* @__PURE__ */ u(KV, {
            label: "IDB · " + k,
            value: num(n)
          }, k, false, undefined, this)) : /* @__PURE__ */ u(KV, {
            label: "IDB",
            value: "…"
          }, undefined, false, undefined, this),
          store?.caches.map(([k, n]) => /* @__PURE__ */ u(KV, {
            label: "Cache · " + k,
            value: num(n) + " записей"
          }, "c" + k, false, undefined, this)),
          store?.local.map(([k, n]) => /* @__PURE__ */ u(KV, {
            label: "localStorage · " + k,
            value: bytes(n)
          }, "l" + k, false, undefined, this))
        ]
      }, undefined, true, undefined, this),
      /* @__PURE__ */ u(Section, {
        title: "Главный поток",
        footer: "Считается, только пока открыт этот раздел.",
        children: [
          /* @__PURE__ */ u(KV, {
            label: "FPS",
            value: m?.fps == null ? "…" : String(m.fps),
            warn: m?.fps != null && m.fps < 50
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u(KV, {
            label: "Long tasks за минуту",
            value: m?.longTasks ? `${m.longTasks.count} · макс. ${ms(m.longTasks.maxMs)}` : "не поддерживается"
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u(KV, {
            label: "Кадр: measure / mutate",
            value: m ? `${m.frame.measures} / ${m.frame.mutations}` : "…"
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u(KV, {
            label: "isHeavyAnimating",
            value: m ? m.frame.heavy ? "да" : "нет" : "…"
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u(KV, {
            label: "Отложено deferDuringAnimation",
            value: m ? `${num(m.frame.deferred)} · ждут ${m.frame.waiting}` : "…"
          }, undefined, false, undefined, this),
          m?.memory ? /* @__PURE__ */ u(KV, {
            label: "Память JS",
            value: `${bytes(m.memory.used)} / ${bytes(m.memory.limit)}`
          }, undefined, false, undefined, this) : null,
          /* @__PURE__ */ u(KV, {
            label: "DOM-узлов",
            value: m ? num(m.domNodes) : "…"
          }, undefined, false, undefined, this)
        ]
      }, undefined, true, undefined, this),
      /* @__PURE__ */ u(Section, {
        footer: "Раздел снова откроется после пяти нажатий на заголовок «Настройки».",
        children: /* @__PURE__ */ u(InfoRow, {
          icon: "close",
          title: "Скрыть раздел",
          onClick: props.onHide
        }, undefined, false, undefined, this)
      }, undefined, false, undefined, this)
    ]
  }, undefined, true, undefined, this);
}

// apps/web/src/devtools/recorder.ts
var MAX_MS = 30000;
var SLOW_MS = 25;
var ANIMS_MAX = 6;
var rec = null;
var rafId = 0;
var last = 0;
var t0 = 0;
var observer = null;
var lastResult = null;
var subs = new Set;
var emit = () => {
  for (const fn of subs) {
    try {
      fn();
    } catch {}
  }
};
function animLabel(a) {
  if (a.playState !== "running")
    return null;
  const css = a;
  if (css.animationName)
    return css.animationName;
  if (css.transitionProperty)
    return "transition " + css.transitionProperty;
  const target = a.effect?.target;
  const cls = target?.classList?.[0];
  return cls ? cls + " (waapi)" : "waapi";
}
function frame(now) {
  if (!rec)
    return;
  const ms = now - last;
  last = now;
  const anims = [];
  for (const a of document.getAnimations()) {
    const n = animLabel(a);
    if (n && !anims.includes(n)) {
      anims.push(n);
      if (anims.length >= ANIMS_MAX)
        break;
    }
  }
  rec.frames.push({ t: Math.round(now - t0), ms: Math.round(ms * 10) / 10, heavy: isHeavyAnimating(), drive: activeDrives() > 0, stickers: stickerStats().playing, anims });
  if (now - t0 >= MAX_MS) {
    stopRecording();
    return;
  }
  rafId = requestAnimationFrame(frame);
  if (rec.frames.length % 15 === 0)
    emit();
}
function startRecording() {
  if (rec)
    return;
  t0 = last = performance.now();
  rec = { startedAt: Date.now(), frames: [], longTasks: [] };
  try {
    if (PerformanceObserver.supportedEntryTypes?.includes("longtask")) {
      observer = new PerformanceObserver((list) => {
        for (const e of list.getEntries())
          rec?.longTasks.push({ t: Math.round(e.startTime - t0), ms: Math.round(e.duration) });
      });
      observer.observe({ type: "longtask" });
    }
  } catch {
    observer = null;
  }
  rafId = requestAnimationFrame(frame);
  emit();
}
function stopRecording() {
  if (!rec)
    return lastResult;
  cancelAnimationFrame(rafId);
  rafId = 0;
  observer?.disconnect();
  observer = null;
  lastResult = rec;
  rec = null;
  emit();
  return lastResult;
}
var isRecording = () => rec != null;
var currentRecording = () => rec ?? lastResult;
function clearRecording() {
  if (rec)
    return;
  lastResult = null;
  emit();
}
function subscribeRecording(fn) {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}
var pct = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] : 0;
function summarize(r) {
  const fr = r.frames.slice(1);
  const durs = fr.map((f) => f.ms).sort((a, b) => a - b);
  const durationMs = r.frames.length ? r.frames[r.frames.length - 1].t : 0;
  return {
    frames: fr.length,
    durationMs,
    fps: durationMs > 0 ? Math.round(fr.length * 1000 / durationMs) : 0,
    p50: pct(durs, 0.5),
    p95: pct(durs, 0.95),
    max: durs.length ? durs[durs.length - 1] : 0,
    slow: fr.filter((f) => f.ms > SLOW_MS).length,
    jank: fr.filter((f) => f.ms > 50).length,
    slowest: fr.filter((f) => f.ms > SLOW_MS).sort((a, b) => b.ms - a.ms).slice(0, 30),
    longTasks: r.longTasks.length,
    longTasksMs: r.longTasks.reduce((s, x) => s + x.ms, 0)
  };
}
function frameTags(f) {
  const tags = [];
  if (f.drive)
    tags.push("прокрутка ленты");
  if (f.heavy)
    tags.push("тяжёлая анимация");
  if (f.stickers)
    tags.push(`стикеров играет: ${f.stickers}`);
  return tags.concat(f.anims);
}

// apps/web/src/ui/settings/DevPerf.tsx
var ms1 = (n) => `${n.toLocaleString("ru-RU", { maximumFractionDigits: 1 })} мс`;
function useRecording() {
  const [, bump] = d(0);
  h(() => subscribeRecording(() => bump((n) => n + 1)), []);
  return { rec: currentRecording(), on: isRecording() };
}
async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast2("Скопировано");
  } catch {
    showToast2("Не удалось скопировать");
  }
}
function FrameChart({ rec }) {
  const ref = A(null);
  _(() => {
    const c = ref.current;
    if (!c)
      return;
    requestMeasure(() => {
      const cs = getComputedStyle(c);
      const col = (v, d) => cs.getPropertyValue(v).trim() || d;
      const ok = col("--brand", "#3c9"), bad = col("--danger", "#e53935"), grid = col("--line-strong", "#888"), band = col("--ink-muted", "#888");
      const { width: W, height: H } = c, top = 100, chartH = H - 14;
      const ctx = c.getContext("2d");
      if (!ctx)
        return;
      ctx.clearRect(0, 0, W, H);
      const frames = rec.frames.slice(1);
      const end = Math.max(1, rec.frames.length ? rec.frames[rec.frames.length - 1].t : 1);
      const x = (t) => t / end * W;
      const y = (v) => chartH - Math.min(v, top) / top * chartH;
      ctx.globalAlpha = 0.18;
      ctx.fillStyle = band;
      for (const f of frames)
        if (f.drive || f.heavy)
          ctx.fillRect(x(f.t - f.ms), chartH + 4, Math.max(1, x(f.ms)), 8);
      ctx.globalAlpha = 1;
      for (const f of frames) {
        ctx.fillStyle = f.ms > SLOW_MS ? bad : ok;
        const bx = x(f.t - f.ms), bw = Math.max(1, x(f.ms) - 0.5);
        ctx.fillRect(bx, y(f.ms), bw, chartH - y(f.ms));
      }
      ctx.strokeStyle = grid;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      for (const v of [16.7, 33.3]) {
        ctx.beginPath();
        ctx.moveTo(0, Math.round(y(v)) + 0.5);
        ctx.lineTo(W, Math.round(y(v)) + 0.5);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    });
  }, [rec, rec.frames.length]);
  return /* @__PURE__ */ u("div", {
    class: "app-perf-chart",
    children: [
      /* @__PURE__ */ u("canvas", {
        ref,
        width: 880,
        height: 240,
        role: "img",
        "aria-label": "Длина кадров во время записи"
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u("div", {
        class: "app-perf-legend",
        children: [
          /* @__PURE__ */ u("span", {
            children: "пунктир — 16,7 и 33,3 мс (60 и 30 к/с)"
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u("span", {
            children: "полоса снизу — прокрутка ленты / тяжёлая анимация"
          }, undefined, false, undefined, this)
        ]
      }, undefined, true, undefined, this)
    ]
  }, undefined, true, undefined, this);
}
function Recorder() {
  const { rec, on } = useRecording();
  const s = rec && !on ? summarize(rec) : null;
  const elapsed = rec && rec.frames.length ? rec.frames[rec.frames.length - 1].t : 0;
  return /* @__PURE__ */ u(Section, {
    title: "Запись кадров",
    children: [
      /* @__PURE__ */ u("p", {
        class: "app-perf-hint",
        children: [
          "Начните запись, сделайте действие в приложении (отправка, прокрутка, открытие панели) и остановите. Запись сама закончится через ",
          MAX_MS / 1000,
          " с."
        ]
      }, undefined, true, undefined, this),
      /* @__PURE__ */ u("div", {
        class: "app-dev-actions",
        children: [
          on ? /* @__PURE__ */ u(Button, {
            onClick: () => stopRecording(),
            children: "Стоп"
          }, undefined, false, undefined, this) : /* @__PURE__ */ u(Button, {
            onClick: () => startRecording(),
            children: rec ? "Записать заново" : "Начать запись"
          }, undefined, false, undefined, this),
          on ? /* @__PURE__ */ u("span", {
            class: "app-perf-live",
            children: [
              /* @__PURE__ */ u("i", {
                "aria-hidden": "true"
              }, undefined, false, undefined, this),
              "Идёт запись: ",
              (elapsed / 1000).toFixed(1),
              " с · ",
              num(rec?.frames.length),
              " кадров"
            ]
          }, undefined, true, undefined, this) : null,
          s && rec ? /* @__PURE__ */ u(Button, {
            variant: "secondary",
            onClick: () => void copy(JSON.stringify({ summary: s, ...rec }, null, 1)),
            children: "Скопировать как JSON"
          }, undefined, false, undefined, this) : null,
          s ? /* @__PURE__ */ u(Button, {
            variant: "secondary",
            onClick: () => clearRecording(),
            children: "Очистить"
          }, undefined, false, undefined, this) : null
        ]
      }, undefined, true, undefined, this),
      s && rec ? /* @__PURE__ */ u(S, {
        children: [
          /* @__PURE__ */ u(FrameChart, {
            rec
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u(KV, {
            label: "Длительность / кадров",
            value: `${(s.durationMs / 1000).toFixed(1)} с · ${num(s.frames)}`
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u(KV, {
            label: "Кадров в секунду",
            value: num(s.fps),
            warn: s.fps < 50
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u(KV, {
            label: "Кадр: медиана",
            value: ms1(s.p50)
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u(KV, {
            label: "Кадр: 95% / самый долгий",
            value: `${ms1(s.p95)} / ${ms1(s.max)}`,
            warn: s.max > 50
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u(KV, {
            label: `Медленных (> ${SLOW_MS} мс) / рывков (> 50 мс)`,
            value: `${num(s.slow)} / ${num(s.jank)}`,
            warn: s.jank > 0
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u(KV, {
            label: "Долгих задач (всего)",
            value: s.longTasks ? `${num(s.longTasks)} (${ms1(s.longTasksMs)})` : "0",
            warn: s.longTasks > 0
          }, undefined, false, undefined, this),
          s.slowest.length ? /* @__PURE__ */ u("div", {
            class: "app-perf-slow",
            role: "list",
            "aria-label": "Медленные кадры",
            children: s.slowest.map((f) => /* @__PURE__ */ u("div", {
              class: "app-perf-row",
              role: "listitem",
              children: [
                /* @__PURE__ */ u("b", {
                  class: f.ms > 50 ? "is-jank" : "",
                  children: ms1(f.ms)
                }, undefined, false, undefined, this),
                /* @__PURE__ */ u("span", {
                  class: "app-perf-at",
                  children: [
                    "+",
                    (f.t / 1000).toFixed(2),
                    " с"
                  ]
                }, undefined, true, undefined, this),
                /* @__PURE__ */ u("span", {
                  class: "app-perf-tags",
                  children: frameTags(f).join(" · ") || "ничего из отслеживаемого"
                }, undefined, false, undefined, this)
              ]
            }, f.t, true, undefined, this))
          }, undefined, false, undefined, this) : /* @__PURE__ */ u("p", {
            class: "app-dev-empty",
            children: "Медленных кадров нет"
          }, undefined, false, undefined, this),
          rec.longTasks.length ? /* @__PURE__ */ u("div", {
            class: "app-perf-slow",
            role: "list",
            "aria-label": "Долгие задачи",
            children: rec.longTasks.map((t) => /* @__PURE__ */ u("div", {
              class: "app-perf-row",
              role: "listitem",
              children: [
                /* @__PURE__ */ u("b", {
                  class: "is-jank",
                  children: ms1(t.ms)
                }, undefined, false, undefined, this),
                /* @__PURE__ */ u("span", {
                  class: "app-perf-at",
                  children: [
                    "+",
                    (t.t / 1000).toFixed(2),
                    " с"
                  ]
                }, undefined, true, undefined, this),
                /* @__PURE__ */ u("span", {
                  class: "app-perf-tags",
                  children: "долгая задача главного потока"
                }, undefined, false, undefined, this)
              ]
            }, t.t, true, undefined, this))
          }, undefined, false, undefined, this) : null
        ]
      }, undefined, true, undefined, this) : null
    ]
  }, undefined, true, undefined, this);
}
function Stickers() {
  const read = () => ({ p: stickerDetail(), r: lottieStats() });
  const [st, setSt] = d(read);
  h(() => {
    const id = setInterval(() => setSt(read()), 500);
    return () => clearInterval(id);
  }, []);
  const { p, r } = st;
  const groups = Object.entries(p.groups).sort((a, b) => b[1].views - a[1].views);
  return /* @__PURE__ */ u(Section, {
    title: "Анимации стикеров",
    children: [
      /* @__PURE__ */ u(KV, {
        label: "Проигрывателей / играют",
        value: `${num(p.players)} / ${num(p.playing)}`
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u(KV, {
        label: "Канвасов (видов) / видимых",
        value: `${num(p.views)} / ${num(p.visible)}`
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u(KV, {
        label: "Ждут рендерер",
        value: num(p.loading)
      }, undefined, false, undefined, this),
      groups.map(([g, v]) => /* @__PURE__ */ u(KV, {
        label: `  группа «${g}»: видов / играют`,
        value: `${num(v.views)} / ${num(v.playing)}`
      }, g, false, undefined, this)),
      /* @__PURE__ */ u(KV, {
        label: "Играет только группа",
        value: p.exclusive ?? "—"
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u(KV, {
        label: "Автовоспроизведение / цикл",
        value: `${p.policy.autoplay ? "да" : "нет"} / ${p.policy.loop ? "да" : "нет"}`
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u(KV, {
        label: "Рендереров (анимация × размер)",
        value: num(r.renderers)
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u(KV, {
        label: "Кадров в памяти (кэш + заготовки)",
        value: `${num(r.cachedFrames)} + ${num(r.looseFrames)}`
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u(KV, {
        label: "Память кадров (≈ ш × в × 4)",
        value: bytes(r.bytes),
        warn: r.bytes > 64 * 1024 * 1024
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u(KV, {
        label: "Бюджет кэша кадров",
        value: bytes(r.budget)
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u(KV, {
        label: "Кадров рисуется сейчас",
        value: num(r.pendingFrames)
      }, undefined, false, undefined, this),
      r.workers.map((w) => /* @__PURE__ */ u(KV, {
        label: `  воркер ${w.index + 1}: рендереров / в работе`,
        value: w.started ? `${num(w.renderers)} / ${num(w.inflight)}` : "не запущен"
      }, w.index, false, undefined, this))
    ]
  }, undefined, true, undefined, this);
}
function Strict() {
  const [, bump] = d(0);
  h(() => subscribeStrictDom(() => bump((n) => n + 1)), []);
  const on = strictDomEnabled();
  const sites = on ? strictDomReport().sort((a, b) => b.count - a.count) : [];
  const [open, setOpen] = d(null);
  return /* @__PURE__ */ u(Section, {
    title: "Строгий DOM",
    children: !on ? /* @__PURE__ */ u(S, {
      children: [
        /* @__PURE__ */ u("p", {
          class: "app-perf-hint",
          children: "Проверка порядка «чтение раскладки → запись» в каждом кадре. В рабочей сборке выключена: перехват всех чтений и записей замедляет страницу. Можно включить до перезагрузки."
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u("div", {
          class: "app-dev-actions",
          children: /* @__PURE__ */ u(Button, {
            variant: "secondary",
            onClick: () => {
              enableStrictDom({ ignore: /twallpaper/ });
              bump((n) => n + 1);
              showToast2("Проверка включена до перезагрузки");
            },
            children: "Включить проверку"
          }, undefined, false, undefined, this)
        }, undefined, false, undefined, this)
      ]
    }, undefined, true, undefined, this) : /* @__PURE__ */ u(S, {
      children: [
        /* @__PURE__ */ u(KV, {
          label: "Мест с нарушениями",
          value: num(sites.length),
          warn: sites.length > 0
        }, undefined, false, undefined, this),
        sites.length ? /* @__PURE__ */ u("div", {
          class: "app-perf-slow",
          role: "list",
          "aria-label": "Нарушения порядка DOM",
          children: sites.map((v) => {
            const key = v.kind + v.prop + v.at;
            return /* @__PURE__ */ u("div", {
              class: "app-perf-strict",
              role: "listitem",
              children: [
                /* @__PURE__ */ u("button", {
                  type: "button",
                  class: "app-perf-row",
                  "aria-expanded": open === key ? "true" : "false",
                  onClick: () => setOpen(open === key ? null : key),
                  children: [
                    /* @__PURE__ */ u("b", {
                      children: [
                        "×",
                        num(v.count)
                      ]
                    }, undefined, true, undefined, this),
                    /* @__PURE__ */ u("span", {
                      class: "app-perf-tags",
                      children: [
                        /* @__PURE__ */ u("em", {
                          children: v.kind
                        }, undefined, false, undefined, this),
                        " — ",
                        v.prop,
                        v.phase ? ` (фаза ${v.phase})` : "",
                        /* @__PURE__ */ u("br", {}, undefined, false, undefined, this),
                        v.at
                      ]
                    }, undefined, true, undefined, this)
                  ]
                }, undefined, true, undefined, this),
                open === key && v.stack ? /* @__PURE__ */ u("pre", {
                  class: "app-dev-pre",
                  children: v.stack
                }, undefined, false, undefined, this) : null
              ]
            }, key, true, undefined, this);
          })
        }, undefined, false, undefined, this) : /* @__PURE__ */ u("p", {
          class: "app-dev-empty",
          children: "Нарушений нет"
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u("div", {
          class: "app-dev-actions",
          children: [
            sites.length ? /* @__PURE__ */ u(Button, {
              variant: "secondary",
              onClick: () => void copy(JSON.stringify(sites.map(({ stack, ...x }) => x), null, 1)),
              children: "Скопировать"
            }, undefined, false, undefined, this) : null,
            sites.length ? /* @__PURE__ */ u(Button, {
              variant: "secondary",
              onClick: () => strictDomReset(),
              children: "Очистить"
            }, undefined, false, undefined, this) : null
          ]
        }, undefined, true, undefined, this)
      ]
    }, undefined, true, undefined, this)
  }, undefined, false, undefined, this);
}
function DevPerf() {
  return /* @__PURE__ */ u("div", {
    class: "rl-settings app-dev-scroll",
    children: [
      /* @__PURE__ */ u(Recorder, {}, undefined, false, undefined, this),
      /* @__PURE__ */ u(Stickers, {}, undefined, false, undefined, this),
      /* @__PURE__ */ u(Strict, {}, undefined, false, undefined, this)
    ]
  }, undefined, true, undefined, this);
}

// apps/web/src/ui/settings/Dev.tsx
var TABS = ["overview", "perf", "log", "network", "data", "errors"];
var LABELS = { overview: "Обзор", perf: "Кадры", log: "Журнал", network: "Сеть", data: "Данные", errors: "Ошибки" };
function useNewErrors(active) {
  const [n, setN] = d(newErrorCount2());
  h(() => subscribeErrors2(() => {
    if (active)
      markErrorsSeen2();
    setN(newErrorCount2());
  }), [active]);
  h(() => {
    if (active)
      markErrorsSeen2();
    setN(newErrorCount2());
  }, [active]);
  return n;
}
function Dev() {
  const tab = useGlobal((s) => s.devTab);
  const errs = useNewErrors(tab === "errors");
  h(() => {
    return openDevSession2();
  }, []);
  h(() => {
    setServerPolling2(tab === "overview");
    return () => setServerPolling2(false);
  }, [tab]);
  const hide = () => {
    back().then(() => setPref("dev.enabled", false));
  };
  return /* @__PURE__ */ u("div", {
    class: "rl-sidepage app-dev",
    "aria-label": "Для разработчиков",
    children: [
      /* @__PURE__ */ u(PanelHeader, {
        icon: "arrowLeft",
        closeLabel: "Назад",
        title: "Для разработчиков",
        onClose: () => void back()
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u("div", {
        class: "app-dev-tabs",
        children: /* @__PURE__ */ u(FolderTabs, {
          label: "Вкладки раздела",
          active: tab,
          onChange: (t) => setGlobal({ devTab: t }),
          items: TABS.map((t) => ({ id: t, label: LABELS[t], count: t === "errors" && errs ? errs : undefined }))
        }, undefined, false, undefined, this)
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u("div", {
        class: "app-dev-pages",
        children: /* @__PURE__ */ u(SlideStack, {
          variant: "tabs",
          order: TABS,
          active: tab,
          render: (k) => k === "overview" ? /* @__PURE__ */ u(DevOverview, {
            onHide: hide
          }, undefined, false, undefined, this) : k === "perf" ? /* @__PURE__ */ u(DevPerf, {}, undefined, false, undefined, this) : k === "log" ? /* @__PURE__ */ u(DevLog, {}, undefined, false, undefined, this) : k === "network" ? /* @__PURE__ */ u(DevNetwork, {}, undefined, false, undefined, this) : k === "data" ? /* @__PURE__ */ u(DevData, {}, undefined, false, undefined, this) : /* @__PURE__ */ u(DevErrors, {}, undefined, false, undefined, this)
        }, undefined, false, undefined, this)
      }, undefined, false, undefined, this)
    ]
  }, undefined, true, undefined, this);
}
// apps/web/src/ui/settings/FolderEmojiPicker.tsx
var W = 382;
var H = 420;
var GAP = 8;
var MARGIN = 8;
function pickerPosition(btn, vw, vh) {
  const left = Math.max(MARGIN, Math.min(btn.left - 12, vw - W - MARGIN));
  const below = btn.bottom + GAP;
  if (below + H <= vh - MARGIN)
    return { left, top: below, up: false };
  const above = btn.top - GAP - H;
  if (above >= MARGIN)
    return { left, top: above, up: true };
  return { left, top: Math.max(MARGIN, vh - H - MARGIN), up: false };
}
var animKey = (e) => e.replace(/\uFE0F/g, "");
var EXIT_MS = 150;
function FolderEmojiPicker({ open, at, selected, onPick, onClose }) {
  const [mounted, setMounted] = d(open);
  const last = A(at);
  if (open && at)
    last.current = at;
  h(() => {
    const end = beginHeavyAnimation(open ? 200 : EXIT_MS);
    if (open) {
      setMounted(true);
      return end;
    }
    const t = setTimeout(() => setMounted(false), reducedMotion() ? 0 : EXIT_MS);
    return () => {
      clearTimeout(t);
      end();
    };
  }, [open]);
  const close = A(onClose);
  close.current = onClose;
  h(() => {
    if (!open)
      return;
    const onEsc = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close.current();
      }
    };
    window.addEventListener("keydown", onEsc, true);
    return () => window.removeEventListener("keydown", onEsc, true);
  }, [open]);
  const pos = last.current;
  if (!(mounted || open) || !pos)
    return null;
  return $(/* @__PURE__ */ u("div", {
    class: "rl app-folder-sym-root",
    "data-state": open ? "open" : "closing",
    children: [
      open ? /* @__PURE__ */ u("div", {
        class: "rl-pop-scrim",
        onClick: onClose,
        onContextMenu: (e) => {
          e.preventDefault();
          onClose();
        }
      }, undefined, false, undefined, this) : null,
      /* @__PURE__ */ u("div", {
        class: "app-sym app-folder-sym" + (pos.up ? " is-up" : ""),
        role: "dialog",
        "aria-modal": "true",
        "aria-label": "Иконка папки",
        "data-esc-layer": open ? "" : undefined,
        inert: !open || undefined,
        style: { left: pos.left + "px", top: pos.top + "px" },
        children: /* @__PURE__ */ u(Picker, {
          selected,
          onPick
        }, undefined, false, undefined, this)
      }, undefined, false, undefined, this)
    ]
  }, undefined, true, undefined, this), document.body);
}
function Picker({ selected, onPick }) {
  useAnimatedEmoji(true);
  return /* @__PURE__ */ u(EmojiTab2, {
    selected,
    animate: (e) => animatedEmojiUrl(animKey(e)),
    onPick
  }, undefined, false, undefined, this);
}

// apps/web/src/ui/settings/FolderEdit.tsx
var COLOR_NAMES = ["Красный", "Оранжевый", "Фиолетовый", "Зелёный", "Бирюзовый", "Синий", "Розовый"];
var INCLUDE_TYPES = [
  { key: "contacts", icon: "contacts", title: "Контакты" },
  { key: "nonContacts", icon: "account", title: "Не контакты" },
  { key: "groups", icon: "community", title: "Группы" }
];
var EXCLUDE_TYPES = [
  { key: "excludeMuted", icon: "bellOff", title: "Без звука" },
  { key: "excludeRead", icon: "check", title: "Прочитанные" }
];
var blank = (id) => ({ id, title: "", emoji: null, color: null, include: [], exclude: [], contacts: false, nonContacts: false, groups: false, excludeMuted: false, excludeRead: false });
var same2 = (a, b) => JSON.stringify(normalizeFolder(a)) === JSON.stringify(normalizeFolder(b));
var SHOWN = 5;
function useDraft(path) {
  const seg = path.split("/")[2];
  const folders = useGlobal((s) => s.settings.folders);
  const draft = useGlobal((s) => s.folderDraft);
  const isNew = seg === "new";
  const id = isNew ? null : Number(seg);
  const existing = id === null ? null : folders.find((f) => f.id === id) ?? null;
  const fits = draft && (isNew ? draft.isNew : draft.id === id && !draft.isNew);
  h(() => {
    if (fits)
      return;
    if (isNew) {
      const f = blank(nextFolderId(folders));
      setGlobal({ folderDraft: { id: f.id, isNew: true, folder: f, original: f } });
    } else if (existing)
      setGlobal({ folderDraft: { id: existing.id, isNew: false, folder: existing, original: existing } });
  }, [fits, isNew, existing]);
  return fits ? draft : null;
}
var editDraft = (patch) => {
  const d = getGlobal().folderDraft;
  if (d)
    setGlobal({ folderDraft: { ...d, folder: { ...d.folder, ...patch } } });
};
function FolderEdit({ path }) {
  const draft = useDraft(path);
  const chats = useGlobal((s) => s.chats);
  const [more, setMore] = d({ include: false, exclude: false });
  const [askLeave, setAskLeave] = d(null);
  const [askDelete, setAskDelete] = d(false);
  const [err, setErr] = d(null);
  const [picker, setPicker] = d(null);
  const [pickerOpen, setPickerOpen] = d(false);
  const input = A(null);
  const f = draft?.folder;
  const dirty = !!draft && (draft.isNew || !same2(draft.folder, draft.original));
  const deeper = A(false);
  h(() => {
    if (!dirty) {
      setLeaveGuard(null);
      return;
    }
    setLeaveGuard(() => {
      if (deeper.current) {
        deeper.current = false;
        return true;
      }
      if (getGlobal().sidebarView !== path)
        return true;
      return new Promise((resolve) => setAskLeave(() => resolve));
    });
    return () => setLeaveGuard(null);
  }, [dirty, path]);
  h(() => {
    if (draft?.isNew)
      setTimeout(() => input.current?.querySelector("input")?.focus({ preventScroll: true }), 300);
  }, [draft?.isNew]);
  if (!draft || !f)
    return /* @__PURE__ */ u("div", {
      class: "rl-sidepage",
      children: /* @__PURE__ */ u(PanelHeader, {
        icon: "arrowLeft",
        closeLabel: "Назад",
        title: "Папка",
        onClose: () => void back()
      }, undefined, false, undefined, this)
    }, undefined, false, undefined, this);
  const toChild = (kind) => {
    deeper.current = true;
    go(`${path}/${kind}`).finally(() => {
      deeper.current = false;
    });
  };
  const leaveAnswer = (ok) => {
    askLeave?.(ok);
    setAskLeave(null);
    if (ok)
      setGlobal({ folderDraft: null });
  };
  const byId = new Map(chats.map((c) => [c.id, c]));
  const chatRow = (id, list) => {
    const c = byId.get(id);
    const name = c?.title || "Чат №" + id;
    return /* @__PURE__ */ u("div", {
      class: "app-folder-chat",
      children: [
        /* @__PURE__ */ u(Avatar, {
          name,
          tone: chatTone(c ?? { id }),
          size: 40,
          logo: isSystemChat(c),
          saved: isSavedChat(c),
          ...avatarPhoto(c?.photo)
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u("span", {
          class: "rl-inforow-text",
          children: [
            /* @__PURE__ */ u("span", {
              children: name
            }, undefined, false, undefined, this),
            /* @__PURE__ */ u("small", {
              children: c?.kind === "group" ? "группа" : "личный чат"
            }, undefined, false, undefined, this)
          ]
        }, undefined, true, undefined, this),
        /* @__PURE__ */ u(IconButton, {
          icon: "close",
          label: "Убрать " + name,
          onClick: () => editDraft({ [list]: f[list].filter((x) => x !== id) })
        }, undefined, false, undefined, this)
      ]
    }, list + id, true, undefined, this);
  };
  const typeRow = (t) => /* @__PURE__ */ u("div", {
    class: "app-folder-chat",
    children: [
      /* @__PURE__ */ u("span", {
        class: "app-folder-type",
        "aria-hidden": "true",
        children: /* @__PURE__ */ u(Icon, {
          name: t.icon,
          size: 22
        }, undefined, false, undefined, this)
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u("span", {
        class: "rl-inforow-text",
        children: /* @__PURE__ */ u("span", {
          children: t.title
        }, undefined, false, undefined, this)
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u(IconButton, {
        icon: "close",
        label: "Убрать «" + t.title + "»",
        onClick: () => editDraft({ [t.key]: false })
      }, undefined, false, undefined, this)
    ]
  }, t.key, true, undefined, this);
  const list = (kind) => {
    const types = (kind === "include" ? INCLUDE_TYPES : EXCLUDE_TYPES).filter((t) => f[t.key]);
    const rows = [...types.map((t) => typeRow(t)), ...f[kind].map((id) => chatRow(id, kind))];
    const open = more[kind] || rows.length <= SHOWN + 1;
    return /* @__PURE__ */ u(S, {
      children: [
        open ? rows : rows.slice(0, SHOWN),
        !open ? /* @__PURE__ */ u(InfoRow, {
          icon: "chevronDown",
          title: `Показать ещё ${rows.length - SHOWN}`,
          onClick: () => setMore({ ...more, [kind]: true })
        }, undefined, false, undefined, this) : null
      ]
    }, undefined, true, undefined, this);
  };
  const save = () => {
    const n = normalizeFolder(f);
    const e = n ? folderError(n) : "folder_title";
    if (!n || e) {
      setErr(failText2(e));
      return;
    }
    setLeaveGuard(null);
    setGlobal({ folderDraft: null });
    saveFolder2(n).catch(() => showToast2("Не удалось сохранить папку"));
    back();
  };
  const remove = () => {
    setAskDelete(false);
    setLeaveGuard(null);
    setGlobal({ folderDraft: null });
    deleteFolder2(f.id).catch(() => showToast2("Не удалось удалить папку"));
    back();
  };
  const titleErr = err && err.startsWith("Укажите название") ? err : null;
  return /* @__PURE__ */ u("div", {
    class: "rl-sidepage",
    "aria-label": draft.isNew ? "Новая папка" : "Изменить папку",
    children: [
      /* @__PURE__ */ u(PanelHeader, {
        icon: "arrowLeft",
        closeLabel: "Назад",
        title: draft.isNew ? "Новая папка" : "Изменить папку",
        onClose: () => void back()
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u("div", {
        class: "rl-settings",
        children: [
          /* @__PURE__ */ u(FolderHero, {
            emoji: f.emoji
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u(Section, {
            title: "Название папки",
            footer: "Эмодзи станет иконкой папки во вкладках. Нажмите выбранный ещё раз, чтобы убрать его.",
            children: /* @__PURE__ */ u("div", {
              ref: input,
              children: /* @__PURE__ */ u(TextField, {
                value: f.title,
                maxLength: FOLDER_LIMITS.title,
                measure: graphemes,
                counter: FOLDER_LIMITS.title - graphemes(f.title) <= Math.round(FOLDER_LIMITS.title / 3),
                label: "Название папки",
                error: titleErr ?? undefined,
                onInput: (v) => {
                  setErr(null);
                  editDraft({ title: v });
                },
                onKeyDown: (e) => {
                  if (e.key === "Enter")
                    save();
                },
                trailing: /* @__PURE__ */ u("button", {
                  type: "button",
                  class: "app-folder-emoji-trigger" + (f.emoji ? " has-emoji" : "") + (pickerOpen ? " is-open" : ""),
                  "aria-haspopup": "dialog",
                  "aria-expanded": pickerOpen,
                  "aria-label": f.emoji ? "Иконка папки: " + f.emoji : "Выбрать иконку папки",
                  title: "Иконка папки",
                  onClick: (e) => {
                    if (pickerOpen) {
                      setPickerOpen(false);
                      return;
                    }
                    const r = e.currentTarget.getBoundingClientRect();
                    setPicker(pickerPosition(r, document.documentElement.clientWidth, innerHeight));
                    setPickerOpen(true);
                  },
                  children: f.emoji ? /* @__PURE__ */ u("span", {
                    class: "app-folder-emoji-glyph",
                    children: f.emoji
                  }, f.emoji, false, undefined, this) : /* @__PURE__ */ u(Icon, {
                    name: "smile",
                    size: 24
                  }, undefined, false, undefined, this)
                }, undefined, false, undefined, this)
              }, undefined, false, undefined, this)
            }, undefined, false, undefined, this)
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u(FolderEmojiPicker, {
            open: pickerOpen,
            at: picker,
            selected: f.emoji,
            onPick: (e) => {
              editDraft({ emoji: f.emoji === e ? null : e });
              setPickerOpen(false);
            },
            onClose: () => setPickerOpen(false)
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u(Section, {
            title: "Включённые чаты",
            footer: "Чаты и типы чатов, которые будут в этой папке.",
            children: [
              /* @__PURE__ */ u(InfoRow, {
                icon: "plus",
                title: "Добавить чаты",
                onClick: () => toChild("include")
              }, undefined, false, undefined, this),
              list("include")
            ]
          }, undefined, true, undefined, this),
          /* @__PURE__ */ u(Section, {
            title: "Исключённые чаты",
            footer: "Этих чатов в папке не будет, даже если они подходят по типу.",
            children: [
              /* @__PURE__ */ u(InfoRow, {
                icon: "plus",
                title: "Исключить чаты",
                onClick: () => toChild("exclude")
              }, undefined, false, undefined, this),
              list("exclude")
            ]
          }, undefined, true, undefined, this),
          /* @__PURE__ */ u(Section, {
            title: /* @__PURE__ */ u("span", {
              class: "app-folder-color-title",
              children: [
                /* @__PURE__ */ u("span", {
                  children: "Цвет папки в списке чатов"
                }, undefined, false, undefined, this),
                f.color !== null ? /* @__PURE__ */ u("span", {
                  class: "rl-tag app-folder-color-preview",
                  style: { "--tag": `var(--peer-${f.color})`, "--tag-bg": `var(--peer-${f.color}-bg)` },
                  children: f.title.trim() || "Папка"
                }, f.color, false, undefined, this) : null
              ]
            }, undefined, true, undefined, this),
            footer: f.color !== null ? "Название папки будет тегом у её чатов в списке." : "Без цвета у чатов нет тега этой папки.",
            children: /* @__PURE__ */ u("div", {
              class: "app-folder-colors",
              role: "radiogroup",
              "aria-label": "Цвет тега папки",
              children: [
                Array.from({ length: FOLDER_COLORS }, (_, i) => /* @__PURE__ */ u("button", {
                  type: "button",
                  role: "radio",
                  "aria-checked": f.color === i ? "true" : "false",
                  "aria-label": COLOR_NAMES[i],
                  title: COLOR_NAMES[i],
                  class: "app-folder-color",
                  style: { "--c": `var(--peer-${i})` },
                  onClick: () => editDraft({ color: i })
                }, i, false, undefined, this)),
                /* @__PURE__ */ u("button", {
                  type: "button",
                  role: "radio",
                  "aria-checked": f.color === null ? "true" : "false",
                  "aria-label": "Без цвета",
                  title: "Без цвета",
                  class: "app-folder-color is-none",
                  onClick: () => editDraft({ color: null }),
                  children: /* @__PURE__ */ u(Icon, {
                    name: "close",
                    size: 20
                  }, undefined, false, undefined, this)
                }, undefined, false, undefined, this)
              ]
            }, undefined, true, undefined, this)
          }, undefined, false, undefined, this),
          err && !titleErr ? /* @__PURE__ */ u("div", {
            class: "app-folder-err",
            role: "alert",
            children: err
          }, undefined, false, undefined, this) : null,
          !draft.isNew ? /* @__PURE__ */ u(Section, {
            children: /* @__PURE__ */ u(InfoRow, {
              icon: "trash",
              danger: true,
              title: "Удалить папку",
              onClick: () => setAskDelete(true)
            }, undefined, false, undefined, this)
          }, undefined, false, undefined, this) : null
        ]
      }, undefined, true, undefined, this),
      /* @__PURE__ */ u(Presence, {
        show: dirty,
        exitMs: 200,
        children: /* @__PURE__ */ u("div", {
          class: "rl-fab-slot",
          children: /* @__PURE__ */ u(Fab, {
            icon: "check",
            label: "Сохранить",
            onClick: save
          }, undefined, false, undefined, this)
        }, undefined, false, undefined, this)
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u(ConfirmDialog, {
        open: !!askLeave,
        danger: true,
        title: "Сбросить изменения?",
        text: "Правки папки не сохранятся.",
        confirm: "Сбросить",
        onCancel: () => leaveAnswer(false),
        onConfirm: () => leaveAnswer(true)
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u(ConfirmDialog, {
        open: askDelete,
        danger: true,
        title: "Удалить папку?",
        text: `Папка «${draft.original.title}» исчезнет на всех устройствах. Чаты останутся.`,
        confirm: "Удалить",
        onCancel: () => setAskDelete(false),
        onConfirm: remove
      }, undefined, false, undefined, this)
    ]
  }, undefined, true, undefined, this);
}
function FolderHero({ emoji }) {
  useAnimatedEmoji(!!emoji);
  const [replay, setReplay] = d(0);
  const [failed, setFailed] = d(null);
  const src = emoji && failed !== emoji ? animatedEmojiUrl(emoji.replace(/\uFE0F/g, "")) : undefined;
  return /* @__PURE__ */ u("div", {
    class: "app-folder-hero",
    children: emoji ? /* @__PURE__ */ u("span", {
      class: "app-folder-hero-emoji",
      children: src ? /* @__PURE__ */ u(StickerView, {
        src,
        w: 512,
        h: 512,
        size: 100,
        group: "menu",
        loop: false,
        replay,
        force: true,
        title: emoji,
        play: !reducedMotion(),
        onError: () => setFailed(emoji),
        onClick: () => setReplay((n) => n + 1)
      }, undefined, false, undefined, this) : /* @__PURE__ */ u("span", {
        class: "app-folder-hero-glyph",
        "aria-hidden": "true",
        children: emoji
      }, undefined, false, undefined, this)
    }, emoji, false, undefined, this) : /* @__PURE__ */ u("span", {
      class: "app-folder-hero-emoji",
      children: /* @__PURE__ */ u(Sticker, {
        name: "folderNew",
        size: 100,
        replay: "click"
      }, undefined, false, undefined, this)
    }, "folder", false, undefined, this)
  }, undefined, false, undefined, this);
}

// apps/web/src/ui/settings/FolderChats.tsx
var TYPE_TONE = { contacts: "blue", nonContacts: "orange", groups: "green", excludeMuted: "gray", excludeRead: "purple" };
function PickRow({ on, onToggle, lead, title, sub }) {
  return /* @__PURE__ */ u("button", {
    type: "button",
    role: "checkbox",
    "aria-checked": on ? "true" : "false",
    class: "app-fpick-row" + (on ? " app-fpick-on" : ""),
    onPointerDown: ripple,
    onClick: onToggle,
    children: [
      lead,
      /* @__PURE__ */ u("span", {
        class: "app-fpick-text",
        children: [
          /* @__PURE__ */ u("span", {
            children: title
          }, undefined, false, undefined, this),
          sub ? /* @__PURE__ */ u("small", {
            children: sub
          }, undefined, false, undefined, this) : null
        ]
      }, undefined, true, undefined, this),
      /* @__PURE__ */ u("span", {
        class: "app-fpick-check",
        "aria-hidden": "true",
        children: /* @__PURE__ */ u(Icon, {
          name: "check",
          size: 14,
          strokeWidth: 3
        }, undefined, false, undefined, this)
      }, undefined, false, undefined, this)
    ]
  }, undefined, true, undefined, this);
}
function FolderChats({ path }) {
  const kind = path.endsWith("/exclude") ? "exclude" : "include";
  const other = kind === "include" ? "exclude" : "include";
  const draft = useDraft(path);
  const chats = useGlobal((s) => s.chats);
  const [q, setQ] = d("");
  const title = kind === "include" ? "Добавить чаты" : "Исключить чаты";
  if (!draft)
    return /* @__PURE__ */ u("div", {
      class: "rl-sidepage",
      children: /* @__PURE__ */ u(PanelHeader, {
        icon: "arrowLeft",
        closeLabel: "Назад",
        title,
        onClose: () => void back()
      }, undefined, false, undefined, this)
    }, undefined, false, undefined, this);
  const f = draft.folder;
  const types = kind === "include" ? INCLUDE_TYPES : EXCLUDE_TYPES;
  const picked = new Set(f[kind]);
  const needle = q.trim().toLowerCase();
  const nameOf = (c) => c.title || "Чат №" + c.id;
  const byId = new Map(chats.map((c) => [c.id, c]));
  const list = needle ? chats.filter((c) => nameOf(c).toLowerCase().includes(needle)) : chats;
  const shownTypes = needle ? types.filter((t) => t.title.toLowerCase().includes(needle)) : types;
  const toggleChat = (id) => {
    if (picked.has(id)) {
      editDraft({ [kind]: f[kind].filter((x) => x !== id) });
      return;
    }
    if (f[kind].length >= FOLDER_LIMITS.chats) {
      showToast2("В папке может быть не больше 200 чатов");
      return;
    }
    editDraft({ [kind]: [...f[kind], id], [other]: f[other].filter((x) => x !== id) });
  };
  const toggleType = (k) => editDraft({ [k]: !f[k] });
  const chips = [
    ...types.filter((t) => f[t.key]).map((t) => ({ key: t.key, label: t.title, onRemove: () => toggleType(t.key) })),
    ...f[kind].map((id) => ({ key: "c" + id, label: nameOf(byId.get(id) ?? { id }), onRemove: () => toggleChat(id) }))
  ];
  const count = chips.length;
  return /* @__PURE__ */ u("div", {
    class: "rl-sidepage",
    "aria-label": title,
    children: [
      /* @__PURE__ */ u(PanelHeader, {
        icon: "arrowLeft",
        closeLabel: "Готово",
        title: count ? `${title} · ${count}` : title,
        onClose: () => void back()
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u("div", {
        class: "app-fpick-top",
        children: /* @__PURE__ */ u(SearchInput, {
          id: "app-fpick-q",
          class: "app-fpick-field",
          label: "Поиск чатов",
          icon: !count,
          value: q,
          onChange: setQ,
          placeholder: count ? "" : "Поиск чатов",
          onKeyDown: (e) => {
            if (e.key === "Backspace" && !q && chips.length) {
              e.preventDefault();
              chips[chips.length - 1].onRemove();
            }
          },
          children: chips.map((c) => /* @__PURE__ */ u("button", {
            type: "button",
            class: "app-fpick-chip",
            onClick: c.onRemove,
            "aria-label": "Убрать " + c.label,
            children: [
              /* @__PURE__ */ u("span", {
                children: c.label
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u(Icon, {
                name: "close",
                size: 14
              }, undefined, false, undefined, this)
            ]
          }, c.key, true, undefined, this))
        }, undefined, false, undefined, this)
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u("div", {
        class: "rl-page-scroll app-fpick",
        children: [
          shownTypes.length ? /* @__PURE__ */ u(S, {
            children: [
              /* @__PURE__ */ u("div", {
                class: "app-fpick-caption",
                children: "Типы чатов"
              }, undefined, false, undefined, this),
              shownTypes.map((t) => /* @__PURE__ */ u(PickRow, {
                on: !!f[t.key],
                onToggle: () => toggleType(t.key),
                title: t.title,
                lead: /* @__PURE__ */ u("span", {
                  class: "app-fpick-tile app-fpick-tile-" + TYPE_TONE[t.key],
                  "aria-hidden": "true",
                  children: /* @__PURE__ */ u(Icon, {
                    name: t.icon,
                    size: 22
                  }, undefined, false, undefined, this)
                }, undefined, false, undefined, this)
              }, t.key, false, undefined, this))
            ]
          }, undefined, true, undefined, this) : null,
          /* @__PURE__ */ u("div", {
            class: "app-fpick-caption",
            children: "Чаты"
          }, undefined, false, undefined, this),
          list.length ? list.map((c) => /* @__PURE__ */ u(PickRow, {
            on: picked.has(c.id),
            onToggle: () => toggleChat(c.id),
            title: nameOf(c),
            sub: c.kind === "group" ? "группа" : "личный чат",
            lead: /* @__PURE__ */ u(Avatar, {
              name: nameOf(c),
              tone: chatTone(c),
              size: 42,
              logo: isSystemChat(c),
              saved: isSavedChat(c),
              ...avatarPhoto(c.photo)
            }, undefined, false, undefined, this)
          }, c.id, false, undefined, this)) : /* @__PURE__ */ u("div", {
            class: "app-fpick-empty",
            children: needle ? `Нет чатов по запросу «${q.trim()}»` : "Чаты появятся здесь, когда загрузятся."
          }, undefined, false, undefined, this)
        ]
      }, undefined, true, undefined, this)
    ]
  }, undefined, true, undefined, this);
}
// apps/web/src/ui/settings/Folders.tsx
function FolderGlyph({ f, size = 26 }) {
  const ic = folderIcon(f);
  return "emoji" in ic ? /* @__PURE__ */ u("span", {
    class: "app-folder-glyph",
    style: { fontSize: size - 2 + "px" },
    "aria-hidden": "true",
    children: ic.emoji
  }, undefined, false, undefined, this) : /* @__PURE__ */ u("span", {
    class: "app-folder-glyph",
    "aria-hidden": "true",
    children: /* @__PURE__ */ u(Icon, {
      name: ic.icon,
      size
    }, undefined, false, undefined, this)
  }, undefined, false, undefined, this);
}
function Folders() {
  const folders = useGlobal((s) => s.settings.folders);
  const chats = useGlobal((s) => s.chats);
  const pos = useGlobal((s) => s.prefs.folders.position);
  const view = useGlobal((s) => s.sidebarView);
  h(() => {
    if (view === "settings/folders" && getGlobal().folderDraft)
      setGlobal({ folderDraft: null });
  }, [view]);
  const wide = useWide();
  const ctx = useFolderCtx();
  const [drag, setDrag] = d(null);
  const [settling, setSettling] = d(false);
  const [ask, setAsk] = d(null);
  const dragRef = A(null);
  dragRef.current = drag;
  const full = folders.length >= FOLDER_LIMITS.folders;
  const recs = recommendedFor(folders);
  const create = () => full ? showToast2("Можно создать не больше 10 папок") : void go("settings/folders/new");
  const reorder = (from, to) => {
    reorderFolders2(moveItem(folders, from, to).map((f) => f.id)).catch(() => showToast2("Не удалось сохранить порядок"));
  };
  const onDown = (i) => (e) => {
    if (e.button !== 0)
      return;
    const row = e.currentTarget.closest(".app-link-row");
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
    setDrag({ from: i, to: i, dy: 0, rowH: row.getBoundingClientRect().height, y0: e.clientY, id: e.pointerId });
  };
  const onMove = (e) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.id)
      return;
    const dy = Math.max(-d.from * d.rowH, Math.min((folders.length - 1 - d.from) * d.rowH, e.clientY - d.y0));
    setDrag({ ...d, dy, to: dropIndex(d.from, dy, d.rowH, folders.length) });
  };
  const onUp = (e) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.id)
      return;
    setDrag(null);
    if (d.to !== d.from) {
      setSettling(true);
      requestAnimationFrame(() => requestAnimationFrame(() => setSettling(false)));
      reorder(d.from, d.to);
    }
  };
  const onKey = (i) => (e) => {
    if (!e.altKey || e.key !== "ArrowUp" && e.key !== "ArrowDown")
      return;
    e.preventDefault();
    const to = i + (e.key === "ArrowUp" ? -1 : 1);
    if (to < 0 || to >= folders.length)
      return;
    reorder(i, to);
    const host = e.currentTarget.parentElement?.parentElement;
    requestAnimationFrame(() => host?.querySelectorAll(".app-link-open")[to]?.focus());
  };
  return /* @__PURE__ */ u("div", {
    class: "rl-sidepage",
    "aria-label": "Папки с чатами",
    children: [
      /* @__PURE__ */ u(PanelHeader, {
        icon: "arrowLeft",
        closeLabel: "Назад",
        title: "Папки с чатами",
        onClose: () => void back()
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u("div", {
        class: "rl-settings",
        children: [
          /* @__PURE__ */ u("div", {
            class: "app-folders-intro",
            children: [
              /* @__PURE__ */ u(Sticker, {
                name: "folder",
                size: 100,
                replay: "click"
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u("p", {
                children: "Создавайте папки для разных групп чатов и быстро переключайтесь между ними."
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u(Button, {
                variant: "primary",
                "data-setting": "folders.create",
                onClick: create,
                children: [
                  /* @__PURE__ */ u(Icon, {
                    name: "plus",
                    size: 20
                  }, undefined, false, undefined, this),
                  " Создать папку"
                ]
              }, undefined, true, undefined, this)
            ]
          }, undefined, true, undefined, this),
          /* @__PURE__ */ u(Section, {
            title: "Папки",
            footer: folders.length > 1 ? "Перетащите папку за ручку справа, чтобы поменять порядок вкладок." : undefined,
            children: [
              /* @__PURE__ */ u(InfoRow, {
                icon: "chats",
                title: "Все чаты",
                subtitle: "Все чаты без исключений"
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u("div", {
                class: "app-links-list" + (drag ? " app-links-dragging" : "") + (settling ? " app-links-settling" : ""),
                role: "list",
                "aria-label": "Свои папки",
                children: folders.map((f, i) => {
                  const dragging = drag?.from === i;
                  const shift = drag && !dragging ? shiftFor(i, drag.from, drag.to) * drag.rowH : 0;
                  return /* @__PURE__ */ u("div", {
                    role: "listitem",
                    class: "app-link-row" + (dragging ? " app-link-row-drag" : ""),
                    style: { transform: dragging ? `translateY(${drag.dy}px)` : shift ? `translateY(${shift}px)` : undefined },
                    children: [
                      /* @__PURE__ */ u("button", {
                        type: "button",
                        class: "app-link-open",
                        onClick: () => void go("settings/folders/" + f.id),
                        onKeyDown: onKey(i),
                        "aria-label": `Папка «${f.title}». Изменить`,
                        "aria-keyshortcuts": "Alt+ArrowUp Alt+ArrowDown",
                        children: [
                          /* @__PURE__ */ u(FolderGlyph, {
                            f
                          }, undefined, false, undefined, this),
                          /* @__PURE__ */ u("span", {
                            class: "rl-inforow-text",
                            children: [
                              /* @__PURE__ */ u("span", {
                                children: f.title
                              }, undefined, false, undefined, this),
                              /* @__PURE__ */ u("small", {
                                children: folderSubtitle(f, folderChats(f, chats, ctx).length)
                              }, undefined, false, undefined, this)
                            ]
                          }, undefined, true, undefined, this)
                        ]
                      }, undefined, true, undefined, this),
                      /* @__PURE__ */ u(IconButton, {
                        icon: "trash",
                        label: `Удалить папку «${f.title}»`,
                        onClick: () => setAsk(f)
                      }, undefined, false, undefined, this),
                      folders.length > 1 ? /* @__PURE__ */ u("span", {
                        class: "app-link-grip",
                        title: "Перетащите, чтобы поменять порядок",
                        "aria-hidden": "true",
                        onPointerDown: onDown(i),
                        onPointerMove: onMove,
                        onPointerUp: onUp,
                        onPointerCancel: onUp,
                        children: /* @__PURE__ */ u(Icon, {
                          name: "grip",
                          size: 22
                        }, undefined, false, undefined, this)
                      }, undefined, false, undefined, this) : null
                    ]
                  }, f.id, true, undefined, this);
                })
              }, undefined, false, undefined, this),
              !folders.length ? /* @__PURE__ */ u("div", {
                class: "app-folders-none",
                children: "Своих папок пока нет."
              }, undefined, false, undefined, this) : null
            ]
          }, undefined, true, undefined, this),
          recs.length && !full ? /* @__PURE__ */ u(Section, {
            title: "Рекомендуемые папки",
            children: recs.map((r) => /* @__PURE__ */ u("div", {
              class: "app-folder-rec",
              children: [
                /* @__PURE__ */ u("span", {
                  class: "rl-inforow-text",
                  children: [
                    /* @__PURE__ */ u("span", {
                      children: r.folder.title
                    }, undefined, false, undefined, this),
                    /* @__PURE__ */ u("small", {
                      children: r.description
                    }, undefined, false, undefined, this)
                  ]
                }, undefined, true, undefined, this),
                /* @__PURE__ */ u(Button, {
                  variant: "primary",
                  class: "rl-btn-tiny",
                  onClick: () => saveFolder2({ ...r.folder, id: nextFolderId(folders) }).catch(() => showToast2("Не удалось добавить папку")),
                  children: "Добавить"
                }, undefined, false, undefined, this)
              ]
            }, r.key, true, undefined, this))
          }, undefined, false, undefined, this) : null,
          /* @__PURE__ */ u(Section, {
            setting: "folders.position",
            title: "Вид вкладок",
            role: "radiogroup",
            footer: wide ? undefined : "На узком окне вкладки всегда сверху.",
            children: [
              /* @__PURE__ */ u(RadioRow, {
                setting: "folders.position.left",
                checked: pos === "left",
                label: "Слева",
                subtitle: "Колонкой рядом со списком чатов",
                onClick: () => setPref("folders.position", "left")
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u(RadioRow, {
                setting: "folders.position.top",
                checked: pos === "top",
                label: "Сверху",
                subtitle: "Полосой над списком чатов",
                onClick: () => setPref("folders.position", "top")
              }, undefined, false, undefined, this)
            ]
          }, undefined, true, undefined, this)
        ]
      }, undefined, true, undefined, this),
      /* @__PURE__ */ u(ConfirmDialog, {
        open: !!ask,
        danger: true,
        title: "Удалить папку?",
        confirm: "Удалить",
        text: ask ? `Папка «${ask.title}» исчезнет на всех устройствах. Чаты останутся.` : "",
        onCancel: () => setAsk(null),
        onConfirm: () => {
          const id = ask.id;
          setAsk(null);
          deleteFolder2(id).catch(() => showToast2("Не удалось удалить папку"));
        }
      }, undefined, false, undefined, this)
    ]
  }, undefined, true, undefined, this);
}
// apps/web/src/ui/settings/General.tsx
var THEME_TITLES = { classic: "Классическая", night: "Ночь", day: "День", tinted: "Тёмная", system: "Как в системе" };
var THEMES = ["classic", "night", "day", "tinted", "system"];
var swatchOf = (p) => {
  const b = p.settings.bubble;
  return b && b.length > 1 ? `linear-gradient(135deg, ${b[0]}, ${b[1]})` : b?.[0] && b[0].toLowerCase() !== "#ffffff" && p.settings.accent === b[0] ? b[0] : p.settings.accent;
};
function Accents({ base }) {
  const choice = useGlobal((s) => s.prefs.themes[base]);
  const pick = (preset) => setPrefs({ [`themes.${base}.preset`]: preset, [`themes.${base}.catalog`]: null });
  const items = [
    { id: null, name: "Как в теме", bg: BASE_ACCENT[base] },
    ...PRESETS[base].map((p, i) => ({ id: p.id, name: "Набор " + (i + 1), bg: swatchOf(p) }))
  ];
  return /* @__PURE__ */ u("div", {
    class: "app-accents",
    role: "radiogroup",
    "aria-label": "Цвет",
    children: items.map((a) => {
      const on = !choice.catalog && choice.preset === a.id;
      return /* @__PURE__ */ u("button", {
        type: "button",
        role: "radio",
        class: "app-accent",
        "aria-checked": on ? "true" : "false",
        "aria-label": a.name,
        title: a.name,
        style: { "--swatch": a.bg.startsWith("linear") ? "var(--brand)" : a.bg, background: a.bg },
        onClick: () => pick(a.id)
      }, a.id ?? "default", false, undefined, this);
    })
  }, undefined, false, undefined, this);
}
var isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
function useNow() {
  const [now, setNow] = d(() => new Date);
  h(() => {
    let t;
    const tick = () => {
      setNow(new Date);
      t = setTimeout(tick, 60000 - Date.now() % 60000 + 50);
    };
    t = setTimeout(tick, 60000 - Date.now() % 60000 + 50);
    return () => clearTimeout(t);
  }, []);
  return now;
}
function General() {
  const prefs = useGlobal((s) => s.prefs);
  const base = useBase();
  const { dark, wp, key } = useWallpaper();
  const wpImage = useWallpaperImage(key, wp.image);
  const scroll = useScrollMemory("settings/general");
  const now = useNow();
  const fmt = prefs.timeFormat ?? localeTimeFormat();
  return /* @__PURE__ */ u("div", {
    class: "rl-sidepage",
    "aria-label": "Общие настройки",
    children: [
      /* @__PURE__ */ u(PanelHeader, {
        icon: "arrowLeft",
        closeLabel: "Назад",
        title: "Общие настройки",
        onClose: () => void back()
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u("div", {
        class: "rl-settings",
        ref: scroll.ref,
        onScroll: scroll.onScroll,
        children: [
          /* @__PURE__ */ u(Section, {
            title: "Настройки",
            children: [
              /* @__PURE__ */ u("div", {
                class: "app-textpreview",
                style: wpImage ? { background: `center / cover no-repeat url("${wpImage}")` } : { background: swatchBackground(wp.colors, dark) },
                "aria-hidden": "true",
                children: [
                  /* @__PURE__ */ u(Bubble, {
                    from: "in",
                    tail: true,
                    time: hm(now),
                    children: "Привет! Так выглядит ваш текст."
                  }, undefined, false, undefined, this),
                  /* @__PURE__ */ u(Bubble, {
                    from: "out",
                    tail: true,
                    time: hm(now),
                    status: "read",
                    children: "Отлично, размер подходит."
                  }, undefined, false, undefined, this)
                ]
              }, undefined, true, undefined, this),
              /* @__PURE__ */ u(RangeRow, {
                setting: "general.textSize",
                label: "Размер текста сообщений",
                min: 12,
                max: 20,
                step: 1,
                value: prefs.textSize,
                onChange: (v) => setPref("textSize", v)
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u(InfoRow, {
                icon: "image",
                title: "Обои чата",
                onClick: () => void go("settings/general/wallpaper"),
                trailing: /* @__PURE__ */ u("span", {
                  class: "app-swatch-mini",
                  "aria-hidden": "true",
                  children: wpImage ? /* @__PURE__ */ u("span", {
                    class: "app-swatch-fill app-swatch-photo",
                    style: { backgroundImage: `url("${wpImage}")` }
                  }, undefined, false, undefined, this) : /* @__PURE__ */ u(Swatch, {
                    pattern: wp.pattern,
                    colors: wp.colors,
                    dark,
                    intensity: wp.intensity
                  }, undefined, false, undefined, this)
                }, undefined, false, undefined, this)
              }, undefined, false, undefined, this)
            ]
          }, undefined, true, undefined, this),
          /* @__PURE__ */ u(Section, {
            setting: "general.theme",
            title: "Цветовая тема",
            children: [
              /* @__PURE__ */ u(ThemeTiles, {
                base
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u("div", {
                role: "radiogroup",
                "aria-label": "Тема",
                children: THEMES.map((t) => /* @__PURE__ */ u(RadioRow, {
                  setting: "general.theme." + t,
                  label: THEME_TITLES[t],
                  checked: prefs.theme === t,
                  onClick: () => setPref("theme", t),
                  subtitle: t === "system" ? `Днём — ${THEME_TITLES[prefs.lastLight].toLowerCase()}, ночью — ${THEME_TITLES[prefs.lastDark].toLowerCase()}` : undefined
                }, t, false, undefined, this))
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u("div", {
                "data-setting": "general.accent",
                children: /* @__PURE__ */ u(Accents, {
                  base
                }, undefined, false, undefined, this)
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u(CheckRow, {
                setting: "general.contrast",
                label: "Повышенная контрастность",
                subtitle: "Текст и ссылки ярче на любом фоне",
                checked: prefs.contrast,
                onChange: (v) => setPref("contrast", v)
              }, undefined, false, undefined, this)
            ]
          }, undefined, true, undefined, this),
          /* @__PURE__ */ u(Section, {
            setting: "general.timeFormat",
            title: "Формат времени",
            role: "radiogroup",
            children: [
              /* @__PURE__ */ u(RadioRow, {
                setting: "general.timeFormat.12h",
                label: "12 часов",
                subtitle: hm(now, "12h"),
                checked: fmt === "12h",
                onClick: () => setPref("timeFormat", "12h")
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u(RadioRow, {
                setting: "general.timeFormat.24h",
                label: "24 часа",
                subtitle: hm(now, "24h"),
                checked: fmt === "24h",
                onClick: () => setPref("timeFormat", "24h")
              }, undefined, false, undefined, this)
            ]
          }, undefined, true, undefined, this),
          /* @__PURE__ */ u(Section, {
            setting: "general.sendKey",
            title: "Клавиатура",
            role: "radiogroup",
            children: [
              /* @__PURE__ */ u(RadioRow, {
                setting: "general.sendKey.enter",
                label: "Enter — отправить, Shift+Enter — новая строка",
                checked: prefs.sendKey === "enter",
                onClick: () => setPref("sendKey", "enter")
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u(RadioRow, {
                setting: "general.sendKey.ctrlEnter",
                label: isMac ? "⌘+Enter — отправить" : "Ctrl+Enter — отправить",
                subtitle: "Enter — новая строка",
                checked: prefs.sendKey === "ctrlEnter",
                onClick: () => setPref("sendKey", "ctrlEnter")
              }, undefined, false, undefined, this)
            ]
          }, undefined, true, undefined, this),
          /* @__PURE__ */ u(Section, {
            children: /* @__PURE__ */ u(InfoRow, {
              icon: "keyboard",
              title: "Сочетания клавиш",
              onClick: () => void go("settings/general/shortcuts")
            }, undefined, false, undefined, this)
          }, undefined, false, undefined, this)
        ]
      }, undefined, true, undefined, this)
    ]
  }, undefined, true, undefined, this);
}
// apps/web/src/settingsSearch/entries.ts
var dev = (c) => c.dev;
var hasPw = (c) => c.hasPassword === true;
var noPw = (c) => c.hasPassword === false;
var PROFILE = "settings/profile";
var GENERAL = "settings/general";
var WP = "settings/general/wallpaper";
var NOTIFY = "settings/notifications";
var PRIVACY = "settings/privacy";
var PASSWORD = "settings/privacy/password";
var DATA = "settings/data";
var PERF = "settings/performance";
var FOLDERS = "settings/folders";
var SESSIONS = "settings/sessions";
var RULES = [
  ["phone", "Номер телефона", ["кто видит номер", "телефон"]],
  ["lastSeen", "Последний визит и «в сети»", ["онлайн", "был в сети", "время захода", "статус"]],
  ["bio", "О себе", ["кто видит описание"]],
  ["birthday", "День рождения", ["кто видит дату рождения"]],
  ["calls", "Звонки", ["кто может звонить", "звонок", "созвон"]],
  ["p2p", "Пиринговые соединения", ["p2p", "ip-адрес", "напрямую", "turn"]]
];
var AUTOLOAD = [["photo", "Фото"], ["video", "Видео"], ["file", "Файлы"]];
var AUTOLOAD_ROWS = [["contacts", "Контакты"], ["private", "Личные чаты"], ["groups", "Группы"]];
var ENTRIES = [
  { id: "profile", path: PROFILE, title: "Аккаунт", kind: "section", icon: "account", tile: "blue", keywords: ["профиль", "изменить профиль"] },
  { id: "profile.firstName", path: PROFILE, title: "Имя", kind: "row", keywords: ["изменить имя"] },
  { id: "profile.lastName", path: PROFILE, title: "Фамилия", kind: "row" },
  { id: "profile.bio", path: PROFILE, title: "О себе", kind: "row", keywords: ["био", "описание"] },
  { id: "profile.username", path: PROFILE, title: "Имя пользователя", kind: "row", keywords: ["username", "юзернейм", "ник", "логин", "ссылка на профиль"] },
  { id: "profile.birthday", path: PROFILE, title: "День рождения", kind: "row", keywords: ["дата рождения"] },
  { id: "profile.photo", path: PROFILE, title: "Фото профиля", kind: "row", keywords: ["аватар", "аватарка", "сменить фото", "поставить фото"] },
  { id: "profile.links", path: "settings/profile/links", title: "Ссылки", kind: "section", keywords: ["соцсети", "сайт"] },
  { id: "profile.links.add", path: "settings/profile/links", title: "Добавить ссылку", kind: "row" },
  { id: "general", path: GENERAL, title: "Общие настройки", kind: "section", icon: "general", tile: "orange", keywords: ["основные", "оформление", "внешний вид"] },
  { id: "general.textSize", path: GENERAL, title: "Размер текста сообщений", kind: "row", keywords: ["шрифт", "крупный текст", "масштаб"] },
  { id: "general.theme", path: GENERAL, title: "Цветовая тема", kind: "subsection", keywords: ["тема", "оформление", "внешний вид"] },
  { id: "general.themeTiles", path: GENERAL, parent: "general.theme", title: "Готовые темы", kind: "row", keywords: ["темы", "эмодзи", "плитки"] },
  { id: "general.theme.classic", path: GENERAL, parent: "general.theme", title: "Классическая", kind: "option", keywords: ["светлая тема", "светлая", "зелёная"] },
  { id: "general.theme.night", path: GENERAL, parent: "general.theme", title: "Ночь", kind: "option", keywords: ["ночной режим", "ночная тема", "тёмная тема", "dark"] },
  { id: "general.theme.day", path: GENERAL, parent: "general.theme", title: "День", kind: "option", keywords: ["дневной режим", "светлая тема", "синяя"] },
  { id: "general.theme.tinted", path: GENERAL, parent: "general.theme", title: "Тёмная", kind: "option", keywords: ["тёмная тема", "цветная тёмная", "dark blue"] },
  { id: "general.theme.system", path: GENERAL, parent: "general.theme", title: "Как в системе", kind: "option", keywords: ["автоматически", "системная тема"] },
  { id: "general.accent", path: GENERAL, parent: "general.theme", title: "Цвет", kind: "row", keywords: ["цвет акцента", "цветовая схема", "цвет интерфейса", "акцент"] },
  { id: "general.contrast", path: GENERAL, parent: "general.theme", title: "Повышенная контрастность", kind: "toggle", keywords: ["контраст", "доступность", "плохое зрение"] },
  { id: "general.timeFormat", path: GENERAL, title: "Формат времени", kind: "subsection", keywords: ["часы"] },
  { id: "general.timeFormat.12h", path: GENERAL, parent: "general.timeFormat", title: "12 часов", kind: "option", keywords: ["am pm"] },
  { id: "general.timeFormat.24h", path: GENERAL, parent: "general.timeFormat", title: "24 часа", kind: "option" },
  { id: "general.sendKey", path: GENERAL, title: "Клавиатура", kind: "subsection", keywords: ["отправка сообщений", "enter"] },
  { id: "general.sendKey.enter", path: GENERAL, parent: "general.sendKey", title: "Enter — отправить, Shift+Enter — новая строка", kind: "option" },
  { id: "general.sendKey.ctrlEnter", path: GENERAL, parent: "general.sendKey", title: "Ctrl+Enter — отправить", kind: "option", keywords: ["cmd enter", "command enter"] },
  { id: "general.shortcuts", path: "settings/general/shortcuts", title: "Сочетания клавиш", kind: "section", keywords: ["горячие клавиши", "хоткеи", "шорткаты"] },
  ...shortcutSections("enter").flatMap((sec) => [
    { id: "shortcuts." + sec.id, anchor: "shortcuts." + sec.id, path: "settings/general/shortcuts", title: sec.title, kind: "subsection" },
    ...sec.items.map((s) => ({ id: `shortcuts.${sec.id}.${s.id}`, anchor: "shortcut." + s.id, path: "settings/general/shortcuts", parent: "shortcuts." + sec.id, title: s.title, kind: "row" }))
  ]),
  { id: "wallpaper", path: WP, title: "Обои", kind: "section", keywords: ["фон", "обои чата", "фон чата"] },
  { id: "wallpaper.upload", path: WP, title: "Загрузить изображение", kind: "row", keywords: ["своё фото", "картинка"] },
  { id: "wallpaper.color", path: "settings/general/wallpaper/color", title: "Выбрать цвет", kind: "section", keywords: ["цвет обоев", "сплошной цвет"] },
  { id: "wallpaper.color.presets", path: "settings/general/wallpaper/color", title: "Готовые цвета", kind: "subsection" },
  { id: "wallpaper.reset", path: WP, title: "Сбросить", kind: "row", keywords: ["обои по умолчанию"] },
  { id: "wallpaper.blur", path: WP, title: "Размытие", kind: "toggle", keywords: ["размыть обои"] },
  { id: "wallpaper.intensity", path: WP, title: "Интенсивность узора", kind: "row", keywords: ["яркость узора"] },
  { id: "wallpaper.pattern", path: WP, title: "Узор", kind: "subsection", keywords: ["паттерн", "рисунок"] },
  { id: "wallpaper.colors", path: WP, title: "Цвета и градиенты", kind: "subsection", keywords: ["градиент"] },
  { id: "calls", path: "settings/calls", title: "Звонки", kind: "section", icon: "phone", tile: "green", keywords: ["микрофон", "камера", "динамики", "звук звонка", "мелодия", "видео"] },
  { id: "calls.background", path: "settings/calls", title: "Фон", kind: "row", keywords: ["размыть фон", "размытие", "фон камеры"] },
  { id: "calls.accept", path: "settings/calls", title: "Принимать звонки на этом устройстве", kind: "row", keywords: ["входящие звонки"] },
  { id: "notifications", path: NOTIFY, title: "Уведомления", kind: "section", icon: "bell", tile: "red", keywords: ["оповещения", "пуш", "push"] },
  { id: "notifications.web", path: NOTIFY, title: "В браузере", kind: "subsection" },
  { id: "notifications.web.on", path: NOTIFY, parent: "notifications.web", title: "Уведомления", kind: "toggle", keywords: ["разрешить уведомления", "пуш", "push"] },
  { id: "notifications.web.background", path: NOTIFY, parent: "notifications.web", title: "Когда вкладка закрыта", kind: "toggle", keywords: ["фоновые уведомления", "push"] },
  { id: "notifications.sound", path: NOTIFY, title: "Звук", kind: "toggle", keywords: ["звук уведомлений", "без звука", "беззвучно"] },
  { id: "notifications.volume", path: NOTIFY, title: "Громкость", kind: "row", keywords: ["громко", "тихо"] },
  { id: "notifications.direct", path: NOTIFY, title: "Личные чаты", kind: "subsection" },
  { id: "notifications.direct.on", path: NOTIFY, parent: "notifications.direct", title: "Уведомления", kind: "toggle", keywords: ["личные сообщения"] },
  { id: "notifications.direct.preview", path: NOTIFY, parent: "notifications.direct", title: "Предпросмотр сообщений", kind: "toggle", keywords: ["превью", "текст в уведомлении"] },
  { id: "notifications.group", path: NOTIFY, title: "Группы", kind: "subsection" },
  { id: "notifications.group.on", path: NOTIFY, parent: "notifications.group", title: "Уведомления", kind: "toggle", keywords: ["групповые чаты"] },
  { id: "notifications.group.preview", path: NOTIFY, parent: "notifications.group", title: "Предпросмотр сообщений", kind: "toggle", keywords: ["превью", "текст в уведомлении"] },
  { id: "privacy", path: PRIVACY, title: "Конфиденциальность", kind: "section", icon: "lock", tile: "gray", keywords: ["приватность", "безопасность"] },
  { id: "privacy.password", path: PASSWORD, title: "Облачный пароль", kind: "section", keywords: ["пароль", "2fa", "двухэтапная проверка", "двухфакторная аутентификация"] },
  { id: "privacy.password.set", path: PASSWORD, title: "Установить пароль", kind: "row", keywords: ["2fa"], when: noPw },
  { id: "privacy.password.change", path: PASSWORD, title: "Сменить пароль", kind: "row", keywords: ["изменить пароль", "подсказка"], when: hasPw },
  { id: "privacy.password.email", path: PASSWORD, title: "Почта для восстановления", kind: "row", keywords: ["email", "почта", "восстановление пароля"], when: hasPw },
  { id: "privacy.password.off", path: PASSWORD, title: "Отключить пароль", kind: "row", keywords: ["убрать пароль", "2fa"], when: hasPw },
  { id: "privacy.passkeys", path: "settings/privacy/passkeys", title: "Паскеи", kind: "section", keywords: ["passkey", "ключ доступа", "биометрия", "face id", "touch id", "windows hello"] },
  { id: "privacy.passkeys.create", path: "settings/privacy/passkeys", title: "Создать паскей", kind: "row", keywords: ["добавить паскей"] },
  { id: "privacy.blocked", path: "settings/privacy/blocked", title: "Заблокированные", kind: "section", keywords: ["чёрный список", "блокировка", "заблокировать", "бан"] },
  ...RULES.map(([k, title, keywords]) => ({ id: "privacy.rule." + k, path: "settings/privacy/rule/" + k, title, kind: "section", keywords })),
  { id: "privacy.rule.phone.discovery", anchor: "privacy.rule.discovery", path: "settings/privacy/rule/phone", title: "Кто найдёт меня по номеру", kind: "subsection", keywords: ["поиск по номеру"] },
  { id: "privacy.screen", path: PRIVACY, title: "Экран", kind: "subsection" },
  { id: "privacy.screen.blur", path: PRIVACY, parent: "privacy.screen", title: "Размывать, когда вкладка не в фокусе", kind: "toggle", keywords: ["размытие", "скрыть экран", "приватный экран"] },
  { id: "privacy.screen.title", path: PRIVACY, parent: "privacy.screen", title: "Не показывать чат в заголовке вкладки", kind: "toggle", keywords: ["название вкладки"] },
  { id: "privacy.screen.unread", path: PRIVACY, parent: "privacy.screen", title: "Не показывать непрочитанные в заголовке и значке", kind: "toggle", keywords: ["счётчик", "бейдж"] },
  { id: "privacy.screen.notifyText", path: PRIVACY, parent: "privacy.screen", title: "Скрывать текст в уведомлениях", kind: "toggle", keywords: ["превью уведомлений"] },
  { id: "folders", path: FOLDERS, title: "Папки с чатами", kind: "section", icon: "folder", tile: "blue", keywords: ["папки", "вкладки", "фильтры чатов"] },
  { id: "folders.create", path: FOLDERS, title: "Создать папку", kind: "row", keywords: ["новая папка", "добавить папку"] },
  { id: "folders.position", path: FOLDERS, title: "Вид вкладок", kind: "subsection", keywords: ["расположение папок"] },
  { id: "folders.position.left", path: FOLDERS, parent: "folders.position", title: "Слева", kind: "option", keywords: ["вкладки слева", "колонка папок"] },
  { id: "folders.position.top", path: FOLDERS, parent: "folders.position", title: "Сверху", kind: "option", keywords: ["вкладки сверху"] },
  { id: "data", path: DATA, title: "Данные и память", kind: "section", icon: "storage", tile: "green", keywords: ["память", "хранилище", "кэш", "место", "диск", "трафик"] },
  { id: "data.autoload", path: DATA, title: "Автозагрузка медиа", kind: "toggle", keywords: ["автоскачивание", "скачивать автоматически"] },
  ...AUTOLOAD.flatMap(([k, title]) => [
    { id: "data.autoload." + k, path: "settings/data/autoload/" + k, title, kind: "section", keywords: ["автозагрузка"] },
    ...AUTOLOAD_ROWS.map(([f, t]) => ({ id: `data.autoload.${k}.${f}`, anchor: "autoload." + f, path: "settings/data/autoload/" + k, title: t, kind: "toggle" }))
  ]),
  { id: "data.autoload.file.maxSize", anchor: "autoload.maxSize", path: "settings/data/autoload/file", title: "Максимальный размер файла", kind: "row", keywords: ["лимит загрузки"] },
  { id: "data.autoload.reset", path: DATA, title: "Сбросить настройки автозагрузки", kind: "row" },
  { id: "data.storage", path: DATA, title: "Память", kind: "subsection", keywords: ["занято", "использование диска", "место"] },
  { id: "data.cache", path: DATA, title: "Кэш медиа", kind: "subsection", keywords: ["кеш"] },
  { id: "data.cache.keep", path: DATA, parent: "data.cache", title: "Хранить медиа", kind: "row", keywords: ["срок хранения"] },
  { id: "data.cache.max", path: DATA, parent: "data.cache", title: "Максимальный размер кэша", kind: "row", keywords: ["лимит кэша", "кеш"] },
  { id: "data.clearCache", path: DATA, title: "Очистить кэш медиа", kind: "row", keywords: ["удалить кэш", "кеш", "освободить место"] },
  { id: "data.clearLocal", path: DATA, title: "Очистить локальные данные", kind: "row", keywords: ["удалить данные с устройства", "сбросить"] },
  { id: "performance", path: PERF, title: "Анимации и производительность", kind: "section", icon: "rocket", tile: "purple", keywords: ["батарея", "энергосбережение", "скорость", "тормозит", "медленно"] },
  { id: "performance.level", path: PERF, title: "Уровень анимаций", kind: "row", keywords: ["меньше анимаций", "эффекты"] },
  { id: "performance.ui", path: PERF, title: "Анимации интерфейса", kind: "toggle", keywords: ["переходы", "отключить анимации"] },
  { id: "performance.wallpaper", path: PERF, title: "Анимация обоев", kind: "toggle", keywords: ["перелив фона"] },
  { id: "performance.blur", path: PERF, title: "Размытие", kind: "toggle", keywords: ["стекло", "прозрачность"] },
  { id: "performance.autoplay", path: PERF, title: "Автовоспроизведение", kind: "subsection" },
  { id: "performance.autoplay.gif", path: PERF, parent: "performance.autoplay", title: "GIF", kind: "toggle", keywords: ["гифки", "гиф"] },
  { id: "performance.autoplay.video", path: PERF, parent: "performance.autoplay", title: "Видео", kind: "toggle" },
  { id: "performance.stickers", path: PERF, title: "Анимированные стикеры", kind: "toggle", keywords: ["стикеры"] },
  { id: "performance.loopStickers", path: PERF, title: "Зацикливать стикеры", kind: "toggle", keywords: ["повтор стикеров"] },
  { id: "performance.bigEmoji", path: PERF, title: "Крупные эмодзи", kind: "toggle", keywords: ["смайлики", "большие эмодзи", "emoji"] },
  { id: "sessions", path: SESSIONS, title: "Активные сеансы", kind: "section", icon: "devices", tile: "blue", keywords: ["устройства", "сессии", "где я вошёл", "выйти на других устройствах"] },
  { id: "sessions.link", path: SESSIONS, title: "Подключить устройство", kind: "row", keywords: ["qr", "войти по qr", "сканировать код"] },
  { id: "sessions.terminateAll", path: SESSIONS, title: "Завершить все другие сеансы", kind: "row", keywords: ["выйти со всех устройств"] },
  { id: "sessions.ttl", path: SESSIONS, title: "Автоматически завершать сеансы", kind: "row", keywords: ["автозавершение", "неактивные сеансы"] },
  { id: "dev", path: "settings/dev", title: "Для разработчиков", kind: "section", icon: "bug", tile: "gray", keywords: ["отладка", "debug", "журнал", "синхронизация"], when: dev }
];
var anchorOf = (e) => e.kind === "section" ? null : e.anchor ?? e.id;

// apps/web/src/settingsSearch/match.ts
function fold(s) {
  let out = "";
  for (const ch of s) {
    const c = ch.toLowerCase();
    const one = c.length === ch.length ? c : ch;
    out += one === "ё" ? "е" : /[\p{L}\p{N}]/u.test(one) ? one : " ".repeat(one.length);
  }
  return out;
}
var normalize = (s) => fold(s.normalize("NFC")).replace(/\s+/g, " ").trim();
var EN = "`qwertyuiop[]asdfghjkl;'zxcvbnm,.";
var RU = "ёйцукенгшщзхъфывапролджэячсмитьбю";
var toRu = new Map([...EN].map((c, i) => [c, RU[i]]));
var toEn = new Map([...RU].map((c, i) => [c, EN[i]]));
var swap = (s, map) => [...s.toLowerCase()].map((c) => map.get(c) ?? c).join("");
function layoutVariants(q) {
  const out = [];
  for (const v of [q, /[a-z`[\];',.]/i.test(q) ? swap(q, toRu) : "", /[а-яё]/i.test(q) ? swap(q, toEn) : ""]) {
    const n = normalize(v);
    if (n && !out.includes(n))
      out.push(n);
  }
  return out;
}
function words(s) {
  const f = fold(s), out = [];
  for (const m of f.matchAll(/\S+/g))
    out.push({ w: m[0], at: m.index });
  return out;
}
var TITLE_START = 0;
var TITLE2 = 1;
var CRUMBS = 2;
var KEYWORDS = 3;
var depth = (e) => e.path.split("/").length + (e.parent ? 1 : 0);
function crumbsFor(entries) {
  const pages = new Map, byId = new Map;
  for (const e of entries) {
    byId.set(e.id, e);
    if (e.kind === "section")
      pages.set(e.path, e);
  }
  return (e) => {
    const seg = e.path.split("/"), out = [];
    for (let i = 2;i <= seg.length; i++) {
      const p = pages.get(seg.slice(0, i).join("/"));
      if (p && p !== e)
        out.push(p.title);
    }
    const parent = e.parent ? byId.get(e.parent) : undefined;
    if (parent)
      out.push(parent.title);
    return out;
  };
}
var topPath = (path) => path.split("/").slice(0, 2).join("/");
function searchSettings(entries, q, ctx) {
  const variants = layoutVariants(q).map((v) => v.split(" "));
  if (!variants.length)
    return [];
  const crumbsOf = crumbsFor(entries);
  const found = [];
  for (const e of entries) {
    if (e.when && !e.when(ctx))
      continue;
    const title = words(e.title), crumbs = crumbsOf(e);
    const crumbWords = crumbs.flatMap(words).map((x) => x.w);
    const keyWords = (e.keywords ?? []).flatMap(words).map((x) => x.w);
    let best = null;
    for (const qw of variants) {
      let level = TITLE2, inTitle = 0;
      const hits = [];
      const ok = qw.every((w) => {
        const t = title.filter((x) => x.w.startsWith(w));
        if (t.length) {
          inTitle++;
          for (const x of t)
            hits.push([x.at, x.at + w.length]);
          return true;
        }
        if (keyWords.some((x) => x.startsWith(w))) {
          level = KEYWORDS;
          return true;
        }
        if (crumbWords.some((x) => x.startsWith(w))) {
          level = Math.max(level, CRUMBS);
          return true;
        }
        return false;
      });
      if (!ok || !inTitle && level !== KEYWORDS)
        continue;
      if (level === TITLE2 && title[0]?.w.startsWith(qw[0]))
        level = TITLE_START;
      if (!best || level < best.score)
        best = { score: level, hits: level === KEYWORDS && !inTitle ? [] : merge(hits) };
    }
    if (best)
      found.push({ entry: e, crumbs, ...best });
  }
  found.sort(compare);
  const groups = new Map;
  for (const h of found) {
    const top = topPath(h.entry.path);
    let g = groups.get(top);
    if (!g)
      groups.set(top, g = { section: entries.find((e) => e.kind === "section" && e.path === top) ?? h.entry, items: [] });
    g.items.push(h);
  }
  return [...groups.values()];
}
function compare(a, b) {
  return a.score - b.score || Number(b.entry.kind === "section") - Number(a.entry.kind === "section") || depth(a.entry) - depth(b.entry) || a.entry.title.localeCompare(b.entry.title, "ru");
}
function merge(r) {
  const s = [...r].sort((a, b) => a[0] - b[0]), out = [];
  for (const x of s) {
    const last = out.at(-1);
    if (last && x[0] <= last[1])
      last[1] = Math.max(last[1], x[1]);
    else
      out.push([x[0], x[1]]);
  }
  return out;
}

// apps/web/src/ui/settings/highlight.ts
var WAIT_MS = 3000;
var FLASH_MS = 1600;
var cancel = null;
function flashSetting(path, anchor) {
  cancel?.();
  const sel = `.rl-slide[data-slide="${CSS.escape(path)}"] [data-setting="${CSS.escape(anchor)}"]`;
  const find = () => document.querySelector(sel);
  let obs = null, timer, done = false;
  const stop = () => {
    done = true;
    obs?.disconnect();
    clearTimeout(timer);
    if (cancel === stop)
      cancel = null;
  };
  cancel = stop;
  requestMeasure(() => {
    if (done)
      return;
    const el = find();
    if (el) {
      stop();
      reveal(el, false);
      return;
    }
    obs = new MutationObserver(() => {
      const e = find();
      if (e) {
        stop();
        reveal(e, true);
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    timer = setTimeout(stop, WAIT_MS);
  });
}
function reveal(el, late) {
  requestMeasure(() => {
    const box = el.closest(".rl-settings");
    if (!box)
      return;
    const r = el.getBoundingClientRect(), b = box.getBoundingClientRect();
    const top = Math.max(0, box.scrollTop + r.top - b.top - (b.height - r.height) / 2);
    requestMutation(() => {
      if (late && !reducedMotion())
        box.scrollTo({ top, behavior: "smooth" });
      else
        box.scrollTop = top;
      if (!reducedMotion())
        onHeavyAnimationEnd(() => requestMutation(() => flash(el)));
    });
  });
}
function flash(el) {
  const target = el.tagName === "SECTION" ? el.querySelector(".rl-sect-title") : el;
  if (!target)
    return;
  const cls = target === el ? "app-setting-flash" : "app-setting-flash-title";
  target.classList.remove(cls);
  target.classList.add(cls);
  setTimeout(() => requestMutation(() => target.classList.remove(cls)), FLASH_MS);
}

// apps/web/src/settingsSearch/recent.ts
var KEY = "relay.settingsRecent";
var RECENT_MAX = 5;
var pushRecent = (list, id) => [id, ...list.filter((x) => x !== id)].slice(0, RECENT_MAX);
var recent = (() => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
})();
function save(next) {
  recent = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {}
}
var getSettingsRecent = () => recent;
var addSettingsRecent = (id) => save(pushRecent(recent, id));
var clearSettingsRecent = () => save([]);

// apps/web/src/settingsSearch/navigate.ts
function openSetting(e) {
  addSettingsRecent(e.id);
  const anchor = anchorOf(e);
  go(e.path, { direct: true }).then(() => {
    if (anchor && getGlobal().sidebarView === e.path)
      flashSetting(e.path, anchor);
  });
}

// apps/web/src/ui/settings/SettingsSearch.tsx
var SWAP_MS = 150;
function openSettingsSearch() {
  setGlobal({ settingsSearch: { open: true, q: "" } });
}
function closeSettingsSearch() {
  setGlobal({ settingsSearch: { open: false, q: "" } });
  document.activeElement?.blur?.();
}
function useSettingsSearch() {
  const open = useGlobal((s) => s.settingsSearch.open);
  const anim = A(null);
  const was = A(open);
  const [, redraw] = d(0);
  if (was.current !== open) {
    was.current = open;
    anim.current = reducedMotion() ? null : open ? "in" : "out";
  }
  h(() => {
    const a = anim.current;
    if (!a)
      return;
    const end = beginHeavyAnimation(SWAP_MS);
    const t = setTimeout(() => {
      if (anim.current === a) {
        anim.current = null;
        redraw((n) => n + 1);
      }
      end();
    }, SWAP_MS);
    return () => {
      clearTimeout(t);
      end();
    };
  }, [open]);
  h(() => () => {
    if (!getGlobal().sidebarView.startsWith("settings"))
      setGlobal({ settingsSearch: { open: false, q: "" } });
  }, []);
  const cls = [open && "app-ssearching", anim.current && "app-ssearch-" + anim.current].filter(Boolean).join(" ");
  return {
    open,
    class: cls ? " " + cls : "",
    toggle: () => open ? closeSettingsSearch() : openSettingsSearch(),
    layer: open || anim.current === "out" ? /* @__PURE__ */ u("div", {
      class: "app-ss-layer",
      inert: !open,
      children: /* @__PURE__ */ u(SettingsSearch, {}, undefined, false, undefined, this)
    }, undefined, false, undefined, this) : null
  };
}
var pwKnown = null;
function SettingsSearch() {
  const q = useGlobal((s) => s.settingsSearch.q);
  const dev = useGlobal((s) => s.prefs.dev.enabled);
  const [hasPassword, setHasPassword] = d(pwKnown);
  h(() => {
    getPassword().then((r) => {
      if (r.ok)
        setHasPassword(pwKnown = r.data.enabled);
    });
  }, []);
  const ctx = { dev, hasPassword };
  const [recent, setRecent] = d(getSettingsRecent);
  const groups = T(() => searchSettings(ENTRIES, q, ctx), [q, dev, hasPassword]);
  const recentHits = T(() => recentList(recent, ctx), [recent, dev, hasPassword]);
  const flat = q.trim() ? groups.flatMap((g) => g.items) : recentHits;
  const [active, setActive] = d(-1);
  h(() => setActive(-1), [q]);
  const list = A(null);
  h(() => {
    const onKey = (e) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.target?.id === "settings-search")
        return;
      if (document.querySelector('[role="dialog"][aria-modal="true"], [role="menu"]'))
        return;
      e.preventDefault();
      closeSettingsSearch();
    };
    addEventListener("keydown", onKey, true);
    return () => removeEventListener("keydown", onKey, true);
  }, []);
  const none = !!q.trim() && !groups.length;
  const showNone = useMinVisible(none, { delay: 150, min: 0 });
  function move(step) {
    if (!flat.length)
      return;
    const next = active < 0 ? step > 0 ? 0 : flat.length - 1 : (active + step + flat.length) % flat.length;
    setActive(next);
    requestMutation(() => {
      list.current?.querySelector(`[data-i="${next}"]`)?.scrollIntoView({ block: "nearest" });
    });
  }
  function onKeyDown(e) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      move(e.key === "ArrowDown" ? 1 : -1);
    }
  }
  const pick = (e) => openSetting(e);
  let i = 0;
  const row = (h, tile) => {
    const n = i++;
    return /* @__PURE__ */ u(Row, {
      n,
      hit: h,
      tile,
      active: n === active,
      onPick: () => pick(h.entry)
    }, h.entry.id, false, undefined, this);
  };
  return /* @__PURE__ */ u("div", {
    class: "app-ss",
    role: "search",
    children: [
      /* @__PURE__ */ u("div", {
        class: "app-ss-head",
        children: /* @__PURE__ */ u(SearchInput, {
          id: "settings-search",
          back: true,
          backLabel: "Закрыть поиск",
          onBack: closeSettingsSearch,
          label: "Поиск по настройкам",
          placeholder: "Поиск",
          value: q,
          autoFocus: true,
          onChange: (v) => setGlobal({ settingsSearch: { open: true, q: v } }),
          onKeyDown,
          onEnter: () => {
            const h = flat[Math.max(0, active)];
            if (h)
              pick(h.entry);
          },
          onEscape: closeSettingsSearch,
          inputProps: { role: "combobox", "aria-expanded": "true", "aria-controls": "settings-search-list", "aria-activedescendant": active >= 0 ? "ss-opt-" + active : undefined }
        }, undefined, false, undefined, this)
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u("div", {
        class: "rl-settings app-ss-body",
        id: "settings-search-list",
        role: "listbox",
        "aria-label": "Пункты настроек",
        ref: list,
        children: [
          q.trim() ? groups.map((g) => /* @__PURE__ */ u(Card, {
            children: g.items.map((h, k) => row(h, k === 0 ? g.section : null))
          }, g.section.id, false, undefined, this)) : recentHits.length ? /* @__PURE__ */ u(Card, {
            title: "Недавние",
            action: /* @__PURE__ */ u("button", {
              type: "button",
              class: "app-gsearch-clear",
              "aria-label": "Очистить недавние",
              onClick: () => {
                clearSettingsRecent();
                setRecent([]);
              },
              children: /* @__PURE__ */ u(Icon, {
                name: "close",
                size: 20
              }, undefined, false, undefined, this)
            }, undefined, false, undefined, this),
            children: recentHits.map((h) => row(h, topSection(h.entry)))
          }, undefined, false, undefined, this) : null,
          none && showNone ? /* @__PURE__ */ u("div", {
            class: "app-ss-none",
            children: /* @__PURE__ */ u(EmptyState, {
              kind: "search",
              title: "Ничего не найдено",
              text: "Попробуйте другое слово или раскладку."
            }, undefined, false, undefined, this)
          }, undefined, false, undefined, this) : null
        ]
      }, undefined, true, undefined, this)
    ]
  }, undefined, true, undefined, this);
}
function Card({ title, action, children }) {
  return /* @__PURE__ */ u("section", {
    class: "rl-sect app-ss-group",
    children: [
      title ? /* @__PURE__ */ u("div", {
        class: "app-ss-group-head",
        children: [
          /* @__PURE__ */ u("h3", {
            class: "rl-sect-title",
            children: title
          }, undefined, false, undefined, this),
          action
        ]
      }, undefined, true, undefined, this) : null,
      /* @__PURE__ */ u("div", {
        class: "rl-sect-card",
        children
      }, undefined, false, undefined, this)
    ]
  }, undefined, true, undefined, this);
}
function Row({ n, hit, tile, active, onPick }) {
  return /* @__PURE__ */ u("button", {
    type: "button",
    tabIndex: -1,
    id: "ss-opt-" + n,
    "data-i": n,
    role: "option",
    "aria-selected": active ? "true" : "false",
    class: "rl-inforow app-ss-row" + (active ? " is-active" : ""),
    onClick: onPick,
    children: [
      tile?.icon ? /* @__PURE__ */ u(SettingsIcon, {
        icon: tile.icon,
        color: tile.tile
      }, undefined, false, undefined, this) : /* @__PURE__ */ u("span", {
        class: "app-ss-gap",
        "aria-hidden": "true"
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u("span", {
        class: "rl-inforow-text",
        children: [
          /* @__PURE__ */ u("span", {
            children: marked(hit.entry.title, hit.hits)
          }, undefined, false, undefined, this),
          hit.crumbs.length ? /* @__PURE__ */ u("small", {
            children: hit.crumbs.join(" › ")
          }, undefined, false, undefined, this) : null
        ]
      }, undefined, true, undefined, this)
    ]
  }, undefined, true, undefined, this);
}
function marked(text, hits) {
  if (!hits.length)
    return text;
  const out = [];
  let at = 0;
  for (const [a, b] of hits) {
    out.push(text.slice(at, a), /* @__PURE__ */ u("mark", {
      class: "rl-mark",
      children: text.slice(a, b)
    }, a, false, undefined, this));
    at = b;
  }
  out.push(text.slice(at));
  return out;
}
var byId = new Map(ENTRIES.map((e) => [e.id, e]));
var crumbsOf = crumbsFor(ENTRIES);
var topSection = (e) => ENTRIES.find((x) => x.kind === "section" && x.path === topPath(e.path)) ?? null;
function recentList(ids, ctx) {
  return ids.flatMap((id) => {
    const e = byId.get(id);
    return !e || e.when && !e.when(ctx) ? [] : [{ entry: e, crumbs: crumbsOf(e), score: 0, hits: [] }];
  });
}

// apps/web/src/ui/settings/Main.tsx
var SECTIONS = [
  { path: "settings/profile", icon: "account", tile: "blue", title: "Аккаунт", subtitle: "Имя пользователя, о себе, день рождения" },
  { path: "settings/general", icon: "general", tile: "orange", title: "Общие настройки", subtitle: "Обои, тема, клавиатура" },
  { path: "settings/notifications", icon: "bell", tile: "red", title: "Уведомления", subtitle: "Звуки, типы чатов" },
  { path: "settings/calls", icon: "phone", tile: "green", title: "Звонки", subtitle: "Микрофон, камера, динамики" },
  { path: "settings/privacy", icon: "lock", tile: "gray", title: "Конфиденциальность", subtitle: "Последний визит, блокировка" },
  { path: "settings/folders", icon: "folder", tile: "blue", title: "Папки с чатами", subtitle: "Сортировка чатов по папкам" },
  { path: "settings/data", icon: "storage", tile: "green", title: "Данные и память", subtitle: "Автозагрузка, кэш" },
  { path: "settings/performance", icon: "rocket", tile: "purple", title: "Анимации и производительность", subtitle: "Анимации, переходы, автовоспроизведение" },
  { path: "settings/sessions", icon: "devices", tile: "blue", title: "Активные сеансы", subtitle: "Сеансы, автозавершение" }
];
async function logout() {
  markSelfLogout2(true);
  try {
    const res = await fetch("/logout", { method: "POST" });
    if (!res.ok && res.status !== 401) {
      markSelfLogout2(false);
      return false;
    }
  } catch {
    markSelfLogout2(false);
    return false;
  }
  await dropSubscription().catch(() => {});
  const uid = getGlobal().me?.userId;
  try {
    localStorage.removeItem("relay.me");
    localStorage.removeItem("relay.thisSession");
  } catch {}
  if (uid != null)
    try {
      indexedDB.deleteDatabase("relay-" + uid);
    } catch {}
  await releaseMediaCache();
  setGlobal({ boot: "login" });
  location.reload();
  return true;
}
function Main() {
  const me = useGlobal((s) => s.me);
  const photo = usePhotoPicker(me.photo);
  const myPhotos = useProfilePhotos(me.userId, me.photo);
  const [viewer, setViewer] = d(null);
  const status = useGlobal((s) => s.status);
  const sessionCount = useGlobal((s) => s.sessions ? sessionsView(s.sessions, s.opsKeys).length : null);
  const scroll = useScrollMemory("settings");
  const search = useSettingsSearch();
  const [menu, setMenu] = d(null);
  const [confirm, setConfirm] = d(false);
  const [toast, setToast] = d(null);
  const lastToast = A("");
  const timer = A(null);
  const devOn = useGlobal((s) => s.prefs.dev.enabled);
  const taps = A([]);
  h(() => {
    prefetchAll2(SECTIONS.map((s) => s.path));
  }, []);
  h(() => () => {
    if (timer.current)
      clearTimeout(timer.current);
  }, []);
  function flash(text) {
    lastToast.current = text;
    setToast(text);
    if (timer.current)
      clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), 2000);
  }
  function copy(text) {
    navigator.clipboard?.writeText(text).then(() => flash("Скопировано")).catch(() => {});
  }
  function onVersionTap() {
    const now = Date.now();
    taps.current = taps.current.filter((t) => now - t < 2000).concat(now);
    if (taps.current.length < 5)
      return;
    taps.current = [];
    if (devOn)
      return;
    setPref("dev.enabled", true);
    flash("Раздел для разработчиков включён");
  }
  const phone = me.phone ? me.phone.startsWith("+") ? me.phone : "+" + me.phone : null;
  const username = me.username ? "@" + me.username.replace(/^@/, "") : null;
  const bio = me.bio?.trim() || null;
  const birthday = me.birthday ? birthdayText(me.birthday) : null;
  const links = me.links ?? [];
  const hasInfo = !!(phone || username || bio || birthday || links.length || me.personalChannel);
  return /* @__PURE__ */ u("div", {
    class: "rl-sidepage" + search.class,
    "aria-label": "Настройки",
    children: [
      /* @__PURE__ */ u("div", {
        class: "app-contents",
        children: /* @__PURE__ */ u(PanelHeader, {
          icon: "arrowLeft",
          closeLabel: "Назад",
          title: "Настройки",
          onClose: () => void back(),
          actions: [
            { icon: "search", label: "Поиск по настройкам", onClick: search.toggle },
            { icon: "write", label: "Изменить профиль", onClick: () => void go("settings/profile") },
            { icon: "more", label: "Ещё", popup: true, onClick: (e) => setMenu(e.currentTarget) }
          ]
        }, undefined, false, undefined, this)
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u(MenuPopover, {
        open: !!menu,
        anchor: menu ?? undefined,
        placement: "bottom-end",
        label: "Меню настроек",
        onClose: () => setMenu(null),
        items: [{ icon: "logout", label: "Выйти", danger: true, onClick: () => setConfirm(true) }]
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u("div", {
        class: "rl-settings",
        ref: scroll.ref,
        onScroll: scroll.onScroll,
        children: [
          /* @__PURE__ */ u(ProfileHeader, {
            name: me.name,
            tone: peerTone(me.userId),
            subtitle: status.phase === "offline" ? "нет сети" : "в сети",
            size: 96,
            ...me.photo && !photo.busy ? { ...avatarPhoto(me.photo, true), camera: false, avatarLabel: "Открыть фото", onAvatar: () => setViewer(0) } : photo.avatar
          }, undefined, false, undefined, this),
          photo.ui,
          viewer != null && myPhotos.length ? /* @__PURE__ */ u(PhotoViewer, {
            own: true,
            photos: myPhotos,
            index: viewer,
            name: me.name,
            onClose: () => setViewer(null),
            origin: (k) => k === 0 ? document.querySelector(".rl-settings .rl-profile-ava .rl-avatar") : null
          }, undefined, false, undefined, this) : null,
          hasInfo ? /* @__PURE__ */ u(Section, {
            children: [
              /* @__PURE__ */ u(PersonalChannelBlock, {
                channel: me.personalChannel,
                from: "left"
              }, undefined, false, undefined, this),
              phone ? /* @__PURE__ */ u(InfoRow, {
                tile: "green",
                icon: "phone",
                title: phone,
                subtitle: "Телефон",
                onClick: () => copy(phone)
              }, undefined, false, undefined, this) : null,
              username ? /* @__PURE__ */ u(InfoRow, {
                tile: "blue",
                icon: "at",
                title: username,
                subtitle: "Имя пользователя",
                onClick: () => copy(username)
              }, undefined, false, undefined, this) : null,
              bio ? /* @__PURE__ */ u("div", {
                class: "rl-inforow rl-inforow-static",
                role: "button",
                tabIndex: 0,
                onClick: (e) => {
                  if (!e.target.closest("a"))
                    copy(bio);
                },
                onKeyDown: (e) => {
                  if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
                    e.preventDefault();
                    copy(bio);
                  }
                },
                children: [
                  /* @__PURE__ */ u(SettingsIcon, {
                    icon: "info",
                    color: "gray"
                  }, undefined, false, undefined, this),
                  /* @__PURE__ */ u("span", {
                    class: "rl-inforow-text",
                    children: [
                      /* @__PURE__ */ u("span", {
                        class: "rl-bio",
                        children: /* @__PURE__ */ u(RichText, {
                          text: bio
                        }, undefined, false, undefined, this)
                      }, undefined, false, undefined, this),
                      /* @__PURE__ */ u("small", {
                        children: "О себе"
                      }, undefined, false, undefined, this)
                    ]
                  }, undefined, true, undefined, this)
                ]
              }, undefined, true, undefined, this) : null,
              birthday ? /* @__PURE__ */ u(InfoRow, {
                tile: "purple",
                icon: "cake",
                title: birthday,
                subtitle: "День рождения",
                onClick: () => copy(birthday)
              }, undefined, false, undefined, this) : null,
              /* @__PURE__ */ u(ProfileLinks, {
                links
              }, undefined, false, undefined, this)
            ]
          }, undefined, true, undefined, this) : null,
          /* @__PURE__ */ u(Section, {
            children: [
              SECTIONS.map((s) => /* @__PURE__ */ u("div", {
                onPointerEnter: () => prefetch2(s.path),
                onFocusCapture: () => prefetch2(s.path),
                children: /* @__PURE__ */ u(InfoRow, {
                  tile: s.tile,
                  icon: s.icon,
                  title: s.title,
                  subtitle: s.subtitle,
                  value: s.path === "settings/sessions" && sessionCount != null ? sessionCount : undefined,
                  onClick: () => void go(s.path)
                }, undefined, false, undefined, this)
              }, s.path, false, undefined, this)),
              /* @__PURE__ */ u(Presence, {
                show: devOn,
                exitMs: 220,
                children: /* @__PURE__ */ u("div", {
                  class: "app-devrow",
                  onPointerEnter: () => prefetch2("settings/dev"),
                  children: /* @__PURE__ */ u(InfoRow, {
                    tile: "gray",
                    icon: "bug",
                    title: "Для разработчиков",
                    subtitle: "Синхронизация, сеть, хранилище",
                    onClick: () => void go("settings/dev")
                  }, undefined, false, undefined, this)
                }, undefined, false, undefined, this)
              }, undefined, false, undefined, this)
            ]
          }, undefined, true, undefined, this),
          /* @__PURE__ */ u(Section, {
            title: "О приложении",
            children: /* @__PURE__ */ u(InfoRow, {
              icon: "info",
              title: "Relay",
              subtitle: "Сборка " + "mw6119zf",
              onClick: onVersionTap
            }, undefined, false, undefined, this)
          }, undefined, false, undefined, this)
        ]
      }, undefined, true, undefined, this),
      search.layer,
      /* @__PURE__ */ u(Presence, {
        show: toast != null,
        exitMs: 200,
        children: /* @__PURE__ */ u("div", {
          class: "app-toast",
          children: /* @__PURE__ */ u(Toast, {
            children: toast ?? lastToast.current
          }, undefined, false, undefined, this)
        }, undefined, false, undefined, this)
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u(ConfirmDialog, {
        open: confirm,
        danger: true,
        title: "Выйти из Relay?",
        text: "Чтобы войти снова, понадобится войти заново. Данные чатов на этом устройстве будут удалены.",
        confirm: "Выйти",
        cancel: "Отмена",
        onCancel: () => setConfirm(false),
        onConfirm: () => {
          setConfirm(false);
          logout().then((ok) => {
            if (!ok)
              flash("Не удалось выйти. Проверьте подключение.");
          });
        }
      }, undefined, false, undefined, this)
    ]
  }, undefined, true, undefined, this);
}
// apps/web/src/ui/settings/Notifications.tsx
registerPrefetch2("settings/notifications", () => {
  refreshSettings2();
});
function Notifications() {
  const prefs = useGlobal((s) => s.prefs.notify);
  const state = useGlobal((s) => s.notify);
  const pushReady = useGlobal((s) => s.pushReady);
  const settings = useGlobal((s) => s.settings.notify);
  const loaded = useGlobal((s) => s.settings.loaded);
  const phase = useGlobal((s) => s.status.phase);
  const waiting = !loaded && phase !== "offline";
  const skeleton = useMinVisible(waiting, { delay: 150, min: 600 });
  const [asking, setAsking] = d(false);
  const scroll = useScrollMemory("settings/notifications");
  const [bg, setBg] = d(bgWanted);
  const blocked = state === "unsupported" || state === "denied";
  const webOn = prefs.web && state === "on";
  const webShown = webOn || asking;
  const toggleWeb = async (on) => {
    setAsking(on);
    await setNotify(on);
    setAsking(false);
    if (on && getGlobal().notify !== "on") {
      setPrefs({ "notify.web": false });
      if (getGlobal().notify === "denied")
        showToast2("Браузер запретил уведомления");
    }
  };
  const toggleBg = (on) => {
    setBg(on);
    setBackground(on);
  };
  const apply = (p) => setPrefs({ "notify.sound": p.sound, "notify.volume": p.volume });
  const toggleSnd = (on) => {
    const p = toggleSound(prefs, on);
    apply(p);
    if (on)
      playNotifySound(p.volume);
  };
  const webHint = state === "unsupported" ? "Не поддерживается" : state === "denied" ? "Запрещено в браузере" : undefined;
  const bgHint = state === "unsupported" ? "Не поддерживается" : !webOn ? "Сначала включите уведомления" : bg && pushReady ? "Придут, даже если вкладка закрыта" : bg ? "Пока открыта вкладка" : undefined;
  const kind = (k, title) => {
    const p = settings[k];
    return /* @__PURE__ */ u(Section, {
      setting: "notifications." + k,
      title,
      children: [
        /* @__PURE__ */ u(CheckRow, {
          setting: "notifications." + k + ".on",
          label: "Уведомления",
          checked: !p.muted,
          onChange: (on) => void setNotifyDefault2(k, { muted: !on })
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u(CheckRow, {
          setting: "notifications." + k + ".preview",
          label: "Предпросмотр сообщений",
          checked: p.preview,
          disabled: p.muted,
          onChange: (on) => void setNotifyDefault2(k, { preview: on })
        }, undefined, false, undefined, this)
      ]
    }, undefined, true, undefined, this);
  };
  return /* @__PURE__ */ u("div", {
    class: "rl-sidepage",
    "aria-label": "Уведомления",
    children: [
      /* @__PURE__ */ u(PanelHeader, {
        icon: "arrowLeft",
        closeLabel: "Назад",
        title: "Уведомления",
        onClose: () => void back()
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u("div", {
        class: "rl-settings",
        ref: scroll.ref,
        onScroll: scroll.onScroll,
        children: [
          /* @__PURE__ */ u(Section, {
            setting: "notifications.web",
            title: "В браузере",
            footer: "Действует на этом устройстве.",
            children: [
              /* @__PURE__ */ u(CheckRow, {
                setting: "notifications.web.on",
                label: "Уведомления",
                subtitle: webHint,
                checked: webShown,
                disabled: blocked,
                onChange: (on) => void toggleWeb(on)
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u(CheckRow, {
                setting: "notifications.web.background",
                label: "Когда вкладка закрыта",
                subtitle: bgHint,
                checked: bg && webOn,
                disabled: blocked || !webOn,
                onChange: toggleBg
              }, undefined, false, undefined, this)
            ]
          }, undefined, true, undefined, this),
          /* @__PURE__ */ u(Section, {
            title: "Звук",
            children: [
              /* @__PURE__ */ u(CheckRow, {
                setting: "notifications.sound",
                label: "Звук",
                checked: soundOn(prefs),
                onChange: toggleSnd
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u(RangeRow, {
                setting: "notifications.volume",
                label: "Громкость",
                min: 0,
                max: 100,
                step: 1,
                value: volumePct(prefs.volume),
                format: (v) => v + " %",
                onChange: (v) => apply(volumeFromSlider(v)),
                onCommit: (v) => playNotifySound(volumeFromSlider(v).volume)
              }, undefined, false, undefined, this)
            ]
          }, undefined, true, undefined, this),
          /* @__PURE__ */ u("div", {
            class: "app-listwrap",
            children: [
              /* @__PURE__ */ u(Presence, {
                show: skeleton,
                exitMs: 280,
                children: /* @__PURE__ */ u("div", {
                  class: "app-skel",
                  "aria-busy": "true",
                  "aria-label": "Загрузка настроек",
                  children: [
                    /* @__PURE__ */ u(Section, {
                      children: [0, 1].map((i) => /* @__PURE__ */ u("div", {
                        style: { "--i": i },
                        children: /* @__PURE__ */ u(ChatRowSkeleton, {}, undefined, false, undefined, this)
                      }, i, false, undefined, this))
                    }, undefined, false, undefined, this),
                    /* @__PURE__ */ u(Section, {
                      children: [0, 1].map((i) => /* @__PURE__ */ u("div", {
                        style: { "--i": i },
                        children: /* @__PURE__ */ u(ChatRowSkeleton, {}, undefined, false, undefined, this)
                      }, i, false, undefined, this))
                    }, undefined, false, undefined, this)
                  ]
                }, undefined, true, undefined, this)
              }, undefined, false, undefined, this),
              waiting || skeleton ? null : /* @__PURE__ */ u(S, {
                children: [
                  kind("direct", "Личные чаты"),
                  kind("group", "Группы")
                ]
              }, undefined, true, undefined, this)
            ]
          }, undefined, true, undefined, this)
        ]
      }, undefined, true, undefined, this)
    ]
  }, undefined, true, undefined, this);
}
// apps/web/src/ui/settings/Passkeys.tsx
function Passkeys() {
  const [list, setList] = d(null);
  const [max, setMax] = d(10);
  const [busy, setBusy] = d(false);
  const [ask, setAsk] = d(null);
  const supported = passkeysSupported();
  h(() => {
    listPasskeys().then((r) => {
      if (r.ok) {
        setList(r.data.passkeys);
        setMax(r.data.max);
      } else
        setList([]);
    });
  }, []);
  async function create() {
    setBusy(true);
    const r = await createPasskey();
    setBusy(false);
    if (r.ok) {
      setList(r.data.passkeys);
      showToast2("Паскей создан");
      return;
    }
    if (r.code === "fresh_session")
      showToast2("С нового входа это можно сделать через сутки или после подтверждения на другом устройстве");
    else if (r.code !== "cancelled")
      showToast2("Не удалось создать паскей. Попробуйте ещё раз.");
  }
  async function remove(p) {
    setAsk(null);
    const r = await deletePasskey(p.id);
    if (r.ok)
      setList(r.data.passkeys);
    else
      showToast2(r.code === "fresh_session" ? "С нового входа это можно сделать через сутки или после подтверждения на другом устройстве" : "Не удалось удалить паскей");
  }
  return /* @__PURE__ */ u("div", {
    class: "rl-sidepage",
    "aria-label": "Паскеи",
    children: [
      /* @__PURE__ */ u(PanelHeader, {
        icon: "arrowLeft",
        closeLabel: "Назад",
        title: "Паскеи",
        onClose: () => void back()
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u("div", {
        class: "rl-settings",
        children: list == null ? null : list.length === 0 ? /* @__PURE__ */ u("div", {
          class: "app-passkey-intro",
          children: [
            /* @__PURE__ */ u("div", {
              class: "app-pw-head",
              children: [
                /* @__PURE__ */ u(Sticker, {
                  name: "key",
                  size: 120,
                  replay: "click"
                }, undefined, false, undefined, this),
                /* @__PURE__ */ u("h3", {
                  children: "Защитите аккаунт"
                }, undefined, false, undefined, this),
                /* @__PURE__ */ u("p", {
                  children: "Входите без кода: паскей хранится в менеджере паролей и открывается Face ID, отпечатком или паролем устройства."
                }, undefined, false, undefined, this)
              ]
            }, undefined, true, undefined, this),
            /* @__PURE__ */ u(Section, {
              children: [
                /* @__PURE__ */ u(InfoRow, {
                  tile: "green",
                  icon: "key",
                  title: "Создать паскей",
                  subtitle: "Займёт пару секунд"
                }, undefined, false, undefined, this),
                /* @__PURE__ */ u(InfoRow, {
                  tile: "blue",
                  icon: "lock",
                  title: "Вход по биометрии",
                  subtitle: "Face ID, Touch ID, Windows Hello или код устройства"
                }, undefined, false, undefined, this),
                /* @__PURE__ */ u(InfoRow, {
                  tile: "purple",
                  icon: "shield",
                  title: "Надёжное хранение",
                  subtitle: "Связка ключей iCloud, Google или ваш менеджер паролей"
                }, undefined, false, undefined, this)
              ]
            }, undefined, true, undefined, this),
            /* @__PURE__ */ u("div", {
              class: "app-pw-actions",
              children: /* @__PURE__ */ u(Button, {
                "data-setting": "privacy.passkeys.create",
                size: "lg",
                disabled: !supported || busy,
                onClick: create,
                children: !supported ? "Браузер не поддерживает паскеи" : busy ? "Ждём менеджер паролей…" : "Создать паскей"
              }, undefined, false, undefined, this)
            }, undefined, false, undefined, this)
          ]
        }, undefined, true, undefined, this) : /* @__PURE__ */ u(S, {
          children: /* @__PURE__ */ u(Section, {
            footer: "Паскей хранится в вашем менеджере паролей. Удалённый здесь паскей больше не откроет аккаунт — удалите его и в менеджере.",
            children: [
              list.map((p) => /* @__PURE__ */ u(InfoRow, {
                tile: "green",
                icon: "key",
                title: p.name,
                subtitle: "Создан " + fullDateTime(p.createdAt) + (p.lastUsedAt ? " · использован " + fullDateTime(p.lastUsedAt) : ""),
                onClick: () => setAsk(p)
              }, p.id, false, undefined, this)),
              supported && list.length < max ? /* @__PURE__ */ u(InfoRow, {
                setting: "privacy.passkeys.create",
                icon: "plus",
                title: busy ? "Ждём менеджер паролей…" : "Создать паскей",
                onClick: busy ? undefined : create
              }, undefined, false, undefined, this) : null
            ]
          }, undefined, true, undefined, this)
        }, undefined, false, undefined, this)
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u(ConfirmDialog, {
        open: !!ask,
        danger: true,
        title: "Удалить паскей?",
        text: "Паскей «" + (ask?.name ?? "") + "» больше нельзя будет использовать для входа. Удалите его и из менеджера паролей.",
        confirm: "Удалить",
        cancel: "Отмена",
        onCancel: () => setAsk(null),
        onConfirm: () => {
          if (ask)
            remove(ask);
        }
      }, undefined, false, undefined, this)
    ]
  }, undefined, true, undefined, this);
}
// apps/web/src/ui/settings/Password.tsx
var ERR = {
  password_invalid: "Неверный текущий пароль",
  email_invalid: "Проверьте адрес почты",
  offline: "Нет соединения",
  flood: "Слишком много попыток",
  fresh_session: "С нового входа это можно сделать через сутки или после подтверждения на другом устройстве"
};
function Password() {
  const [state, setState] = d(null);
  const [mode, setMode] = d("view");
  const [current, setCurrent] = d("");
  const [pw, setPw] = d("");
  const [pw2, setPw2] = d("");
  const [hint, setHint] = d("");
  const [email, setEmail] = d("");
  const [show, setShow] = d(false);
  const [error, setError] = d(null);
  const [busy, setBusy] = d(false);
  const [askOff, setAskOff] = d(false);
  const v = A({ current: "", pw: "", pw2: "", hint: "", email: "" }).current;
  h(() => {
    getPassword().then((r) => {
      if (r.ok)
        setState(r.data);
    });
  }, []);
  function edit() {
    setMode("edit");
    setCurrent("");
    setPw("");
    setPw2("");
    setHint(state?.hint ?? "");
    setEmail("");
    setError(null);
    Object.assign(v, { current: "", pw: "", pw2: "", hint: state?.hint ?? "", email: "" });
  }
  async function save(e) {
    e.preventDefault();
    if (!v.pw) {
      setError("Введите новый пароль");
      return;
    }
    if (v.pw !== v.pw2) {
      setError("Пароли не совпадают");
      return;
    }
    if (v.hint && v.hint.trim() === v.pw) {
      setError("Подсказка не должна совпадать с паролем");
      return;
    }
    setBusy(true);
    const r = await savePassword({ password: v.pw, hint: v.hint.trim(), email: v.email.trim() }, state?.enabled ? v.current : null);
    setBusy(false);
    if (!r.ok) {
      setError(ERR[r.code] ?? "Не удалось сохранить");
      return;
    }
    showToast2(state?.enabled ? "Пароль изменён" : "Облачный пароль включён");
    setMode("view");
    const s = await getPassword();
    if (s.ok)
      setState(s.data);
  }
  async function turnOff() {
    setAskOff(false);
    setBusy(true);
    const r = await removePassword(current);
    setBusy(false);
    if (!r.ok) {
      setCurrent("");
      showToast2(ERR[r.code] ?? "Не удалось отключить");
      return;
    }
    showToast2("Облачный пароль отключён");
    setState({ enabled: false, hint: "", email: null });
    setMode("view");
  }
  const typing = mode === "edit";
  return /* @__PURE__ */ u("div", {
    class: "rl-sidepage",
    "aria-label": "Облачный пароль",
    children: [
      /* @__PURE__ */ u(PanelHeader, {
        icon: "arrowLeft",
        closeLabel: "Назад",
        title: "Облачный пароль",
        onClose: () => typing ? setMode("view") : void back()
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u("div", {
        class: "rl-settings",
        children: [
          /* @__PURE__ */ u("div", {
            class: "app-pw-head",
            children: [
              /* @__PURE__ */ u(Owl, {
                mode: typing ? "cover" : "idle",
                peek: show,
                size: 110
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u("p", {
                children: state?.enabled ? "При входе на новом устройстве после кода понадобится этот пароль." : "Пароль защитит аккаунт, даже если кто-то получит код входа. Его спросят при входе на новом устройстве."
              }, undefined, false, undefined, this)
            ]
          }, undefined, true, undefined, this),
          !state ? null : !typing ? /* @__PURE__ */ u(Section, {
            children: state.enabled ? /* @__PURE__ */ u(S, {
              children: [
                /* @__PURE__ */ u(InfoRow, {
                  setting: "privacy.password.change",
                  tile: "green",
                  icon: "lock",
                  title: "Сменить пароль",
                  subtitle: state.hint ? "Подсказка: " + state.hint : undefined,
                  onClick: edit
                }, undefined, false, undefined, this),
                /* @__PURE__ */ u(InfoRow, {
                  setting: "privacy.password.email",
                  icon: "mail",
                  title: "Почта для восстановления",
                  value: state.email ?? "не задана",
                  onClick: edit
                }, undefined, false, undefined, this),
                /* @__PURE__ */ u(InfoRow, {
                  setting: "privacy.password.off",
                  icon: "trash",
                  danger: true,
                  title: "Отключить пароль",
                  onClick: () => {
                    setCurrent("");
                    setAskOff(true);
                  }
                }, undefined, false, undefined, this)
              ]
            }, undefined, true, undefined, this) : /* @__PURE__ */ u(InfoRow, {
              setting: "privacy.password.set",
              tile: "green",
              icon: "lock",
              title: "Установить пароль",
              onClick: edit
            }, undefined, false, undefined, this)
          }, undefined, false, undefined, this) : /* @__PURE__ */ u("form", {
            class: "app-pw-form",
            onSubmit: save,
            children: [
              /* @__PURE__ */ u(Section, {
                footer: state.enabled ? "Чтобы сменить или отключить пароль, введите текущий." : "Пароль хранится только у вас: Relay не сможет его подсказать.",
                children: [
                  state.enabled ? /* @__PURE__ */ u(TextField, {
                    label: "Текущий пароль",
                    type: show ? "text" : "password",
                    value: current,
                    autoFocus: true,
                    onInput: (x) => {
                      v.current = x;
                      setCurrent(x);
                      setError(null);
                    }
                  }, undefined, false, undefined, this) : null,
                  /* @__PURE__ */ u(TextField, {
                    label: "Новый пароль",
                    type: show ? "text" : "password",
                    value: pw,
                    autoFocus: !state.enabled,
                    onInput: (x) => {
                      v.pw = x;
                      setPw(x);
                      setError(null);
                    }
                  }, undefined, false, undefined, this),
                  /* @__PURE__ */ u(TextField, {
                    label: "Повторите пароль",
                    type: show ? "text" : "password",
                    value: pw2,
                    onInput: (x) => {
                      v.pw2 = x;
                      setPw2(x);
                      setError(null);
                    }
                  }, undefined, false, undefined, this),
                  /* @__PURE__ */ u("label", {
                    class: "app-pw-show",
                    children: [
                      /* @__PURE__ */ u("input", {
                        type: "checkbox",
                        checked: show,
                        onChange: (e) => setShow(e.currentTarget.checked)
                      }, undefined, false, undefined, this),
                      " Показать пароль"
                    ]
                  }, undefined, true, undefined, this)
                ]
              }, undefined, true, undefined, this),
              /* @__PURE__ */ u(Section, {
                footer: "Подсказку видно на экране ввода пароля. Почта нужна, чтобы сбросить пароль, если вы его забудете.",
                children: [
                  /* @__PURE__ */ u(TextField, {
                    label: "Подсказка (необязательно)",
                    value: hint,
                    maxLength: 64,
                    onInput: (x) => {
                      v.hint = x;
                      setHint(x);
                    }
                  }, undefined, false, undefined, this),
                  /* @__PURE__ */ u(TextField, {
                    label: "Почта для восстановления",
                    type: "email",
                    value: email,
                    onInput: (x) => {
                      v.email = x;
                      setEmail(x);
                    },
                    hint: state.email ? "Сейчас: " + state.email + " — пустое поле уберёт почту" : undefined
                  }, undefined, false, undefined, this)
                ]
              }, undefined, true, undefined, this),
              error ? /* @__PURE__ */ u("p", {
                class: "app-pw-error",
                role: "alert",
                children: error
              }, undefined, false, undefined, this) : null,
              /* @__PURE__ */ u("div", {
                class: "app-pw-actions",
                children: /* @__PURE__ */ u(Button, {
                  type: "submit",
                  size: "lg",
                  disabled: busy,
                  children: busy ? "Сохраняем…" : "Сохранить"
                }, undefined, false, undefined, this)
              }, undefined, false, undefined, this)
            ]
          }, undefined, true, undefined, this)
        ]
      }, undefined, true, undefined, this),
      /* @__PURE__ */ u(ConfirmDialog, {
        open: askOff && !!current,
        danger: true,
        title: "Отключить облачный пароль?",
        text: "Для входа на новом устройстве будет достаточно кода.",
        confirm: "Отключить",
        cancel: "Отмена",
        onCancel: () => setAskOff(false),
        onConfirm: () => void turnOff()
      }, undefined, false, undefined, this),
      askOff && !current ? /* @__PURE__ */ u(OffPrompt, {
        onCancel: () => setAskOff(false),
        onSubmit: (v) => {
          setCurrent(v);
        }
      }, undefined, false, undefined, this) : null
    ]
  }, undefined, true, undefined, this);
}
function OffPrompt(props) {
  const [v, setV] = d("");
  return /* @__PURE__ */ u(Modal, {
    title: "Текущий пароль",
    size: "confirm",
    onClose: props.onCancel,
    actions: [
      /* @__PURE__ */ u(Button, {
        variant: "ghost",
        onClick: props.onCancel,
        children: "Отмена"
      }, "no", false, undefined, this),
      /* @__PURE__ */ u(Button, {
        type: "submit",
        form: "rl-pw-off",
        disabled: !v,
        children: "Далее"
      }, "ok", false, undefined, this)
    ],
    children: /* @__PURE__ */ u("form", {
      id: "rl-pw-off",
      onSubmit: (e) => {
        e.preventDefault();
        if (v)
          props.onSubmit(v);
      },
      children: /* @__PURE__ */ u(TextField, {
        label: "Пароль",
        type: "password",
        value: v,
        autoFocus: true,
        onInput: (x) => setV(x)
      }, undefined, false, undefined, this)
    }, undefined, false, undefined, this)
  }, undefined, false, undefined, this);
}
// apps/web/src/ui/settings/PeoplePicker.tsx
function PeoplePicker({ path }) {
  const parsed = parseRulePath(path);
  const key = parsed?.key ?? "lastSeen";
  const list = parsed?.list ?? "allow";
  const rule = useGlobal((s) => s.settings.privacy[key]);
  const loaded = useGlobal((s) => s.settings.loaded);
  const title = EXCEPTION_TITLE[key][list];
  return /* @__PURE__ */ u("div", {
    class: "rl-sidepage",
    "aria-label": `${RULE_TITLE[key]}: ${title}`,
    children: /* @__PURE__ */ u(Picker2, {
      ruleKey: key,
      list,
      initial: rule[list],
      title
    }, String(loaded), false, undefined, this)
  }, undefined, false, undefined, this);
}
function Picker2({ ruleKey, list, initial, title }) {
  const me = useGlobal((s) => s.me.userId);
  const contacts = useGlobal((s) => s.contacts);
  const chats = useGlobal((s) => s.chats);
  const blocked = useGlobal((s) => s.blocked);
  const rule = useGlobal((s) => s.settings.privacy[ruleKey]);
  const [picked, setPicked] = d(initial);
  const [ask, setAsk] = d(null);
  const dirty = !samePeople(picked, rule[list]);
  const people = candidates(contacts, chats, me, [...initial, ...picked], blocked);
  const arm = () => setLeaveGuard(() => new Promise((resolve) => setAsk(() => resolve)));
  h(() => {
    if (!dirty) {
      setLeaveGuard(null);
      return;
    }
    arm();
    return () => setLeaveGuard(null);
  }, [dirty]);
  const answer = (leave) => {
    ask?.(leave);
    setAsk(null);
  };
  function save() {
    if (!dirty)
      return;
    setLeaveGuard(null);
    setPrivacy2(ruleKey, withPeople(rule, list, picked)).then(() => back(), () => {
      arm();
      showToast2("Не удалось сохранить изменения");
    });
  }
  return /* @__PURE__ */ u(S, {
    children: [
      /* @__PURE__ */ u(PanelHeader, {
        icon: "arrowLeft",
        closeLabel: "Назад",
        title,
        onClose: () => void back()
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u("div", {
        class: "rl-page-scroll app-people",
        children: /* @__PURE__ */ u(ContactPicker, {
          multi: true,
          contacts: people.map((p) => ({ ...p, tone: peerTone(p.id), avatar: senderAvatar(p.id) })),
          selected: initial,
          onChange: (ids) => setPicked(ids),
          searchLabel: "Поиск людей",
          placeholder: "Имя или @имя пользователя",
          empty: "Здесь появятся ваши контакты и собеседники по личным чатам."
        }, undefined, false, undefined, this)
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u(Presence, {
        show: dirty,
        exitMs: 200,
        children: /* @__PURE__ */ u("div", {
          class: "rl-fab-slot",
          children: /* @__PURE__ */ u(Fab, {
            icon: "check",
            label: "Сохранить",
            onClick: save
          }, undefined, false, undefined, this)
        }, undefined, false, undefined, this)
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u(ConfirmDialog, {
        open: !!ask,
        danger: true,
        title: "Сбросить изменения?",
        text: "Выбранные люди не сохранятся.",
        confirm: "Сбросить",
        cancel: "Отмена",
        onCancel: () => answer(false),
        onConfirm: () => answer(true)
      }, undefined, false, undefined, this)
    ]
  }, undefined, true, undefined, this);
}
// apps/web/src/ui/settings/Performance.tsx
var NAMES = ["Экономия", "Быстро и красиво", "Максимум"];
var MARKS = NAMES.map((label, value) => ({ value, label }));
var systemReduced = () => {
  try {
    return matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
};
function Performance() {
  const a = useGlobal((s) => s.prefs.anim);
  const bigEmoji = useGlobal((s) => s.prefs.bigEmoji);
  const scroll = useScrollMemory("settings/performance");
  const lv = levelOf(a);
  const reduced = systemReduced();
  const flag = (key) => (v) => setPref("anim." + key, v);
  return /* @__PURE__ */ u("div", {
    class: "rl-sidepage",
    "aria-label": "Анимации и производительность",
    children: [
      /* @__PURE__ */ u(PanelHeader, {
        icon: "arrowLeft",
        closeLabel: "Назад",
        title: "Анимации и производительность",
        onClose: () => void back()
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u("div", {
        class: "rl-settings",
        ref: scroll.ref,
        onScroll: scroll.onScroll,
        children: [
          /* @__PURE__ */ u(Section, {
            title: "Уровень анимаций",
            footer: "Чем выше уровень, тем больше анимаций и эффектов.",
            children: /* @__PURE__ */ u(RangeRow, {
              setting: "performance.level",
              label: "Уровень",
              min: 0,
              max: 2,
              step: 1,
              value: a.level,
              marks: MARKS,
              format: (v) => lv === "custom" ? "Своё" : NAMES[v],
              onChange: (v) => {
                if (v !== a.level || lv === "custom")
                  setPref("anim.level", v);
              }
            }, undefined, false, undefined, this)
          }, undefined, false, undefined, this),
          reduced ? /* @__PURE__ */ u("p", {
            class: "app-perf-note",
            children: "В системе включено уменьшение движения — анимации интерфейса отключены."
          }, undefined, false, undefined, this) : null,
          /* @__PURE__ */ u(Section, {
            title: "Интерфейс",
            children: [
              /* @__PURE__ */ u(CheckRow, {
                setting: "performance.ui",
                label: "Анимации интерфейса",
                subtitle: "Переходы, появление, перестановки, меню",
                checked: a.ui && !reduced,
                disabled: reduced,
                onChange: flag("ui")
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u(CheckRow, {
                setting: "performance.wallpaper",
                label: "Анимация обоев",
                subtitle: "Перелив фона при отправке",
                checked: a.wallpaper,
                onChange: flag("wallpaper")
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u(CheckRow, {
                setting: "performance.blur",
                label: "Размытие",
                subtitle: "Стеклянные панели и меню",
                checked: a.blur,
                onChange: flag("blur")
              }, undefined, false, undefined, this)
            ]
          }, undefined, true, undefined, this),
          /* @__PURE__ */ u(Section, {
            setting: "performance.autoplay",
            title: "Автовоспроизведение",
            children: [
              /* @__PURE__ */ u(CheckRow, {
                setting: "performance.autoplay.gif",
                label: "GIF",
                checked: a.autoplayGif,
                onChange: flag("autoplayGif")
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u(CheckRow, {
                setting: "performance.autoplay.video",
                label: "Видео",
                checked: a.autoplayVideo,
                onChange: flag("autoplayVideo")
              }, undefined, false, undefined, this)
            ]
          }, undefined, true, undefined, this),
          /* @__PURE__ */ u(Section, {
            title: "Стикеры",
            children: [
              /* @__PURE__ */ u(CheckRow, {
                setting: "performance.stickers",
                label: "Анимированные стикеры",
                subtitle: "Играют в чатах и в панели стикеров",
                checked: a.autoplayStickers,
                onChange: flag("autoplayStickers")
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u(CheckRow, {
                setting: "performance.loopStickers",
                label: "Зацикливать стикеры",
                subtitle: "Иначе стикер в чате проигрывается один раз",
                checked: a.loopStickers,
                disabled: !a.autoplayStickers,
                onChange: flag("loopStickers")
              }, undefined, false, undefined, this)
            ]
          }, undefined, true, undefined, this),
          /* @__PURE__ */ u(Section, {
            title: "Эмодзи",
            children: /* @__PURE__ */ u(CheckRow, {
              setting: "performance.bigEmoji",
              label: "Крупные эмодзи",
              subtitle: "Сообщение из одних эмодзи — крупно, один эмодзи — анимированный",
              checked: bigEmoji,
              onChange: (v) => setPref("bigEmoji", v)
            }, undefined, false, undefined, this)
          }, undefined, false, undefined, this)
        ]
      }, undefined, true, undefined, this)
    ]
  }, undefined, true, undefined, this);
}
// apps/web/src/ui/settings/Privacy.tsx
registerPrefetch2("settings/privacy", () => {
  refreshSettings2();
});
for (const k of RULE_KEYS)
  registerPrefetch2("settings/privacy/rule/" + k, () => {
    refreshSettings2();
  });
var ICON = {
  phone: ["smartphone", "green"],
  lastSeen: ["clock", "blue"],
  bio: ["info", "gray"],
  birthday: ["cake", "purple"],
  calls: ["phone", "green"],
  p2p: ["shield", "blue"]
};
function Privacy() {
  const privacy = useGlobal((s) => s.settings.privacy);
  const loaded = useGlobal((s) => s.settings.loaded);
  const blocked = useGlobal((s) => s.blocked.length);
  const phase = useGlobal((s) => s.status.phase);
  const waiting = !loaded && phase !== "offline";
  const skeleton = useMinVisible(waiting, { delay: 150, min: 600 });
  const screen = useGlobal((s) => s.prefs.screen);
  const scroll = useScrollMemory("settings/privacy");
  const [pw, setPw] = d(null);
  const [keys, setKeys] = d(null);
  h(() => {
    getPassword().then((r) => {
      if (r.ok)
        setPw(r.data.enabled);
    });
    listPasskeys().then((r) => {
      if (r.ok)
        setKeys(r.data.passkeys.length);
    });
  }, []);
  return /* @__PURE__ */ u("div", {
    class: "rl-sidepage",
    "aria-label": "Конфиденциальность",
    children: [
      /* @__PURE__ */ u(PanelHeader, {
        icon: "arrowLeft",
        closeLabel: "Назад",
        title: "Конфиденциальность",
        onClose: () => void back()
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u("div", {
        class: "rl-settings",
        ref: scroll.ref,
        onScroll: scroll.onScroll,
        children: [
          /* @__PURE__ */ u(Section, {
            title: "Вход",
            children: [
              /* @__PURE__ */ u(InfoRow, {
                tile: "green",
                icon: "lock",
                title: "Облачный пароль",
                value: pw == null ? undefined : pw ? "Вкл." : "Выкл.",
                onClick: () => void go("settings/privacy/password")
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u(InfoRow, {
                tile: "blue",
                icon: "key",
                title: "Паскеи",
                value: keys ? keys : undefined,
                onClick: () => void go("settings/privacy/passkeys")
              }, undefined, false, undefined, this)
            ]
          }, undefined, true, undefined, this),
          /* @__PURE__ */ u(Section, {
            children: /* @__PURE__ */ u("div", {
              onPointerEnter: () => prefetch2("settings/privacy/blocked"),
              children: /* @__PURE__ */ u(InfoRow, {
                tile: "red",
                icon: "block",
                title: "Заблокированные",
                value: blocked || undefined,
                onClick: () => void go("settings/privacy/blocked")
              }, undefined, false, undefined, this)
            }, undefined, false, undefined, this)
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u("div", {
            class: "app-listwrap",
            children: [
              /* @__PURE__ */ u(Presence, {
                show: skeleton,
                exitMs: 280,
                children: /* @__PURE__ */ u("div", {
                  class: "app-skel",
                  "aria-busy": "true",
                  "aria-label": "Загрузка правил",
                  children: /* @__PURE__ */ u(Section, {
                    children: [0, 1, 2, 3, 4, 5].map((i) => /* @__PURE__ */ u("div", {
                      style: { "--i": i },
                      children: /* @__PURE__ */ u(ChatRowSkeleton, {}, undefined, false, undefined, this)
                    }, i, false, undefined, this))
                  }, undefined, false, undefined, this)
                }, undefined, false, undefined, this)
              }, undefined, false, undefined, this),
              waiting || skeleton ? null : /* @__PURE__ */ u(Section, {
                title: "Конфиденциальность",
                children: RULE_KEYS.map((k) => /* @__PURE__ */ u("div", {
                  onPointerEnter: () => prefetch2("settings/privacy/rule/" + k),
                  children: /* @__PURE__ */ u(InfoRow, {
                    tile: ICON[k][1],
                    icon: ICON[k][0],
                    title: RULE_TITLE[k],
                    subtitle: ruleSubtitle(privacy[k]),
                    onClick: () => void go("settings/privacy/rule/" + k)
                  }, undefined, false, undefined, this)
                }, k, false, undefined, this))
              }, undefined, false, undefined, this)
            ]
          }, undefined, true, undefined, this),
          /* @__PURE__ */ u(Section, {
            setting: "privacy.screen",
            title: "Экран",
            footer: "Эти настройки действуют только на этом устройстве.",
            children: [
              /* @__PURE__ */ u(CheckRow, {
                setting: "privacy.screen.blur",
                label: "Размывать, когда вкладка не в фокусе",
                checked: screen.blur,
                onChange: (on) => setPref("screen.blur", on)
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u(Presence, {
                show: screen.blur,
                exitMs: 200,
                children: /* @__PURE__ */ u(SelectRow, {
                  label: "Задержка",
                  value: screen.blurDelay,
                  onChange: (v) => setPref("screen.blurDelay", Number(v)),
                  options: [{ value: 0, label: "Сразу" }, { value: 5, label: "5 секунд" }, { value: 30, label: "30 секунд" }]
                }, undefined, false, undefined, this)
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u(CheckRow, {
                setting: "privacy.screen.title",
                label: "Не показывать чат в заголовке вкладки",
                checked: screen.hideChatInTitle,
                onChange: (on) => setPref("screen.hideChatInTitle", on)
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u(CheckRow, {
                setting: "privacy.screen.unread",
                label: "Не показывать непрочитанные в заголовке и значке",
                checked: screen.hideUnreadInTitle,
                onChange: (on) => setPref("screen.hideUnreadInTitle", on)
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u(CheckRow, {
                setting: "privacy.screen.notifyText",
                label: "Скрывать текст в уведомлениях",
                checked: screen.hideNotifyText,
                onChange: (on) => setPref("screen.hideNotifyText", on)
              }, undefined, false, undefined, this)
            ]
          }, undefined, true, undefined, this)
        ]
      }, undefined, true, undefined, this)
    ]
  }, undefined, true, undefined, this);
}
// apps/web/src/ui/settings/PrivacyRule.tsx
var MODES = ["everyone", "contacts", "nobody"];
function PrivacyRule({ path }) {
  const parsed = parseRulePath(path);
  const key = parsed?.key ?? "lastSeen";
  const rule = useGlobal((s) => s.settings.privacy[key]);
  const discovery = useGlobal((s) => s.settings.privacy.phoneDiscovery);
  const loaded = useGlobal((s) => s.settings.loaded);
  const phase = useGlobal((s) => s.status.phase);
  const waiting = !loaded && phase !== "offline";
  const skeleton = useMinVisible(waiting, { delay: 150, min: 600 });
  const pick = (mode) => {
    if (mode !== rule.mode)
      setPrivacy2(key, { mode, allow: rule.allow, deny: rule.deny });
  };
  const pickDiscovery = (mode) => {
    if (mode !== discovery.mode)
      setPrivacy2("phoneDiscovery", { mode });
  };
  return /* @__PURE__ */ u("div", {
    class: "rl-sidepage",
    "aria-label": RULE_TITLE[key],
    children: [
      /* @__PURE__ */ u(PanelHeader, {
        icon: "arrowLeft",
        closeLabel: "Назад",
        title: RULE_TITLE[key],
        onClose: () => void back()
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u("div", {
        class: "rl-settings",
        children: /* @__PURE__ */ u("div", {
          class: "app-listwrap",
          children: [
            /* @__PURE__ */ u(Presence, {
              show: skeleton,
              exitMs: 280,
              children: /* @__PURE__ */ u("div", {
                class: "app-skel",
                "aria-busy": "true",
                "aria-label": "Загрузка правила",
                children: /* @__PURE__ */ u(Section, {
                  children: [0, 1, 2].map((i) => /* @__PURE__ */ u("div", {
                    style: { "--i": i },
                    children: /* @__PURE__ */ u(ChatRowSkeleton, {}, undefined, false, undefined, this)
                  }, i, false, undefined, this))
                }, undefined, false, undefined, this)
              }, undefined, false, undefined, this)
            }, undefined, false, undefined, this),
            waiting || skeleton ? null : /* @__PURE__ */ u(S, {
              children: [
                /* @__PURE__ */ u(Section, {
                  title: RULE_QUESTION[key],
                  role: "radiogroup",
                  footer: ruleCaption(key, rule.mode),
                  children: MODES.map((m) => /* @__PURE__ */ u(RadioRow, {
                    label: MODE_LABEL[m],
                    checked: rule.mode === m,
                    onClick: () => pick(m)
                  }, m, false, undefined, this))
                }, undefined, false, undefined, this),
                key === "phone" && rule.mode !== "everyone" ? /* @__PURE__ */ u(Section, {
                  setting: "privacy.rule.discovery",
                  title: DISCOVERY_TITLE,
                  role: "radiogroup",
                  footer: discoveryCaption(discovery.mode),
                  children: ["everyone", "contacts"].map((m) => /* @__PURE__ */ u(RadioRow, {
                    label: MODE_LABEL[m],
                    checked: discovery.mode === m,
                    onClick: () => pickDiscovery(m)
                  }, m, false, undefined, this))
                }, undefined, false, undefined, this) : null,
                /* @__PURE__ */ u(Section, {
                  title: "Исключения",
                  footer: rule.mode === "contacts" ? EXCEPTIONS_FOOTER : undefined,
                  children: [
                    rule.mode !== "everyone" ? /* @__PURE__ */ u(InfoRow, {
                      icon: "userPlus",
                      title: EXCEPTION_TITLE[key].allow,
                      subtitle: peopleCount(rule.allow.length),
                      onClick: () => void go(path + "/allow")
                    }, undefined, false, undefined, this) : null,
                    rule.mode !== "nobody" ? /* @__PURE__ */ u(InfoRow, {
                      icon: "block",
                      title: EXCEPTION_TITLE[key].deny,
                      subtitle: peopleCount(rule.deny.length),
                      onClick: () => void go(path + "/deny")
                    }, undefined, false, undefined, this) : null
                  ]
                }, undefined, true, undefined, this)
              ]
            }, undefined, true, undefined, this)
          ]
        }, undefined, true, undefined, this)
      }, undefined, false, undefined, this)
    ]
  }, undefined, true, undefined, this);
}
// apps/web/src/ui/settings/PersonalChannelPicker.tsx
function PersonalChannelPicker({ channels, current, onPick, onClose }) {
  const [q, setQ] = d("");
  const shown = filterChannels(channels, q);
  return /* @__PURE__ */ u(Modal, {
    onClose,
    title: "Выберите канал",
    size: "slim",
    class: "app-pcp",
    bodyClass: "app-pcp-body",
    children: [
      /* @__PURE__ */ u("div", {
        class: "app-pcp-search",
        children: /* @__PURE__ */ u(SearchInput, {
          id: "app-pcp-q",
          label: "Поиск канала",
          placeholder: "Поиск",
          value: q,
          onInput: (e) => setQ(e.target.value)
        }, undefined, false, undefined, this)
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u("div", {
        class: "app-pcp-list",
        role: "listbox",
        "aria-label": "Каналы",
        children: shown.length ? shown.map((c) => {
          const a = avatarPhoto(c.photo);
          return /* @__PURE__ */ u("button", {
            type: "button",
            role: "option",
            "aria-selected": current?.id === c.id,
            class: "app-pcp-row" + (current?.id === c.id ? " is-on" : ""),
            onClick: () => onPick(c),
            children: [
              /* @__PURE__ */ u(Avatar, {
                name: c.title || c.username,
                tone: peerTone(c.id),
                size: 42,
                src: a.src,
                thumb: a.thumb
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u("span", {
                class: "app-pcp-text",
                children: [
                  /* @__PURE__ */ u("b", {
                    children: c.title || "@" + c.username
                  }, undefined, false, undefined, this),
                  /* @__PURE__ */ u("small", {
                    children: subscribersText(c.members)
                  }, undefined, false, undefined, this)
                ]
              }, undefined, true, undefined, this)
            ]
          }, c.id, true, undefined, this);
        }) : /* @__PURE__ */ u("p", {
          class: "app-pcp-empty",
          children: "Ничего не найдено"
        }, undefined, false, undefined, this)
      }, undefined, false, undefined, this),
      current ? /* @__PURE__ */ u("button", {
        type: "button",
        class: "app-pcp-remove",
        onClick: () => onPick(null),
        children: "Убрать канал"
      }, undefined, false, undefined, this) : null
    ]
  }, undefined, true, undefined, this);
}

// apps/web/src/ui/settings/Profile.tsx
var CHECK_DELAY = 400;
var linksText = (n) => n === 0 ? "Добавить GitHub, LinkedIn, соцсети" : n % 10 === 1 && n % 100 !== 11 ? `${n} ссылка` : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? `${n} ссылки` : `${n} ссылок`;
var MONTHS = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
function useUsernameStatus(me, value) {
  const [status, setStatus] = d(null);
  const seq = A(0);
  h(() => {
    const n = ++seq.current;
    const u2 = normUsername(value);
    if (!u2 || u2 === normUsername(me.username ?? "")) {
      setStatus(null);
      return;
    }
    const shapeOk = usernameShapeOk(u2);
    setStatus(shapeOk ? "checking" : null);
    const t = setTimeout(() => {
      if (!shapeOk) {
        setStatus("invalid");
        return;
      }
      checkUsername2(u2).then((r) => {
        if (n !== seq.current)
          return;
        setStatus("offline" in r ? "offline" : r.ok ? "free" : r.reason === "invalid" ? "invalid" : "taken");
      });
    }, CHECK_DELAY);
    return () => clearTimeout(t);
  }, [value, me.username]);
  return status;
}
function BirthdayModal({ value, onSave, onClose }) {
  const [day, setDay] = d(value?.day ?? 1);
  const [month, setMonth] = d(value?.month ?? 1);
  const [year, setYear] = d(value?.year ? String(value.year) : "");
  const nowYear = new Date().getFullYear();
  const y = year.trim() ? Number(year) : undefined;
  const yearBad = y !== undefined && (!Number.isInteger(y) || y < 1900 || y > nowYear);
  const future = !yearBad && y !== undefined && new Date(y, month - 1, day).getTime() > Date.now();
  const max = daysIn(month, yearBad ? undefined : y);
  const d2 = Math.min(day, max);
  const [yearLeft, setYearLeft] = d(false);
  const typed = year.trim().length === 4 || yearLeft;
  const err = !typed ? undefined : yearBad ? "Неверный год" : future ? "Ещё впереди" : undefined;
  const incomplete = year.trim().length > 0 && year.trim().length < 4;
  const privacy = () => {
    onClose();
    go("settings/privacy/rule/birthday");
  };
  return /* @__PURE__ */ u(Modal, {
    size: "slim",
    onClose,
    label: "Дата рождения",
    className: "app-bday-modal",
    header: /* @__PURE__ */ u("div", {
      class: "app-bday-head",
      children: /* @__PURE__ */ u(IconButton, {
        icon: "close",
        label: "Закрыть",
        onClick: onClose
      }, undefined, false, undefined, this)
    }, undefined, false, undefined, this),
    children: /* @__PURE__ */ u("div", {
      class: "app-bday",
      children: [
        /* @__PURE__ */ u(Sticker, {
          name: "cake",
          size: 150,
          replay: "click"
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u("h2", {
          class: "app-bday-title",
          children: "Дата рождения"
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u("div", {
          class: "app-bday-row",
          children: [
            /* @__PURE__ */ u(SelectField, {
              label: "День",
              value: d2,
              onChange: setDay,
              options: Array.from({ length: max }, (_, i) => ({ value: i + 1, label: String(i + 1) }))
            }, undefined, false, undefined, this),
            /* @__PURE__ */ u(SelectField, {
              label: "Месяц",
              class: "app-bday-month",
              value: month,
              onChange: setMonth,
              options: MONTHS.map((m, i) => ({ value: i + 1, label: m }))
            }, undefined, false, undefined, this),
            /* @__PURE__ */ u(TextField, {
              label: "Год",
              value: year,
              inputMode: "numeric",
              maxLength: 4,
              error: err,
              onInput: (v) => {
                setYear(v.replace(/\D/g, ""));
                setYearLeft(false);
              },
              onBlur: () => setYearLeft(true)
            }, undefined, false, undefined, this)
          ]
        }, undefined, true, undefined, this),
        /* @__PURE__ */ u("p", {
          class: "app-bday-note",
          children: [
            "Кто видит дату рождения — в ",
            /* @__PURE__ */ u("button", {
              type: "button",
              class: "app-bday-link",
              onClick: privacy,
              children: "Настройках ›"
            }, undefined, false, undefined, this)
          ]
        }, undefined, true, undefined, this),
        value ? /* @__PURE__ */ u("button", {
          type: "button",
          class: "app-bday-remove",
          onClick: () => onSave(null),
          children: "Удалить из профиля"
        }, undefined, false, undefined, this) : null,
        /* @__PURE__ */ u(Button, {
          size: "lg",
          class: "app-bday-save",
          disabled: !!err || incomplete || yearBad || future,
          onClick: () => onSave(y === undefined ? { day: d2, month } : { day: d2, month, year: y }),
          children: "Сохранить"
        }, undefined, false, undefined, this)
      ]
    }, undefined, true, undefined, this)
  }, undefined, false, undefined, this);
}
var NO_CHANNELS = "Нет подходящих каналов. Подходит публичный канал, которым вы владеете";
function PersonalChannelCard({ value, onChange }) {
  const [list, setList] = d(null);
  const post = useChannelPost(value?.id);
  const pick = () => {
    const now = knownPersonalChannels();
    if (now) {
      open(now);
      return;
    }
    loadPersonalChannels().then((l) => {
      if (l)
        open(l);
      else
        showToast2("Нет сети — выбрать канал можно, когда связь вернётся");
    });
  };
  const open = (l) => {
    if (!l.length && !value) {
      showToast2(NO_CHANNELS, 3500);
      return;
    }
    setList(l);
    loadPersonalChannels().then((f) => {
      if (f)
        setList((cur) => cur ? f : cur);
    });
  };
  return /* @__PURE__ */ u(Section, {
    footer: "Покажите в профиле канал, которым вы управляете.",
    children: [
      /* @__PURE__ */ u(Expand, {
        show: !value,
        children: !value ? /* @__PURE__ */ u(InfoRow, {
          tile: "orange",
          icon: "channels",
          title: "Личный канал",
          subtitle: "Добавить канал",
          onClick: pick
        }, undefined, false, undefined, this) : null
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u(Expand, {
        show: !!value,
        children: value ? /* @__PURE__ */ u(PersonalChannelRow, {
          channel: value,
          post,
          onClick: pick
        }, undefined, false, undefined, this) : null
      }, undefined, false, undefined, this),
      list ? /* @__PURE__ */ u(PersonalChannelPicker, {
        channels: list,
        current: value,
        onClose: () => setList(null),
        onPick: (c) => {
          setList(null);
          onChange(c);
        }
      }, undefined, false, undefined, this) : null
    ]
  }, undefined, true, undefined, this);
}
function Profile() {
  const me = useGlobal((s) => s.me);
  const [form, setForm] = d(() => formFromMe(me));
  const [bday, setBday] = d(false);
  const [ask, setAsk] = d(null);
  const status = useUsernameStatus(me, form.username);
  const dirty = isDirty(me, form);
  const ok = canSave(me, form, status);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const photo = usePhotoPicker(me.photo);
  const [askDelete, setAskDelete] = d(false);
  const dirtyRef = A(dirty);
  dirtyRef.current = dirty;
  h(() => {
    if (!dirtyRef.current)
      setForm(formFromMe(me));
  }, [me]);
  const arm = () => setLeaveGuard(() => new Promise((resolve) => setAsk(() => resolve)));
  h(() => {
    if (!dirty) {
      setLeaveGuard(null);
      return;
    }
    arm();
    return () => setLeaveGuard(null);
  }, [dirty]);
  const answer = (leave) => {
    ask?.(leave);
    setAsk(null);
  };
  function save() {
    if (!dirty || !ok)
      return;
    const patch = profilePatch(me, form);
    const jobs = [];
    if (Object.keys(patch).length)
      jobs.push(updateProfile2(patch));
    if (usernameChanged(me, form))
      jobs.push(setUsername2(normUsername(form.username) || null));
    if (channelChanged(me, form))
      jobs.push(setPersonalChannel2(form.channel));
    setLeaveGuard(null);
    Promise.all(jobs).then(() => back(), () => {
      arm();
      showToast2("Не удалось сохранить изменения");
    });
  }
  const uname = normUsername(form.username);
  const unameErr = status === "taken" || status === "invalid" ? USERNAME_TEXT[status] : undefined;
  const unameHint = status === "checking" || status === "free" ? USERNAME_TEXT[status] : undefined;
  const link = uname && (!usernameChanged(me, form) || status === "free" || status === "offline") ? "relay/@" + uname : null;
  const copy = (text) => {
    navigator.clipboard?.writeText(text).then(() => showToast2("Скопировано")).catch(() => {});
  };
  const name = `${form.firstName} ${form.lastName}`.trim() || me.name;
  const limited = (key, max) => (v, e) => {
    const c = clip(v, max);
    if (c !== v)
      e.currentTarget.value = c;
    set({ [key]: c });
  };
  return /* @__PURE__ */ u("div", {
    class: "rl-sidepage",
    "aria-label": "Изменить профиль",
    children: [
      /* @__PURE__ */ u(PanelHeader, {
        icon: "arrowLeft",
        closeLabel: "Назад",
        title: "Изменить профиль",
        onClose: () => void back()
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u("div", {
        class: "rl-settings app-profile-form",
        children: [
          /* @__PURE__ */ u(ProfileHeader, {
            name,
            tone: peerTone(me.userId),
            size: 96,
            ...photo.avatar
          }, undefined, false, undefined, this),
          photo.ui,
          /* @__PURE__ */ u(Section, {
            children: [
              /* @__PURE__ */ u(TextField, {
                setting: "profile.firstName",
                label: "Имя",
                value: form.firstName,
                maxLength: NAME_MAX,
                measure: cpLen,
                error: form.firstName.trim() ? undefined : dirty ? "Укажите имя" : undefined,
                onInput: limited("firstName", NAME_MAX),
                autoComplete: "given-name"
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u(TextField, {
                setting: "profile.lastName",
                label: "Фамилия",
                value: form.lastName,
                maxLength: NAME_MAX,
                measure: cpLen,
                onInput: limited("lastName", NAME_MAX),
                autoComplete: "family-name"
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u(TextField, {
                setting: "profile.bio",
                label: "О себе",
                multiline: true,
                rows: 3,
                counter: true,
                maxLength: BIO_MAX,
                measure: cpLen,
                value: form.bio,
                hint: "Можно добавить пару строк о себе…",
                onInput: limited("bio", BIO_MAX)
              }, undefined, false, undefined, this)
            ]
          }, undefined, true, undefined, this),
          /* @__PURE__ */ u(Section, {
            title: "Имя пользователя",
            children: [
              /* @__PURE__ */ u(TextField, {
                setting: "profile.username",
                label: "Имя пользователя",
                value: form.username,
                maxLength: 33,
                error: unameErr,
                hint: unameHint,
                class: status === "free" ? "app-tf-ok" : undefined,
                onInput: (v) => set({ username: v }),
                autoComplete: "username"
              }, undefined, false, undefined, this),
              link ? /* @__PURE__ */ u("button", {
                type: "button",
                class: "app-uname-link",
                onClick: () => copy(link),
                "aria-label": "Скопировать ссылку " + link,
                children: [
                  /* @__PURE__ */ u("span", {
                    children: "Ссылка:"
                  }, undefined, false, undefined, this),
                  " ",
                  /* @__PURE__ */ u("b", {
                    children: link
                  }, undefined, false, undefined, this)
                ]
              }, undefined, true, undefined, this) : null
            ]
          }, undefined, true, undefined, this),
          /* @__PURE__ */ u(Section, {
            footer: /* @__PURE__ */ u(S, {
              children: [
                "Кто видит дату рождения — в ",
                /* @__PURE__ */ u("button", {
                  type: "button",
                  class: "app-bday-link",
                  onClick: () => void go("settings/privacy/rule/birthday"),
                  children: "Настройках ›"
                }, undefined, false, undefined, this)
              ]
            }, undefined, true, undefined, this),
            children: /* @__PURE__ */ u(InfoRow, {
              setting: "profile.birthday",
              tile: "purple",
              icon: "cake",
              title: form.birthday ? birthdayText(form.birthday) : "Не указан",
              subtitle: "День рождения",
              onClick: () => setBday(true)
            }, undefined, false, undefined, this)
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u(Section, {
            children: /* @__PURE__ */ u(InfoRow, {
              tile: "blue",
              icon: "link",
              title: "Ссылки",
              subtitle: linksText(me.links?.length ?? 0),
              onClick: () => void go("settings/profile/links")
            }, undefined, false, undefined, this)
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u(Section, {
            children: [
              /* @__PURE__ */ u(InfoRow, {
                setting: "profile.photo",
                icon: "camera",
                title: photo.has ? "Сменить фото" : "Поставить фото",
                onClick: photo.pick
              }, undefined, false, undefined, this),
              me.photo && !photo.busy ? /* @__PURE__ */ u(InfoRow, {
                icon: "trash",
                danger: true,
                title: "Удалить фото",
                onClick: () => setAskDelete(true)
              }, undefined, false, undefined, this) : null
            ]
          }, undefined, true, undefined, this),
          /* @__PURE__ */ u(PersonalChannelCard, {
            value: form.channel,
            onChange: (channel) => set({ channel })
          }, undefined, false, undefined, this)
        ]
      }, undefined, true, undefined, this),
      /* @__PURE__ */ u(Presence, {
        show: dirty && ok,
        exitMs: 200,
        children: /* @__PURE__ */ u("div", {
          class: "rl-fab-slot",
          children: /* @__PURE__ */ u(Fab, {
            icon: "check",
            label: "Сохранить",
            onClick: save
          }, undefined, false, undefined, this)
        }, undefined, false, undefined, this)
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u(ConfirmDialog, {
        open: askDelete,
        danger: true,
        title: "Удалить фото?",
        text: "Вместо фото снова будут инициалы.",
        confirm: "Удалить",
        cancel: "Отмена",
        onCancel: () => setAskDelete(false),
        onConfirm: () => {
          setAskDelete(false);
          photo.remove();
        }
      }, undefined, false, undefined, this),
      bday ? /* @__PURE__ */ u(BirthdayModal, {
        value: form.birthday,
        onClose: () => setBday(false),
        onSave: (b) => {
          set({ birthday: b });
          setBday(false);
        }
      }, undefined, false, undefined, this) : null,
      /* @__PURE__ */ u(ConfirmDialog, {
        open: !!ask,
        danger: true,
        title: "Сбросить изменения?",
        text: "Несохранённые изменения профиля пропадут.",
        confirm: "Сбросить",
        cancel: "Отмена",
        onCancel: () => answer(false),
        onConfirm: () => answer(true)
      }, undefined, false, undefined, this)
    ]
  }, undefined, true, undefined, this);
}
// apps/web/src/ui/useLeaving.ts
function mergeLeaving(prev, items, key, leaving, animate = true) {
  const keys = new Set(items.map(key));
  prev.forEach((p, i) => {
    if (animate && !keys.has(p.key) && !leaving.has(p.key))
      leaving.set(p.key, { item: p.item, after: i > 0 ? prev[i - 1].key : null });
  });
  for (const k of [...leaving.keys()])
    if (keys.has(k))
      leaving.delete(k);
  const out = items.map((item) => ({ item, key: key(item), leaving: false }));
  for (const [k, v] of leaving) {
    let at;
    if (v.after == null)
      at = 0;
    else {
      const i = out.findIndex((o) => o.key === v.after);
      at = i >= 0 ? i + 1 : out.length;
    }
    out.splice(at, 0, { item: v.item, key: k, leaving: true });
  }
  return out;
}
function useLeaving(items, key, ms) {
  const prev = A([]);
  const leaving = A(new Map);
  const [, force] = d(0);
  const out = mergeLeaving(prev.current, items, key, leaving.current, ms > 0);
  prev.current = out.filter((o) => !o.leaving).map(({ item, key }) => ({ item, key }));
  const n = leaving.current.size;
  h(() => {
    if (!n)
      return;
    const t = setTimeout(() => {
      leaving.current.clear();
      force((x) => x + 1);
    }, ms);
    return () => clearTimeout(t);
  }, [n]);
  return out;
}

// apps/web/src/ui/settings/Sessions.tsx
registerPrefetch2("settings/sessions", () => {
  loadSessions2();
});
var TTL_OPTIONS = [
  { value: 7, label: "1 неделю" },
  { value: 30, label: "1 месяц" },
  { value: 90, label: "3 месяца" },
  { value: 180, label: "6 месяцев" },
  { value: 365, label: "1 год" }
];
var BROWSERS = [
  [/^Chrome/, "browserChrome", "green"],
  [/^Safari/, "browserSafari", "blue"],
  [/^Firefox/, "browserFirefox", "orange"],
  [/^Edge/, "browserEdge", "blue"],
  [/^Opera/, "browserOpera", "red"],
  [/^Яндекс/, "browserYandex", "red"]
];
function deviceLook(device) {
  const b = BROWSERS.find(([re]) => re.test(device));
  if (b)
    return { icon: b[1], tile: b[2] };
  return { icon: /iOS|Android/.test(device) ? "smartphone" : "laptop", tile: "gray" };
}
var NEW_LOGIN = /* @__PURE__ */ u("span", {
  class: "app-session-new",
  children: "Новый вход — не подтверждён"
}, undefined, false, undefined, this);
var LOCKED_HINT = "Доступно через сутки после входа или после подтверждения на другом устройстве";
var METHOD = {
  code: "Код из Relay",
  password: "Код и облачный пароль",
  recovery: "Восстановление через почту",
  signup: "Регистрация",
  passkey: "Паскей",
  qr: "QR-код с другого устройства",
  dev: "Вход для разработки"
};
var where = (s) => s.place ?? s.ip ?? "";
function Sessions() {
  const raw = useGlobal((s) => s.sessions);
  const offline = useGlobal((s) => s.sessionsOffline);
  const keys = useGlobal((s) => s.opsKeys);
  const ttl = useGlobal((s) => s.settings.sessionsTtlDays);
  const phase = useGlobal((s) => s.status.phase);
  const [menu, setMenu] = d(null);
  const [details, setDetails] = d(null);
  const [askAll, setAskAll] = d(false);
  const [scan, setScan] = d(false);
  h(() => {
    loadSessions2(true);
  }, []);
  h(() => {
    if (phase === "ready" && offline)
      loadSessions2(true);
  }, [phase, offline]);
  h(() => {
    if (!details)
      return;
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setDetails(null);
      }
    };
    addEventListener("keydown", onKey, true);
    return () => removeEventListener("keydown", onKey, true);
  }, [details]);
  const list = raw ? sessionsSeen(raw, keys) : null;
  const waiting = list == null && !offline;
  const skeleton = useMinVisible(waiting, { delay: 150, min: 600 });
  const current = list?.find((s) => s.current) ?? null;
  const others = list?.filter((s) => !s.current) ?? [];
  const locked = !!(current?.unconfirmed || current?.limited);
  const lockSeen = A(false);
  if (locked)
    lockSeen.current = true;
  const shown = details ? list?.find((s) => s.id === details.id) ?? details : null;
  const ms = reducedMotion() ? 0 : 220;
  const rows = useLeaving(others, (s) => String(s.id), ms);
  const allRow = useLeaving(others.length ? ["all"] : [], (k) => k, ms);
  const end = (id) => {
    setMenu(null);
    setDetails(null);
    terminateSession2(id);
  };
  return /* @__PURE__ */ u("div", {
    class: "rl-sidepage",
    "aria-label": "Активные сеансы",
    children: [
      /* @__PURE__ */ u(PanelHeader, {
        icon: "arrowLeft",
        closeLabel: "Назад",
        title: "Активные сеансы",
        onClose: () => void back()
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u("div", {
        class: "rl-settings",
        children: [
          /* @__PURE__ */ u(Section, {
            footer: "Отсканируйте QR-код на экране входа другого устройства, чтобы войти там без кода.",
            children: /* @__PURE__ */ u(InfoRow, {
              setting: "sessions.link",
              tile: "green",
              icon: "qr",
              title: "Подключить устройство",
              onClick: () => setScan(true)
            }, undefined, false, undefined, this)
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u("div", {
            class: "app-listwrap",
            children: [
              /* @__PURE__ */ u(Presence, {
                show: skeleton,
                exitMs: 280,
                children: /* @__PURE__ */ u("div", {
                  class: "app-skel",
                  "aria-busy": "true",
                  "aria-label": "Загрузка сеансов",
                  children: [
                    /* @__PURE__ */ u(Section, {
                      title: "Это устройство",
                      children: [0].map((i) => /* @__PURE__ */ u("div", {
                        style: { "--i": i },
                        children: /* @__PURE__ */ u(ChatRowSkeleton, {}, undefined, false, undefined, this)
                      }, i, false, undefined, this))
                    }, undefined, false, undefined, this),
                    /* @__PURE__ */ u(Section, {
                      title: "Активные сеансы",
                      children: [1, 2].map((i) => /* @__PURE__ */ u("div", {
                        style: { "--i": i },
                        children: /* @__PURE__ */ u(ChatRowSkeleton, {}, undefined, false, undefined, this)
                      }, i, false, undefined, this))
                    }, undefined, false, undefined, this)
                  ]
                }, undefined, true, undefined, this)
              }, undefined, false, undefined, this),
              waiting || skeleton ? null : !list ? /* @__PURE__ */ u(EmptyState, {
                title: "Нет сети",
                text: "Список сеансов загрузится, когда появится подключение."
              }, undefined, false, undefined, this) : /* @__PURE__ */ u("div", {
                children: [
                  current ? /* @__PURE__ */ u(Section, {
                    title: "Это устройство",
                    children: [
                      /* @__PURE__ */ u(InfoRow, {
                        ...deviceLook(current.device),
                        title: current.device,
                        subtitle: current.unconfirmed ? NEW_LOGIN : (where(current) ? where(current) + " · " : "") + "в сети",
                        onClick: () => setDetails(current)
                      }, undefined, false, undefined, this),
                      allRow.map((r) => /* @__PURE__ */ u("div", {
                        class: "app-collapse" + (r.leaving ? " app-collapse-out" : ""),
                        children: /* @__PURE__ */ u("div", {
                          class: "app-row-lock" + (locked ? " app-row-off" : ""),
                          "aria-disabled": locked ? "true" : undefined,
                          children: /* @__PURE__ */ u(InfoRow, {
                            setting: "sessions.terminateAll",
                            icon: "logout",
                            danger: true,
                            title: "Завершить все другие сеансы",
                            subtitle: lockSeen.current ? /* @__PURE__ */ u("span", {
                              class: "app-lock-hint" + (locked ? "" : " app-lock-hint-off"),
                              "aria-hidden": locked ? undefined : "true",
                              children: /* @__PURE__ */ u("span", {
                                children: LOCKED_HINT
                              }, undefined, false, undefined, this)
                            }, undefined, false, undefined, this) : undefined,
                            onClick: locked ? undefined : () => setAskAll(true)
                          }, undefined, false, undefined, this)
                        }, undefined, false, undefined, this)
                      }, r.key, false, undefined, this))
                    ]
                  }, undefined, true, undefined, this) : null,
                  rows.length ? /* @__PURE__ */ u(Section, {
                    title: "Активные сеансы",
                    children: /* @__PURE__ */ u("div", {
                      role: "list",
                      children: rows.map(({ item: s, key, leaving }) => /* @__PURE__ */ u("div", {
                        role: "listitem",
                        class: "app-collapse" + (leaving ? " app-collapse-out" : ""),
                        onContextMenu: (e) => {
                          e.preventDefault();
                          if (!leaving && !locked)
                            setMenu({ x: e.clientX, y: e.clientY, id: s.id });
                        },
                        children: /* @__PURE__ */ u("div", {
                          children: /* @__PURE__ */ u(InfoRow, {
                            ...deviceLook(s.device),
                            title: s.device,
                            subtitle: s.unconfirmed ? NEW_LOGIN : where(s),
                            value: s.online ? "в сети" : sessionTime(s.lastActiveAt),
                            onClick: () => {
                              if (!leaving)
                                setDetails(s);
                            }
                          }, undefined, false, undefined, this)
                        }, undefined, false, undefined, this)
                      }, key, false, undefined, this))
                    }, undefined, false, undefined, this)
                  }, undefined, false, undefined, this) : null,
                  /* @__PURE__ */ u(Section, {
                    title: "Автоматически завершать сеансы",
                    children: /* @__PURE__ */ u(SelectRow, {
                      setting: "sessions.ttl",
                      label: "Если не активен",
                      value: ttl,
                      options: TTL_OPTIONS,
                      disabled: locked,
                      onChange: (v) => {
                        if (Number(v) !== ttl)
                          setSessionsTtl2(Number(v));
                      }
                    }, undefined, false, undefined, this)
                  }, undefined, false, undefined, this)
                ]
              }, undefined, true, undefined, this)
            ]
          }, undefined, true, undefined, this)
        ]
      }, undefined, true, undefined, this),
      /* @__PURE__ */ u(MenuPopover, {
        open: !!menu,
        anchor: menu ?? undefined,
        label: "Действия",
        onClose: () => setMenu(null),
        items: menu ? [{ icon: "logout", label: "Завершить", danger: true, onClick: () => end(menu.id) }] : []
      }, undefined, false, undefined, this),
      shown ? /* @__PURE__ */ u(Modal, {
        title: shown.device,
        size: "slim",
        onClose: () => setDetails(null),
        actions: shown.current ? null : /* @__PURE__ */ u(S, {
          children: [
            shown.unconfirmed ? /* @__PURE__ */ u(Button, {
              disabled: locked,
              onClick: () => void confirmSession2(shown.id),
              children: "Это я"
            }, undefined, false, undefined, this) : null,
            /* @__PURE__ */ u(Button, {
              variant: "danger",
              disabled: locked,
              onClick: () => end(shown.id),
              children: "Завершить сеанс"
            }, undefined, false, undefined, this)
          ]
        }, undefined, true, undefined, this),
        children: [
          /* @__PURE__ */ u("dl", {
            class: "app-session-info",
            children: [
              /* @__PURE__ */ u("dt", {
                children: "Устройство"
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u("dd", {
                children: shown.device
              }, undefined, false, undefined, this),
              shown.place ? /* @__PURE__ */ u(S, {
                children: [
                  /* @__PURE__ */ u("dt", {
                    children: "Место"
                  }, undefined, false, undefined, this),
                  /* @__PURE__ */ u("dd", {
                    children: shown.place
                  }, undefined, false, undefined, this)
                ]
              }, undefined, true, undefined, this) : null,
              /* @__PURE__ */ u("dt", {
                children: "IP"
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u("dd", {
                children: shown.ip ?? "—"
              }, undefined, false, undefined, this),
              shown.method && METHOD[shown.method] ? /* @__PURE__ */ u(S, {
                children: [
                  /* @__PURE__ */ u("dt", {
                    children: "Способ входа"
                  }, undefined, false, undefined, this),
                  /* @__PURE__ */ u("dd", {
                    children: METHOD[shown.method]
                  }, undefined, false, undefined, this)
                ]
              }, undefined, true, undefined, this) : null,
              /* @__PURE__ */ u("dt", {
                children: "Вход"
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u("dd", {
                children: fullDateTime(shown.createdAt)
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u("dt", {
                children: "Последняя активность"
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u("dd", {
                children: shown.online ? "в сети" : fullDateTime(shown.lastActiveAt)
              }, undefined, false, undefined, this)
            ]
          }, undefined, true, undefined, this),
          shown.unconfirmed ? /* @__PURE__ */ u("p", {
            class: "app-session-note",
            children: NEW_LOGIN
          }, undefined, false, undefined, this) : null,
          locked && !shown.current ? /* @__PURE__ */ u("p", {
            class: "app-session-note",
            children: LOCKED_HINT
          }, undefined, false, undefined, this) : null,
          shown.current && shown.limited && !shown.unconfirmed ? /* @__PURE__ */ u("p", {
            class: "app-session-note",
            children: "Новый вход: первые сутки с этого устройства нельзя завершать другие сеансы, менять пароль и паскеи."
          }, undefined, false, undefined, this) : null
        ]
      }, undefined, true, undefined, this) : null,
      scan ? /* @__PURE__ */ u(QrScanner, {
        onClose: () => setScan(false)
      }, undefined, false, undefined, this) : null,
      /* @__PURE__ */ u(ConfirmDialog, {
        open: askAll,
        danger: true,
        title: "Завершить все другие сеансы?",
        text: "Relay выйдет из аккаунта на всех устройствах, кроме этого.",
        confirm: "Завершить",
        cancel: "Отмена",
        onCancel: () => setAskAll(false),
        onConfirm: () => {
          setAskAll(false);
          terminateOtherSessions2();
        }
      }, undefined, false, undefined, this)
    ]
  }, undefined, true, undefined, this);
}
// apps/web/src/ui/settings/Shortcuts.tsx
function Combo({ combo, range }) {
  const keys = comboKeys(combo);
  if (range)
    keys[keys.length - 1] = range;
  return /* @__PURE__ */ u("span", {
    class: "app-combo",
    children: keys.map((k, i) => /* @__PURE__ */ u(S, {
      children: [
        i > 0 && !IS_APPLE ? /* @__PURE__ */ u("span", {
          class: "app-combo-plus",
          "aria-hidden": "true",
          children: "+"
        }, undefined, false, undefined, this) : null,
        /* @__PURE__ */ u("kbd", {
          class: "app-kbd",
          children: k
        }, undefined, false, undefined, this)
      ]
    }, i, true, undefined, this))
  }, undefined, false, undefined, this);
}
function Row2({ s }) {
  const label = s.combos.map((c) => comboKeys(c).join(IS_APPLE ? "" : "+")).join(" или ");
  return /* @__PURE__ */ u("div", {
    class: "app-sc-row",
    role: "listitem",
    "data-setting": "shortcut." + s.id,
    "aria-label": `${s.title}: ${label}`,
    children: [
      /* @__PURE__ */ u("span", {
        class: "rl-optrow-text",
        children: [
          /* @__PURE__ */ u("span", {
            children: s.title
          }, undefined, false, undefined, this),
          s.hint ? /* @__PURE__ */ u("small", {
            children: s.hint
          }, undefined, false, undefined, this) : null
        ]
      }, undefined, true, undefined, this),
      /* @__PURE__ */ u("span", {
        class: "app-sc-keys",
        "aria-hidden": "true",
        children: s.combos.map((c, i) => /* @__PURE__ */ u(S, {
          children: [
            i > 0 ? /* @__PURE__ */ u("span", {
              class: "app-combo-or",
              children: "/"
            }, undefined, false, undefined, this) : null,
            /* @__PURE__ */ u(Combo, {
              combo: c,
              range: s.range
            }, undefined, false, undefined, this)
          ]
        }, c, true, undefined, this))
      }, undefined, false, undefined, this)
    ]
  }, undefined, true, undefined, this);
}
function Shortcuts() {
  const sendKey = useGlobal((s) => s.prefs.sendKey);
  const scroll = useScrollMemory("settings/general/shortcuts");
  const mod = IS_APPLE ? "⌘" : "Ctrl";
  return /* @__PURE__ */ u("div", {
    class: "rl-sidepage",
    "aria-label": "Сочетания клавиш",
    children: [
      /* @__PURE__ */ u(PanelHeader, {
        icon: "arrowLeft",
        closeLabel: "Назад",
        title: "Сочетания клавиш",
        onClose: () => void back()
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u("div", {
        class: "rl-settings",
        ref: scroll.ref,
        onScroll: scroll.onScroll,
        children: [
          /* @__PURE__ */ u(Section, {
            title: "Отправка сообщений",
            role: "radiogroup",
            footer: "Как отправлять сообщения и переносить строку.",
            children: [
              /* @__PURE__ */ u(RadioRow, {
                label: "Enter — отправить",
                subtitle: "Shift+Enter — новая строка",
                checked: sendKey === "enter",
                onClick: () => setPref("sendKey", "enter")
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u(RadioRow, {
                label: `${mod}+Enter — отправить`,
                subtitle: "Enter — новая строка",
                checked: sendKey === "ctrlEnter",
                onClick: () => setPref("sendKey", "ctrlEnter")
              }, undefined, false, undefined, this)
            ]
          }, undefined, true, undefined, this),
          shortcutSections(sendKey).map((sec) => /* @__PURE__ */ u(Section, {
            setting: "shortcuts." + sec.id,
            title: sec.title,
            footer: sec.footer,
            children: /* @__PURE__ */ u("div", {
              role: "list",
              children: sec.items.map((s) => /* @__PURE__ */ u(Row2, {
                s
              }, s.id, false, undefined, this))
            }, undefined, false, undefined, this)
          }, sec.id, false, undefined, this))
        ]
      }, undefined, true, undefined, this)
    ]
  }, undefined, true, undefined, this);
}
// apps/web/src/ui/links/Links.tsx
var save2 = (links) => {
  setLinks2(links).catch(() => showToast2("Не удалось сохранить ссылки"));
};
function Links() {
  const links = useGlobal((s) => s.me?.links) ?? [];
  const [drag, setDrag] = d(null);
  const [settling, setSettling] = d(false);
  const dragRef = A(null);
  dragRef.current = drag;
  const onDown = (i) => (e) => {
    if (e.button !== 0)
      return;
    const row = e.currentTarget.closest(".app-link-row");
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
    setDrag({ from: i, to: i, dy: 0, rowH: row.getBoundingClientRect().height, y0: e.clientY, id: e.pointerId });
  };
  const onMove = (e) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.id)
      return;
    const dy = Math.max(-d.from * d.rowH, Math.min((links.length - 1 - d.from) * d.rowH, e.clientY - d.y0));
    setDrag({ ...d, dy, to: dropIndex(d.from, dy, d.rowH, links.length) });
  };
  const onUp = (e) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.id)
      return;
    setDrag(null);
    if (d.to !== d.from) {
      setSettling(true);
      requestAnimationFrame(() => requestAnimationFrame(() => setSettling(false)));
      save2(moveLink(links, d.from, d.to));
    }
  };
  const onKey = (i) => (e) => {
    if (!e.altKey || e.key !== "ArrowUp" && e.key !== "ArrowDown")
      return;
    e.preventDefault();
    const to = i + (e.key === "ArrowUp" ? -1 : 1);
    if (to < 0 || to >= links.length)
      return;
    save2(moveLink(links, i, to));
    const host = e.currentTarget.parentElement?.parentElement;
    requestAnimationFrame(() => host?.querySelectorAll(".app-link-open")[to]?.focus());
  };
  const remove = (i) => save2(links.filter((_, k) => k !== i));
  return /* @__PURE__ */ u("div", {
    class: "rl-sidepage",
    "aria-label": "Ссылки",
    children: [
      /* @__PURE__ */ u(PanelHeader, {
        icon: "arrowLeft",
        closeLabel: "Назад",
        title: "Ссылки",
        onClose: () => void back()
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u("div", {
        class: "rl-settings",
        children: links.length === 0 ? /* @__PURE__ */ u("div", {
          class: "app-links-intro",
          children: [
            /* @__PURE__ */ u(Sticker, {
              name: "link",
              size: 100,
              replay: "click"
            }, undefined, false, undefined, this),
            /* @__PURE__ */ u("h2", {
              children: "Ссылки в профиле"
            }, undefined, false, undefined, this),
            /* @__PURE__ */ u("p", {
              children: "Покажите, где ещё вас можно найти, — прямо под именем."
            }, undefined, false, undefined, this),
            /* @__PURE__ */ u("ul", {
              children: [
                /* @__PURE__ */ u("li", {
                  children: [
                    /* @__PURE__ */ u(Icon, {
                      name: "link",
                      size: 22
                    }, undefined, false, undefined, this),
                    /* @__PURE__ */ u("div", {
                      children: [
                        /* @__PURE__ */ u("b", {
                          children: "Все профили в одном месте"
                        }, undefined, false, undefined, this),
                        /* @__PURE__ */ u("span", {
                          children: "LinkedIn, GitHub и соцсети — кнопками в профиле."
                        }, undefined, false, undefined, this)
                      ]
                    }, undefined, true, undefined, this)
                  ]
                }, undefined, true, undefined, this),
                /* @__PURE__ */ u("li", {
                  children: [
                    /* @__PURE__ */ u(Icon, {
                      name: "lock",
                      size: 22
                    }, undefined, false, undefined, this),
                    /* @__PURE__ */ u("div", {
                      children: [
                        /* @__PURE__ */ u("b", {
                          children: "Только настоящие сайты"
                        }, undefined, false, undefined, this),
                        /* @__PURE__ */ u("span", {
                          children: "Ссылка собирается из имени пользователя, адрес нельзя подменить."
                        }, undefined, false, undefined, this)
                      ]
                    }, undefined, true, undefined, this)
                  ]
                }, undefined, true, undefined, this),
                /* @__PURE__ */ u("li", {
                  children: [
                    /* @__PURE__ */ u(Icon, {
                      name: "listOrdered",
                      size: 22
                    }, undefined, false, undefined, this),
                    /* @__PURE__ */ u("div", {
                      children: [
                        /* @__PURE__ */ u("b", {
                          children: "Ваш порядок"
                        }, undefined, false, undefined, this),
                        /* @__PURE__ */ u("span", {
                          children: "Главную ссылку — первой. Порядок меняется перетаскиванием."
                        }, undefined, false, undefined, this)
                      ]
                    }, undefined, true, undefined, this)
                  ]
                }, undefined, true, undefined, this)
              ]
            }, undefined, true, undefined, this),
            /* @__PURE__ */ u(Button, {
              "data-setting": "profile.links.add",
              variant: "primary",
              onClick: () => void go("settings/profile/links/new"),
              children: "Добавить ссылку"
            }, undefined, false, undefined, this)
          ]
        }, undefined, true, undefined, this) : /* @__PURE__ */ u(S, {
          children: /* @__PURE__ */ u(Section, {
            footer: "Ссылки показываются кнопками в профиле в этом порядке. Перетащите за ручку справа, чтобы поменять порядок.",
            children: [
              /* @__PURE__ */ u("div", {
                class: "app-links-list" + (drag ? " app-links-dragging" : "") + (settling ? " app-links-settling" : ""),
                role: "list",
                "aria-label": "Ссылки профиля",
                children: links.map((l, i) => {
                  const dragging = drag?.from === i;
                  const shift = drag && !dragging ? shiftFor(i, drag.from, drag.to) * drag.rowH : 0;
                  return /* @__PURE__ */ u("div", {
                    role: "listitem",
                    class: "app-link-row" + (dragging ? " app-link-row-drag" : ""),
                    style: { transform: dragging ? `translateY(${drag.dy}px)` : shift ? `translateY(${shift}px)` : undefined },
                    children: [
                      /* @__PURE__ */ u("button", {
                        type: "button",
                        class: "app-link-open",
                        onClick: () => void go("settings/profile/links/" + i),
                        onKeyDown: onKey(i),
                        "aria-label": `${LINK_TITLE[l.service]}: ${linkLabel(l)}. Изменить`,
                        "aria-keyshortcuts": "Alt+ArrowUp Alt+ArrowDown",
                        children: [
                          /* @__PURE__ */ u(ServiceIcon, {
                            service: l.service,
                            size: 34
                          }, undefined, false, undefined, this),
                          /* @__PURE__ */ u("span", {
                            class: "rl-inforow-text",
                            children: [
                              /* @__PURE__ */ u("span", {
                                children: LINK_TITLE[l.service]
                              }, undefined, false, undefined, this),
                              /* @__PURE__ */ u("small", {
                                children: linkLabel(l)
                              }, undefined, false, undefined, this)
                            ]
                          }, undefined, true, undefined, this)
                        ]
                      }, undefined, true, undefined, this),
                      /* @__PURE__ */ u(IconButton, {
                        icon: "trash",
                        label: "Удалить " + LINK_TITLE[l.service],
                        onClick: () => remove(i)
                      }, undefined, false, undefined, this),
                      /* @__PURE__ */ u("span", {
                        class: "app-link-grip",
                        title: "Перетащите, чтобы поменять порядок",
                        "aria-hidden": "true",
                        onPointerDown: onDown(i),
                        onPointerMove: onMove,
                        onPointerUp: onUp,
                        onPointerCancel: onUp,
                        children: /* @__PURE__ */ u(Icon, {
                          name: "grip",
                          size: 22
                        }, undefined, false, undefined, this)
                      }, undefined, false, undefined, this)
                    ]
                  }, l.service + ":" + l.handle, true, undefined, this);
                })
              }, undefined, false, undefined, this),
              links.length < MAX_LINKS ? /* @__PURE__ */ u(InfoRow, {
                setting: "profile.links.add",
                icon: "plus",
                title: "Добавить ссылку",
                onClick: () => void go("settings/profile/links/new")
              }, undefined, false, undefined, this) : null
            ]
          }, undefined, true, undefined, this)
        }, undefined, false, undefined, this)
      }, undefined, false, undefined, this)
    ]
  }, undefined, true, undefined, this);
}
export {
  Autoload,
  Blocked,
  Calls,
  Data,
  Dev,
  FolderChats,
  FolderEdit,
  Folders,
  General,
  LinkEdit2 as LinkEdit,
  Links,
  Main,
  Notifications,
  Passkeys,
  Password,
  PeoplePicker,
  Performance,
  Privacy,
  PrivacyRule,
  Profile,
  Sessions,
  Shortcuts,
  Wallpaper3 as Wallpaper,
  WallpaperColor2 as WallpaperColor
};

//# debugId=B1BC10A57DF7A4A164756E2164756E21
//# sourceMappingURL=pages-4sjc33gf.js.map
