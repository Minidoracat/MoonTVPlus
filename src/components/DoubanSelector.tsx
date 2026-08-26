/* eslint-disable react-hooks/exhaustive-deps */

'use client';

import React, { useEffect, useRef, useState } from 'react';

import {
  NETFLIX_TOP10_DEFAULT_REGION,
  NETFLIX_TOP10_REGIONS,
} from '@/lib/netflix.client';

import MultiLevelSelector from './MultiLevelSelector';
import WeekdaySelector from './WeekdaySelector';

interface SelectorOption {
  label: string;
  value: string;
}

interface DoubanSelectorProps {
  type: 'movie' | 'tv' | 'show' | 'anime';
  primarySelection?: string;
  secondarySelection?: string;
  showTmdbHot?: boolean;
  netflixWeeks?: string[]; // 官方周榜可选周次，由 /api/netflix/top10 回传
  netflixRegions?: string[]; // 实际有资料的地区；各国榜没抓成时只剩两个全球榜
  onPrimaryChange: (value: string) => void;
  onSecondaryChange: (value: string) => void;
  onMultiLevelChange?: (values: Record<string, string>) => void;
  onWeekdayChange: (weekday: string) => void;
  /** 「每日放送」的展示视图：卡片网格 / 时刻表时间轴 */
  viewMode?: 'grid' | 'schedule';
  onViewModeChange?: (viewMode: 'grid' | 'schedule') => void;
}

// TMDB 热门的一级选项与时间窗二级选项（电影/电视剧共用）
export const TMDB_HOT_PRIMARY = 'tmdb-hot';
export const TMDB_HOT_WINDOW_OPTIONS: SelectorOption[] = [
  { label: '今日', value: 'day' },
  { label: '本周', value: 'week' },
];

// Netflix 一级选项（电影页与剧集页共用）。二级是资料源：豆瓣热度 / 官方周榜。
// 加 -hot 后缀是为了与 MultiLevelSelector 平台筛选栏的 'netflix' 区分：两者语义不同，
// 会同时出现在电影页，同名容易让人误以为是同一个状态
export const NETFLIX_PRIMARY = 'netflix-hot';

// Netflix 二级：资料源 +（官方周榜时）地区、周次。
// 三个维度编码进 secondarySelection 一个字串，而不是在 douban/page 新增两个 state：
// 那样得同步 currentParamsRef、isSnapshotEqual 与三处依赖阵列共 5 个点，
// 漏一处就会写入过期资料。
// 注意：Netflix 模式下 secondarySelection 不是单纯字串，一律走 parse/build 收口，
// 不可在别处直接做 `secondarySelection === '全部'` 之类的字串比对。
export const NETFLIX_SOURCE_DOUBAN = 'douban-hot';
export const NETFLIX_SOURCE_OFFICIAL = 'official-top10';

export const NETFLIX_SOURCE_OPTIONS: SelectorOption[] = [
  { label: '豆瓣热度', value: NETFLIX_SOURCE_DOUBAN },
  { label: '官方周榜', value: NETFLIX_SOURCE_OFFICIAL },
];

export function parseNetflixSecondary(value?: string) {
  const [source, region, week] = (value || '').split(':');
  return {
    // 非法/残留值（如切换分类时留下的 '全部'）一律按豆瓣热度处理
    source:
      source === NETFLIX_SOURCE_OFFICIAL
        ? NETFLIX_SOURCE_OFFICIAL
        : NETFLIX_SOURCE_DOUBAN,
    region: region || NETFLIX_TOP10_DEFAULT_REGION,
    week: week || '', // 空 = 最新一周，由服务端解析成实际周次
  };
}

export function buildNetflixSecondary(
  source: string,
  region: string,
  week: string
) {
  return source === NETFLIX_SOURCE_OFFICIAL
    ? `${NETFLIX_SOURCE_OFFICIAL}:${region}:${week}`
    : NETFLIX_SOURCE_DOUBAN;
}

