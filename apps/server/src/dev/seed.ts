// Наполнение базы для разработки и проверки производительности.
//   docker compose exec server bun apps/server/src/dev/seed.ts [--reset] [--owners 31] [--chats 500] [--groups 20]
// Основные пользователи: «Анна Смирнова» и ещё 30; у каждого 500 личных чатов и ~20 групп,
// в чате 3–60 сообщений за последние 90 дней, в ~15% чатов есть непрочитанное.
// Журнал изменений не пишется: клиент заберёт всё снимком (/chats) при первом входе.
import { sql } from '../db';

const arg = (name: string, def: number) => { const i = process.argv.indexOf('--' + name); return i > 0 ? Number(process.argv[i + 1]) : def; };
const OWNERS = arg('owners', 31), CHATS = arg('chats', 500), GROUPS = arg('groups', 20);

// mulberry32: детерминированный и без потери точности (LCG на double повторял значения)
let seed = 20261016;
const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];

const FIRST_F = ['Анна', 'Мария', 'Елена', 'Ольга', 'Наталья', 'Ирина', 'Татьяна', 'Светлана', 'Юлия', 'Екатерина', 'Дарья', 'Алина', 'Полина', 'Ксения', 'Виктория', 'Алиса', 'Вера', 'Софья', 'Марина', 'Кристина'];
const FIRST_M = ['Алексей', 'Дмитрий', 'Иван', 'Сергей', 'Андрей', 'Павел', 'Максим', 'Никита', 'Артём', 'Михаил', 'Егор', 'Илья', 'Олег', 'Роман', 'Денис', 'Кирилл', 'Тимур', 'Глеб', 'Владимир', 'Игорь'];
const LAST = ['Смирнов', 'Иванов', 'Кузнецов', 'Попов', 'Васильев', 'Петров', 'Соколов', 'Михайлов', 'Новиков', 'Фёдоров', 'Морозов', 'Волков', 'Алексеев', 'Лебедев', 'Семёнов', 'Егоров', 'Павлов', 'Козлов', 'Степанов', 'Николаев', 'Орлов', 'Андреев', 'Макаров', 'Никитин', 'Захаров'];
const fem = (last: string) => last.endsWith('ий') ? last.slice(0, -2) + 'ая' : last + 'а';
/** i-е уникальное сочетание имени и фамилии (до 20 × 25 × 2 = 1000 человек). */
function personName(i: number): string {
  const f = i % 2 === 0, k = Math.floor(i / 2);
  const first = (f ? FIRST_F : FIRST_M)[k % 20];
  const last = LAST[Math.floor(k / 20) % LAST.length];
  return `${first} ${f ? fem(last) : last}`;
}
const PHRASES = [
  'Привет!', 'Как дела?', 'Отлично, спасибо', 'Созвонимся вечером?', 'Давай после семи', 'Скинь, пожалуйста, адрес',
  'Уже выезжаю', 'Буду через 10 минут', 'Ок 👍', 'Хорошо', 'Договорились', 'Посмотрю завтра утром', 'Спасибо большое!',
  'Ты видел новости?', 'Да, уже читал', 'Сколько стоит?', 'Скинул в почту', 'Где встречаемся?', 'У входа в метро',
  'Опаздываю немного', 'Не вопрос', 'Можешь перезвонить?', 'Сейчас на встрече', 'Напишу позже', 'Ага', 'С днём рождения! 🎉',
  'Спасибо, очень приятно', 'Отправил фото', 'Красиво получилось', 'Когда будет готово?', 'К пятнице сделаю', 'Супер',
  'Нужна помощь с переездом в субботу', 'Помогу, во сколько?', 'Часов в 11', 'Купи хлеба по дороге', 'Уже купил',
  'Собрание жильцов в четверг в 19:00', 'Кто придёт?', 'Я буду', 'Счётчики сдаём до 25-го', 'Принято',
  'Посмотри PR, пожалуйста', 'Оставил пару комментариев', 'Поправил, глянь ещё раз', 'Мёржим', 'Деплой прошёл',
  'Можно перенести на завтра?', 'Да, без проблем', 'Как добрался?', 'Всё хорошо, уже дома', 'Хорошего вечера!',
];
const GROUP_TITLES = ['Команда frontend', 'Блок 5', 'Семья', 'Дизайн-ревью', 'Bun meetup', 'Друзья', 'Работа', 'Бег по утрам', 'Родительский чат 3«Б»', 'Поездка в Казань', 'Книжный клуб', 'Футбол по средам', 'Соседи', 'Маркетинг', 'Продукт', 'Однокурсники', 'Настолки', 'Ремонт', 'Велопокатушки', 'Кино в пятницу'];

async function reset() {
  await sql`truncate users, sessions, chats, chat_members, messages, user_seq, updates restart identity cascade`;
}

