/* eslint-disable no-console,react-hooks/exhaustive-deps,@typescript-eslint/no-explicit-any */

'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { GetBangumiCalendarData } from '@/lib/bangumi.client';
import {
  getDoubanCategories,
  getDoubanList,
  getDoubanRecommends,
  NETFLIX_MOVIE_RECOMMEND_PARAMS,
  NETFLIX_TV_RECOMMEND_PARAMS,
} from '@/lib/douban.client';
import { fetchNetflixTop10 } from '@/lib/netflix.client';
import { fetchTMDBHot } from '@/lib/tmdb.client';
import { DoubanItem, DoubanResult } from '@/lib/types';

import BangumiScheduleTimeline from '@/components/BangumiScheduleTimeline';
import DoubanCardSkeleton from '@/components/DoubanCardSkeleton';
import DoubanCustomSelector from '@/components/DoubanCustomSelector';
import DoubanSelector, {
  buildNetflixSecondary,
  NETFLIX_PRIMARY,
  NETFLIX_SOURCE_DOUBAN,
  NETFLIX_SOURCE_OFFICIAL,
  parseNetflixSecondary,
  TMDB_HOT_PRIMARY,
} from '@/components/DoubanSelector';
import PageLayout from '@/components/PageLayout';
import VideoCard from '@/components/VideoCard';

