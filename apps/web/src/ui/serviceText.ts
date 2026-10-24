import type { ServiceData, ServiceType } from '@relay/protocol';

// Тексты служебных событий группы (как action-сообщения в Telegram): «Вы …» за свои, «Имя …(а)» за чужие,
// «вас» — когда событие о вас. Имена участников — те, что сервер записал в момент события.

const GROUP_TYPES = new Set<ServiceType>([
  'group_created', 'channel_created', 'title_changed', 'photo_changed', 'photo_removed', 'members_added', 'member_left', 'member_removed',
  'joined_by_link', 'joined_by_request', 'owner_changed', 'protected_on', 'protected_off',
]);
export const isGroupService = (t: string | undefined): t is ServiceType => !!t && GROUP_TYPES.has(t as ServiceType);

export function serviceText(type: ServiceType, opts: { data?: ServiceData; body?: string; mine: boolean; sender: string; meId: number }): string {
  const { data, mine, sender, meId } = opts;
  const v = (you: string, other: string) => (mine ? 'Вы ' + you : `${sender} ${other}`);
  const users = (data?.users ?? []).map((u) => (u.id === meId ? 'вас' : u.name)).join(', ');
  const first = data?.users?.[0];
  const subject = first ? (first.id === meId ? 'Вы' : first.name) : sender;
  switch (type) {
    case 'group_created': return v('создали группу', 'создал(а) группу') + ` «${opts.body ?? ''}»`;
    case 'channel_created': return v('создали канал', 'создал(а) канал') + ` «${opts.body ?? ''}»`;
    case 'title_changed': return v('изменили название группы на', 'изменил(а) название группы на') + ` «${data?.title ?? opts.body ?? ''}»`;
    case 'photo_changed': return v('изменили фото группы', 'изменил(а) фото группы');
    case 'photo_removed': return v('удалили фото группы', 'удалил(а) фото группы');
    case 'members_added':
      // сам себя добавил — значит вступил (Telegram пишет так же)
      if (data?.users?.length === 1 && first && opts.mine && first.id === meId) return 'Вы вступили в группу';
      return v('добавили', 'добавил(а)') + ' ' + users;
    case 'member_left': return mine ? 'Вы покинули группу' : `${sender} покинул(а) группу`;
    case 'member_removed': return v('удалили', 'удалил(а)') + ' ' + users;
    case 'joined_by_link': return subject === 'Вы' ? 'Вы вступили в группу по ссылке' : `${subject} вступил(а) в группу по ссылке`;
    case 'joined_by_request': return subject === 'Вы' ? 'Вашу заявку на вступление одобрили' : `${subject} принят(а) в группу`;
    case 'owner_changed': return v('передали права на группу', 'передал(а) права на группу') + ' ' + users;
    case 'protected_on': return v('запретили копирование в группе', 'запретил(а) копирование в группе');
    case 'protected_off': return v('разрешили копирование в группе', 'разрешил(а) копирование в группе');
    default: return opts.body ?? '';
  }
}
