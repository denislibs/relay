import {
  S,
  d,
  h,
  A,
  T,
  q,
  requestMutation,
  SearchInput,
  ContactPicker,
  WindowList,
  asideFloats,
  Fab,
  Icon,
  Button,
  IconButton,
  peerTone,
  Avatar,
  Chip,
  ChatRowSkeleton,
  Switch,
  PanelHeader,
  ProfileHeader,
  InfoRow,
  Presence,
  useMinVisible,
  EmptyState,
  Modal,
  Section,
  RadioRow,
  CheckRow,
  RangeRow,
  TextField,
  ConfirmDialog,
  useGlobal,
  clock,
  dayLabel,
  lastSeenText,
  isSystemChat,
  useMembers,
  wantPeople,
  showToast2,
  MEMBER_RIGHT_TEXT,
  adminRightText,
  SLOW_TEXT,
  useGroup,
  adminCan,
  canChangeInfo,
  canInvite,
  PLAIN_RIGHTS,
  toggleRight,
  mediaCount,
  sameRights,
  sameAdmin,
  errorText,
  act,
  useGroupData,
  inviteUrl,
  publicUrl,
  copyText,
  plural3,
  u,
  openInner2,
  openUserChat2,
  engineSend2,
  groupCall2,
  peerRefs2,
  createDirectChat2,
  refreshChats2,
  avatarPhoto,
  userPhoto,
  senderAvatar,
  upload,
  reactionCatalog,
  useReactionCatalog,
  termText,
  candidates,
  usePhotoPicker,
  proofOf
} from "./main-s48bdnny.js";
import {
  emojiKey,
  MEMBER_RIGHTS,
  MEDIA_RIGHTS,
  ADMIN_RIGHTS_BY_KIND,
  SLOW_MODES,
  GROUP_ABOUT_MAX,
  RANK_MAX,
  INVITE_USAGE_MAX,
  allAdminRights,
  noAdminRights,
  rightsCount,
  isAdminRole,
  ADMIN_LOG_GROUPS,
  ADMIN_LOG_ACTIONS,
  ADMIN_LOG_LABELS
} from "./main-p1twxvxz.js";