function DoubanPageClient() {
  const searchParams = useSearchParams();
  const [doubanData, setDoubanData] = useState<DoubanItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [currentPage, setCurrentPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [selectorsReady, setSelectorsReady] = useState(false);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const loadingRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const debounceTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // 用于存储最新参数值的 refs
  const currentParamsRef = useRef({
    type: '',
    primarySelection: '',
    secondarySelection: '',
    multiLevelSelection: {} as Record<string, string>,
    selectedWeekday: '',
    currentPage: 0,
  });

  const type = searchParams.get('type') || 'movie';

  // 获取 runtimeConfig 中的自定义分类数据
  const [customCategories, setCustomCategories] = useState<
    Array<{ name: string; type: 'movie' | 'tv'; query: string }>
  >([]);

  // 选择器状态 - 完全独立，不依赖URL参数
  const [primarySelection, setPrimarySelection] = useState<string>(() => {
    if (type === 'movie') return '热门';
    if (type === 'tv' || type === 'show') return '最近热门';
    if (type === 'anime') return '每日放送';
    return '';
  });
  const [secondarySelection, setSecondarySelection] = useState<string>(() => {
    if (type === 'movie') return '全部';
    if (type === 'tv') return 'tv';
    if (type === 'show') return 'show';
    return '全部';
  });

  // MultiLevelSelector 状态
  const [multiLevelValues, setMultiLevelValues] = useState<
    Record<string, string>
  >({
    type: 'all',
    region: 'all',
    year: 'all',
    platform: 'all',
    label: 'all',
    sort: 'T',
  });

  // 星期选择器状态 - 默认选中今天
  const getTodayWeekday = (): string => {
    const today = new Date().getDay();
    // getDay() 返回 0-6，0 是周日，1-6 是周一到周六
    const weekdayMap = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return weekdayMap[today];
  };

  const [selectedWeekday, setSelectedWeekday] = useState<string>(() => {
    if (type === 'anime') {
      return getTodayWeekday();
    }
    return '';
  });

  // 官方周榜可选周次，只驱动下拉；不进 snapshot 比对（它不是请求参数）
  const [netflixWeeks, setNetflixWeeks] = useState<string[]>([]);
  // 实际有资料的地区，驱动地区下拉收敛；各国榜没抓成时只剩两个全球榜
  const [netflixRegions, setNetflixRegions] = useState<string[]>([]);
  // 冷启动：后端正在背景抓取官方榜，空清单不是「没有内容」而是「还没好」
  const [netflixPending, setNetflixPending] = useState(false);

  // 由 primary/secondary 直接推导，不新增 state
  const isNetflixOfficial =
    primarySelection === NETFLIX_PRIMARY &&
    (type === 'movie' || type === 'tv') &&
    parseNetflixSecondary(secondarySelection).source ===
      NETFLIX_SOURCE_OFFICIAL;

  // 每日放送视图模式：grid(卡片) / schedule(时刻表)
  const [viewMode, setViewMode] = useState<'grid' | 'schedule'>('grid');

  // 获取自定义分类数据
  useEffect(() => {
    const runtimeConfig = (window as any).RUNTIME_CONFIG;
    if (runtimeConfig?.CUSTOM_CATEGORIES?.length > 0) {
      setCustomCategories(runtimeConfig.CUSTOM_CATEGORIES);
    }
  }, []);

  // 站点是否配置了 TMDB API Key（控制 TMDB 热门入口显隐）
  const [tmdbEnabled, setTmdbEnabled] = useState(false);
  useEffect(() => {
    fetch('/api/server-config')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setTmdbEnabled(Boolean(data?.TMDBEnabled)))
      .catch(() => setTmdbEnabled(false));
  }, []);

  // 同步最新参数值到 ref
  useEffect(() => {
    currentParamsRef.current = {
      type,
      primarySelection,
      secondarySelection,
      multiLevelSelection: multiLevelValues,
      selectedWeekday,
      currentPage,
    };
  }, [
    type,
    primarySelection,
    secondarySelection,
    multiLevelValues,
    selectedWeekday,
    currentPage,
  ]);

  // 初始化时标记选择器为准备好状态
  useEffect(() => {
    // 短暂延迟确保初始状态设置完成
    const timer = setTimeout(() => {
      setSelectorsReady(true);
    }, 50);

    return () => clearTimeout(timer);
  }, []); // 只在组件挂载时执行一次

  // type变化时立即重置selectorsReady（最高优先级）
  useEffect(() => {
    setSelectorsReady(false);
    setLoading(true); // 立即显示loading状态
  }, [type]);

  // 当type变化时重置选择器状态
  useEffect(() => {
    if (type === 'custom' && customCategories.length > 0) {
      // 自定义分类模式：优先选择 movie，如果没有 movie 则选择 tv
      const types = Array.from(
        new Set(customCategories.map((cat) => cat.type))
      );
      if (types.length > 0) {
        // 优先选择 movie，如果没有 movie 则选择 tv
        let selectedType = types[0]; // 默认选择第一个
        if (types.includes('movie')) {
          selectedType = 'movie';
        } else {
          selectedType = 'tv';
        }
        setPrimarySelection(selectedType);

        // 设置选中类型的第一个分类的 query 作为二级选择
        const firstCategory = customCategories.find(
          (cat) => cat.type === selectedType
        );
        if (firstCategory) {
          setSecondarySelection(firstCategory.query);
        }
      }
      setSelectedWeekday(''); // 清空星期选择
    } else {
      // 原有逻辑
      if (type === 'movie') {
        setPrimarySelection('热门');
        setSecondarySelection('全部');
        setSelectedWeekday(''); // 清空星期选择
      } else if (type === 'tv') {
        setPrimarySelection('最近热门');
        setSecondarySelection('tv');
        setSelectedWeekday(''); // 清空星期选择
      } else if (type === 'show') {
        setPrimarySelection('最近热门');
        setSecondarySelection('show');
        setSelectedWeekday(''); // 清空星期选择
      } else if (type === 'anime') {
        setPrimarySelection('每日放送');
        setSecondarySelection('全部');
        setSelectedWeekday(getTodayWeekday()); // 默认选中今天
      } else {
        setPrimarySelection('');
        setSecondarySelection('全部');
        setSelectedWeekday(''); // 清空星期选择
      }
    }

    // 清空 MultiLevelSelector 状态
    setMultiLevelValues({
      type: 'all',
      region: 'all',
      year: 'all',
      platform: 'all',
      label: 'all',
      sort: 'T',
    });

    // 使用短暂延迟确保状态更新完成后标记选择器准备好
    const timer = setTimeout(() => {
      setSelectorsReady(true);
    }, 50);

    return () => clearTimeout(timer);
  }, [type, customCategories]);

  // 生成骨架屏数据
  const skeletonData = Array.from({ length: 25 }, (_, index) => index);

  // 参数快照比较函数
  const isSnapshotEqual = useCallback(
    (
      snapshot1: {
        type: string;
        primarySelection: string;
        secondarySelection: string;
        multiLevelSelection: Record<string, string>;
        selectedWeekday: string;
        currentPage: number;
      },
      snapshot2: {
        type: string;
        primarySelection: string;
        secondarySelection: string;
        multiLevelSelection: Record<string, string>;
        selectedWeekday: string;
        currentPage: number;
      }
    ) => {
      return (
        snapshot1.type === snapshot2.type &&
        snapshot1.primarySelection === snapshot2.primarySelection &&
        snapshot1.secondarySelection === snapshot2.secondarySelection &&
        snapshot1.selectedWeekday === snapshot2.selectedWeekday &&
        snapshot1.currentPage === snapshot2.currentPage &&
        JSON.stringify(snapshot1.multiLevelSelection) ===
          JSON.stringify(snapshot2.multiLevelSelection)
      );
    },
    []
  );

  // 生成API请求参数的辅助函数
  const getRequestParams = useCallback(
    (pageStart: number) => {
      // 当type为tv或show时，kind统一为'tv'，category使用type本身
      if (type === 'tv' || type === 'show') {
        return {
          kind: 'tv' as const,
          category: type,
          type: secondarySelection,
          pageLimit: 25,
          pageStart,
        };
      }

      // 电影类型保持原逻辑
      return {
        kind: type as 'tv' | 'movie',
        category: primarySelection,
        type: secondarySelection,
        pageLimit: 25,
        pageStart,
      };
    },
    [type, primarySelection, secondarySelection]
  );

  // 防抖的数据加载函数
  const loadInitialData = useCallback(async () => {
    // 创建当前参数的快照
    const requestSnapshot = {
      type,
      primarySelection,
      secondarySelection,
      multiLevelSelection: multiLevelValues,
      selectedWeekday,
      currentPage: 0,
    };

    try {
      setLoading(true);
      setLoadError('');
      // 确保在加载初始数据时重置页面状态
      setDoubanData([]);
      setCurrentPage(0);
      setHasMore(true);
      setIsLoadingMore(false);

      let data: DoubanResult;

      if (type === 'custom') {
        // 自定义分类模式：根据选中的一级和二级选项获取对应的分类
        const selectedCategory = customCategories.find(
          (cat) =>
            cat.type === primarySelection && cat.query === secondarySelection
        );

        if (selectedCategory) {
          data = await getDoubanList({
            tag: selectedCategory.query,
            type: selectedCategory.type,
            pageLimit: 25,
            pageStart: 0,
          });
        } else {
          throw new Error('没有找到对应的分类');
        }
      } else if (type === 'anime' && primarySelection === '每日放送') {
        const calendarData = await Promise.race([
          GetBangumiCalendarData(),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error('Bangumi calendar 请求超时')),
              8000
            )
          ),
        ]);
        const weekdayData = calendarData.find(
          (item) => item.weekday.en === selectedWeekday
        );
        if (weekdayData) {
          data = {
            code: 200,
            message: 'success',
            list: weekdayData.items
              .filter((item) => item.images) // 过滤掉没有图片的
              .map((item) => ({
                id: item.id?.toString() || '',
                title: item.name_cn || item.name,
                poster:
                  item.images.large ||
                  item.images.common ||
                  item.images.medium ||
                  item.images.small ||
                  item.images.grid,
                rate: item.rating?.score?.toFixed(1) || '',
                year: item.air_date?.split('-')?.[0] || '',
              })),
          };
        } else {
          throw new Error('没有找到对应的日期');
        }
      } else if (type === 'anime') {
        data = await getDoubanRecommends({
          kind: primarySelection === '番剧' ? 'tv' : 'movie',
          pageLimit: 25,
          pageStart: 0,
          category: '动画',
          format: primarySelection === '番剧' ? '电视剧' : '',
          region: multiLevelValues.region
            ? (multiLevelValues.region as string)
            : '',
          year: multiLevelValues.year ? (multiLevelValues.year as string) : '',
          platform: multiLevelValues.platform
            ? (multiLevelValues.platform as string)
            : '',
          sort: multiLevelValues.sort ? (multiLevelValues.sort as string) : '',
          label: multiLevelValues.label
            ? (multiLevelValues.label as string)
            : '',
        });
      } else if (
        primarySelection === TMDB_HOT_PRIMARY &&
        (type === 'movie' || type === 'tv')
      ) {
        data = await fetchTMDBHot({
          kind: type,
          window: secondarySelection === 'week' ? 'week' : 'day',
          pageLimit: 25,
          pageStart: 0,
        });
      } else if (
        primarySelection === NETFLIX_PRIMARY &&
        (type === 'movie' || type === 'tv')
      ) {
        const { source, region, week } =
          parseNetflixSecondary(secondarySelection);
        if (source === NETFLIX_SOURCE_OFFICIAL) {
          const res = await fetchNetflixTop10({
            region,
            kind: type === 'tv' ? 'tv' : 'films',
            week,
          });
          // 周次/地区清单只驱动下拉，过期回应覆盖它无害
          if (res.weeks.length > 0) setNetflixWeeks(res.weeks);
          if (res.regions && res.regions.length > 0) {
            setNetflixRegions(res.regions);
            // 各国榜没抓成时地区选单会收缩，但已选中的地区还留在 secondarySelection，
            // 画面看起来切到全球榜、请求仍送旧地区并回空。改选第一个可用地区重新载入。
            if (!res.regions.includes(region)) {
              setSecondarySelection(
                buildNetflixSecondary(source, res.regions[0], '')
              );
              return;
            }
          }
          setNetflixPending(Boolean(res.pending));
          data = res;
        } else {
          data = await getDoubanRecommends({
            ...(type === 'tv'
              ? NETFLIX_TV_RECOMMEND_PARAMS
              : NETFLIX_MOVIE_RECOMMEND_PARAMS),
            pageLimit: 25,
            pageStart: 0,
          });
        }
      } else if (primarySelection === '全部') {
        data = await getDoubanRecommends({
          kind: type === 'show' ? 'tv' : (type as 'tv' | 'movie'),
          pageLimit: 25,
          pageStart: 0, // 初始数据加载始终从第一页开始
          category: multiLevelValues.type
            ? (multiLevelValues.type as string)
            : '',
          format: type === 'show' ? '综艺' : type === 'tv' ? '电视剧' : '',
          region: multiLevelValues.region
            ? (multiLevelValues.region as string)
            : '',
          year: multiLevelValues.year ? (multiLevelValues.year as string) : '',
          platform: multiLevelValues.platform
            ? (multiLevelValues.platform as string)
            : '',
          sort: multiLevelValues.sort ? (multiLevelValues.sort as string) : '',
          label: multiLevelValues.label
            ? (multiLevelValues.label as string)
            : '',
        });
      } else {
        data = await getDoubanCategories(getRequestParams(0));
      }

      if (data.code === 200) {
        // 检查参数是否仍然一致，如果一致才设置数据
        // 使用 ref 获取最新的当前值
        const currentSnapshot = { ...currentParamsRef.current };

        if (isSnapshotEqual(requestSnapshot, currentSnapshot)) {
          setDoubanData(data.list);
          // 官方周榜固定 10 条无分页：直接收敛，否则 hasMore 会短暂为 true，
          // 触发一次首屏预取的空转与转圈闪烁
          setHasMore(!isNetflixOfficial && data.list.length !== 0);
          setLoadError('');
          setLoading(false);
        } else {
          console.log('参数不一致，不执行任何操作，避免设置过期数据');
        }
        // 如果参数不一致，不执行任何操作，避免设置过期数据
      } else {
        throw new Error(data.message || '获取数据失败');
      }
    } catch (err) {
      console.error(err);
      // 与 success path 一致做快照比对：过期请求的失败不应覆盖新选择的状态
      if (isSnapshotEqual(requestSnapshot, { ...currentParamsRef.current })) {
        setLoadError(
          type === 'anime' && primarySelection === '每日放送'
            ? 'Bangumi 暂时无法读取，请稍后再试。'
            : '内容加载失败，请稍后再试。'
        );
        setLoading(false); // 发生错误时总是停止loading状态
      }
    }
  }, [
    type,
    primarySelection,
    secondarySelection,
    multiLevelValues,
    selectedWeekday,
    getRequestParams,
    customCategories,
  ]);

  // 只在选择器准备好后才加载数据
  useEffect(() => {
    // 只有在选择器准备好时才开始加载
    if (!selectorsReady) {
      return;
    }

    // 清除之前的防抖定时器
    if (debounceTimeoutRef.current) {
      clearTimeout(debounceTimeoutRef.current);
    }

    // 使用防抖机制加载数据，避免连续状态更新触发多次请求
    debounceTimeoutRef.current = setTimeout(() => {
      loadInitialData();
    }, 100); // 100ms 防抖延迟

    // 清理函数
    return () => {
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
      }
    };
  }, [
    selectorsReady,
    type,
    primarySelection,
    secondarySelection,
    multiLevelValues,
    selectedWeekday,
    loadInitialData,
  ]);

  // 单独处理 currentPage 变化（加载更多）
  useEffect(() => {
    if (currentPage > 0) {
      const fetchMoreData = async () => {
        // 创建当前参数的快照
        const requestSnapshot = {
          type,
          primarySelection,
          secondarySelection,
          multiLevelSelection: multiLevelValues,
          selectedWeekday,
          currentPage,
        };

        try {
          setIsLoadingMore(true);

          let data: DoubanResult;
          if (type === 'custom') {
            // 自定义分类模式：根据选中的一级和二级选项获取对应的分类
            const selectedCategory = customCategories.find(
              (cat) =>
                cat.type === primarySelection &&
                cat.query === secondarySelection
            );

            if (selectedCategory) {
              data = await getDoubanList({
                tag: selectedCategory.query,
                type: selectedCategory.type,
                pageLimit: 25,
                pageStart: currentPage * 25,
              });
            } else {
              throw new Error('没有找到对应的分类');
            }
          } else if (type === 'anime' && primarySelection === '每日放送') {
            // 每日放送模式下，不进行数据请求，返回空数据
            data = {
              code: 200,
              message: 'success',
              list: [],
            };
          } else if (type === 'anime') {
            data = await getDoubanRecommends({
              kind: primarySelection === '番剧' ? 'tv' : 'movie',
              pageLimit: 25,
              pageStart: currentPage * 25,
              category: '动画',
              format: primarySelection === '番剧' ? '电视剧' : '',
              region: multiLevelValues.region
                ? (multiLevelValues.region as string)
                : '',
              year: multiLevelValues.year
                ? (multiLevelValues.year as string)
                : '',
              platform: multiLevelValues.platform
                ? (multiLevelValues.platform as string)
                : '',
              sort: multiLevelValues.sort
                ? (multiLevelValues.sort as string)
                : '',
              label: multiLevelValues.label
                ? (multiLevelValues.label as string)
                : '',
            });
          } else if (
            primarySelection === TMDB_HOT_PRIMARY &&
            (type === 'movie' || type === 'tv')
          ) {
            data = await fetchTMDBHot({
              kind: type,
              window: secondarySelection === 'week' ? 'week' : 'day',
              pageLimit: 25,
              pageStart: currentPage * 25,
            });
          } else if (
            primarySelection === NETFLIX_PRIMARY &&
            (type === 'movie' || type === 'tv')
          ) {
            const { source } = parseNetflixSecondary(secondarySelection);
            data =
              source === NETFLIX_SOURCE_OFFICIAL
                ? // 官方周榜固定 10 条无分页：与 anime「每日放送」一样回空清单，
                  // 让下面的 setHasMore(list.length !== 0) 自然收敛成 false
                  { code: 200, message: 'success', list: [] }
                : await getDoubanRecommends({
                    ...(type === 'tv'
                      ? NETFLIX_TV_RECOMMEND_PARAMS
                      : NETFLIX_MOVIE_RECOMMEND_PARAMS),
                    pageLimit: 25,
                    pageStart: currentPage * 25,
                  });
          } else if (primarySelection === '全部') {
            data = await getDoubanRecommends({
              kind: type === 'show' ? 'tv' : (type as 'tv' | 'movie'),
              pageLimit: 25,
              pageStart: currentPage * 25,
              category: multiLevelValues.type
                ? (multiLevelValues.type as string)
                : '',
              format: type === 'show' ? '综艺' : type === 'tv' ? '电视剧' : '',
              region: multiLevelValues.region
                ? (multiLevelValues.region as string)
                : '',
              year: multiLevelValues.year
                ? (multiLevelValues.year as string)
                : '',
              platform: multiLevelValues.platform
                ? (multiLevelValues.platform as string)
                : '',
              sort: multiLevelValues.sort
                ? (multiLevelValues.sort as string)
                : '',
              label: multiLevelValues.label
                ? (multiLevelValues.label as string)
                : '',
            });
          } else {
            data = await getDoubanCategories(
              getRequestParams(currentPage * 25)
            );
          }

          if (data.code === 200) {
            // 检查参数是否仍然一致，如果一致才设置数据
            // 使用 ref 获取最新的当前值
            const currentSnapshot = { ...currentParamsRef.current };

            if (isSnapshotEqual(requestSnapshot, currentSnapshot)) {
              setDoubanData((prev) => [...prev, ...data.list]);
              setHasMore(data.list.length !== 0);
            } else {
              console.log('参数不一致，不执行任何操作，避免设置过期数据');
            }
          } else {
            throw new Error(data.message || '获取数据失败');
          }
        } catch (err) {
          console.error(err);
        } finally {
          setIsLoadingMore(false);
        }
      };

      fetchMoreData();
    }
  }, [
    currentPage,
    type,
    primarySelection,
    secondarySelection,
    customCategories,
    multiLevelValues,
    selectedWeekday,
  ]);

  // 设置滚动监听
  useEffect(() => {
    // 如果没有更多数据或正在加载，则不设置监听
    if (!hasMore || isLoadingMore || loading) {
      return;
    }

    // 确保 loadingRef 存在
    if (!loadingRef.current) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !isLoadingMore) {
          setCurrentPage((prev) => prev + 1);
        }
      },
      { threshold: 0.1 }
    );

    observer.observe(loadingRef.current);
    observerRef.current = observer;

    return () => {
      if (observerRef.current) {
        observerRef.current.disconnect();
      }
    };
  }, [hasMore, isLoadingMore, loading]);

  // 首屏如果未被撑满，仅在第一页时额外请求一次下一页
  useEffect(() => {
    if (
      loading ||
      !selectorsReady ||
      isLoadingMore ||
      !hasMore ||
      doubanData.length === 0 ||
      currentPage !== 0
    ) {
      return;
    }

    const rafId = window.requestAnimationFrame(() => {
      const contentEl = contentRef.current;
      if (!contentEl) return;

      const rect = contentEl.getBoundingClientRect();
      const preloadThreshold = window.innerHeight + 120;

      if (rect.bottom < preloadThreshold) {
        setCurrentPage(1);
      }
    });

    return () => window.cancelAnimationFrame(rafId);
  }, [loading, selectorsReady, isLoadingMore, hasMore, doubanData.length, currentPage]);

  // 处理选择器变化
  const handlePrimaryChange = useCallback(
    (value: string) => {
      // 只有当值真正改变时才设置loading状态
      if (value !== primarySelection) {
        setLoading(true);
        // 立即重置页面状态，防止基于旧状态的请求
        setCurrentPage(0);
        setDoubanData([]);
        setHasMore(true);
        setIsLoadingMore(false);

        // 清空 MultiLevelSelector 状态
        setMultiLevelValues({
          type: 'all',
          region: 'all',
          year: 'all',
          platform: 'all',
          label: 'all',
          sort: 'T',
        });

        // 如果是自定义分类模式，同时更新一级和二级选择器
        if (type === 'custom' && customCategories.length > 0) {
          const firstCategory = customCategories.find(
            (cat) => cat.type === value
          );
          if (firstCategory) {
            // 批量更新状态，避免多次触发数据加载
            setPrimarySelection(value);
            setSecondarySelection(firstCategory.query);
          } else {
            setPrimarySelection(value);
          }
        } else {
          // 电视剧和综艺切换到"最近热门"时，重置二级分类为第一个选项
          if ((type === 'tv' || type === 'show') && value === '最近热门') {
            setPrimarySelection(value);
            if (type === 'tv') {
              setSecondarySelection('tv');
            } else if (type === 'show') {
              setSecondarySelection('show');
            }
          } else if (value === TMDB_HOT_PRIMARY) {
            // 进入 TMDB 热门：二级切为时间窗默认值
            setPrimarySelection(value);
            setSecondarySelection('day');
          } else if (value === NETFLIX_PRIMARY) {
            // 进入 Netflix：二级切为资料源默认值（保持现状 = 豆瓣近期热度）
            setPrimarySelection(value);
            setSecondarySelection(NETFLIX_SOURCE_DOUBAN);
          } else if (
            primarySelection === TMDB_HOT_PRIMARY ||
            primarySelection === NETFLIX_PRIMARY
          ) {
            // 离开 TMDB/Netflix：二级恢复该类型的默认值，否则残留的
            // day / official-top10:TW: 会被 getRequestParams 当成豆瓣分类的 type 送出去
            setPrimarySelection(value);
            setSecondarySelection(type === 'tv' ? 'tv' : '全部');
          } else {
            setPrimarySelection(value);
          }

          // 动漫类型：切换到"每日放送"时设置当天，切换到其他分类时清空星期选择
          if (type === 'anime') {
            if (value === '每日放送') {
              setSelectedWeekday(getTodayWeekday());
            } else {
              setSelectedWeekday('');
            }
          }
        }
      }
    },
    [primarySelection, type, customCategories]
  );

  const handleSecondaryChange = useCallback(
    (value: string) => {
      // 只有当值真正改变时才设置loading状态
      if (value !== secondarySelection) {
        setLoading(true);
        // 立即重置页面状态，防止基于旧状态的请求
        setCurrentPage(0);
        setDoubanData([]);
        setHasMore(true);
        setIsLoadingMore(false);
        setSecondarySelection(value);
      }
    },
    [secondarySelection]
  );

  const handleMultiLevelChange = useCallback(
    (values: Record<string, string>) => {
      // 比较两个对象是否相同，忽略顺序
      const isEqual = (
        obj1: Record<string, string>,
        obj2: Record<string, string>
      ) => {
        const keys1 = Object.keys(obj1).sort();
        const keys2 = Object.keys(obj2).sort();

        if (keys1.length !== keys2.length) return false;

        return keys1.every((key) => obj1[key] === obj2[key]);
      };

      // 如果相同，则不设置loading状态
      if (isEqual(values, multiLevelValues)) {
        return;
      }

      setLoading(true);
      // 立即重置页面状态，防止基于旧状态的请求
      setCurrentPage(0);
      setDoubanData([]);
      setHasMore(true);
      setIsLoadingMore(false);
      setMultiLevelValues(values);
    },
    [multiLevelValues]
  );

  const handleWeekdayChange = useCallback((weekday: string) => {
    setSelectedWeekday(weekday);
  }, []);

  const getPageTitle = () => {
    // 根据 type 生成标题
    return type === 'movie'
      ? '电影'
      : type === 'tv'
      ? '电视剧'
      : type === 'anime'
      ? '动漫'
      : type === 'show'
      ? '综艺'
      : '自定义';
  };

  const getPageDescription = () => {
    if (type === 'anime' && primarySelection === '每日放送') {
      return '来自 Bangumi 番组计划的精选内容';
    }
    if (primarySelection === TMDB_HOT_PRIMARY) {
      return '来自 TMDB 的热门内容';
    }
    if (primarySelection === NETFLIX_PRIMARY) {
      return isNetflixOfficial
        ? '来自 Netflix 官方 Top 10 周榜'
        : '来自豆瓣的 Netflix 热门内容';
    }
    return '来自豆瓣的精选内容';
  };

  const getActivePath = () => {
    const params = new URLSearchParams();
    if (type) params.set('type', type);

    const queryString = params.toString();
    const activePath = `/douban${queryString ? `?${queryString}` : ''}`;
    return activePath;
  };

  // 是否为时刻表视图（每日放送 + 已切换）
  const isScheduleView =
    type === 'anime' &&
    primarySelection === '每日放送' &&
    viewMode === 'schedule';

  return (
    <PageLayout activePath={getActivePath()}>
      <div className='px-4 sm:px-10 py-4 sm:py-8 overflow-visible'>
        {/* 页面标题和选择器 */}
        <div className='mb-6 sm:mb-8 space-y-4 sm:space-y-6'>
          {/* 页面标题 */}
          <div>
            <h1 className='text-2xl sm:text-3xl font-bold text-gray-800 mb-1 sm:mb-2 dark:text-gray-200'>
              {getPageTitle()}
            </h1>
            <p className='text-sm sm:text-base text-gray-600 dark:text-gray-400'>
              {getPageDescription()}
            </p>
          </div>

          {/* 选择器组件 */}
          {type !== 'custom' ? (
            <div className='bg-white/60 dark:bg-gray-800/40 rounded-2xl p-4 sm:p-6 border border-gray-200/30 dark:border-gray-700/30 backdrop-blur-sm'>
              <DoubanSelector
                type={type as 'movie' | 'tv' | 'show' | 'anime'}
                primarySelection={primarySelection}
                secondarySelection={secondarySelection}
                showTmdbHot={tmdbEnabled && (type === 'movie' || type === 'tv')}
                netflixWeeks={netflixWeeks}
                netflixRegions={netflixRegions}
                onPrimaryChange={handlePrimaryChange}
                onSecondaryChange={handleSecondaryChange}
                onMultiLevelChange={handleMultiLevelChange}
                onWeekdayChange={handleWeekdayChange}
                viewMode={viewMode}
                onViewModeChange={setViewMode}
              />
            </div>
          ) : (
            <div className='bg-white/60 dark:bg-gray-800/40 rounded-2xl p-4 sm:p-6 border border-gray-200/30 dark:border-gray-700/30 backdrop-blur-sm'>
              <DoubanCustomSelector
                customCategories={customCategories}
                primarySelection={primarySelection}
                secondarySelection={secondarySelection}
                onPrimaryChange={handlePrimaryChange}
                onSecondaryChange={handleSecondaryChange}
              />
            </div>
          )}
        </div>

        {/* 内容展示区域 */}
        <div ref={contentRef} className='max-w-[95%] mx-auto mt-8 overflow-visible'>
          {/* 时刻表视图（每日放送） */}
          {isScheduleView ? (
            <BangumiScheduleTimeline weekday={selectedWeekday} />
          ) : loadError && !loading ? (
            <div className='rounded-2xl border border-yellow-500/30 bg-yellow-500/10 px-5 py-4 text-sm text-yellow-700 dark:text-yellow-200'>
              {loadError}
            </div>
          ) : (
            /* 内容网格 */
            <div className='justify-start grid grid-cols-3 gap-x-2 gap-y-12 px-0 sm:px-2 sm:grid-cols-[repeat(auto-fill,minmax(160px,1fr))] sm:gap-x-8 sm:gap-y-20'>
              {loading || !selectorsReady
                ? // 显示骨架屏
                  skeletonData.map((index) => (
                    <DoubanCardSkeleton key={index} />
                  ))
                : // 显示实际数据
                  doubanData.map((item, index) => {
                    // Netflix 官方周榜的条目同样来自 TMDB，走与 TMDB 热门一致的卡片路径
                    const useTmdbCard =
                      primarySelection === TMDB_HOT_PRIMARY ||
                      isNetflixOfficial;
                    return (
                      <div key={`${item.title}-${index}`} className='w-full'>
                        <VideoCard
                          from={useTmdbCard ? 'tmdb' : 'douban'}
                          // 官方周榜的 list 已按 rank 1~10 排序且不丢列，名次 = 下标+1
                          rank={isNetflixOfficial ? item.rank : undefined}
                          title={item.title}
                          query={item.query}
                          poster={item.poster}
                          douban_id={useTmdbCard ? undefined : Number(item.id)}
                          // 失配项的 id 是空字串，Number('') 为 0，会传出假的 tmdb_id
                          tmdb_id={
                            useTmdbCard
                              ? Number(item.id) || undefined
                              : undefined
                          }
                          rate={item.rate}
                          year={item.year}
                          // 电影类型严格控制，tv 不控；TMDB 榜单的 kind 精确可知，直接传递
                          type={
                            type === 'movie' ? 'movie' : useTmdbCard ? 'tv' : ''
                          }
                          isBangumi={
                            type === 'anime' && primarySelection === '每日放送'
                          }
                          isAnime={type === 'anime'}
                        />
                      </div>
                    );
                  })}
            </div>
          )}

          {/* 加载更多指示器 */}
          {!isScheduleView && hasMore && !loading && (
            <div
              ref={(el) => {
                if (el && el.offsetParent !== null) {
                  (
                    loadingRef as React.MutableRefObject<HTMLDivElement | null>
                  ).current = el;
                }
              }}
              className='flex justify-center mt-12 py-8'
            >
              {isLoadingMore && (
                <div className='flex items-center gap-2'>
                  <div className='animate-spin rounded-full h-6 w-6 border-b-2 border-green-500'></div>
                  <span className='text-gray-600'>加载中...</span>
                </div>
              )}
            </div>
          )}

          {/* 没有更多数据提示 */}
          {!isScheduleView && !hasMore && doubanData.length > 0 && (
            <div className='text-center text-gray-500 py-8'>已加载全部内容</div>
          )}

          {/* 空状态 */}
          {!isScheduleView && !loading && !loadError && doubanData.length === 0 && (
            <div className='text-center text-gray-500 py-8'>
              {isNetflixOfficial && netflixPending
                ? '正在获取 Netflix 官方榜单，首次载入需要一点时间，请稍后重新整理'
                : '暂无相关内容'}
            </div>
          )}
        </div>
      </div>
    </PageLayout>
  );
}

export default function DoubanPage() {
  return (
    <Suspense>
      <DoubanPageClient />
    </Suspense>
  );
}