async function insertUsers(names: string[]): Promise<number[]> {
  // «был(а) …»: чаще недавно, иногда несколько дней назад
  const lastSeen = () => new Date(Date.now() - rnd() ** 2 * 6 * 86_400_000 - 120_000);
  const rows = await sql`insert into users ${sql(names.map((name) => ({ name, last_seen_at: lastSeen() })))} returning id`;
  return rows.map((r) => r.id as number);
}

type Msg = { chat_id: number; sender_id: number; client_id: string; body: string; created_at: Date };

async function main() {
  const t0 = Date.now();
  if (process.argv.includes('--reset')) await reset();

  // все имена уникальны: вход по имени однозначен
  const all = Array.from({ length: OWNERS + CHATS + 200 }, (_, i) => personName(i));
  const ownerNames = ['Анна Смирнова', ...all.filter((n) => n !== 'Анна Смирнова').slice(0, OWNERS - 1)];
  const owners = await insertUsers(ownerNames);
  const contacts = await insertUsers(all.filter((n) => !ownerNames.includes(n)).slice(0, CHATS + 200));
  console.log(`users: ${owners.length} owners + ${contacts.length} contacts`);

  const now = Date.now();
  let chatCount = 0, msgCount = 0;
  let batch: Msg[] = [];
  const flushMessages = async () => {
    if (!batch.length) return;
    await sql`insert into messages ${sql(batch, 'chat_id', 'sender_id', 'client_id', 'body', 'created_at')}`;
    msgCount += batch.length;
    batch = [];
  };

  for (const owner of owners) {
    // личные чаты: 500 разных собеседников
    const pool = [...contacts].sort(() => rnd() - 0.5).slice(0, CHATS);
    const direct = await sql`insert into chats ${sql(pool.map(() => ({ kind: 'direct' })))} returning id`;
    const groups = await sql`insert into chats ${sql(Array.from({ length: GROUPS }, (_, g) => ({ kind: 'group', title: GROUP_TITLES[g % GROUP_TITLES.length] })))} returning id`;
    const members: { chat_id: number; user_id: number }[] = [];
    const plan: { chatId: number; people: number[] }[] = [];
    direct.forEach((c, i) => { members.push({ chat_id: c.id, user_id: owner }, { chat_id: c.id, user_id: pool[i] }); plan.push({ chatId: c.id, people: [owner, pool[i]] }); });
    for (const g of groups) {
      const people = [owner, ...Array.from({ length: int(3, 9) }, () => pick(contacts))].filter((v, i, a) => a.indexOf(v) === i);
      for (const u of people) members.push({ chat_id: g.id, user_id: u });
      plan.push({ chatId: g.id, people });
    }
    await sql`insert into chat_members ${sql(members)}`;
    chatCount += plan.length;

    // сообщения: последнее время у каждого чата своё, разброс 90 дней
    for (const { chatId, people } of plan) {
      // последнее сообщение — в случайной точке последних 90 дней (свежие чаты встречаются чаще)
      const n = int(3, 60);
      const lastAt = now - Math.floor(rnd() ** 1.6 * 90 * 86400_000) - int(2, 90) * 60_000;
      const gaps = Array.from({ length: n }, () => int(15, 4 * 3600) * 1000);
      let t = lastAt - gaps.reduce((a, b) => a + b, 0);
      for (let k = 0; k < n; k++) {
        t += gaps[k];
        batch.push({ chat_id: chatId, sender_id: k % 2 === 0 ? pick(people.slice(1)) : (rnd() < 0.6 ? owner : pick(people)), client_id: crypto.randomUUID(), body: pick(PHRASES), created_at: new Date(t) });
      }
      if (batch.length >= 5000) await flushMessages();
    }
    await flushMessages();
    process.stdout.write('.');
  }
  console.log();

  // прочтение: по умолчанию всё прочитано; в ~15% чатов последние 1–20 сообщений не прочитаны владельцем
  await sql`
    update chat_members cm set last_read_id = coalesce(x.read_to, 0)
      from (
        select m.chat_id, cm2.user_id,
               case when random() < 0.15
                    then (select id from messages m3 where m3.chat_id = m.chat_id order by id desc offset (1 + floor(random() * 20))::int limit 1)
                    else max(m.id) end as read_to
          from messages m join chat_members cm2 on cm2.chat_id = m.chat_id
         group by m.chat_id, cm2.user_id
      ) x
     where cm.chat_id = x.chat_id and cm.user_id = x.user_id`;

  console.log(`chats: ${chatCount}, messages: ${msgCount}, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`вход: имя «${ownerNames[0]}» (или любое из ${ownerNames.slice(1, 4).map((n) => `«${n}»`).join(', ')}…)`);
}

await main();
await sql.end();
