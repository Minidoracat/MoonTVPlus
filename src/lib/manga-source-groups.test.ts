import {
  getMangaSourceCategories,
  getMangaSourceCategory,
  pickDefaultMangaSourceId,
  rememberMangaSourceId,
  sourcesInCategory,
} from '@/lib/manga-source-groups';
import type { MangaSource, MangaSourceProbeSummary } from '@/lib/manga.types';
import { isSuwayomiUnknownFieldError } from '@/lib/suwayomi-errors';

function source(
  name: string,
  extras: Partial<MangaSource> = {}
): MangaSource {
  return { id: extras.id || name, name, ...extras };
}

describe('getMangaSourceCategory', () => {
  it('maps NSFW to adult', () => {
    expect(
      getMangaSourceCategory(source('Random Site', { contentWarning: 'NSFW' }))
    ).toBe('adult');
  });

  it('keeps MIXED adult-named sources in adult', () => {
    expect(
      getMangaSourceCategory(source('18漫画', { contentWarning: 'MIXED' }))
    ).toBe('adult');
    expect(
      getMangaSourceCategory(source('TOPTOON頂通', { contentWarning: 'MIXED' }))
    ).toBe('adult');
  });

  it('keeps mainstream MIXED sources in mixed', () => {
    expect(
      getMangaSourceCategory(source('嗶哩漫畫', { contentWarning: 'MIXED' }))
    ).toBe('mixed');
    expect(
      getMangaSourceCategory(source('漫画柜', { contentWarning: 'MIXED' }))
    ).toBe('mixed');
  });

  it('maps SAFE only when warning is SAFE', () => {
    expect(
      getMangaSourceCategory(source('包子漫画', { contentWarning: 'SAFE' }))
    ).toBe('safe');
  });

  it('maps missing contentWarning without adult names to mixed', () => {
    expect(getMangaSourceCategory(source('崩坏3'))).toBe('mixed');
  });
});

describe('getMangaSourceCategories', () => {
  it('labels chips from contentWarning counts and omits empty groups', () => {
    const sources = [
      source('safe-1', { contentWarning: 'SAFE' }),
      source('mixed-1', { contentWarning: 'MIXED' }),
      source('adult-1', { contentWarning: 'NSFW' }),
    ];
    expect(getMangaSourceCategories(sources, [])).toEqual([
      { id: 'all', label: '全部 3' },
      { id: 'safe', label: '一般 1' },
      { id: 'mixed', label: '混合 1' },
      { id: 'adult', label: '成人 1' },
    ]);
  });
});

describe('sourcesInCategory', () => {
  it('orders recent sources by recency', () => {
    const sources = [source('A', { id: 'a' }), source('B', { id: 'b' })];
    expect(
      sourcesInCategory(sources, 'recent', ['b', 'a']).map((item) => item.id)
    ).toEqual(['b', 'a']);
  });
});

describe('pickDefaultMangaSourceId', () => {
  const sources = [
    source('包子漫画', { contentWarning: 'SAFE' }),
    source('GoDa', { contentWarning: 'SAFE' }),
    source('崩坏3'),
    source('禁漫天堂', { contentWarning: 'NSFW' }),
  ];
  const failing = (ok: boolean): MangaSourceProbeSummary =>
    ({ popularOk: ok, popularMs: 1, searchOk: ok, searchMs: 1 } as MangaSourceProbeSummary);

  it('最近選過且仍存在的來源優先，即使是成人源', () => {
    expect(pickDefaultMangaSourceId(sources, {}, ['已移除', '禁漫天堂', 'GoDa'])).toBe('禁漫天堂');
  });

  it('跳過上次測試熱門失敗的一般源', () => {
    expect(pickDefaultMangaSourceId(sources, { 包子漫画: failing(false) }, [])).toBe('GoDa');
  });

  it('一般源全壞時改用健康的混合源，全部都壞才退回第一個一般源', () => {
    const allSafeBad = { 包子漫画: failing(false), GoDa: failing(false) };
    expect(pickDefaultMangaSourceId(sources, allSafeBad, [])).toBe('崩坏3');
    expect(
      pickDefaultMangaSourceId(sources, { ...allSafeBad, 崩坏3: failing(false) }, [])
    ).toBe('包子漫画');
  });
});

describe('rememberMangaSourceId', () => {
  const store: Record<string, string> = {};
  const original = window.localStorage;

  beforeEach(() => {
    Object.keys(store).forEach((key) => delete store[key]);
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => store[key] ?? null,
        setItem: (key: string, value: string) => {
          store[key] = value;
        },
      },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: original,
    });
  });

  it('dedupes and keeps the newest source first', () => {
    expect(rememberMangaSourceId('a')).toEqual(['a']);
    expect(rememberMangaSourceId('b')).toEqual(['b', 'a']);
    expect(rememberMangaSourceId('a')).toEqual(['a', 'b']);
  });

  it('still returns the next order when setItem throws', () => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: () => null,
        setItem: () => {
          throw new Error('quota');
        },
      },
    });
    expect(rememberMangaSourceId('x')).toEqual(['x']);
  });
});

describe('isSuwayomiUnknownFieldError', () => {
  it('detects GraphQL unknown-field validation errors', () => {
    expect(
      isSuwayomiUnknownFieldError(
        new Error("Validation error (FieldUndefined@[sources/nodes/contentWarning])")
      )
    ).toBe(true);
    expect(isSuwayomiUnknownFieldError(new Error('Cannot query field "contentWarning"'))).toBe(
      true
    );
  });

  it('does not treat network or generic GraphQL errors as schema fallback', () => {
    expect(isSuwayomiUnknownFieldError(new Error('Suwayomi 请求失败: 502'))).toBe(false);
    expect(isSuwayomiUnknownFieldError(new Error('Suwayomi 返回空数据'))).toBe(false);
  });
});
