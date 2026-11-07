import { describe, expect, test } from 'bun:test';
import { lintFile, lintSql } from './migration-lint';

const rules = (sql: string) => lintSql(sql).map((p) => p.rule);

describe('migration lint', () => {
  test('additive changes pass', () => {
    expect(rules(`create table t (id bigint primary key, name text not null);
      alter table chats add column muted boolean not null default false;
      alter table chats add column note text, add constraint c check (note is not null or true);
      alter table chats alter column note drop not null, alter column muted drop default;
      create index concurrently if not exists i on chats (note);`)).toEqual([]);
  });

  test('drop, rename, not null without default fail', () => {
    expect(rules('drop table chats')).toEqual(['drop']);
    expect(rules('alter table chats drop column note')).toEqual(['drop']);
    expect(rules('alter table chats drop note')).toEqual(['drop']);
    expect(rules('drop index if exists i')).toEqual(['drop']);
    expect(rules('alter table chats rename column a to b')).toEqual(['rename']);
    expect(rules('alter table chats add column x int not null')).toEqual(['not-null']);
    expect(rules('alter table chats add x int, add y int not null')).toEqual(['not-null']);
    expect(rules('alter table chats alter column x set not null')).toEqual(['not-null']);
  });

  test('comments, strings and function bodies are ignored', () => {
    expect(rules(`-- drop table chats
      /* rename */ insert into notes values ('drop table x; rename');
      create function f() returns void language plpgsql as $$ begin execute 'drop table y'; end $$;
      create function g() returns void language plpgsql as $body$ begin drop table z; end $body$;`)).toEqual([]);
  });

  test('marker comment allows listed rules only', () => {
    const sql = '-- migration-lint: allow drop — column unused since v12\nalter table chats drop column a; alter table chats rename a to b;';
    expect(lintFile(sql).map((p) => p.rule)).toEqual(['rename']);
    expect(lintFile('-- migration-lint: allow drop, rename\n' + sql)).toEqual([]);
  });

  test('editing an existing migration fails unless allowed', () => {
    expect(lintFile('create table t (id int)', true).map((p) => p.rule)).toEqual(['edited']);
    expect(lintFile('-- migration-lint: allow edited\ncreate table t (id int)', true)).toEqual([]);
  });
});