// apps/web/src/ui/group/common.tsx
function GPage({ title, onBack, children, fab, action, actions }) {
  return /* @__PURE__ */ u("div", {
    class: "rl-sidepage",
    "aria-label": title,
    children: [
      /* @__PURE__ */ u(PanelHeader, {
        icon: "arrowLeft",
        closeLabel: "Назад",
        title,
        onClose: onBack,
        action,
        actions
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u("div", {
        class: "rl-settings app-gm",
        children
      }, undefined, false, undefined, this),
      fab ? /* @__PURE__ */ u(Presence, {
        show: fab.show,
        exitMs: 200,
        children: /* @__PURE__ */ u("div", {
          class: "rl-fab-slot" + (fab.busy ? " app-gm-busy" : ""),
          children: /* @__PURE__ */ u(Fab, {
            icon: fab.icon,
            label: fab.label,
            onClick: fab.busy ? () => {} : fab.onClick
          }, undefined, false, undefined, this)
        }, undefined, false, undefined, this)
      }, undefined, false, undefined, this) : null
    ]
  }, undefined, true, undefined, this);
}
function PersonRow({ id, name, label, photo, subtitle, online, trailing, onClick, onContext, disabled }) {
  h(() => {
    if (!photo)
      wantPeople([id]);
  }, [id, !photo]);
  return /* @__PURE__ */ u("button", {
    type: "button",
    role: "listitem",
    class: "rl-row app-member app-gm-person",
    disabled,
    onClick,
    onContextMenu: onContext ? (e) => {
      e.preventDefault();
      onContext(e);
    } : undefined,
    children: [
      /* @__PURE__ */ u(Avatar, {
        name,
        tone: peerTone(id),
        size: 44,
        online: !!online,
        ...avatarPhoto(photo ?? userPhoto(id))
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u("span", {
        class: "rl-row-main",
        children: [
          /* @__PURE__ */ u("span", {
            class: "app-member-top",
            children: [
              /* @__PURE__ */ u("span", {
                class: "rl-row-name",
                children: label ?? name
              }, undefined, false, undefined, this),
              trailing ? /* @__PURE__ */ u("span", {
                class: "app-member-badge",
                children: trailing
              }, undefined, false, undefined, this) : null
            ]
          }, undefined, true, undefined, this),
          subtitle != null ? /* @__PURE__ */ u("span", {
            class: "rl-row-preview" + (online ? " app-online" : ""),
            children: subtitle
          }, undefined, false, undefined, this) : null
        ]
      }, undefined, true, undefined, this)
    ]
  }, undefined, true, undefined, this);
}
function Loading() {
  return /* @__PURE__ */ u("div", {
    class: "app-sm-loading",
    "aria-busy": "true"
  }, undefined, false, undefined, this);
}

// apps/web/src/ui/group/EditGroup.tsx
var TITLE_MAX = 128;
var cpLen = (s) => [...s].length;
var clip = (s, max) => [...s].slice(0, max).join("");
function EditGroup({ nav }) {
  const { chatId } = nav;
  const { group, me, title: chatTitle, kind } = useGroup(chatId);
  const channel = kind === "channel";
  const linkedTitle = useGlobal((s) => {
    const id = group?.linkedChatId;
    return id != null ? s.chats.find((c) => c.id === id)?.title ?? null : null;
  });
  const members = useMembers(chatId, true);
  const myUserId = useGlobal((s) => s.me.userId);
  const [title, setTitle] = d(group?.title ?? chatTitle);
  const [about, setAbout] = d(group?.about ?? "");
  const [busy, setBusy] = d(false);
  const [ask, setAsk] = d(null);
  const base = A({ title: group?.title ?? chatTitle, about: group?.about ?? "" });
  h(() => {
    if (!group)
      return;
    if (title === base.current.title)
      setTitle(group.title);
    if (about === base.current.about)
      setAbout(group.about);
    base.current = { title: group.title, about: group.about };
  }, [group?.title, group?.about]);
  const owner = me?.role === "owner";
  const info = canChangeInfo(me);
  const photo = usePhotoPicker(group?.photo, {
    set: async (c) => {
      const [id, small, video] = await Promise.all([upload(c.big, 640), upload(c.small, 160), c.video ? upload(c.video.blob, c.video.side, c.video) : undefined]);
      const r = await groupCall2("PUT", `/groups/${chatId}/photo`, { id, small, thumb: c.thumb, ...video ? { video } : {} });
      if (!r.ok)
        throw new Error(r.code);
    },
    remove: async () => {
      const r = await groupCall2("DELETE", `/groups/${chatId}/photo`);
      if (!r.ok)
        throw new Error(r.code);
    }
  });
  const invites = useGroupData(adminCan(me, "invite") ? `/groups/${chatId}/invites` : null, group);
  if (!group || !me)
    return /* @__PURE__ */ u(GPage, {
      title: "Изменить",
      onBack: nav.back,
      children: /* @__PURE__ */ u("div", {}, undefined, false, undefined, this)
    }, undefined, false, undefined, this);
  const dirty = title.trim() !== group.title || about.trim() !== group.about;
  const titleErr = !title.trim() ? channel ? "Укажите название канала" : "Укажите название группы" : undefined;
  const save = async () => {
    if (!dirty || titleErr)
      return;
    setBusy(true);
    const ok = await act("PATCH", `/groups/${chatId}`, { title: title.trim(), about: about.trim() });
    setBusy(false);
    if (ok)
      nav.back();
  };
  const admins = members?.members.filter((m) => m.role === "owner" || m.role === "admin").length;
  const live = invites.data?.invites.filter((i) => !i.revoked).length;
  const total = MEMBER_RIGHTS.length;
  const leave = async () => {
    setAsk(null);
    const ok = await act("DELETE", ask === "delete" ? `/groups/${chatId}` : `/groups/${chatId}/members/${myUserId}`);
    if (ok)
      nav.close();
  };
  return /* @__PURE__ */ u(GPage, {
    title: "Изменить",
    onBack: nav.back,
    fab: { show: dirty && !titleErr, icon: "check", label: "Сохранить", onClick: save, busy },
    children: [
      /* @__PURE__ */ u(ProfileHeader, {
        name: title || group.title,
        tone: peerTone(chatId),
        size: 96,
        ...info ? photo.avatar : {}
      }, undefined, false, undefined, this),
      info ? photo.ui : null,
      /* @__PURE__ */ u(Section, {
        children: [
          /* @__PURE__ */ u(TextField, {
            label: channel ? "Название канала" : "Название группы",
            value: title,
            disabled: !info,
            maxLength: TITLE_MAX,
            measure: cpLen,
            error: titleErr,
            onInput: (v, e) => {
              const c = clip(v, TITLE_MAX);
              if (c !== v)
                e.currentTarget.value = c;
              setTitle(c);
            }
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u(TextField, {
            label: "Описание",
            multiline: true,
            rows: 3,
            counter: true,
            value: about,
            disabled: !info,
            maxLength: GROUP_ABOUT_MAX,
            measure: cpLen,
            hint: channel ? "Расскажите, о чём этот канал" : "Расскажите, о чём эта группа",
            onInput: (v, e) => {
              const c = clip(v, GROUP_ABOUT_MAX);
              if (c !== v)
                e.currentTarget.value = c;
              setAbout(c);
            }
          }, undefined, false, undefined, this)
        ]
      }, undefined, true, undefined, this),
      /* @__PURE__ */ u(Section, {
        children: [
          owner ? /* @__PURE__ */ u(InfoRow, {
            tile: "blue",
            icon: "lock",
            title: channel ? "Тип канала" : "Тип группы",
            subtitle: channel ? group.username ? "Публичный" : "Частный" : group.username ? "Публичная" : "Частная",
            onClick: () => nav.go("gType")
          }, undefined, false, undefined, this) : null,
          channel && owner ? /* @__PURE__ */ u(InfoRow, {
            tile: "blue",
            icon: "chats",
            title: "Обсуждение",
            subtitle: group.linkedChatId != null ? linkedTitle ?? "Группа привязана" : "Добавить группу",
            onClick: () => nav.go("gDiscussion")
          }, undefined, false, undefined, this) : null,
          !channel && adminCan(me, "ban") ? /* @__PURE__ */ u(InfoRow, {
            tile: "green",
            icon: "key",
            title: "Разрешения",
            subtitle: `${rightsCount(group.rights)}/${total}`,
            onClick: () => nav.go("gPerms")
          }, undefined, false, undefined, this) : null,
          adminCan(me, "info") ? /* @__PURE__ */ u(InfoRow, {
            tile: "orange",
            icon: "smile",
            title: "Реакции",
            subtitle: group.reactions.mode === "all" ? "Все" : group.reactions.mode === "none" ? "Выкл." : String(group.reactions.allowed.length),
            onClick: () => nav.go("gReactions")
          }, undefined, false, undefined, this) : null,
          /* @__PURE__ */ u(InfoRow, {
            tile: "purple",
            icon: "shield",
            title: "Администраторы",
            subtitle: admins != null ? String(admins) : "…",
            onClick: () => nav.go("gAdmins")
          }, undefined, false, undefined, this),
          adminCan(me, "invite") ? /* @__PURE__ */ u(InfoRow, {
            tile: "green",
            icon: "link",
            title: "Пригласительные ссылки",
            subtitle: live != null ? String(live) : "…",
            onClick: () => nav.go("gInvites")
          }, undefined, false, undefined, this) : null,
          group.requests > 0 ? /* @__PURE__ */ u(InfoRow, {
            tile: "red",
            icon: "userPlus",
            title: "Заявки на вступление",
            subtitle: String(group.requests),
            onClick: () => nav.go("gRequests")
          }, undefined, false, undefined, this) : null,
          isAdminRole(me.role) ? /* @__PURE__ */ u(InfoRow, {
            tile: "orange",
            icon: "history",
            title: "Недавние действия",
            onClick: () => nav.go("gLog")
          }, undefined, false, undefined, this) : null
        ]
      }, undefined, true, undefined, this),
      channel && adminCan(me, "info") ? /* @__PURE__ */ u(Section, {
        footer: group.signatures ? "Под постами видно имя администратора, который их опубликовал." : "Посты публикуются от имени канала, без имени автора.",
        children: /* @__PURE__ */ u(InfoRow, {
          icon: "pencil",
          title: "Подписи постов",
          trailing: /* @__PURE__ */ u(Switch, {
            id: "g-signatures",
            label: "Подписи постов",
            checked: group.signatures,
            onChange: () => void act("PUT", `/groups/${chatId}/settings`, { signatures: !group.signatures })
          }, undefined, false, undefined, this)
        }, undefined, false, undefined, this)
      }, undefined, false, undefined, this) : null,
      !channel && group.linkedChatId != null ? /* @__PURE__ */ u(Section, {
        footer: "Посты канала приходят в эту группу, комментарии к ним — ответы в треде.",
        children: /* @__PURE__ */ u(InfoRow, {
          tile: "blue",
          icon: "channels",
          title: "Связанный канал",
          subtitle: linkedTitle ?? "Канал"
        }, undefined, false, undefined, this)
      }, undefined, false, undefined, this) : null,
      /* @__PURE__ */ u(Section, {
        children: /* @__PURE__ */ u(InfoRow, {
          tile: "blue",
          icon: "users",
          title: channel ? "Подписчики" : "Участники",
          subtitle: channel ? `${group.members} ${plural3(group.members, "подписчик", "подписчика", "подписчиков")}` : `${group.members} ${plural3(group.members, "участник", "участника", "участников")}`,
          onClick: () => nav.go("gMembers")
        }, undefined, false, undefined, this)
      }, undefined, false, undefined, this),
      !channel && !group.username && group.linkedChatId == null && adminCan(me, "ban") ? /* @__PURE__ */ u(Section, {
        footer: group.historyHidden ? "Новые участники не увидят сообщения, отправленные до их вступления." : "Новые участники увидят все сообщения группы.",
        children: /* @__PURE__ */ u(InfoRow, {
          icon: "history",
          title: "История чата для новых участников",
          subtitle: group.historyHidden ? "Скрыта" : "Видна",
          trailing: /* @__PURE__ */ u(Switch, {
            id: "g-history",
            label: "История для новых участников",
            checked: !group.historyHidden,
            onChange: () => void act("PUT", `/groups/${chatId}/settings`, { historyHidden: !group.historyHidden })
          }, undefined, false, undefined, this)
        }, undefined, false, undefined, this)
      }, undefined, false, undefined, this) : null,
      !channel && group.linkedChatId != null && (adminCan(me, "ban") || adminCan(me, "info")) ? /* @__PURE__ */ u(Section, {
        footer: group.joinToSend ? "Чтобы оставить комментарий, подписчику канала нужно вступить в группу." : "Подписчики канала могут комментировать посты, не вступая в группу.",
        children: /* @__PURE__ */ u(InfoRow, {
          icon: "chats",
          title: "Комментировать могут только участники",
          trailing: /* @__PURE__ */ u(Switch, {
            id: "g-join-to-send",
            label: "Комментировать могут только участники",
            checked: !!group.joinToSend,
            onChange: () => void act("PUT", `/groups/${chatId}/settings`, { joinToSend: !group.joinToSend })
          }, undefined, false, undefined, this)
        }, undefined, false, undefined, this)
      }, undefined, false, undefined, this) : null,
      /* @__PURE__ */ u(Section, {
        children: /* @__PURE__ */ u(InfoRow, {
          icon: "logout",
          danger: true,
          title: owner ? channel ? "Удалить канал" : "Удалить и покинуть группу" : channel ? "Покинуть канал" : "Покинуть группу",
          onClick: () => setAsk(owner ? "delete" : "leave")
        }, undefined, false, undefined, this)
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u(ConfirmDialog, {
        open: !!ask,
        danger: true,
        title: ask === "delete" ? channel ? "Удалить канал?" : "Удалить группу?" : channel ? "Покинуть канал?" : "Покинуть группу?",
        text: ask === "delete" ? `${channel ? "Канал" : "Группа"} «${group.title}» будет удалён${channel ? "" : "а"} у всех ${channel ? "подписчиков" : "участников"} вместе с историей.` : `Вы покинете «${group.title}». Вернуться можно будет только по приглашению.`,
        confirm: ask === "delete" ? "Удалить у всех" : "Покинуть",
        onCancel: () => setAsk(null),
        onConfirm: () => void leave()
      }, undefined, false, undefined, this)
    ]
  }, undefined, true, undefined, this);
}
function GroupType({ nav }) {
  const { chatId } = nav;
  const { group, me, kind } = useGroup(chatId);
  const channel = kind === "channel";
  const T = channel ? "Тип канала" : "Тип группы";
  const [pub, setPub] = d(!!group?.username);
  const [name, setName] = d(group?.username ?? "");
  const [status, setStatus] = d(null);
  const [busy, setBusy] = d(false);
  const [askPrivate, setAskPrivate] = d(false);
  const [askRevoke, setAskRevoke] = d(false);
  const invites = useGroupData(`/groups/${chatId}/invites`, group);
  const primary = invites.data?.invites.find((i) => i.primary && !i.revoked) ?? null;
  h(() => {
    if (!pub) {
      setStatus(null);
      return;
    }
    const n = name.trim().replace(/^@/, "");
    if (n && n.toLowerCase() === group?.username) {
      setStatus(null);
      return;
    }
    if (!/^[a-z][a-z0-9_]{4,31}$/i.test(n)) {
      setStatus(n ? "invalid" : null);
      return;
    }
    setStatus("checking");
    const t = setTimeout(() => {
      groupCall2("GET", `/groups/username/check?username=${encodeURIComponent(n)}&chatId=${chatId}`).then((r) => {
        if (r.ok)
          setStatus(r.data.ok ? "free" : r.data.reason === "taken" ? "taken" : "invalid");
      });
    }, 400);
    return () => clearTimeout(t);
  }, [name, pub]);
  if (!group || !me)
    return /* @__PURE__ */ u(GPage, {
      title: T,
      onBack: nav.back,
      children: /* @__PURE__ */ u("div", {}, undefined, false, undefined, this)
    }, undefined, false, undefined, this);
  const was = group.username;
  const n = name.trim().replace(/^@/, "").toLowerCase();
  const dirty = pub ? n !== (was ?? "") : !!was;
  const valid = !pub || (status === "free" || n === was);
  const save = async () => {
    if (!dirty || !valid)
      return;
    if (!pub && was && !askPrivate) {
      setAskPrivate(true);
      return;
    }
    setAskPrivate(false);
    setBusy(true);
    const ok = await act("PUT", `/groups/${chatId}/username`, { username: pub ? n : null });
    setBusy(false);
    if (ok)
      nav.back();
  };
  const revoke = async () => {
    setAskRevoke(false);
    if (primary && await act("PATCH", `/groups/${chatId}/invites/${primary.id}`, { revoked: true }, "Ссылка сброшена"))
      invites.reload();
  };
  const hint = status === "checking" ? "Проверяем…" : status === "free" ? `${n} — свободно` : undefined;
  const err = status === "taken" ? "Это имя уже занято" : status === "invalid" ? "Имя: 5–32 символа, латиница, цифры и _" : undefined;
  return /* @__PURE__ */ u(GPage, {
    title: T,
    onBack: nav.back,
    fab: { show: dirty && valid, icon: "check", label: "Сохранить", onClick: save, busy },
    children: [
      /* @__PURE__ */ u(Section, {
        title: T,
        role: "radiogroup",
        children: [
          /* @__PURE__ */ u(RadioRow, {
            checked: !pub,
            label: channel ? "Частный" : "Частная",
            subtitle: channel ? "Подписаться можно только по пригласительной ссылке." : "Вступить можно только по пригласительной ссылке.",
            onClick: () => setPub(false)
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u(RadioRow, {
            checked: pub,
            label: channel ? "Публичный" : "Публичная",
            subtitle: channel ? "Канал можно найти по имени, подписаться может любой." : "Группу можно найти по имени, вступить может любой.",
            onClick: () => setPub(true)
          }, undefined, false, undefined, this)
        ]
      }, undefined, true, undefined, this),
      pub ? /* @__PURE__ */ u(Section, {
        title: "Публичная ссылка",
        footer: "По этой ссылке группу найдут и смогут вступить. Имя — латиница, цифры и _, от 5 символов.",
        children: [
          /* @__PURE__ */ u(TextField, {
            label: channel ? "Имя канала" : "Имя группы",
            value: name,
            error: err,
            hint,
            class: status === "free" ? "app-tf-ok" : undefined,
            onInput: (v) => setName(v)
          }, undefined, false, undefined, this),
          n && !err ? /* @__PURE__ */ u("button", {
            type: "button",
            class: "app-uname-link",
            onClick: () => copyText(publicUrl(n)),
            children: [
              /* @__PURE__ */ u("span", {
                children: "Ссылка:"
              }, undefined, false, undefined, this),
              " ",
              /* @__PURE__ */ u("b", {
                children: publicUrl(n).replace(/^https?:\/\//, "")
              }, undefined, false, undefined, this)
            ]
          }, undefined, true, undefined, this) : null
        ]
      }, undefined, true, undefined, this) : /* @__PURE__ */ u(Section, {
        title: "Пригласительная ссылка",
        footer: "Любой, у кого есть ссылка, сможет вступить. Сбросьте её, если она попала не туда.",
        children: primary ? /* @__PURE__ */ u(S, {
          children: [
            /* @__PURE__ */ u(InfoRow, {
              icon: "link",
              title: inviteUrl(primary.link).replace(/^https?:\/\//, ""),
              subtitle: "Нажмите, чтобы скопировать",
              onClick: () => copyText(inviteUrl(primary.link))
            }, undefined, false, undefined, this),
            /* @__PURE__ */ u(InfoRow, {
              icon: "refresh",
              danger: true,
              title: "Сбросить ссылку",
              onClick: () => setAskRevoke(true)
            }, undefined, false, undefined, this)
          ]
        }, undefined, true, undefined, this) : /* @__PURE__ */ u("div", {
          class: "app-sm-loading",
          "aria-busy": "true"
        }, undefined, false, undefined, this)
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u(Section, {
        title: channel ? "Новые подписчики" : "Новые участники",
        footer: group.joinApproval ? "Вступающие по ссылке или имени сначала подают заявку — её одобряют администраторы." : channel ? "Подписавшиеся по ссылке попадают в канал сразу." : "Вступающие по ссылке попадают в группу сразу.",
        children: /* @__PURE__ */ u(InfoRow, {
          icon: "userCheck",
          title: channel ? "Одобрять новых подписчиков" : "Одобрять новых участников",
          trailing: /* @__PURE__ */ u(Switch, {
            id: "g-approval",
            label: "Одобрять новых",
            checked: group.joinApproval,
            onChange: () => void act("PUT", `/groups/${chatId}/settings`, { joinApproval: !group.joinApproval })
          }, undefined, false, undefined, this)
        }, undefined, false, undefined, this)
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u(Section, {
        title: "Копирование",
        role: "radiogroup",
        footer: channel ? group.protected ? "Подписчики не смогут пересылать посты и сохранять медиа." : "Подписчики могут пересылать посты канала." : group.protected ? "Участники не смогут пересылать сообщения из группы и сохранять медиа." : "Участники могут пересылать сообщения из группы.",
        children: [
          /* @__PURE__ */ u(RadioRow, {
            checked: !group.protected,
            label: "Разрешить копирование",
            onClick: () => group.protected && void act("PUT", `/groups/${chatId}/settings`, { protected: false })
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u(RadioRow, {
            checked: group.protected,
            label: "Запретить копирование",
            onClick: () => !group.protected && void act("PUT", `/groups/${chatId}/settings`, { protected: true })
          }, undefined, false, undefined, this)
        ]
      }, undefined, true, undefined, this),
      /* @__PURE__ */ u(ConfirmDialog, {
        open: askPrivate,
        danger: true,
        title: channel ? "Сделать канал частным?" : "Сделать группу частной?",
        text: `Имя @${was} освободится — его сможет занять кто угодно.`,
        confirm: "Сделать частной",
        onCancel: () => setAskPrivate(false),
        onConfirm: () => void save()
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u(ConfirmDialog, {
        open: askRevoke,
        danger: true,
        title: "Сбросить ссылку?",
        text: "Старая ссылка перестанет работать, появится новая.",
        confirm: "Сбросить",
        onCancel: () => setAskRevoke(false),
        onConfirm: () => void revoke()
      }, undefined, false, undefined, this)
    ]
  }, undefined, true, undefined, this);
}

// apps/web/src/ui/group/Permissions.tsx
function RightsList({ value, onChange, locked, disabled }) {
  const [open, setOpen] = d(false);
  const off = (k) => disabled || (locked ? !locked[k] : false);
  const n = mediaCount(value);
  const row = (k) => /* @__PURE__ */ u(CheckRow, {
    label: MEMBER_RIGHT_TEXT[k],
    checked: value[k],
    disabled: off(k),
    onChange: (on) => onChange(toggleRight(value, k, on))
  }, k, false, undefined, this);
  return /* @__PURE__ */ u(S, {
    children: [
      row("text"),
      /* @__PURE__ */ u("div", {
        class: "app-gm-media",
        children: [
          /* @__PURE__ */ u(CheckRow, {
            label: /* @__PURE__ */ u(S, {
              children: [
                "Медиа ",
                /* @__PURE__ */ u("span", {
                  class: "app-gm-count",
                  children: [
                    n,
                    "/",
                    MEDIA_RIGHTS.length
                  ]
                }, undefined, true, undefined, this)
              ]
            }, undefined, true, undefined, this),
            checked: n > 0,
            disabled: disabled || (locked ? MEDIA_RIGHTS.every((k) => !locked[k]) : false),
            onChange: (on) => onChange(toggleRight(value, "media", on))
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u("button", {
            type: "button",
            class: "app-gm-expand" + (open ? " is-open" : ""),
            "aria-expanded": open,
            "aria-label": "Показать виды медиа",
            onClick: () => setOpen(!open),
            children: /* @__PURE__ */ u(Icon, {
              name: "chevronDown",
              size: 20
            }, undefined, false, undefined, this)
          }, undefined, false, undefined, this)
        ]
      }, undefined, true, undefined, this),
      /* @__PURE__ */ u("div", {
        class: "app-gm-sub" + (open ? " is-open" : ""),
        inert: !open || undefined,
        children: /* @__PURE__ */ u("div", {
          children: MEDIA_RIGHTS.map(row)
        }, undefined, false, undefined, this)
      }, undefined, false, undefined, this),
      PLAIN_RIGHTS.map(row)
    ]
  }, undefined, true, undefined, this);
}
function extraBans(r, defaults) {
  const list = Object.keys(r).filter((k) => !r[k] && defaults[k]).map((k) => MEMBER_RIGHT_TEXT[k].toLowerCase());
  return list.length ? "Нельзя: " + list.join(", ") : "Без ограничений";
}
function Permissions({ nav }) {
  const { chatId } = nav;
  const { group, membersRev } = useGroup(chatId);
  const [draft, setDraft] = d(null);
  const [slow, setSlow] = d(null);
  const [busy, setBusy] = d(false);
  const restricted = useGroupData(`/groups/${chatId}/members?filter=restricted`, membersRev);
  const bans = useGroupData(`/groups/${chatId}/bans`, membersRev);
  if (!group)
    return /* @__PURE__ */ u(GPage, {
      title: "Разрешения",
      onBack: nav.back,
      children: /* @__PURE__ */ u(Loading, {}, undefined, false, undefined, this)
    }, undefined, false, undefined, this);
  const rights = draft ?? group.rights;
  const slowMode = slow ?? group.slowMode;
  const dirty = !sameRights(rights, group.rights) || slowMode !== group.slowMode;
  const save = async () => {
    setBusy(true);
    const ok = await act("PUT", `/groups/${chatId}/rights`, { rights, slowMode });
    setBusy(false);
    if (ok)
      nav.back();
  };
  const idx = Math.max(0, SLOW_MODES.indexOf(slowMode));
  return /* @__PURE__ */ u(GPage, {
    title: "Разрешения",
    onBack: nav.back,
    fab: { show: dirty, icon: "check", label: "Сохранить", onClick: save, busy },
    children: [
      /* @__PURE__ */ u(Section, {
        title: "Что могут участники",
        children: /* @__PURE__ */ u(RightsList, {
          value: rights,
          onChange: setDraft
        }, undefined, false, undefined, this)
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u(Section, {
        title: "Медленный режим",
        footer: slowMode ? `Участники смогут отправлять одно сообщение раз в ${SLOW_TEXT[slowMode]}.` : "Участники пишут без ограничений по частоте.",
        children: /* @__PURE__ */ u(RangeRow, {
          label: "Задержка",
          min: 0,
          max: SLOW_MODES.length - 1,
          step: 1,
          value: idx,
          format: (i) => SLOW_TEXT[SLOW_MODES[i]],
          marks: SLOW_MODES.map((s, i) => ({ value: i, label: SLOW_TEXT[s] })),
          onChange: (i) => setSlow(SLOW_MODES[i])
        }, undefined, false, undefined, this)
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u(Section, {
        children: /* @__PURE__ */ u(InfoRow, {
          tile: "red",
          icon: "userX",
          title: "Удалённые пользователи",
          subtitle: bans.data ? String(bans.data.banned.length) : "…",
          onClick: () => nav.go("gBanned")
        }, undefined, false, undefined, this)
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u(Section, {
        title: "Исключения",
        children: [
          /* @__PURE__ */ u(InfoRow, {
            icon: "userPlus",
            title: "Добавить исключение",
            onClick: () => nav.go("gExceptionPick")
          }, undefined, false, undefined, this),
          restricted.data ? restricted.data.members.map((m) => /* @__PURE__ */ u(PersonRow, {
            id: m.userId,
            name: m.name,
            photo: m.photo,
            subtitle: extraBans(m.restricted ?? group.rights, group.rights),
            onClick: () => nav.go("gException", { userId: m.userId })
          }, m.userId, false, undefined, this)) : /* @__PURE__ */ u(Loading, {}, undefined, false, undefined, this)
        ]
      }, undefined, true, undefined, this)
    ]
  }, undefined, true, undefined, this);
}
function Exception({ nav }) {
  const { chatId, params } = nav;
  const { group, membersRev } = useGroup(chatId);
  const all = useGroupData(`/groups/${chatId}/members`, membersRev);
  const member = all.data?.members.find((m) => m.userId === params.userId) ?? null;
  const [draft, setDraft] = d(null);
  const [busy, setBusy] = d(false);
  const [ask, setAsk] = d(false);
  if (!group || !member)
    return /* @__PURE__ */ u(GPage, {
      title: "Исключение",
      onBack: nav.back,
      children: /* @__PURE__ */ u(Loading, {}, undefined, false, undefined, this)
    }, undefined, false, undefined, this);
  const start = member.restricted ?? group.rights;
  const rights = draft ?? start;
  const dirty = !sameRights(rights, start);
  const save = async () => {
    setBusy(true);
    const ok = await act("PUT", `/groups/${chatId}/members/${member.userId}/restrict`, { rights });
    setBusy(false);
    if (ok)
      nav.back();
  };
  const remove = async () => {
    setAsk(false);
    if (await act("DELETE", `/groups/${chatId}/members/${member.userId}`))
      nav.back();
  };
  return /* @__PURE__ */ u(GPage, {
    title: "Исключение",
    onBack: nav.back,
    fab: { show: dirty, icon: "check", label: "Сохранить", onClick: save, busy },
    children: [
      /* @__PURE__ */ u(Section, {
        children: /* @__PURE__ */ u(PersonRow, {
          id: member.userId,
          name: member.name,
          photo: member.photo,
          subtitle: lastSeenText(!!member.online, member.lastSeen),
          online: !!member.online
        }, undefined, false, undefined, this)
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u(Section, {
        title: "Что может этот участник",
        footer: "Права, выключенные для всех участников, здесь не включить.",
        children: /* @__PURE__ */ u(RightsList, {
          value: rights,
          onChange: setDraft,
          locked: group.rights
        }, undefined, false, undefined, this)
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u(Section, {
        children: [
          member.restricted ? /* @__PURE__ */ u(InfoRow, {
            icon: "refresh",
            title: "Снять исключение",
            onClick: () => void act("PUT", `/groups/${chatId}/members/${member.userId}/restrict`, { rights: null }).then((ok) => ok && nav.back())
          }, undefined, false, undefined, this) : null,
          /* @__PURE__ */ u(InfoRow, {
            icon: "userX",
            danger: true,
            title: "Удалить из группы",
            onClick: () => setAsk(true)
          }, undefined, false, undefined, this)
        ]
      }, undefined, true, undefined, this),
      /* @__PURE__ */ u(ConfirmDialog, {
        open: ask,
        danger: true,
        title: "Удалить из группы?",
        text: `${member.name} попадёт в «Удалённые» и не сможет вернуться по ссылке.`,
        confirm: "Удалить",
        onCancel: () => setAsk(false),
        onConfirm: () => void remove()
      }, undefined, false, undefined, this)
    ]
  }, undefined, true, undefined, this);
}
function MemberPick({ nav, mode }) {
  const { chatId } = nav;
  const { membersRev } = useGroup(chatId);
  const me = useGlobal((s) => s.me.userId);
  const [q, setQ] = d("");
  const [ask, setAsk] = d(null);
  const all = useGroupData(`/groups/${chatId}/members`, membersRev);
  const title = mode === "admin" ? "Новый администратор" : mode === "ban" ? "Удалить участника" : "Добавить исключение";
  const needle = q.trim().toLowerCase();
  const list = (all.data?.members ?? []).filter((m) => m.userId !== me && m.role === "member" && (!needle || m.name.toLowerCase().includes(needle) || (m.username ?? "").toLowerCase().includes(needle)));
  const pick = (m) => {
    if (mode === "ban")
      setAsk(m);
    else if (mode === "admin")
      nav.go("gAdminRights", { userId: m.userId, fresh: true });
    else
      nav.go("gException", { userId: m.userId });
  };
  const ban = async () => {
    const m = ask;
    setAsk(null);
    if (await act("DELETE", `/groups/${chatId}/members/${m.userId}`, undefined, `${m.name} удалён(а) из группы`))
      nav.back();
  };
  return /* @__PURE__ */ u(GPage, {
    title,
    onBack: nav.back,
    children: [
      /* @__PURE__ */ u("div", {
        class: "app-gm-search",
        children: /* @__PURE__ */ u(SearchInput, {
          id: "gm-perm-search",
          label: "Поиск участников",
          value: q,
          placeholder: "Поиск участников",
          onInput: (e) => setQ(e.currentTarget.value)
        }, undefined, false, undefined, this)
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u("div", {
        class: "app-members",
        role: "list",
        children: all.data ? list.length ? list.map((m) => /* @__PURE__ */ u(PersonRow, {
          id: m.userId,
          name: m.name,
          photo: m.photo,
          online: !!m.online,
          subtitle: lastSeenText(!!m.online, m.lastSeen),
          onClick: () => pick(m)
        }, m.userId, false, undefined, this)) : /* @__PURE__ */ u("p", {
          class: "app-gm-empty",
          children: needle ? "Никого не нашлось" : "Здесь появятся участники группы"
        }, undefined, false, undefined, this) : /* @__PURE__ */ u(Loading, {}, undefined, false, undefined, this)
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u(ConfirmDialog, {
        open: !!ask,
        danger: true,
        title: "Удалить из группы?",
        text: ask ? `${ask.name} попадёт в «Удалённые» и не сможет вернуться по ссылке.` : "",
        confirm: "Удалить",
        onCancel: () => setAsk(null),
        onConfirm: () => void ban()
      }, undefined, false, undefined, this)
    ]
  }, undefined, true, undefined, this);
}
function Banned({ nav }) {
  const { chatId } = nav;
  const { membersRev } = useGroup(chatId);
  const bans = useGroupData(`/groups/${chatId}/bans`, membersRev);
  const [ask, setAsk] = d(null);
  const unban = async () => {
    const b = ask;
    setAsk(null);
    if (await act("DELETE", `/groups/${chatId}/bans/${b.userId}`, undefined, `${b.name} снова может вступить`))
      bans.reload();
  };
  const n = bans.data?.banned.length ?? 0;
  return /* @__PURE__ */ u(GPage, {
    title: "Удалённые пользователи",
    onBack: nav.back,
    fab: { show: true, icon: "userPlus", label: "Удалить участника", onClick: () => nav.go("gBanPick") },
    children: [
      /* @__PURE__ */ u(Section, {
        footer: "Удалённые не могут вернуться в группу по ссылке или имени. Добавить их снова может администратор с правом блокировки.",
        children: bans.data ? n ? bans.data.banned.map((b) => /* @__PURE__ */ u(PersonRow, {
          id: b.userId,
          name: b.name,
          photo: b.photo,
          subtitle: b.bannedByName ? `Удалил(а) ${b.bannedByName}` : "Удалён(а)",
          onClick: () => setAsk(b)
        }, b.userId, false, undefined, this)) : /* @__PURE__ */ u("p", {
          class: "app-gm-empty",
          children: "Никто не удалён"
        }, undefined, false, undefined, this) : /* @__PURE__ */ u(Loading, {}, undefined, false, undefined, this)
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u("p", {
        class: "app-gm-note",
        children: n ? `${n} ${plural3(n, "пользователь", "пользователя", "пользователей")}` : ""
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u(ConfirmDialog, {
        open: !!ask,
        title: "Разблокировать?",
        text: ask ? `${ask.name} сможет снова вступить в группу по ссылке.` : "",
        confirm: "Разблокировать",
        onCancel: () => setAsk(null),
        onConfirm: () => void unban()
      }, undefined, false, undefined, this)
    ]
  }, undefined, true, undefined, this);
}

// apps/web/src/ui/group/Admins.tsx
function Admins({ nav }) {
  const { chatId } = nav;
  const { me, membersRev, kind } = useGroup(chatId);
  const all = useGroupData(`/groups/${chatId}/members`, membersRev);
  const names = new Map((all.data?.members ?? []).map((m) => [m.userId, m.name]));
  const admins = (all.data?.members ?? []).filter((m) => m.role !== "member");
  return /* @__PURE__ */ u(GPage, {
    title: "Администраторы",
    onBack: nav.back,
    fab: adminCan(me, "addAdmins") ? { show: true, icon: "userPlus", label: "Назначить администратора", onClick: () => nav.go("gAdminPick") } : undefined,
    children: /* @__PURE__ */ u(Section, {
      footer: kind === "channel" ? "Администраторы помогают вести канал. Права каждого настраиваются отдельно." : "Администраторы помогают управлять группой. Права каждого настраиваются отдельно.",
      children: all.data ? admins.map((m) => /* @__PURE__ */ u(PersonRow, {
        id: m.userId,
        name: m.name,
        photo: m.photo,
        trailing: m.rank ?? undefined,
        subtitle: m.role === "owner" ? "Владелец" : m.promotedBy && names.has(m.promotedBy) ? `Назначил(а) ${names.get(m.promotedBy)}` : "Администратор",
        onClick: () => nav.go("gAdminRights", { userId: m.userId })
      }, m.userId, false, undefined, this)) : /* @__PURE__ */ u(Loading, {}, undefined, false, undefined, this)
    }, undefined, false, undefined, this)
  }, undefined, false, undefined, this);
}
function AdminRightsPage({ nav }) {
  const { chatId, params } = nav;
  const { me, membersRev, group, kind } = useGroup(chatId);
  const myId = useGlobal((s) => s.me.userId);
  const all = useGroupData(`/groups/${chatId}/members`, membersRev);
  const target = all.data?.members.find((m) => m.userId === params.userId) ?? null;
  const [draft, setDraft] = d(null);
  const [rank, setRank] = d(null);
  const [busy, setBusy] = d(false);
  const [ask, setAsk] = d(null);
  const [password, setPassword] = d(null);
  const [pwErr, setPwErr] = d();
  if (!target || !me || !group)
    return /* @__PURE__ */ u(GPage, {
      title: "Права администратора",
      onBack: nav.back,
      children: /* @__PURE__ */ u(Loading, {}, undefined, false, undefined, this)
    }, undefined, false, undefined, this);
  const isOwner = target.role === "owner";
  const self = target.userId === myId;
  const fresh = !!params.fresh && target.role === "member";
  const editable = !isOwner && (me.role === "owner" || adminCan(me, "addAdmins") && (fresh || target.promotedBy === myId));
  const rankEditable = editable || self;
  const mine = me.admin ?? noAdminRights();
  const start = isOwner ? allAdminRights(kind) : target.admin ?? (fresh ? { ...mine, addAdmins: false } : noAdminRights());
  const rights = draft ?? start;
  const r0 = target.rank ?? "";
  const r1 = rank ?? r0;
  const dirty = fresh || editable && !sameAdmin(rights, start) || r1.trim() !== r0;
  const save = async () => {
    setBusy(true);
    const ok = editable ? await act("PUT", `/groups/${chatId}/admins/${target.userId}`, { rights, rank: r1.trim() || null }) : await act("PUT", `/groups/${chatId}/members/${target.userId}/rank`, { rank: r1.trim() || null });
    setBusy(false);
    if (ok)
      nav.back();
  };
  const dismiss = async () => {
    setAsk(null);
    if (await act("PUT", `/groups/${chatId}/admins/${target.userId}`, { rights: null }, `${target.name} больше не администратор`))
      nav.back();
  };
  const transfer = async () => {
    if (!password)
      return;
    setBusy(true);
    const p = await proofOf(password);
    const r = p.ok ? await act("POST", `/groups/${chatId}/owner`, { userId: target.userId, proof: p.data }) : null;
    setBusy(false);
    if (!p.ok) {
      setPwErr(errorText(p.code));
      return;
    }
    if (r) {
      setPassword(null);
      showToast2(`${target.name} теперь владелец группы`);
      nav.back();
    }
  };
  return /* @__PURE__ */ u(GPage, {
    title: fresh ? "Новый администратор" : "Права администратора",
    onBack: nav.back,
    fab: rankEditable ? { show: dirty, icon: "check", label: "Сохранить", onClick: save, busy } : undefined,
    children: [
      /* @__PURE__ */ u(Section, {
        children: /* @__PURE__ */ u(PersonRow, {
          id: target.userId,
          name: target.name,
          photo: target.photo,
          online: !!target.online,
          subtitle: self ? "это вы" : lastSeenText(!!target.online, target.lastSeen)
        }, undefined, false, undefined, this)
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u(Section, {
        title: "Что может этот администратор",
        footer: !editable && !isOwner ? "Менять права может владелец или тот, кто назначил этого администратора." : isOwner ? "У владельца все права." : undefined,
        children: ADMIN_RIGHTS_BY_KIND[kind].map((k) => /* @__PURE__ */ u(CheckRow, {
          label: adminRightText(k, kind),
          checked: rights[k],
          disabled: !editable || !mine[k],
          onChange: (on) => setDraft({ ...rights, [k]: on })
        }, k, false, undefined, this))
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u(Section, {
        title: "Звание",
        footer: "Звание видно в списке участников и рядом с именем в сообщениях.",
        children: /* @__PURE__ */ u(TextField, {
          label: isOwner ? "Владелец" : "Администратор",
          value: r1,
          disabled: !rankEditable,
          maxLength: RANK_MAX,
          onInput: (v) => setRank(v)
        }, undefined, false, undefined, this)
      }, undefined, false, undefined, this),
      !fresh && !isOwner && editable && !self ? /* @__PURE__ */ u(Section, {
        children: /* @__PURE__ */ u(InfoRow, {
          icon: "userMinus",
          danger: true,
          title: "Снять с должности",
          onClick: () => setAsk("dismiss")
        }, undefined, false, undefined, this)
      }, undefined, false, undefined, this) : null,
      me.role === "owner" && !self && !isOwner ? /* @__PURE__ */ u(Section, {
        footer: "Новый владелец получит все права, а вы останетесь администратором.",
        children: /* @__PURE__ */ u(InfoRow, {
          icon: "crown",
          title: kind === "channel" ? "Передать права на канал" : "Передать права на группу",
          onClick: () => setAsk("transfer")
        }, undefined, false, undefined, this)
      }, undefined, false, undefined, this) : null,
      /* @__PURE__ */ u(ConfirmDialog, {
        open: ask === "dismiss",
        danger: true,
        title: "Снять с должности?",
        text: `${target.name} станет обычным участником.`,
        confirm: "Снять",
        onCancel: () => setAsk(null),
        onConfirm: () => void dismiss()
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u(ConfirmDialog, {
        open: ask === "transfer",
        danger: true,
        title: "Передать права на группу?",
        text: `${target.name} станет владельцем «${group.title}». Отменить это может только новый владелец.`,
        confirm: "Продолжить",
        onCancel: () => setAsk(null),
        onConfirm: () => {
          setAsk(null);
          setPwErr(undefined);
          setPassword("");
        }
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u(Modal, {
        open: password !== null,
        onClose: () => setPassword(null),
        title: "Облачный пароль",
        size: "confirm",
        actions: [
          /* @__PURE__ */ u("button", {
            type: "button",
            class: "rl-mdl-btn",
            onClick: () => setPassword(null),
            children: "Отмена"
          }, "no", false, undefined, this),
          /* @__PURE__ */ u("button", {
            type: "button",
            class: "rl-mdl-btn rl-mdl-btn-danger",
            disabled: busy || !password,
            onClick: () => void transfer(),
            children: "Передать"
          }, "ok", false, undefined, this)
        ],
        children: [
          /* @__PURE__ */ u("p", {
            class: "rl-mdl-text",
            children: "Чтобы передать права на группу, введите облачный пароль."
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u(TextField, {
            label: "Пароль",
            type: "password",
            value: password ?? "",
            error: pwErr,
            autoFocus: true,
            onInput: (v) => {
              setPassword(v);
              setPwErr(undefined);
            },
            onKeyDown: (e) => {
              if (e.key === "Enter")
                transfer();
            }
          }, undefined, false, undefined, this)
        ]
      }, undefined, true, undefined, this)
    ]
  }, undefined, true, undefined, this);
}

// apps/web/src/ui/group/Members.tsx
function ManageMembers({ nav }) {
  const { chatId } = nav;
  const { me, membersRev, kind } = useGroup(chatId);
  const channel = kind === "channel";
  const myId = useGlobal((s) => s.me.userId);
  const all = useGroupData(`/groups/${chatId}/members`, membersRev);
  const [q, setQ] = d("");
  const [menu, setMenu] = d(null);
  const needle = q.trim().toLowerCase();
  const list = (all.data?.members ?? []).filter((m) => !needle || m.name.toLowerCase().includes(needle) || (m.username ?? "").toLowerCase().includes(needle));
  const n = all.data?.members.length ?? 0;
  const badge = (m) => m.rank ?? (m.role === "owner" ? "владелец" : m.role === "admin" ? "админ" : undefined);
  const canBan = adminCan(me, "ban"), canPromote = adminCan(me, "addAdmins");
  const open = (m) => {
    if (m.userId === myId)
      return;
    if (m.role === "member" && (canBan || canPromote))
      setMenu(m);
    else {
      nav.close();
      openUserChat2(m.userId);
    }
  };
  const remove = async (m) => {
    setMenu(null);
    await act("DELETE", `/groups/${chatId}/members/${m.userId}`, undefined, `${m.name} удалён(а) из ${channel ? "канала" : "группы"}`);
  };
  const who = channel ? "подписчиков" : "участников";
  return /* @__PURE__ */ u(GPage, {
    title: channel ? "Подписчики" : "Участники",
    onBack: nav.back,
    fab: canInvite(me) ? { show: true, icon: "userPlus", label: "Добавить " + who, onClick: () => nav.go("gAddMembers") } : undefined,
    children: [
      /* @__PURE__ */ u("div", {
        class: "app-gm-search",
        children: /* @__PURE__ */ u(SearchInput, {
          id: "gm-members-search",
          label: "Поиск " + who,
          value: q,
          placeholder: "Поиск " + who,
          onInput: (e) => setQ(e.currentTarget.value)
        }, undefined, false, undefined, this)
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u("p", {
        class: "app-gm-note",
        children: n ? `${n} ${channel ? plural3(n, "подписчик", "подписчика", "подписчиков") : plural3(n, "участник", "участника", "участников")}` : ""
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u("div", {
        class: "app-members",
        role: "list",
        children: all.data ? list.length ? list.map((m) => /* @__PURE__ */ u(PersonRow, {
          id: m.userId,
          name: m.name,
          label: m.userId === myId ? m.name + " (вы)" : m.name,
          photo: m.photo,
          online: !!m.online || m.userId === myId,
          subtitle: m.userId === myId ? "в сети" : lastSeenText(!!m.online, m.lastSeen),
          trailing: badge(m),
          onClick: () => open(m)
        }, m.userId, false, undefined, this)) : /* @__PURE__ */ u("p", {
          class: "app-gm-empty",
          children: "Никого не нашлось"
        }, undefined, false, undefined, this) : /* @__PURE__ */ u(Loading, {}, undefined, false, undefined, this)
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u(Modal, {
        open: !!menu,
        onClose: () => setMenu(null),
        title: menu?.name ?? "",
        size: "confirm",
        closeButton: false,
        actions: [/* @__PURE__ */ u("button", {
          type: "button",
          class: "rl-mdl-btn",
          onClick: () => setMenu(null),
          children: "Закрыть"
        }, "x", false, undefined, this)],
        children: menu ? /* @__PURE__ */ u("div", {
          class: "app-gm-actions",
          children: [
            /* @__PURE__ */ u("button", {
              type: "button",
              class: "rl-optrow",
              onClick: () => {
                const id = menu.userId;
                setMenu(null);
                nav.close();
                openUserChat2(id);
              },
              children: "Написать сообщение"
            }, undefined, false, undefined, this),
            canPromote ? /* @__PURE__ */ u("button", {
              type: "button",
              class: "rl-optrow",
              onClick: () => {
                const id = menu.userId;
                setMenu(null);
                nav.go("gAdminRights", { userId: id, fresh: true });
              },
              children: "Назначить администратором"
            }, undefined, false, undefined, this) : null,
            canBan && !channel ? /* @__PURE__ */ u("button", {
              type: "button",
              class: "rl-optrow",
              onClick: () => {
                const id = menu.userId;
                setMenu(null);
                nav.go("gException", { userId: id });
              },
              children: "Ограничить права"
            }, undefined, false, undefined, this) : null,
            canBan ? /* @__PURE__ */ u("button", {
              type: "button",
              class: "rl-optrow app-gm-danger",
              onClick: () => void remove(menu),
              children: channel ? "Удалить из канала" : "Удалить из группы"
            }, undefined, false, undefined, this) : null
          ]
        }, undefined, true, undefined, this) : null
      }, undefined, false, undefined, this)
    ]
  }, undefined, true, undefined, this);
}
function AddMembers({ nav }) {
  const { chatId } = nav;
  const { me: my, membersRev, kind } = useGroup(chatId);
  const me = useGlobal((s) => s.me.userId);
  const contacts = useGlobal((s) => s.contacts);
  const chats = useGlobal((s) => s.chats);
  const all = useGroupData(`/groups/${chatId}/members`, membersRev);
  const [picked, setPicked] = d([]);
  const [busy, setBusy] = d(false);
  const [failed, setFailed] = d([]);
  const inside = new Set((all.data?.members ?? []).map((m) => m.userId));
  const people = candidates(contacts, chats.filter((c) => !isSystemChat(c)), me).filter((p) => !inside.has(p.id));
  const nameOf = (id) => people.find((p) => p.id === id)?.name ?? "";
  const add = async () => {
    if (!picked.length)
      return;
    setBusy(true);
    const { refs, missing } = await peerRefs2(picked);
    const r = refs.length ? await act("POST", `/groups/${chatId}/members`, { users: refs }) : { added: [], failed: [] };
    setBusy(false);
    if (!r)
      return;
    r.failed = [...r.failed, ...missing];
    if (r.added.length && kind === "channel")
      refreshChats2();
    if (r.added.length)
      showToast2(r.added.length === 1 ? `${nameOf(r.added[0])} в группе` : `Добавлено: ${r.added.length}`);
    if (r.failed.length)
      setFailed(r.failed);
    else
      nav.back();
  };
  const sendLinks = async () => {
    const ids = failed;
    setFailed([]);
    const inv = adminCan(my, "invite") ? await act("GET", `/groups/${chatId}/invites`) : null;
    const primary = inv?.invites.find((i) => i.primary && !i.revoked);
    if (!primary) {
      showToast2("Нет ссылки-приглашения");
      nav.back();
      return;
    }
    for (const id of ids) {
      try {
        await engineSend2(await createDirectChat2(id), inviteUrl(primary.link));
      } catch {}
    }
    showToast2("Приглашения отправлены");
    nav.back();
  };
  return /* @__PURE__ */ u(GPage, {
    title: kind === "channel" ? "Добавить подписчиков" : "Добавить участников",
    onBack: nav.back,
    fab: { show: picked.length > 0, icon: "check", label: "Добавить", onClick: add, busy },
    children: [
      /* @__PURE__ */ u("div", {
        class: "rl-page-scroll app-newgroup",
        children: all.data ? /* @__PURE__ */ u(ContactPicker, {
          multi: true,
          selected: picked,
          contacts: people.map((p) => ({ ...p, tone: peerTone(p.id), avatar: senderAvatar(p.id) })),
          searchLabel: "Поиск людей",
          placeholder: "Кого добавить?",
          onChange: (ids) => setPicked(ids),
          empty: "Здесь появятся ваши контакты и собеседники, которых ещё нет в группе."
        }, undefined, false, undefined, this) : /* @__PURE__ */ u(Loading, {}, undefined, false, undefined, this)
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u(Modal, {
        open: failed.length > 0,
        onClose: () => {
          setFailed([]);
          nav.back();
        },
        title: "Не удалось добавить",
        size: "confirm",
        closeButton: false,
        actions: [
          /* @__PURE__ */ u("button", {
            type: "button",
            class: "rl-mdl-btn",
            onClick: () => {
              setFailed([]);
              nav.back();
            },
            children: "Не нужно"
          }, "no", false, undefined, this),
          adminCan(my, "invite") ? /* @__PURE__ */ u("button", {
            type: "button",
            class: "rl-mdl-btn",
            onClick: () => void sendLinks(),
            children: "Отправить ссылку"
          }, "ok", false, undefined, this) : null
        ],
        children: /* @__PURE__ */ u("p", {
          class: "rl-mdl-text",
          children: [
            failed.map(nameOf).filter(Boolean).join(", ") || "Эти люди",
            " — нельзя добавить в группу напрямую. ",
            adminCan(my, "invite") ? "Можно отправить им пригласительную ссылку." : ""
          ]
        }, undefined, true, undefined, this)
      }, undefined, false, undefined, this)
    ]
  }, undefined, true, undefined, this);
}

// apps/web/src/ui/group/Invites.tsx
var short = (url) => url.replace(/^https?:\/\//, "");
var expired = (i) => !!i.expiresAt && Date.parse(i.expiresAt) <= Date.now();
var full = (i) => i.usageLimit != null && i.usage >= i.usageLimit;
function inviteSubtitle(i) {
  const parts = [];
  if (i.usageLimit != null && !full(i))
    parts.push(`можно вступить: ${i.usageLimit - i.usage}`);
  else
    parts.push(i.usage ? `${i.usage} ${plural3(i.usage, "вступил", "вступили", "вступили")}` : "никто не вступил");
  if (i.requests)
    parts.push(`${i.requests} ${plural3(i.requests, "заявка", "заявки", "заявок")}`);
  if (i.revoked)
    parts.push("отозвана");
  else if (full(i))
    parts.push("лимит исчерпан");
  else if (expired(i))
    parts.push("истекла");
  else if (i.expiresAt)
    parts.push("до " + dayLabel(i.expiresAt) + " " + clock(i.expiresAt));
  if (i.approval)
    parts.push("с одобрением");
  return parts.join(" · ");
}
var tone = (i) => i.revoked ? "gray" : expired(i) || full(i) ? "red" : "blue";
function Invites({ nav }) {
  const { chatId } = nav;
  const { group } = useGroup(chatId);
  const inv = useGroupData(`/groups/${chatId}/invites`, group);
  const [ask, setAsk] = d(null);
  const list = inv.data?.invites ?? [];
  const primary = list.find((i) => i.primary && !i.revoked);
  const extra = list.filter((i) => !i.primary && !i.revoked).sort((a, b) => b.usage - a.usage || b.id - a.id);
  const revoked = list.filter((i) => i.revoked);
  const run = async () => {
    const a = ask;
    setAsk(null);
    const ok = a.kind === "revoke" ? await act("PATCH", `/groups/${chatId}/invites/${a.invite.id}`, { revoked: true }, "Ссылка отозвана") : a.kind === "delete" ? await act("DELETE", `/groups/${chatId}/invites/${a.invite.id}`) : await act("DELETE", `/groups/${chatId}/invites`);
    if (ok)
      inv.reload();
  };
  return /* @__PURE__ */ u(GPage, {
    title: "Пригласительные ссылки",
    onBack: nav.back,
    children: [
      /* @__PURE__ */ u(Section, {
        footer: "По ссылке в группу можно вступить, даже если вы не в контактах. Сбросьте ссылку, если она попала не туда.",
        children: group?.username ? /* @__PURE__ */ u(InfoRow, {
          tile: "blue",
          icon: "link",
          title: short(publicUrl(group.username)),
          subtitle: "Публичная ссылка · нажмите, чтобы скопировать",
          onClick: () => copyText(publicUrl(group.username))
        }, undefined, false, undefined, this) : primary ? /* @__PURE__ */ u(S, {
          children: [
            /* @__PURE__ */ u(InfoRow, {
              tile: "blue",
              icon: "link",
              title: short(inviteUrl(primary.link)),
              subtitle: "Основная ссылка · " + inviteSubtitle(primary),
              onClick: () => copyText(inviteUrl(primary.link))
            }, undefined, false, undefined, this),
            /* @__PURE__ */ u("div", {
              class: "app-gm-linkbtns",
              children: [
                /* @__PURE__ */ u(Button, {
                  variant: "primary",
                  onClick: () => copyText(inviteUrl(primary.link)),
                  children: "Скопировать"
                }, undefined, false, undefined, this),
                /* @__PURE__ */ u(Button, {
                  onClick: () => setAsk({ kind: "revoke", invite: primary }),
                  children: "Сбросить"
                }, undefined, false, undefined, this)
              ]
            }, undefined, true, undefined, this)
          ]
        }, undefined, true, undefined, this) : /* @__PURE__ */ u(Loading, {}, undefined, false, undefined, this)
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u(Section, {
        title: "Дополнительные ссылки",
        footer: "Можно ограничить срок, число вступлений или включить одобрение заявок.",
        children: [
          /* @__PURE__ */ u(InfoRow, {
            icon: "plus",
            title: "Создать ссылку",
            onClick: () => nav.go("gInvite")
          }, undefined, false, undefined, this),
          extra.map((i) => /* @__PURE__ */ u(InfoRow, {
            tile: tone(i),
            icon: "link",
            title: i.title || short(inviteUrl(i.link)),
            subtitle: inviteSubtitle(i),
            onClick: () => nav.go("gInviteInfo", { inviteId: i.id })
          }, i.id, false, undefined, this))
        ]
      }, undefined, true, undefined, this),
      revoked.length ? /* @__PURE__ */ u(Section, {
        title: "Отозванные ссылки",
        children: [
          /* @__PURE__ */ u(InfoRow, {
            icon: "trash",
            danger: true,
            title: "Удалить все отозванные",
            onClick: () => setAsk({ kind: "deleteAll" })
          }, undefined, false, undefined, this),
          revoked.map((i) => /* @__PURE__ */ u(InfoRow, {
            tile: "gray",
            icon: "link",
            title: i.title || short(inviteUrl(i.link)),
            subtitle: inviteSubtitle(i),
            onClick: () => setAsk({ kind: "delete", invite: i })
          }, i.id, false, undefined, this))
        ]
      }, undefined, true, undefined, this) : null,
      /* @__PURE__ */ u(ConfirmDialog, {
        open: !!ask,
        danger: true,
        title: ask?.kind === "revoke" ? "Отозвать ссылку?" : ask?.kind === "delete" ? "Удалить ссылку?" : "Удалить все отозванные?",
        text: ask?.kind === "revoke" ? ask.invite?.primary ? "Старая ссылка перестанет работать, появится новая." : "По ссылке больше нельзя будет вступить." : "Ссылки исчезнут из списка насовсем.",
        confirm: ask?.kind === "revoke" ? "Отозвать" : "Удалить",
        onCancel: () => setAsk(null),
        onConfirm: () => void run()
      }, undefined, false, undefined, this)
    ]
  }, undefined, true, undefined, this);
}
var PERIODS = [
  { label: "1 час", ms: 3600000 },
  { label: "1 день", ms: 86400000 },
  { label: "1 неделя", ms: 7 * 86400000 },
  { label: "Без ограничения", ms: null }
];
var LIMITS = [1, 10, 100, null];
var localInput = (iso) => {
  const d = new Date(iso);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};
function InviteEdit({ nav }) {
  const { chatId, params } = nav;
  const { group } = useGroup(chatId);
  const inv = useGroupData(params.inviteId ? `/groups/${chatId}/invites` : null, group);
  const editing = params.inviteId ? inv.data?.invites.find((i) => i.id === params.inviteId) ?? null : null;
  const [approval, setApproval] = d(false);
  const [title, setTitle] = d("");
  const [period, setPeriod] = d(null);
  const [until, setUntil] = d(localInput(new Date(Date.now() + 3600000).toISOString()));
  const [limit, setLimit] = d(null);
  const [custom, setCustom] = d("10");
  const [busy, setBusy] = d(false);
  h(() => {
    if (!editing)
      return;
    setApproval(editing.approval);
    setTitle(editing.title ?? "");
    if (editing.expiresAt) {
      setPeriod("custom");
      setUntil(localInput(new Date(Math.max(Date.parse(editing.expiresAt), Date.now() + 3600000)).toISOString()));
    }
    if (editing.usageLimit != null) {
      if (LIMITS.includes(editing.usageLimit))
        setLimit(editing.usageLimit);
      else {
        setLimit("custom");
        setCustom(String(editing.usageLimit));
      }
    }
  }, [editing?.id]);
  if (params.inviteId && !editing)
    return /* @__PURE__ */ u(GPage, {
      title: "Изменить ссылку",
      onBack: nav.back,
      children: /* @__PURE__ */ u(Loading, {}, undefined, false, undefined, this)
    }, undefined, false, undefined, this);
  const usage = limit === "custom" ? Number(custom) : limit;
  const badLimit = limit === "custom" && !(Number.isInteger(usage) && usage >= 1 && usage <= INVITE_USAGE_MAX);
  const save = async () => {
    if (badLimit)
      return;
    const expiresAt = period === "custom" ? new Date(until).toISOString() : period ? new Date(Date.now() + period).toISOString() : null;
    const body = { title: title.trim() || null, approval, expiresAt, usageLimit: approval ? null : usage };
    setBusy(true);
    const ok = editing ? await act("PATCH", `/groups/${chatId}/invites/${editing.id}`, body) : await act("POST", `/groups/${chatId}/invites`, body, "Ссылка создана");
    setBusy(false);
    if (ok)
      nav.back();
  };
  return /* @__PURE__ */ u(GPage, {
    title: editing ? "Изменить ссылку" : "Новая ссылка",
    onBack: nav.back,
    fab: { show: true, icon: "check", label: "Сохранить", onClick: save, busy },
    children: [
      /* @__PURE__ */ u(Section, {
        footer: approval ? "Вступающие по ссылке будут подавать заявку — её одобрят администраторы." : "Вступить по ссылке можно сразу.",
        children: /* @__PURE__ */ u(InfoRow, {
          icon: "userCheck",
          title: "Одобрять новых участников",
          trailing: /* @__PURE__ */ u(Switch, {
            id: "inv-approval",
            label: "Одобрять новых участников",
            checked: approval,
            onChange: () => setApproval(!approval)
          }, undefined, false, undefined, this)
        }, undefined, false, undefined, this)
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u(Section, {
        footer: "Название видно только администраторам.",
        children: /* @__PURE__ */ u(TextField, {
          label: "Название ссылки (необязательно)",
          value: title,
          maxLength: 32,
          onInput: (v) => setTitle(v)
        }, undefined, false, undefined, this)
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u(Section, {
        title: "Срок действия",
        role: "radiogroup",
        children: [
          PERIODS.map((p) => /* @__PURE__ */ u(RadioRow, {
            checked: period === p.ms,
            label: p.label,
            onClick: () => setPeriod(p.ms)
          }, p.label, false, undefined, this)),
          /* @__PURE__ */ u(RadioRow, {
            checked: period === "custom",
            label: "Свой срок",
            onClick: () => setPeriod("custom")
          }, undefined, false, undefined, this),
          period === "custom" ? /* @__PURE__ */ u("div", {
            class: "app-gm-pad",
            children: /* @__PURE__ */ u("input", {
              type: "datetime-local",
              class: "app-gm-date",
              value: until,
              min: localInput(new Date().toISOString()),
              onInput: (e) => setUntil(e.currentTarget.value)
            }, undefined, false, undefined, this)
          }, undefined, false, undefined, this) : null
        ]
      }, undefined, true, undefined, this),
      !approval ? /* @__PURE__ */ u(Section, {
        title: "Сколько человек может вступить",
        role: "radiogroup",
        children: [
          LIMITS.map((l) => /* @__PURE__ */ u(RadioRow, {
            checked: limit === l,
            label: l == null ? "Без ограничения" : String(l),
            onClick: () => setLimit(l)
          }, String(l), false, undefined, this)),
          /* @__PURE__ */ u(RadioRow, {
            checked: limit === "custom",
            label: "Своё число",
            onClick: () => setLimit("custom")
          }, undefined, false, undefined, this),
          limit === "custom" ? /* @__PURE__ */ u(TextField, {
            label: "Число вступлений",
            value: custom,
            inputMode: "numeric",
            error: badLimit ? `От 1 до ${INVITE_USAGE_MAX}` : undefined,
            onInput: (v) => setCustom(v.replace(/\D/g, ""))
          }, undefined, false, undefined, this) : null
        ]
      }, undefined, true, undefined, this) : null
    ]
  }, undefined, true, undefined, this);
}
function InviteInfo({ nav }) {
  const { chatId, params } = nav;
  const { group } = useGroup(chatId);
  const inv = useGroupData(`/groups/${chatId}/invites`, group);
  const i = inv.data?.invites.find((x) => x.id === params.inviteId) ?? null;
  const joined = useGroupData(i ? `/groups/${chatId}/invites/${i.id}/joined` : null, group);
  const [ask, setAsk] = d(false);
  if (!i)
    return /* @__PURE__ */ u(GPage, {
      title: "Ссылка",
      onBack: nav.back,
      children: /* @__PURE__ */ u(Loading, {}, undefined, false, undefined, this)
    }, undefined, false, undefined, this);
  const revoke = async () => {
    setAsk(false);
    if (await act("PATCH", `/groups/${chatId}/invites/${i.id}`, { revoked: true }, "Ссылка отозвана"))
      nav.back();
  };
  return /* @__PURE__ */ u(GPage, {
    title: i.title || "Ссылка",
    onBack: nav.back,
    action: !i.revoked && !i.primary ? { icon: "write", label: "Изменить", onClick: () => nav.go("gInvite", { inviteId: i.id }) } : undefined,
    children: [
      /* @__PURE__ */ u(Section, {
        footer: inviteSubtitle(i),
        children: [
          /* @__PURE__ */ u(InfoRow, {
            tile: tone(i),
            icon: "link",
            title: short(inviteUrl(i.link)),
            subtitle: "Нажмите, чтобы скопировать",
            onClick: () => copyText(inviteUrl(i.link))
          }, undefined, false, undefined, this),
          !i.revoked ? /* @__PURE__ */ u(InfoRow, {
            icon: "close",
            danger: true,
            title: "Отозвать ссылку",
            onClick: () => setAsk(true)
          }, undefined, false, undefined, this) : null
        ]
      }, undefined, true, undefined, this),
      /* @__PURE__ */ u(Section, {
        title: "Создал(а)",
        children: i.creatorId ? /* @__PURE__ */ u(PersonRow, {
          id: i.creatorId,
          name: i.creatorName ?? "",
          subtitle: dayLabel(i.createdAt) + " " + clock(i.createdAt)
        }, undefined, false, undefined, this) : null
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u(Section, {
        title: joined.data?.joined.length ? `${joined.data.joined.length} ${plural3(joined.data.joined.length, "вступил", "вступили", "вступили")}` : "Вступившие",
        children: joined.data ? joined.data.joined.length ? joined.data.joined.map((j) => /* @__PURE__ */ u(PersonRow, {
          id: j.userId,
          name: j.name,
          subtitle: dayLabel(j.at) + " " + clock(j.at),
          onClick: () => {
            nav.close();
            openUserChat2(j.userId);
          }
        }, j.userId, false, undefined, this)) : /* @__PURE__ */ u("p", {
          class: "app-gm-empty",
          children: i.usageLimit != null ? `Вступить могут ещё ${i.usageLimit - i.usage}` : "Пока никто не вступил"
        }, undefined, false, undefined, this) : /* @__PURE__ */ u(Loading, {}, undefined, false, undefined, this)
      }, undefined, false, undefined, this),
      joined.data?.requests.length && !i.revoked ? /* @__PURE__ */ u(Section, {
        title: "Ждут одобрения",
        children: joined.data.requests.map((r) => /* @__PURE__ */ u(RequestRow, {
          chatId,
          r,
          onDone: joined.reload
        }, r.userId, false, undefined, this))
      }, undefined, false, undefined, this) : null,
      /* @__PURE__ */ u(ConfirmDialog, {
        open: ask,
        danger: true,
        title: "Отозвать ссылку?",
        text: "По ссылке больше нельзя будет вступить.",
        confirm: "Отозвать",
        onCancel: () => setAsk(false),
        onConfirm: () => void revoke()
      }, undefined, false, undefined, this)
    ]
  }, undefined, true, undefined, this);
}
function RequestRow({ chatId, r, onDone }) {
  const decide = async (approve) => {
    if (await act("POST", `/groups/${chatId}/requests/${r.userId}`, { approve }, approve ? `${r.name} в группе` : undefined))
      onDone();
  };
  return /* @__PURE__ */ u("div", {
    class: "app-gm-request",
    children: [
      /* @__PURE__ */ u(PersonRow, {
        id: r.userId,
        name: r.name,
        photo: r.photo,
        subtitle: r.about || dayLabel(r.at) + " " + clock(r.at)
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u("div", {
        class: "app-gm-request-btns",
        children: [
          /* @__PURE__ */ u(Button, {
            variant: "primary",
            onClick: () => void decide(true),
            children: [
              /* @__PURE__ */ u(Icon, {
                name: "check",
                size: 18
              }, undefined, false, undefined, this),
              " Принять"
            ]
          }, undefined, true, undefined, this),
          /* @__PURE__ */ u(Button, {
            onClick: () => void decide(false),
            children: "Отклонить"
          }, undefined, false, undefined, this)
        ]
      }, undefined, true, undefined, this)
    ]
  }, undefined, true, undefined, this);
}
function Requests({ nav }) {
  const { chatId } = nav;
  const { group } = useGroup(chatId);
  const reqs = useGroupData(`/groups/${chatId}/requests`, group?.requests);
  const [ask, setAsk] = d(null);
  const list = reqs.data?.requests ?? [];
  const all = async () => {
    const approve = ask;
    setAsk(null);
    if (await act("POST", `/groups/${chatId}/requests`, { approve }))
      reqs.reload();
  };
  return /* @__PURE__ */ u(GPage, {
    title: "Заявки на вступление",
    onBack: nav.back,
    children: [
      list.length > 1 ? /* @__PURE__ */ u("div", {
        class: "app-gm-linkbtns",
        children: [
          /* @__PURE__ */ u(Button, {
            variant: "primary",
            onClick: () => setAsk(true),
            children: "Принять всех"
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u(Button, {
            onClick: () => setAsk(false),
            children: "Отклонить всех"
          }, undefined, false, undefined, this)
        ]
      }, undefined, true, undefined, this) : null,
      /* @__PURE__ */ u(Section, {
        footer: "Заявки приходят, когда включено одобрение новых участников.",
        children: reqs.data ? list.length ? list.map((r) => /* @__PURE__ */ u(RequestRow, {
          chatId,
          r,
          onDone: reqs.reload
        }, r.userId, false, undefined, this)) : /* @__PURE__ */ u("p", {
          class: "app-gm-empty",
          children: "Новых заявок нет"
        }, undefined, false, undefined, this) : /* @__PURE__ */ u(Loading, {}, undefined, false, undefined, this)
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u(ConfirmDialog, {
        open: ask !== null,
        danger: ask === false,
        title: ask ? "Принять всех?" : "Отклонить всех?",
        text: ask ? `В группу вступят ${list.length} ${plural3(list.length, "человек", "человека", "человек")}.` : "Все заявки будут отклонены.",
        confirm: ask ? "Принять" : "Отклонить",
        onCancel: () => setAsk(null),
        onConfirm: () => void all()
      }, undefined, false, undefined, this)
    ]
  }, undefined, true, undefined, this);
}

// apps/web/src/ui/group/Reactions.tsx
var REACTION_SET = [
  "\uD83D\uDC4D",
  "❤️",
  "\uD83D\uDE02",
  "\uD83D\uDE2E",
  "\uD83D\uDE22",
  "\uD83D\uDE4F",
  "\uD83D\uDC4E",
  "\uD83D\uDD25",
  "\uD83E\uDD70",
  "\uD83D\uDC4F",
  "\uD83D\uDE01",
  "\uD83E\uDD14",
  "\uD83E\uDD2F",
  "\uD83D\uDE31",
  "\uD83C\uDF89",
  "\uD83E\uDD29",
  "\uD83D\uDCAF",
  "\uD83E\uDD23",
  "⚡",
  "\uD83C\uDFC6",
  "\uD83D\uDC94",
  "\uD83E\uDD28",
  "\uD83D\uDE10",
  "\uD83C\uDF53",
  "\uD83C\uDF7E",
  "\uD83D\uDE08",
  "\uD83D\uDE34",
  "\uD83D\uDE2D",
  "\uD83E\uDD13",
  "\uD83D\uDC7B",
  "\uD83D\uDC40",
  "\uD83D\uDE48",
  "\uD83D\uDE07",
  "\uD83E\uDD1D",
  "✍️",
  "\uD83E\uDD17",
  "\uD83E\uDEE1",
  "\uD83D\uDC85",
  "\uD83E\uDD2A",
  "\uD83D\uDDFF",
  "\uD83D\uDE0E",
  "\uD83D\uDC4C"
];
function Reactions({ nav }) {
  const { chatId } = nav;
  const { group } = useGroup(chatId);
  const [mode, setMode] = d(null);
  const [allowed, setAllowed] = d(null);
  const [busy, setBusy] = d(false);
  useReactionCatalog();
  if (!group)
    return /* @__PURE__ */ u(GPage, {
      title: "Реакции",
      onBack: nav.back,
      children: /* @__PURE__ */ u(Loading, {}, undefined, false, undefined, this)
    }, undefined, false, undefined, this);
  const cat = reactionCatalog();
  const set = cat.length ? cat.map((r) => ({ key: r.key, icon: r.static })) : REACTION_SET.map((e) => ({ key: emojiKey(e), icon: undefined }));
  const m = mode ?? group.reactions.mode;
  const a = (allowed ?? (group.reactions.mode === "some" ? group.reactions.allowed : set.slice(0, 7).map((x) => x.key))).map(emojiKey);
  const saved = group.reactions.allowed.map(emojiKey);
  const dirty = m !== group.reactions.mode || m === "some" && (a.length !== saved.length || a.some((e) => !saved.includes(e)));
  const toggle = (e) => setAllowed(a.includes(e) ? a.filter((x) => x !== e) : [...a, e]);
  const save = async () => {
    setBusy(true);
    const ok = await act("PUT", `/groups/${chatId}/settings`, { reactions: { mode: m, allowed: m === "some" ? a : [] } });
    setBusy(false);
    if (ok)
      nav.back();
  };
  return /* @__PURE__ */ u(GPage, {
    title: "Реакции",
    onBack: nav.back,
    fab: { show: dirty && !(m === "some" && !a.length), icon: "check", label: "Сохранить", onClick: save, busy },
    children: [
      /* @__PURE__ */ u(Section, {
        title: "Реакции в группе",
        role: "radiogroup",
        children: [
          /* @__PURE__ */ u(RadioRow, {
            checked: m === "all",
            label: "Все реакции",
            subtitle: "Участники могут ставить любые реакции.",
            onClick: () => setMode("all")
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u(RadioRow, {
            checked: m === "some",
            label: "Некоторые",
            subtitle: "Только реакции, выбранные ниже.",
            onClick: () => setMode("some")
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u(RadioRow, {
            checked: m === "none",
            label: "Без реакций",
            subtitle: "Реакции в группе выключены.",
            onClick: () => setMode("none")
          }, undefined, false, undefined, this)
        ]
      }, undefined, true, undefined, this),
      m === "some" ? /* @__PURE__ */ u(Section, {
        title: `Доступные реакции · ${a.length}`,
        footer: "Нажмите на эмодзи, чтобы включить или выключить его.",
        children: /* @__PURE__ */ u("div", {
          class: "app-gm-emoji",
          role: "group",
          "aria-label": "Доступные реакции",
          children: set.map((e) => /* @__PURE__ */ u("button", {
            type: "button",
            class: "app-gm-emoji-btn" + (a.includes(e.key) ? " is-on" : ""),
            "aria-pressed": a.includes(e.key),
            "aria-label": "Реакция " + e.key,
            onClick: () => toggle(e.key),
            children: e.icon ? /* @__PURE__ */ u("img", {
              src: e.icon,
              alt: "",
              draggable: false,
              decoding: "async"
            }, undefined, false, undefined, this) : e.key
          }, e.key, false, undefined, this))
        }, undefined, false, undefined, this)
      }, undefined, false, undefined, this) : null
    ]
  }, undefined, true, undefined, this);
}

// apps/web/src/ui/group/Discussion.tsx
function Discussion({ nav }) {
  const { chatId } = nav;
  const { group } = useGroup(chatId);
  const linked = group?.linkedChatId ?? null;
  const chats = useGlobal((s) => s.chats);
  const linkedChat = linked != null ? chats.find((c) => c.id === linked) : undefined;
  const list = useGroupData(linked == null ? `/groups/${chatId}/discussion-candidates` : null, group);
  const [ask, setAsk] = d(null);
  const [busy, setBusy] = d(false);
  if (!group)
    return /* @__PURE__ */ u(GPage, {
      title: "Обсуждение",
      onBack: nav.back,
      children: /* @__PURE__ */ u(Loading, {}, undefined, false, undefined, this)
    }, undefined, false, undefined, this);
  const infoOf = (id) => chats.find((c) => c.id === id)?.group ?? null;
  const warnings = (c) => {
    const g = infoOf(c.id), out = [];
    if (!group.username)
      out.push("Канал частный: все участники группы увидят его посты и вложения.");
    if (g && !g.username)
      out.push("Группа частная: комментировать смогут только её участники.");
    if (g?.historyHidden)
      out.push("История группы станет видна новым участникам.");
    return out;
  };
  const link = async (c) => {
    setAsk(null);
    setBusy(true);
    const ok = await act("PUT", `/groups/${chatId}/discussion`, { groupId: c.id }, `«${c.title}» — теперь обсуждение канала`);
    setBusy(false);
    if (ok)
      nav.back();
  };
  const unlink = async () => {
    setAsk(null);
    setBusy(true);
    await act("PUT", `/groups/${chatId}/discussion`, { groupId: null }, "Группа отвязана");
    setBusy(false);
  };
  const picked = ask && ask !== "unlink" ? ask : null;
  return /* @__PURE__ */ u(GPage, {
    title: "Обсуждение",
    onBack: nav.back,
    children: [
      linked != null ? /* @__PURE__ */ u(S, {
        children: [
          /* @__PURE__ */ u(Section, {
            footer: "Посты канала приходят в эту группу; подписчики обсуждают их в комментариях.",
            children: /* @__PURE__ */ u(InfoRow, {
              tile: "blue",
              icon: "chats",
              title: linkedChat?.title ?? "Группа обсуждения",
              subtitle: "Привязанная группа"
            }, undefined, false, undefined, this)
          }, undefined, false, undefined, this),
          /* @__PURE__ */ u(Section, {
            children: /* @__PURE__ */ u(InfoRow, {
              icon: "close",
              danger: true,
              title: "Отвязать группу",
              onClick: () => !busy && setAsk("unlink")
            }, undefined, false, undefined, this)
          }, undefined, false, undefined, this)
        ]
      }, undefined, true, undefined, this) : /* @__PURE__ */ u(Section, {
        title: "Выберите группу",
        footer: "Каждый пост канала появится в группе, а подписчики смогут оставлять к нему комментарии. Здесь — ваши группы, где вы администратор.",
        children: list.data ? list.data.groups.length ? list.data.groups.map((c) => /* @__PURE__ */ u(InfoRow, {
          tile: "green",
          icon: "community",
          title: c.title,
          subtitle: `${c.members} ${plural3(c.members, "участник", "участника", "участников")}`,
          onClick: () => !busy && setAsk(c)
        }, c.id, false, undefined, this)) : /* @__PURE__ */ u("p", {
          class: "app-gm-empty",
          children: "Подходящих групп нет — создайте группу и станьте её администратором."
        }, undefined, false, undefined, this) : /* @__PURE__ */ u(Loading, {}, undefined, false, undefined, this)
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u(ConfirmDialog, {
        open: !!picked,
        title: "Привязать группу?",
        confirm: "Привязать",
        text: picked ? [`«${picked.title}» станет обсуждением канала «${group.title}».`, ...warnings(picked)].join(" ") : "",
        onCancel: () => setAsk(null),
        onConfirm: () => {
          if (picked)
            link(picked);
        }
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u(ConfirmDialog, {
        open: ask === "unlink",
        danger: true,
        title: "Отвязать группу?",
        confirm: "Отвязать",
        text: "Новые посты перестанут приходить в группу, кнопки комментариев под постами пропадут. Старые обсуждения останутся в группе.",
        onCancel: () => setAsk(null),
        onConfirm: () => void unlink()
      }, undefined, false, undefined, this)
    ]
  }, undefined, true, undefined, this);
}

// apps/web/src/adminLog.ts
var GROUP_LABELS = { members: "Участники", admins: "Администраторы", settings: "Настройки", messages: "Сообщения", invites: "Ссылки" };
var GROUP_ORDER = ["members", "admins", "settings", "messages", "invites"];
var UNKNOWN_NAME = "Пользователь";
var text = (v) => ({ t: "text", v });
var bold = (v) => ({ t: "b", v });
var nameOf = (id, c) => ({ t: "user", id: id != null && c.users.get(id)?.name != null ? id : null, name: (id != null ? c.users.get(id)?.name : null) ?? UNKNOWN_NAME });
var KIND_TEXT = { photo: "Фото", video: "Видео", file: "Файл", voice: "Голосовое сообщение", round: "Видеосообщение", audio: "Музыка", todo: "Чек-лист", sticker: "Стикер", poll: "Опрос", contact: "Контакт", geo: "Геопозиция", dice: "Кубик" };
function messageLabel(m) {
  const body = m.body.replace(/\s+/g, " ").trim();
  return body || KIND_TEXT[m.kind] || "Сообщение";
}
var ON_OFF = (on, yes, no) => on ? yes : no;
var slow = (s) => SLOW_TEXT[s] ?? `${s} с`;
var term = (s) => s ? termText(s) : "выкл.";
function reactionsText(r) {
  if (r.mode === "all")
    return "все";
  if (r.mode === "none")
    return "никаких";
  return r.allowed.length ? r.allowed.join(" ") : "некоторые";
}
function diffRights(from, to, label, keys, plus, minus) {
  const added = keys.filter((k) => !!to?.[k] && !from?.[k]).map(label), removed = keys.filter((k) => !!from?.[k] && !to?.[k]).map(label);
  const parts = [];
  if (added.length)
    parts.push(text(`${plus}: `), bold(added.join(", ")));
  if (removed.length)
    parts.push(text(added.length ? `; ${minus}: ` : `${minus}: `), bold(removed.join(", ")));
  return parts;
}
var MEMBER_KEYS = Object.keys(MEMBER_RIGHT_TEXT);
var ADMIN_KEYS = ["info", "post", "edit", "delete", "ban", "invite", "pin", "calls", "addAdmins"];
function inviteDiff(from, to) {
  const parts = [];
  if (from.title !== to.title)
    parts.push([text("название: "), bold(to.title ?? "без названия")]);
  if (from.expiresAt !== to.expiresAt)
    parts.push([text(to.expiresAt ? "срок изменён" : "срок снят")]);
  if (from.usageLimit !== to.usageLimit)
    parts.push([text("лимит: "), bold(to.usageLimit == null ? "без лимита" : String(to.usageLimit))]);
  if (from.approval !== to.approval)
    parts.push([text(to.approval ? "с одобрением заявок" : "без одобрения заявок")]);
  return parts.flatMap((p, i) => i ? [text("; "), ...p] : p);
}
var linkLabel = (d) => d.title ? `«${d.title}» (${d.mask})` : d.mask;
var fromTo = (a, b) => [bold(a), text(" → "), bold(b)];
function adminLogText(e, c) {
  const who = nameOf(e.actorId, c);
  const line = (...rest) => [who, text(" "), ...rest];
  const channel = c.kind === "channel";
  const target = (id) => nameOf(id, c);
  const about = (d, noun) => d.target != null && !d.hidden ? [text(`${noun} от `), target(d.target)] : [text(noun)];
  switch (e.action) {
    case "title_changed":
      return line(text("изменил(а) название: "), ...fromTo(e.data.from, e.data.to));
    case "about_changed":
      if (!e.data.to)
        return line(text("удалил(а) описание"));
      return e.data.from ? line(text("изменил(а) описание: "), ...fromTo(e.data.from, e.data.to)) : line(text("добавил(а) описание: "), bold(e.data.to));
    case "photo_changed":
      return line(text("изменил(а) фото"));
    case "photo_removed":
      return line(text("удалил(а) фото"));
    case "username_changed":
      if (!e.data.to)
        return line(text("убрал(а) публичный адрес "), bold("@" + e.data.from));
      return e.data.from ? line(text("изменил(а) адрес: "), ...fromTo("@" + e.data.from, "@" + e.data.to)) : line(text("задал(а) публичный адрес "), bold("@" + e.data.to));
    case "signatures_toggled":
      return line(text(ON_OFF(e.data.on, "включил(а) подписи постов", "выключил(а) подписи постов")));
    case "protected_toggled":
      return line(text(ON_OFF(e.data.on, "запретил(а) копирование содержимого", "разрешил(а) копирование содержимого")));
    case "theme_changed": {
      const t = e.data.to;
      return t ? line(text("изменил(а) тему чата на "), bold(`${t.emoji} ${t.title}`)) : line(text("отключил(а) тему чата"));
    }
    case "auto_delete_changed":
      if (!e.data.to)
        return line(text("выключил(а) автоудаление"));
      return e.data.from ? line(text("изменил(а) автоудаление: "), ...fromTo(term(e.data.from), term(e.data.to))) : line(text("включил(а) автоудаление: "), bold(term(e.data.to)));
    case "slow_mode_changed":
      if (!e.data.to)
        return line(text("выключил(а) медленный режим"));
      return e.data.from ? line(text("изменил(а) медленный режим: "), ...fromTo(slow(e.data.from), slow(e.data.to))) : line(text("включил(а) медленный режим: "), bold(slow(e.data.to)));
    case "history_toggled":
      return line(text(ON_OFF(e.data.hidden, "скрыл(а) историю чата для новых участников", "открыл(а) историю чата для новых участников")));
    case "join_approval_toggled":
      return line(text(ON_OFF(e.data.on, "включил(а) вступление по заявке", "выключил(а) вступление по заявке")));
    case "join_to_send_toggled":
      return line(text(ON_OFF(e.data.on, "разрешил(а) комментировать только участникам", "разрешил(а) комментировать без вступления")));
    case "linked_chat_changed": {
      const noun = channel ? "группу обсуждения" : "канал";
      const title = (id) => id != null ? c.chats.get(id) : undefined;
      const to = title(e.data.to), from = title(e.data.from);
      if (e.data.to == null)
        return line(text(`отвязал(а) ${noun}`), ...from ? [text(" "), bold(from)] : []);
      return line(text(e.data.from == null ? `привязал(а) ${noun}` : `сменил(а) ${noun}`), ...to ? [text(" "), bold(to)] : []);
    }
    case "reactions_changed":
      return line(text("изменил(а) реакции: "), ...fromTo(reactionsText(e.data.from), reactionsText(e.data.to)));
    case "default_rights_changed":
      return line(text("изменил(а) права участников"), ...withDash(diffRights(e.data.from, e.data.to, (k) => MEMBER_RIGHT_TEXT[k], MEMBER_KEYS, "разрешено", "запрещено")));
    case "member_added":
      return line(text("добавил(а) "), target(e.data.target));
    case "member_joined":
      return e.data.via === "link" && e.data.mask ? line(text("вступил(а) по ссылке "), bold(e.data.mask)) : e.data.via === "discussion" ? line(text("вступил(а) из обсуждения")) : line(text("вступил(а)"));
    case "member_left":
      return line(text("вышел(а)"));
    case "member_banned":
      return line(text("исключил(а) "), target(e.data.target));
    case "member_unbanned":
      return line(text("снял(а) исключение с "), target(e.data.target));
    case "member_restricted":
      return line(text("ограничил(а) "), target(e.data.target), ...withDash(diffRights(e.data.from, e.data.to, (k) => MEMBER_RIGHT_TEXT[k], MEMBER_KEYS, "разрешено", "запрещено")));
    case "member_unrestricted":
      return line(text("снял(а) ограничения с "), target(e.data.target));
    case "request_approved":
      return line(text("одобрил(а) заявку "), target(e.data.target));
    case "request_declined":
      return line(text("отклонил(а) заявку "), target(e.data.target));
    case "admin_promoted": {
      const on = ADMIN_KEYS.filter((k) => e.data.rights[k]).map((k) => adminRightText(k, c.kind));
      return line(text("назначил(а) администратором "), target(e.data.target), ...e.data.rank ? [text(" со званием "), bold(e.data.rank)] : [], ...on.length ? [text(": "), bold(on.join(", "))] : []);
    }
    case "admin_edited":
      return line(text("изменил(а) права администратора "), target(e.data.target), ...withDash(diffRights(e.data.from, e.data.to, (k) => adminRightText(k, c.kind), ADMIN_KEYS, "добавлено", "убрано")));
    case "admin_demoted":
      return line(text("снял(а) с поста администратора "), target(e.data.target));
    case "admin_rank_changed":
      return e.data.to ? line(text("изменил(а) звание "), target(e.data.target), text(": "), bold(e.data.to)) : line(text("убрал(а) звание "), target(e.data.target));
    case "owner_transferred":
      return e.data.auto ? line(text("вышел(а), права владельца перешли к "), target(e.data.target)) : line(text("передал(а) права владельца "), target(e.data.target));
    case "message_deleted":
      return line(text("удалил(а) "), ...about(e.data, channel ? "публикацию" : "сообщение"));
    case "message_edited":
      return line(text("изменил(а) "), ...about(e.data, channel ? "публикацию" : "сообщение"));
    case "message_pinned":
      return line(text("закрепил(а) "), ...about(e.data, channel ? "публикацию" : "сообщение"));
    case "message_unpinned":
      return line(text("открепил(а) "), ...about(e.data, channel ? "публикацию" : "сообщение"));
    case "all_unpinned":
      return line(text(`открепил(а) все сообщения (${e.data.count})`));
    case "poll_closed":
      return line(text("закрыл(а) "), ...about(e.data, "опрос"));
    case "invite_created":
      return line(text(e.data.primary ? "создал(а) новую основную ссылку " : "создал(а) ссылку "), bold(linkLabel(e.data)));
    case "invite_edited":
      return line(text("изменил(а) ссылку "), bold(e.data.mask), ...withColon(inviteDiff(e.data.from, e.data.to)));
    case "invite_revoked":
      return line(text(e.data.primary ? "отозвал(а) основную ссылку " : "отозвал(а) ссылку "), bold(linkLabel(e.data)));
    case "invite_deleted":
      return line(text("удалил(а) ссылку "), bold(linkLabel(e.data)));
  }
}
var withColon = (rest) => rest.length ? [text(": "), ...rest] : [];
var withDash = (rest) => rest.length ? [text(" — "), ...rest] : [];
var segsText = (segs) => segs.map((s) => s.t === "user" ? s.name : s.v).join("");
var ROW_TEXT_FIT = 90;
var needsDetails = (segs) => segsText(segs).length > ROW_TEXT_FIT;
function messageSeg(e) {
  return e.message ? { t: "msg", v: messageLabel(e.message), message: e.message } : null;
}
var deletedAt = (e) => e.action === "message_deleted" && e.data.at ? e.data.at : null;
var dayOf = (iso) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};
function groupByDay(entries, labelOf) {
  const out = [];
  for (const e of entries) {
    const key = dayOf(e.at), last = out[out.length - 1];
    if (last?.key === key)
      last.entries.push(e);
    else
      out.push({ key, label: labelOf(e.at), entries: [e] });
  }
  return out;
}
var EMPTY_LOG = { entries: [], users: new Map, chats: new Map, hasMore: false };
function appendPage(prev, page) {
  const seen = new Set(prev.entries.map((e) => e.id));
  const users = new Map(prev.users), chats = new Map(prev.chats);
  for (const u of page.users)
    users.set(u.id, u);
  for (const c of page.chats)
    chats.set(c.id, c.title);
  return { entries: [...prev.entries, ...page.entries.filter((e) => !seen.has(e.id))], users, chats, hasMore: page.hasMore };
}
var NO_FILTER = { actions: [], actors: [], q: "" };
var filterActive = (f) => f.actions.length > 0 || f.actors.length > 0 || !!f.q.trim();
function groupState(f, g) {
  const list = ADMIN_LOG_GROUPS[g];
  const n = list.filter((a) => f.actions.includes(a)).length;
  return n === 0 ? "none" : n === list.length ? "all" : "some";
}
function toggleGroup(f, g) {
  const list = ADMIN_LOG_GROUPS[g];
  const rest = f.actions.filter((a) => !list.includes(a));
  return { ...f, actions: groupState(f, g) === "all" ? rest : [...rest, ...list] };
}
function toggleAction(f, a) {
  return { ...f, actions: f.actions.includes(a) ? f.actions.filter((x) => x !== a) : [...f.actions, a] };
}
function toggleActor(f, id) {
  return { ...f, actors: f.actors.includes(id) ? f.actors.filter((x) => x !== id) : [...f.actors, id] };
}
function filterChips(f, actorName) {
  const chips = [];
  if (f.q.trim())
    chips.push({ key: "q", label: `«${f.q.trim()}»`, remove: (x) => ({ ...x, q: "" }) });
  for (const g of GROUP_ORDER) {
    const st = groupState(f, g);
    if (st === "all")
      chips.push({ key: "g:" + g, label: GROUP_LABELS[g], remove: (x) => toggleGroup(x, g) });
    else if (st === "some") {
      for (const a of ADMIN_LOG_GROUPS[g])
        if (f.actions.includes(a))
          chips.push({ key: "a:" + a, label: ADMIN_LOG_LABELS[a], remove: (x) => toggleAction(x, a) });
    }
  }
  for (const id of f.actors)
    chips.push({ key: "u:" + id, label: actorName(id), remove: (x) => toggleActor(x, id) });
  return chips;
}
function logPath(chatId, f, before, limit = 50) {
  const p = new URLSearchParams;
  if (before != null)
    p.set("before", String(before));
  p.set("limit", String(limit));
  if (f.actions.length)
    p.set("actions", ADMIN_LOG_ACTIONS.filter((a) => f.actions.includes(a)).join(","));
  if (f.actors.length)
    p.set("actors", [...f.actors].sort((a, b) => a - b).join(","));
  if (f.q.trim())
    p.set("q", f.q.trim());
  return `/chats/${chatId}/admin-log?${p}`;
}
function logView(s, f) {
  if (s.status === "denied")
    return "denied";
  if (s.entries)
    return "list";
  if (s.status === "ready")
    return filterActive(f) ? "emptyFiltered" : "empty";
  return s.status;
}
var logFailure = (code) => code === "offline" ? "offline" : code === "forbidden" || code === "not_member" || code === "not_found" ? "denied" : "error";

// apps/web/src/ui/group/AdminLog.tsx
var ROW_H = 84;
var PAGE = 50;
function useAdminLog(chatId, filter, admin) {
  const [log, setLog] = d(EMPTY_LOG);
  const [status, setStatus] = d("loading");
  const [tail, setTail] = d("idle");
  const [fresh, setFresh] = d(0);
  const logRef = A(log);
  logRef.current = log;
  const seq = A(0);
  const busy = A(false);
  const first = q(() => {
    const my = ++seq.current;
    busy.current = false;
    setStatus("loading");
    setTail("idle");
    groupCall2("GET", logPath(chatId, filter, null, PAGE)).then((r) => {
      if (my !== seq.current)
        return;
      if (!r.ok) {
        const st = logFailure(r.code);
        setStatus(st);
        if (st === "denied")
          setLog(EMPTY_LOG);
        return;
      }
      setLog(appendPage(EMPTY_LOG, r.data));
      setStatus("ready");
      setFresh((n) => n + 1);
    });
  }, [chatId, JSON.stringify(filter)]);
  const more = q(() => {
    const cur = logRef.current;
    if (busy.current || !cur.hasMore || !cur.entries.length)
      return;
    const my = seq.current;
    busy.current = true;
    setTail("loading");
    groupCall2("GET", logPath(chatId, filter, cur.entries[cur.entries.length - 1].id, PAGE)).then((r) => {
      if (my !== seq.current)
        return;
      busy.current = false;
      if (r.ok) {
        setLog((l) => appendPage(l, r.data));
        setTail("idle");
        return;
      }
      const st = logFailure(r.code);
      if (st === "denied") {
        setLog(EMPTY_LOG);
        setStatus("denied");
        setTail("idle");
      } else
        setTail("offline");
    });
  }, [chatId, JSON.stringify(filter)]);
  h(() => {
    if (admin)
      first();
    else {
      seq.current++;
      setLog(EMPTY_LOG);
      setStatus("denied");
    }
  }, [first, admin]);
  const online = useGlobal((s) => s.status.online);
  h(() => {
    if (!online || !admin)
      return;
    if (status === "offline" || status === "error")
      first();
    else if (tail === "offline")
      more();
  }, [online]);
  return { log, status, tail, fresh, reload: first, more };
}
function Segs({ segs, onUser }) {
  return /* @__PURE__ */ u(S, {
    children: segs.map((s, i) => s.t === "text" ? /* @__PURE__ */ u("span", {
      children: s.v
    }, i, false, undefined, this) : s.t === "b" ? /* @__PURE__ */ u("b", {
      children: s.v
    }, i, false, undefined, this) : s.t === "user" ? s.id != null ? /* @__PURE__ */ u("button", {
      type: "button",
      class: "app-log-name",
      onClick: () => onUser(s.id),
      children: s.name
    }, i, false, undefined, this) : /* @__PURE__ */ u("b", {
      children: s.name
    }, i, false, undefined, this) : null)
  }, undefined, false, undefined, this);
}
function Row({ e, ctx, onUser, onMessage, onDetails }) {
  const segs = adminLogText(e, ctx);
  const msg = messageSeg(e), gone = deletedAt(e), long = needsDetails(segs);
  const actor = e.actorId != null ? ctx.users.get(e.actorId) : undefined;
  const name = actor?.name ?? "Пользователь";
  const canOpen = e.actorId != null && actor?.name != null;
  const ava = /* @__PURE__ */ u(Avatar, {
    name,
    tone: peerTone(e.actorId ?? 0),
    size: 40,
    ...avatarPhoto(actor?.photo ?? null)
  }, undefined, false, undefined, this);
  return /* @__PURE__ */ u("div", {
    class: "app-log-row",
    role: "listitem",
    children: [
      canOpen ? /* @__PURE__ */ u("button", {
        type: "button",
        class: "app-log-ava",
        "aria-label": name,
        onClick: () => onUser(e.actorId),
        children: ava
      }, undefined, false, undefined, this) : /* @__PURE__ */ u("span", {
        class: "app-log-ava",
        children: ava
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u("div", {
        class: "app-log-main",
        children: [
          /* @__PURE__ */ u("div", {
            class: "app-log-text" + (msg || gone || long ? " is-two" : ""),
            children: /* @__PURE__ */ u(Segs, {
              segs,
              onUser
            }, undefined, false, undefined, this)
          }, undefined, false, undefined, this),
          msg ? /* @__PURE__ */ u("button", {
            type: "button",
            class: "app-log-msg",
            onClick: () => onMessage(e),
            children: msg.t === "msg" ? msg.v : ""
          }, undefined, false, undefined, this) : gone ? /* @__PURE__ */ u("span", {
            class: "app-log-sub",
            children: [
              "от ",
              dayLabel(gone).toLowerCase(),
              ", ",
              clock(gone)
            ]
          }, undefined, true, undefined, this) : long ? /* @__PURE__ */ u("button", {
            type: "button",
            class: "app-log-more",
            onClick: () => onDetails(e),
            children: "Подробнее"
          }, undefined, false, undefined, this) : null
        ]
      }, undefined, true, undefined, this),
      /* @__PURE__ */ u("time", {
        class: "app-log-time",
        dateTime: e.at,
        children: clock(e.at)
      }, undefined, false, undefined, this)
    ]
  }, undefined, true, undefined, this);
}
function FilterDialog({ open, chatId, value, onClose, onApply }) {
  const [f, setF] = d(value);
  const [expanded, setExpanded] = d(null);
  h(() => {
    if (open)
      setF(value);
  }, [open]);
  const admins = useGroupData(open ? `/groups/${chatId}/members?filter=admins` : null);
  return /* @__PURE__ */ u(Modal, {
    open,
    onClose,
    title: "Фильтр",
    actions: [
      /* @__PURE__ */ u("button", {
        type: "button",
        class: "rl-mdl-btn",
        onClick: () => {
          onApply(NO_FILTER);
          onClose();
        },
        children: "Сбросить"
      }, "reset", false, undefined, this),
      /* @__PURE__ */ u("button", {
        type: "button",
        class: "rl-mdl-btn",
        onClick: () => {
          onApply(f);
          onClose();
        },
        children: "Применить"
      }, "ok", false, undefined, this)
    ],
    children: /* @__PURE__ */ u("div", {
      class: "app-log-filter",
      children: [
        /* @__PURE__ */ u(TextField, {
          label: "Имя или действие",
          value: f.q,
          maxLength: 64,
          onInput: (v) => setF({ ...f, q: v })
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u(Section, {
          title: "Действия",
          children: GROUP_ORDER.map((g) => {
            const st = groupState(f, g), list = ADMIN_LOG_GROUPS[g], opened = expanded === g;
            const on = list.filter((a) => f.actions.includes(a)).length;
            return /* @__PURE__ */ u("div", {
              children: [
                /* @__PURE__ */ u("div", {
                  class: "app-gm-media",
                  children: [
                    /* @__PURE__ */ u(CheckRow, {
                      checked: st === "all",
                      label: GROUP_LABELS[g],
                      subtitle: st === "some" ? `${on} из ${list.length}` : undefined,
                      onChange: () => setF(toggleGroup(f, g))
                    }, undefined, false, undefined, this),
                    /* @__PURE__ */ u(IconButton, {
                      class: "app-gm-expand" + (opened ? " is-open" : ""),
                      icon: "chevronDown",
                      label: opened ? "Свернуть" : "Выбрать типы",
                      onClick: () => setExpanded(opened ? null : g)
                    }, undefined, false, undefined, this)
                  ]
                }, undefined, true, undefined, this),
                /* @__PURE__ */ u("div", {
                  class: "app-gm-sub" + (opened ? " is-open" : ""),
                  children: /* @__PURE__ */ u("div", {
                    children: opened ? list.map((a) => /* @__PURE__ */ u(CheckRow, {
                      checked: f.actions.includes(a),
                      label: ADMIN_LOG_LABELS[a],
                      onChange: () => setF(toggleAction(f, a))
                    }, a, false, undefined, this)) : null
                  }, undefined, false, undefined, this)
                }, undefined, false, undefined, this)
              ]
            }, g, true, undefined, this);
          })
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u(Section, {
          title: "Кто",
          children: admins.data ? admins.data.members.map((m) => /* @__PURE__ */ u(CheckRow, {
            checked: f.actors.includes(m.userId),
            label: m.name,
            onChange: () => setF(toggleActor(f, m.userId))
          }, m.userId, false, undefined, this)) : /* @__PURE__ */ u("div", {
            class: "app-log-filter-wait",
            "aria-busy": "true"
          }, undefined, false, undefined, this)
        }, undefined, false, undefined, this)
      ]
    }, undefined, true, undefined, this)
  }, undefined, false, undefined, this);
}
function AdminLog({ nav }) {
  const { chatId } = nav;
  const { me, kind } = useGroup(chatId);
  const admin = isAdminRole(me?.role ?? "member");
  const [filter, setFilter] = d(NO_FILTER);
  const [asking, setAsking] = d(false);
  const [details, setDetails] = d(null);
  const { log, status, tail, fresh, reload, more } = useAdminLog(chatId, filter, admin);
  const ctx = T(() => ({ kind, users: log.users, chats: log.chats }), [kind, log.users, log.chats]);
  const days = T(() => groupByDay(log.entries, dayLabel), [log.entries]);
  const adminNames = useGroupData(filter.actors.length ? `/groups/${chatId}/members?filter=admins` : null);
  const actorName = (id) => adminNames.data?.members.find((m) => m.userId === id)?.name ?? log.users.get(id)?.name ?? "Пользователь";
  const chips = filterChips(filter, actorName);
  const skeleton = useMinVisible(status === "loading" && !log.entries.length, { delay: 150, min: 600 });
  const tailBusy = useMinVisible(tail === "loading", { delay: 150, min: 400 });
  const view = logView({ entries: log.entries.length, status }, filter);
  const page = A(null);
  const closeIfFloats = () => {
    if (asideFloats())
      nav.close();
  };
  const onUser = (id) => {
    const key = log.users.get(id)?.key;
    closeIfFloats();
    openUserChat2(id, key ? { key } : undefined);
  };
  const onMessage = (e) => {
    const m = e.message;
    if (!m)
      return;
    closeIfFloats();
    openInner2(m.threadId != null ? { chatId, threadId: m.threadId } : chatId, { id: m.id, sort: m.id });
  };
  const refresh = () => {
    reload();
    requestMutation(() => {
      page.current?.closest(".rl-settings")?.scrollTo({ top: 0 });
    });
  };
  const rowsFor = (entries, last) => /* @__PURE__ */ u(WindowList, {
    items: entries,
    rowHeight: ROW_H,
    overscan: 6,
    role: "list",
    getKey: (e) => -e.id,
    onNearEnd: last ? more : undefined,
    nearEndKey: last ? log.entries.length : undefined,
    render: (e) => /* @__PURE__ */ u(Row, {
      e,
      ctx,
      onUser,
      onMessage,
      onDetails: setDetails
    }, undefined, false, undefined, this)
  }, undefined, false, undefined, this);
  return /* @__PURE__ */ u(GPage, {
    title: "Недавние действия",
    onBack: nav.back,
    actions: admin ? [
      { icon: "refresh", label: "Обновить", onClick: refresh },
      { icon: "general", label: "Фильтр", onClick: () => setAsking(true) }
    ] : undefined,
    children: [
      /* @__PURE__ */ u("div", {
        ref: page,
        class: "app-log",
        children: [
          filterActive(filter) ? /* @__PURE__ */ u("div", {
            class: "app-log-chips",
            role: "group",
            "aria-label": "Активный фильтр",
            children: [
              chips.map((c) => /* @__PURE__ */ u(Chip, {
                active: true,
                "aria-label": `Убрать: ${c.label}`,
                onClick: () => setFilter(c.remove(filter)),
                children: c.label
              }, c.key, false, undefined, this)),
              /* @__PURE__ */ u(Chip, {
                onClick: () => setFilter(NO_FILTER),
                children: "Сбросить"
              }, undefined, false, undefined, this)
            ]
          }, undefined, true, undefined, this) : null,
          /* @__PURE__ */ u("div", {
            class: "app-listwrap is-fresh",
            children: [
              /* @__PURE__ */ u(Presence, {
                show: skeleton,
                exitMs: 280,
                children: /* @__PURE__ */ u("div", {
                  class: "app-skel",
                  "aria-busy": "true",
                  "aria-label": "Загрузка журнала",
                  children: [0, 1, 2, 3, 4].map((i) => /* @__PURE__ */ u("div", {
                    style: { "--i": i },
                    children: /* @__PURE__ */ u(ChatRowSkeleton, {}, undefined, false, undefined, this)
                  }, i, false, undefined, this))
                }, undefined, false, undefined, this)
              }, undefined, false, undefined, this),
              view === "list" ? /* @__PURE__ */ u("div", {
                class: "app-log-list",
                children: [
                  days.map((d, i) => /* @__PURE__ */ u("section", {
                    class: "app-log-day",
                    "aria-label": d.label,
                    children: [
                      /* @__PURE__ */ u("h3", {
                        class: "app-log-daylabel",
                        children: d.label
                      }, undefined, false, undefined, this),
                      rowsFor(d.entries, i === days.length - 1)
                    ]
                  }, d.key + ":" + i, true, undefined, this)),
                  log.hasMore || tail !== "idle" ? /* @__PURE__ */ u("div", {
                    class: "app-log-tail",
                    role: "status",
                    children: tail === "offline" ? /* @__PURE__ */ u(S, {
                      children: [
                        /* @__PURE__ */ u("span", {
                          children: "Нет сети"
                        }, undefined, false, undefined, this),
                        /* @__PURE__ */ u(Button, {
                          size: "small",
                          onClick: more,
                          children: "Повторить"
                        }, undefined, false, undefined, this)
                      ]
                    }, undefined, true, undefined, this) : /* @__PURE__ */ u(Presence, {
                      show: tailBusy,
                      exitMs: 200,
                      children: /* @__PURE__ */ u("svg", {
                        class: "app-sm-spin",
                        width: "22",
                        height: "22",
                        viewBox: "0 0 18 18",
                        fill: "none",
                        "aria-label": "Загружаем ещё",
                        children: /* @__PURE__ */ u("circle", {
                          cx: "9",
                          cy: "9",
                          r: "7",
                          stroke: "currentColor",
                          "stroke-width": "2",
                          "stroke-linecap": "round",
                          "stroke-dasharray": "30 44"
                        }, undefined, false, undefined, this)
                      }, undefined, false, undefined, this)
                    }, undefined, false, undefined, this)
                  }, undefined, false, undefined, this) : null
                ]
              }, fresh, true, undefined, this) : skeleton ? null : view === "empty" ? /* @__PURE__ */ u(EmptyState, {
                kind: "log",
                title: "За последние 48 часов действий нет",
                text: "Здесь появятся действия администраторов и участников."
              }, undefined, false, undefined, this) : view === "emptyFiltered" ? /* @__PURE__ */ u(EmptyState, {
                kind: "search",
                title: "Ничего не найдено",
                text: "Попробуйте изменить фильтр.",
                action: /* @__PURE__ */ u(Button, {
                  onClick: () => setFilter(NO_FILTER),
                  children: "Сбросить"
                }, undefined, false, undefined, this)
              }, undefined, false, undefined, this) : view === "offline" ? /* @__PURE__ */ u(EmptyState, {
                title: "Нет сети",
                text: "Журнал загрузится, когда появится подключение.",
                action: /* @__PURE__ */ u(Button, {
                  onClick: reload,
                  children: "Повторить"
                }, undefined, false, undefined, this)
              }, undefined, false, undefined, this) : view === "error" ? /* @__PURE__ */ u(EmptyState, {
                title: "Не получилось загрузить",
                text: "Попробуйте ещё раз.",
                action: /* @__PURE__ */ u(Button, {
                  onClick: reload,
                  children: "Повторить"
                }, undefined, false, undefined, this)
              }, undefined, false, undefined, this) : view === "denied" ? /* @__PURE__ */ u(EmptyState, {
                title: "Нет доступа",
                text: "Журнал видят только администраторы."
              }, undefined, false, undefined, this) : null
            ]
          }, undefined, true, undefined, this)
        ]
      }, undefined, true, undefined, this),
      /* @__PURE__ */ u(FilterDialog, {
        open: asking,
        chatId,
        value: filter,
        onClose: () => setAsking(false),
        onApply: setFilter
      }, undefined, false, undefined, this),
      /* @__PURE__ */ u(Modal, {
        open: !!details,
        onClose: () => setDetails(null),
        title: details ? `${dayLabel(details.at)}, ${clock(details.at)}` : "",
        size: "confirm",
        closeButton: false,
        actions: [/* @__PURE__ */ u("button", {
          type: "button",
          class: "rl-mdl-btn",
          onClick: () => setDetails(null),
          children: "Закрыть"
        }, "x", false, undefined, this)],
        children: details ? /* @__PURE__ */ u("p", {
          class: "rl-mdl-text app-log-full",
          children: /* @__PURE__ */ u(Segs, {
            segs: adminLogText(details, ctx),
            onUser: (id) => {
              setDetails(null);
              onUser(id);
            }
          }, undefined, false, undefined, this)
        }, undefined, false, undefined, this) : null
      }, undefined, false, undefined, this)
    ]
  }, undefined, true, undefined, this);
}
// apps/web/src/ui/group/Manage.tsx
function GroupScreen({ page, nav }) {
  switch (page) {
    case "gEdit":
      return /* @__PURE__ */ u(EditGroup, {
        nav
      }, undefined, false, undefined, this);
    case "gType":
      return /* @__PURE__ */ u(GroupType, {
        nav
      }, undefined, false, undefined, this);
    case "gReactions":
      return /* @__PURE__ */ u(Reactions, {
        nav
      }, undefined, false, undefined, this);
    case "gPerms":
      return /* @__PURE__ */ u(Permissions, {
        nav
      }, undefined, false, undefined, this);
    case "gBanned":
      return /* @__PURE__ */ u(Banned, {
        nav
      }, undefined, false, undefined, this);
    case "gBanPick":
      return /* @__PURE__ */ u(MemberPick, {
        nav,
        mode: "ban"
      }, undefined, false, undefined, this);
    case "gExceptionPick":
      return /* @__PURE__ */ u(MemberPick, {
        nav,
        mode: "exception"
      }, undefined, false, undefined, this);
    case "gException":
      return /* @__PURE__ */ u(Exception, {
        nav
      }, undefined, false, undefined, this);
    case "gAdmins":
      return /* @__PURE__ */ u(Admins, {
        nav
      }, undefined, false, undefined, this);
    case "gAdminPick":
      return /* @__PURE__ */ u(MemberPick, {
        nav,
        mode: "admin"
      }, undefined, false, undefined, this);
    case "gAdminRights":
      return /* @__PURE__ */ u(AdminRightsPage, {
        nav
      }, undefined, false, undefined, this);
    case "gMembers":
      return /* @__PURE__ */ u(ManageMembers, {
        nav
      }, undefined, false, undefined, this);
    case "gAddMembers":
      return /* @__PURE__ */ u(AddMembers, {
        nav
      }, undefined, false, undefined, this);
    case "gRequests":
      return /* @__PURE__ */ u(Requests, {
        nav
      }, undefined, false, undefined, this);
    case "gInvites":
      return /* @__PURE__ */ u(Invites, {
        nav
      }, undefined, false, undefined, this);
    case "gInvite":
      return /* @__PURE__ */ u(InviteEdit, {
        nav
      }, undefined, false, undefined, this);
    case "gInviteInfo":
      return /* @__PURE__ */ u(InviteInfo, {
        nav
      }, undefined, false, undefined, this);
    case "gDiscussion":
      return /* @__PURE__ */ u(Discussion, {
        nav
      }, undefined, false, undefined, this);
    case "gLog":
      return /* @__PURE__ */ u(AdminLog, {
        nav
      }, undefined, false, undefined, this);
  }
}
export {
  GroupScreen
};

//# debugId=1730EB1CD839FB6364756E2164756E21
//# sourceMappingURL=Manage-6rd5yjg9.js.map