const DoubanSelector: React.FC<DoubanSelectorProps> = ({
  type,
  primarySelection,
  secondarySelection,
  showTmdbHot = false,
  netflixWeeks = [],
  netflixRegions = [],
  onPrimaryChange,
  onSecondaryChange,
  onMultiLevelChange,
  onWeekdayChange,
  viewMode = 'grid',
  onViewModeChange,
}) => {
  // 为不同的选择器创建独立的refs和状态
  const primaryContainerRef = useRef<HTMLDivElement>(null);
  const primaryButtonRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [primaryIndicatorStyle, setPrimaryIndicatorStyle] = useState<{
    left: number;
    width: number;
  }>({ left: 0, width: 0 });

  const secondaryContainerRef = useRef<HTMLDivElement>(null);
  const secondaryButtonRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [secondaryIndicatorStyle, setSecondaryIndicatorStyle] = useState<{
    left: number;
    width: number;
  }>({ left: 0, width: 0 });

  // 电影的一级选择器选项
  const moviePrimaryOptions: SelectorOption[] = [
    { label: '全部', value: '全部' },
    { label: '热门电影', value: '热门' },
    { label: '最新电影', value: '最新' },
    { label: '豆瓣高分', value: '豆瓣高分' },
    { label: '冷门佳片', value: '冷门佳片' },
    { label: 'Netflix', value: NETFLIX_PRIMARY },
    ...(showTmdbHot
      ? [{ label: 'TMDB热门', value: TMDB_HOT_PRIMARY }]
      : []),
  ];

  // 电影的二级选择器选项
  const movieSecondaryOptions: SelectorOption[] = [
    { label: '全部', value: '全部' },
    { label: '华语', value: '华语' },
    { label: '欧美', value: '欧美' },
    { label: '韩国', value: '韩国' },
    { label: '日本', value: '日本' },
  ];

  // 电视剧一级选择器选项
  const tvPrimaryOptions: SelectorOption[] = [
    { label: '全部', value: '全部' },
    { label: '最近热门', value: '最近热门' },
    { label: 'Netflix', value: NETFLIX_PRIMARY },
    ...(showTmdbHot
      ? [{ label: 'TMDB热门', value: TMDB_HOT_PRIMARY }]
      : []),
  ];

  // 电视剧二级选择器选项
  const tvSecondaryOptions: SelectorOption[] = [
    { label: '全部', value: 'tv' },
    { label: '国产', value: 'tv_domestic' },
    { label: '欧美', value: 'tv_american' },
    { label: '日本', value: 'tv_japanese' },
    { label: '韩国', value: 'tv_korean' },
    { label: '动漫', value: 'tv_animation' },
    { label: '纪录片', value: 'tv_documentary' },
  ];

  // 综艺一级选择器选项
  const showPrimaryOptions: SelectorOption[] = [
    { label: '全部', value: '全部' },
    { label: '最近热门', value: '最近热门' },
  ];

  // 综艺二级选择器选项
  const showSecondaryOptions: SelectorOption[] = [
    { label: '全部', value: 'show' },
    { label: '国内', value: 'show_domestic' },
    { label: '国外', value: 'show_foreign' },
  ];

  // 动漫一级选择器选项
  const animePrimaryOptions: SelectorOption[] = [
    { label: '每日放送', value: '每日放送' },
    { label: '番剧', value: '番剧' },
    { label: '剧场版', value: '剧场版' },
  ];

  // 「每日放送」视图切换选项
  const viewOptions: SelectorOption[] = [
    { label: '卡片', value: 'grid' },
    { label: '时刻表', value: 'schedule' },
  ];

  // 处理多级选择器变化
  const handleMultiLevelChange = (values: Record<string, string>) => {
    onMultiLevelChange?.(values);
  };

  // 更新指示器位置的通用函数
  const updateIndicatorPosition = (
    activeIndex: number,
    containerRef: React.RefObject<HTMLDivElement>,
    buttonRefs: React.MutableRefObject<(HTMLButtonElement | null)[]>,
    setIndicatorStyle: React.Dispatch<
      React.SetStateAction<{ left: number; width: number }>
    >
  ) => {
    if (
      activeIndex >= 0 &&
      buttonRefs.current[activeIndex] &&
      containerRef.current
    ) {
      const timeoutId = setTimeout(() => {
        const button = buttonRefs.current[activeIndex];
        const container = containerRef.current;
        if (button && container) {
          const buttonRect = button.getBoundingClientRect();
          const containerRect = container.getBoundingClientRect();

          if (buttonRect.width > 0) {
            setIndicatorStyle({
              left: buttonRect.left - containerRect.left,
              width: buttonRect.width,
            });
          }
        }
      }, 0);
      return () => clearTimeout(timeoutId);
    }
  };

  // 组件挂载时立即计算初始位置
  useEffect(() => {
    // 主选择器初始位置
    if (type === 'movie') {
      const activeIndex = moviePrimaryOptions.findIndex(
        (opt) =>
          opt.value === (primarySelection || moviePrimaryOptions[0].value)
      );
      updateIndicatorPosition(
        activeIndex,
        primaryContainerRef,
        primaryButtonRefs,
        setPrimaryIndicatorStyle
      );
    } else if (type === 'tv') {
      const activeIndex = tvPrimaryOptions.findIndex(
        (opt) => opt.value === (primarySelection || tvPrimaryOptions[1].value)
      );
      updateIndicatorPosition(
        activeIndex,
        primaryContainerRef,
        primaryButtonRefs,
        setPrimaryIndicatorStyle
      );
    } else if (type === 'anime') {
      const activeIndex = animePrimaryOptions.findIndex(
        (opt) =>
          opt.value === (primarySelection || animePrimaryOptions[0].value)
      );
      updateIndicatorPosition(
        activeIndex,
        primaryContainerRef,
        primaryButtonRefs,
        setPrimaryIndicatorStyle
      );
    } else if (type === 'show') {
      const activeIndex = showPrimaryOptions.findIndex(
        (opt) => opt.value === (primarySelection || showPrimaryOptions[1].value)
      );
      updateIndicatorPosition(
        activeIndex,
        primaryContainerRef,
        primaryButtonRefs,
        setPrimaryIndicatorStyle
      );
    }

    // 副选择器初始位置
    let secondaryActiveIndex = -1;
    if (type === 'movie') {
      secondaryActiveIndex = movieSecondaryOptions.findIndex(
        (opt) =>
          opt.value === (secondarySelection || movieSecondaryOptions[0].value)
      );
    } else if (type === 'tv') {
      secondaryActiveIndex = tvSecondaryOptions.findIndex(
        (opt) =>
          opt.value === (secondarySelection || tvSecondaryOptions[0].value)
      );
    } else if (type === 'show') {
      secondaryActiveIndex = showSecondaryOptions.findIndex(
        (opt) =>
          opt.value === (secondarySelection || showSecondaryOptions[0].value)
      );
    }

    if (secondaryActiveIndex >= 0) {
      updateIndicatorPosition(
        secondaryActiveIndex,
        secondaryContainerRef,
        secondaryButtonRefs,
        setSecondaryIndicatorStyle
      );
    }
  }, [type]); // 只在type变化时重新计算

  // 监听主选择器变化
  useEffect(() => {
    if (type === 'movie') {
      const activeIndex = moviePrimaryOptions.findIndex(
        (opt) => opt.value === primarySelection
      );
      const cleanup = updateIndicatorPosition(
        activeIndex,
        primaryContainerRef,
        primaryButtonRefs,
        setPrimaryIndicatorStyle
      );
      return cleanup;
    } else if (type === 'tv') {
      const activeIndex = tvPrimaryOptions.findIndex(
        (opt) => opt.value === primarySelection
      );
      const cleanup = updateIndicatorPosition(
        activeIndex,
        primaryContainerRef,
        primaryButtonRefs,
        setPrimaryIndicatorStyle
      );
      return cleanup;
    } else if (type === 'anime') {
      const activeIndex = animePrimaryOptions.findIndex(
        (opt) => opt.value === primarySelection
      );
      const cleanup = updateIndicatorPosition(
        activeIndex,
        primaryContainerRef,
        primaryButtonRefs,
        setPrimaryIndicatorStyle
      );
      return cleanup;
    } else if (type === 'show') {
      const activeIndex = showPrimaryOptions.findIndex(
        (opt) => opt.value === primarySelection
      );
      const cleanup = updateIndicatorPosition(
        activeIndex,
        primaryContainerRef,
        primaryButtonRefs,
        setPrimaryIndicatorStyle
      );
      return cleanup;
    }
  }, [primarySelection]);

  // 监听副选择器变化
  useEffect(() => {
    let activeIndex = -1;
    let options: SelectorOption[] = [];

    if (primarySelection === NETFLIX_PRIMARY) {
      // Netflix 二级是资料源胶囊；地区/周次走原生 select，不参与指示器
      options = NETFLIX_SOURCE_OPTIONS;
      activeIndex = options.findIndex(
        (opt) => opt.value === parseNetflixSecondary(secondarySelection).source
      );
    } else if (primarySelection === TMDB_HOT_PRIMARY) {
      // TMDB 热门模式下二级是时间窗选项，不是豆瓣地区/类型
      activeIndex = TMDB_HOT_WINDOW_OPTIONS.findIndex(
        (opt) => opt.value === secondarySelection
      );
      options = TMDB_HOT_WINDOW_OPTIONS;
    } else if (type === 'movie') {
      activeIndex = movieSecondaryOptions.findIndex(
        (opt) => opt.value === secondarySelection
      );
      options = movieSecondaryOptions;
    } else if (type === 'tv') {
      activeIndex = tvSecondaryOptions.findIndex(
        (opt) => opt.value === secondarySelection
      );
      options = tvSecondaryOptions;
    } else if (type === 'show') {
      activeIndex = showSecondaryOptions.findIndex(
        (opt) => opt.value === secondarySelection
      );
      options = showSecondaryOptions;
    }

    if (options.length > 0) {
      const cleanup = updateIndicatorPosition(
        activeIndex,
        secondaryContainerRef,
        secondaryButtonRefs,
        setSecondaryIndicatorStyle
      );
      return cleanup;
    }
    // showTmdbHot 会决定 Netflix「榜单」列渲不渲染，翻转时指示器要重算
  }, [secondarySelection, primarySelection, showTmdbHot]);

  // 监听「每日放送」视图切换（卡片/时刻表）——
  // 视图胶囊复用副选择器的滑动指示器，需要单独定位
  useEffect(() => {
    const activeIndex = viewOptions.findIndex(
      (opt) => opt.value === viewMode
    );
    const cleanup = updateIndicatorPosition(
      activeIndex,
      secondaryContainerRef,
      secondaryButtonRefs,
      setSecondaryIndicatorStyle
    );
    return cleanup;
  }, [viewMode, primarySelection]);

  // 渲染胶囊式选择器
  const renderCapsuleSelector = (
    options: SelectorOption[],
    activeValue: string | undefined,
    onChange: (value: string) => void,
    isPrimary = false
  ) => {
    const containerRef = isPrimary
      ? primaryContainerRef
      : secondaryContainerRef;
    const buttonRefs = isPrimary ? primaryButtonRefs : secondaryButtonRefs;
    const indicatorStyle = isPrimary
      ? primaryIndicatorStyle
      : secondaryIndicatorStyle;

    return (
      <div
        ref={containerRef}
        className='relative inline-flex bg-gray-200/60 rounded-full p-0.5 sm:p-1 dark:bg-gray-700/60 backdrop-blur-sm'
      >
        {/* 滑动的白色背景指示器 */}
        {indicatorStyle.width > 0 && (
          <div
            className='absolute top-0.5 bottom-0.5 sm:top-1 sm:bottom-1 bg-white dark:bg-gray-500 rounded-full shadow-sm transition-all duration-300 ease-out'
            style={{
              left: `${indicatorStyle.left}px`,
              width: `${indicatorStyle.width}px`,
            }}
          />
        )}

        {options.map((option, index) => {
          const isActive = activeValue === option.value;
          return (
            <button
              key={option.value}
              ref={(el) => {
                buttonRefs.current[index] = el;
              }}
              onClick={() => onChange(option.value)}
              className={`relative z-10 px-2 py-1 sm:px-4 sm:py-2 text-xs sm:text-sm font-medium rounded-full transition-all duration-200 whitespace-nowrap ${
                isActive
                  ? 'text-gray-900 dark:text-gray-100 cursor-default'
                  : 'text-gray-700 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100 cursor-pointer'
              }`}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    );
  };

  // 原生 select 免掉第三组 ref/indicator state；265 个周次原生元件完全撑得住
  const netflixSelectClass =
    'rounded-full bg-gray-200/60 dark:bg-gray-700/60 backdrop-blur-sm px-2 py-1 sm:px-4 sm:py-2 text-xs sm:text-sm font-medium text-gray-900 dark:text-gray-100 outline-none cursor-pointer';

  const renderNetflixSecondary = () => {
    const { source, region, week } = parseNetflixSecondary(secondarySelection);
    // ponytail: 265 项做 O(n×年数) 过滤，够用；资料量再涨才需要预分组
    const years = Array.from(new Set(netflixWeeks.map((w) => w.slice(0, 4))));

    return (
      <>
        {/* 无 TMDB Key 时官方周榜没有海报与中文名，只剩「豆瓣热度」一个选项，
            渲染成单选项切换器徒增困惑，整列不渲染 */}
        {showTmdbHot && (
          <div className='flex flex-col sm:flex-row sm:items-center gap-2'>
            <span className='text-xs sm:text-sm font-medium text-gray-600 dark:text-gray-400 min-w-[48px]'>
              榜单
            </span>
            <div className='overflow-x-auto'>
              {renderCapsuleSelector(
                NETFLIX_SOURCE_OPTIONS,
                source,
                (value) =>
                  onSecondaryChange(buildNetflixSecondary(value, region, week)),
                false
              )}
            </div>
          </div>
        )}

        {source === NETFLIX_SOURCE_OFFICIAL && (
          <div className='flex flex-col sm:flex-row sm:items-center gap-2'>
            <span className='text-xs sm:text-sm font-medium text-gray-600 dark:text-gray-400 min-w-[48px]'>
              地区
            </span>
            <div className='flex items-center gap-2 flex-wrap'>
              <select
                aria-label='地区'
                value={region}
                onChange={(e) =>
                  // 切地区时把周次重设为最新：不同地区的资料覆盖不完全一致
                  onSecondaryChange(
                    buildNetflixSecondary(source, e.target.value, '')
                  )
                }
                className={netflixSelectClass}
              >
                {/* 只列出实际有资料的地区：各国榜抓取失败或 COUNTRIES=off 时，
                    选单自动收敛成两个全球榜，不会留下点了必空的选项。
                    regions 尚未回来时先全列，避免首屏少一半选项 */}
                {NETFLIX_TOP10_REGIONS.filter(
                  (opt) =>
                    netflixRegions.length === 0 ||
                    netflixRegions.includes(opt.value)
                ).map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <select
                aria-label='周次'
                value={week}
                onChange={(e) =>
                  onSecondaryChange(
                    buildNetflixSecondary(source, region, e.target.value)
                  )
                }
                className={netflixSelectClass}
              >
                <option value=''>最新一周</option>
                {years.map((year) => (
                  <optgroup key={year} label={year}>
                    {netflixWeeks
                      .filter((w) => w.startsWith(year))
                      .map((w) => (
                        <option key={w} value={w}>
                          {w}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </select>
            </div>
          </div>
        )}
      </>
    );
  };

  return (
    <div className='space-y-4 sm:space-y-6'>
      {/* 电影类型 - 显示两级选择器 */}
      {type === 'movie' && (
        <div className='space-y-3 sm:space-y-4'>
          {/* 一级选择器 */}
          <div className='flex flex-col sm:flex-row sm:items-center gap-2'>
            <span className='text-xs sm:text-sm font-medium text-gray-600 dark:text-gray-400 min-w-[48px]'>
              分类
            </span>
            <div className='overflow-x-auto'>
              {renderCapsuleSelector(
                moviePrimaryOptions,
                primarySelection || moviePrimaryOptions[0].value,
                onPrimaryChange,
                true
              )}
            </div>
          </div>

          {/* 二级选择器 - TMDB 热门显示时间窗；Netflix 显示榜单来源；其余非"全部"时显示地区 */}
          {primarySelection === TMDB_HOT_PRIMARY ? (
            <div className='flex flex-col sm:flex-row sm:items-center gap-2'>
              <span className='text-xs sm:text-sm font-medium text-gray-600 dark:text-gray-400 min-w-[48px]'>
                榜单
              </span>
              <div className='overflow-x-auto'>
                {renderCapsuleSelector(
                  TMDB_HOT_WINDOW_OPTIONS,
                  secondarySelection || TMDB_HOT_WINDOW_OPTIONS[0].value,
                  onSecondaryChange,
                  false
                )}
              </div>
            </div>
          ) : primarySelection === NETFLIX_PRIMARY ? (
            renderNetflixSecondary()
          ) : primarySelection !== '全部' ? (
            <div className='flex flex-col sm:flex-row sm:items-center gap-2'>
              <span className='text-xs sm:text-sm font-medium text-gray-600 dark:text-gray-400 min-w-[48px]'>
                地区
              </span>
              <div className='overflow-x-auto'>
                {renderCapsuleSelector(
                  movieSecondaryOptions,
                  secondarySelection || movieSecondaryOptions[0].value,
                  onSecondaryChange,
                  false
                )}
              </div>
            </div>
          ) : (
            /* 多级选择器 - 只在选中"全部"时显示 */
            <div className='flex flex-col sm:flex-row sm:items-center gap-2'>
              <span className='text-xs sm:text-sm font-medium text-gray-600 dark:text-gray-400 min-w-[48px]'>
                筛选
              </span>
              <div className='overflow-x-auto'>
                <MultiLevelSelector
                  key={`${type}-${primarySelection}`}
                  onChange={handleMultiLevelChange}
                  contentType={type}
                />
              </div>
            </div>
          )}
        </div>
      )}

      {/* 电视剧类型 - 显示两级选择器 */}
      {type === 'tv' && (
        <div className='space-y-3 sm:space-y-4'>
          {/* 一级选择器 */}
          <div className='flex flex-col sm:flex-row sm:items-center gap-2'>
            <span className='text-xs sm:text-sm font-medium text-gray-600 dark:text-gray-400 min-w-[48px]'>
              分类
            </span>
            <div className='overflow-x-auto'>
              {renderCapsuleSelector(
                tvPrimaryOptions,
                primarySelection || tvPrimaryOptions[1].value,
                onPrimaryChange,
                true
              )}
            </div>
          </div>

          {/* 二级选择器 - Netflix 显示榜单来源；TMDB 热门显示时间窗；"最近热门"显示类型；"全部"显示多级选择器 */}
          {primarySelection === NETFLIX_PRIMARY ? (
            renderNetflixSecondary()
          ) : primarySelection === TMDB_HOT_PRIMARY ? (
            <div className='flex flex-col sm:flex-row sm:items-center gap-2'>
              <span className='text-xs sm:text-sm font-medium text-gray-600 dark:text-gray-400 min-w-[48px]'>
                榜单
              </span>
              <div className='overflow-x-auto'>
                {renderCapsuleSelector(
                  TMDB_HOT_WINDOW_OPTIONS,
                  secondarySelection || TMDB_HOT_WINDOW_OPTIONS[0].value,
                  onSecondaryChange,
                  false
                )}
              </div>
            </div>
          ) : (primarySelection || tvPrimaryOptions[1].value) === '最近热门' ? (
            <div className='flex flex-col sm:flex-row sm:items-center gap-2'>
              <span className='text-xs sm:text-sm font-medium text-gray-600 dark:text-gray-400 min-w-[48px]'>
                类型
              </span>
              <div className='overflow-x-auto'>
                {renderCapsuleSelector(
                  tvSecondaryOptions,
                  secondarySelection || tvSecondaryOptions[0].value,
                  onSecondaryChange,
                  false
                )}
              </div>
            </div>
          ) : (primarySelection || tvPrimaryOptions[1].value) === '全部' ? (
            /* 多级选择器 - 只在选中"全部"时显示 */
            <div className='flex flex-col sm:flex-row sm:items-center gap-2'>
              <span className='text-xs sm:text-sm font-medium text-gray-600 dark:text-gray-400 min-w-[48px]'>
                筛选
              </span>
              <div className='overflow-x-auto'>
                <MultiLevelSelector
                  key={`${type}-${primarySelection}`}
                  onChange={handleMultiLevelChange}
                  contentType={type}
                />
              </div>
            </div>
          ) : null}
        </div>
      )}

      {/* 动漫类型 - 显示一级选择器和多级选择器 */}
      {type === 'anime' && (
        <div className='space-y-3 sm:space-y-4'>
          <div className='flex flex-col sm:flex-row sm:items-center gap-2'>
            <span className='text-xs sm:text-sm font-medium text-gray-600 dark:text-gray-400 min-w-[48px]'>
              分类
            </span>
            <div className='overflow-x-auto'>
              {renderCapsuleSelector(
                animePrimaryOptions,
                primarySelection || animePrimaryOptions[0].value,
                onPrimaryChange,
                true
              )}
            </div>
          </div>

          {/* 筛选部分 - 根据一级选择器显示不同内容 */}
          {(primarySelection || animePrimaryOptions[0].value) === '每日放送' ? (
            // 每日放送分类下：视图切换 + 星期选择器（两种视图共用，控制当天内容）
            <div className='space-y-3 sm:space-y-4'>
              <div className='flex flex-col sm:flex-row sm:items-center gap-2'>
                <span className='text-xs sm:text-sm font-medium text-gray-600 dark:text-gray-400 min-w-[48px]'>
                  视图
                </span>
                <div className='overflow-x-auto'>
                  {renderCapsuleSelector(
                    viewOptions,
                    viewMode,
                    (value) =>
                      onViewModeChange?.(value === 'schedule' ? 'schedule' : 'grid'),
                    false
                  )}
                </div>
              </div>

              <div className='flex flex-col sm:flex-row sm:items-center gap-2'>
                <span className='text-xs sm:text-sm font-medium text-gray-600 dark:text-gray-400 min-w-[48px]'>
                  星期
                </span>
                <div className='overflow-x-auto'>
                  <WeekdaySelector onWeekdayChange={onWeekdayChange} />
                </div>
              </div>
            </div>
          ) : (
            // 其他分类下显示原有的筛选功能
            <div className='flex flex-col sm:flex-row sm:items-center gap-2'>
              <span className='text-xs sm:text-sm font-medium text-gray-600 dark:text-gray-400 min-w-[48px]'>
                筛选
              </span>
              <div className='overflow-x-auto'>
                {(primarySelection || animePrimaryOptions[0].value) ===
                '番剧' ? (
                  <MultiLevelSelector
                    key={`anime-tv-${primarySelection}`}
                    onChange={handleMultiLevelChange}
                    contentType='anime-tv'
                  />
                ) : (
                  <MultiLevelSelector
                    key={`anime-movie-${primarySelection}`}
                    onChange={handleMultiLevelChange}
                    contentType='anime-movie'
                  />
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* 综艺类型 - 显示两级选择器 */}
      {type === 'show' && (
        <div className='space-y-3 sm:space-y-4'>
          {/* 一级选择器 */}
          <div className='flex flex-col sm:flex-row sm:items-center gap-2'>
            <span className='text-xs sm:text-sm font-medium text-gray-600 dark:text-gray-400 min-w-[48px]'>
              分类
            </span>
            <div className='overflow-x-auto'>
              {renderCapsuleSelector(
                showPrimaryOptions,
                primarySelection || showPrimaryOptions[1].value,
                onPrimaryChange,
                true
              )}
            </div>
          </div>

          {/* 二级选择器 - 只在选中"最近热门"时显示，选中"全部"时显示多级选择器 */}
          {(primarySelection || showPrimaryOptions[1].value) === '最近热门' ? (
            <div className='flex flex-col sm:flex-row sm:items-center gap-2'>
              <span className='text-xs sm:text-sm font-medium text-gray-600 dark:text-gray-400 min-w-[48px]'>
                类型
              </span>
              <div className='overflow-x-auto'>
                {renderCapsuleSelector(
                  showSecondaryOptions,
                  secondarySelection || showSecondaryOptions[0].value,
                  onSecondaryChange,
                  false
                )}
              </div>
            </div>
          ) : (primarySelection || showPrimaryOptions[1].value) === '全部' ? (
            /* 多级选择器 - 只在选中"全部"时显示 */
            <div className='flex flex-col sm:flex-row sm:items-center gap-2'>
              <span className='text-xs sm:text-sm font-medium text-gray-600 dark:text-gray-400 min-w-[48px]'>
                筛选
              </span>
              <div className='overflow-x-auto'>
                <MultiLevelSelector
                  key={`${type}-${primarySelection}`}
                  onChange={handleMultiLevelChange}
                  contentType={type}
                />
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
};

export default DoubanSelector;
