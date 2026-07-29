import { DoubanResult } from './types';

/** 官方 Top 10 的地区：GLOBAL_* 是 global 档的英语/非英语两份榜，其余是 ISO-3166 alpha-2 */
export const NETFLIX_TOP10_REGIONS: { label: string; value: string }[] = [
  { label: '台湾', value: 'TW' }, // 默认
  { label: '全球·英语', value: 'GLOBAL_EN' },
  { label: '全球·非英语', value: 'GLOBAL_NONEN' },
  { label: '香港', value: 'HK' },
  { label: '日本', value: 'JP' },
  { label: '韩国', value: 'KR' },
  { label: '美国', value: 'US' },
  { label: '英国', value: 'GB' },
  { label: '新加坡', value: 'SG' },
  { label: '马来西亚', value: 'MY' },
  { label: '泰国', value: 'TH' },
  { label: '越南', value: 'VN' },
];

export const NETFLIX_TOP10_DEFAULT_REGION = 'TW';

export type NetflixTop10Kind = 'films' | 'tv';

/** 单周单地区单类别的一列榜单（Tudum TSV 原始资料，片名是英文） */
export interface NetflixTop10Row {
  rank: number;
  showTitle: string;
  seasonTitle?: string; // 'N/A' 已剔除
  weeksInTop10: number;
}

/** 一周的完整快照：region -> { films: [...], tv: [...] }，rank 升序 */
export interface NetflixWeekSnapshot {
  week: string;
  regions: Record<string, Record<NetflixTop10Kind, NetflixTop10Row[]>>;
}

export interface NetflixTop10Manifest {
  weeks: string[]; // 新 -> 旧
  latestWeek: string;
  regions: string[]; // 实际有资料的地区，用于收敛地区选单
  countriesOk?: boolean; // false 代表上轮 31MB 各国榜没抓成，下轮 cron 要重试
  updatedAt: number;
  checkedAt: number; // 上次尝试（含失败），用于退避
}

export interface NetflixTop10Result extends DoubanResult {
  week: string; // 实际返回的周（YYYY-MM-DD，周日）
  weeks: string[]; // 可选周次，新 -> 旧
  regions?: string[]; // 实际有资料的地区；各国榜没抓成时只剩两个全球榜
  pending?: boolean; // 冷启动尚未回填
}

/** 请求 /api/netflix/top10（客户端使用），形状对齐 fetchTMDBHot */
export async function fetchNetflixTop10(params: {
  region: string;
  kind: 'films' | 'tv';
  week?: string;
}): Promise<NetflixTop10Result> {
  const q = new URLSearchParams({ region: params.region, kind: params.kind });
  if (params.week) q.set('week', params.week);
  const response = await fetch(`/api/netflix/top10?${q.toString()}`);
  if (!response.ok) {
    throw new Error(`HTTP error! Status: ${response.status}`);
  }
  return response.json();
}
