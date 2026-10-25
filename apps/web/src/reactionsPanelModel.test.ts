import { describe, expect, test } from 'bun:test';
import type { ReactionAsset } from '@relay/protocol';
import { moveFocus, panelPosition, panelSections, PANEL_H, PANEL_W, TOP_COUNT } from './reactionsPanelModel';

const asset = (key: string, title = key): ReactionAsset => ({ key, title, inactive: false, static: `/rx/${key}/s.webp`, appear: '', select: '', center: null, around: null });
const catalog = ['❤', '👍', '👎', '🔥', '🥰', '👏', '😁', '🤔', '🤯', '😱', '🤬', '😢', '🎉', '🤩', '🤮', '💩', '🙏', '👌', '🕊', '🤡'].map((k) => asset(k, 'Title ' + k));

describe('panelSections', () => {
  test('первая секция — быстрый порядок без заголовка, затем «Часто используемые» без дублей', () => {
    const quick = ['🔥', '❤', '🔥', '🚀'];   // дубль и неизвестный — мимо
    const s = panelSections(catalog, quick, {});
    expect(s[0].title).toBeUndefined();
    expect(s[0].items.map((r) => r.key)).toEqual(['🔥', '❤']);
    expect(s[1].title).toBe('Часто используемые');
    expect(s[1].items.length).toBe(catalog.length - 2);
    expect(s[1].items.some((r) => r.key === '🔥')).toBe(false);
  });
  test('не больше TOP_COUNT в первой секции', () => {
    const s = panelSections(catalog, catalog.map((r) => r.key), {});
    expect(s[0].items.length).toBe(TOP_COUNT);
    expect(s[1].items.length).toBe(catalog.length - TOP_COUNT);
  });
  test('allowed («некоторые», в любой форме записи) ограничивает всё, одна секция', () => {
    const s = panelSections(catalog, ['👍'], { allowed: ['❤️', '👍'] });
    expect(s.length).toBe(1);
    expect(s[0].items.map((r) => r.key)).toEqual(['👍', '❤']);
  });
  test('категория — пересечение с каталогом', () => {
    const s = panelSections(catalog, [], { category: ['❤️', '🧡', '🥰'] });
    expect(s[0].items.map((r) => r.key)).toEqual(['❤', '🥰']);
  });
  test('текст — найденные эмодзи плюс название латиницей', () => {
    const s = panelSections(catalog, [], { q: 'title 🤡', found: ['🔥'] });
    expect(s[0].items.map((r) => r.key)).toEqual(['🔥', '🤡']);
    expect(panelSections(catalog, [], { q: 'zzz', found: [] })[0].items).toEqual([]);
  });
});

describe('panelPosition', () => {
  test('от панели влево 10.5 и вверх 60.5', () => {
    expect(panelPosition({ left: 300, top: 400 }, 1280, 900)).toEqual({ left: 290, top: 340, width: PANEL_W });
  });
  test('зажим в экран с полями 8', () => {
    expect(panelPosition({ left: 1200, top: 20 }, 1280, 900)).toEqual({ left: 1280 - PANEL_W - 8, top: 8, width: PANEL_W });
    expect(panelPosition({ left: 0, top: 880 }, 1280, 900).top).toBe(900 - PANEL_H - 8);
  });
  test('узкий экран — во всю ширину с полями', () => {
    expect(panelPosition({ left: 100, top: 300 }, 375, 700)).toEqual({ left: 8, top: 240, width: 375 - 16 });
  });
});

test('moveFocus — стрелки по сетке с зажимом', () => {
  expect(moveFocus(0, 'ArrowRight', 8, 20)).toBe(1);
  expect(moveFocus(0, 'ArrowLeft', 8, 20)).toBe(0);
  expect(moveFocus(3, 'ArrowDown', 8, 20)).toBe(11);
  expect(moveFocus(17, 'ArrowDown', 8, 20)).toBe(19);
  expect(moveFocus(11, 'ArrowUp', 8, 20)).toBe(3);
  expect(moveFocus(5, 'Enter', 8, 20)).toBe(5);
  expect(moveFocus(0, 'ArrowRight', 8, 0)).toBe(-1);
});
