/* 繁简转换 —— 独立客户端模块。
 *
 * 服务端 bundle 不应包含 opencc-js（其字典约 1.9MB，会撑爆 Cloudflare Worker）。
 * 使用动态 import，不要静态 import；也不要把 server 端 opencc-js alias 成 identity，
 * 否则 title-alias 的跨字形正規化会失效。
 */

type OpenCCConverter = (text: string) => string;

let danmakuConverter: OpenCCConverter | null = null;
let danmakuConverterPromise: Promise<OpenCCConverter | null> | null = null;

/**
 * 加载繁简转换器（from: hk → to: cn）。同一进程只加载一次。
 * 仅客户端可调用；服务端（SSR）下 window 未定义时由调用方自行保护。
 */
export function loadTraditionalToSimplifiedConverter(): Promise<OpenCCConverter | null> {
  if (danmakuConverter) return Promise.resolve(danmakuConverter);
  if (!danmakuConverterPromise) {
    danmakuConverterPromise = import('opencc-js')
      .then((module) => {
        const OpenCC = module.default || module;
        danmakuConverter = OpenCC.Converter({ from: 'hk', to: 'cn' });
        return danmakuConverter;
      })
      .catch((error) => {
        console.error('初始化繁简转换器失败:', error);
        danmakuConverterPromise = null;
        danmakuConverter = null;
        return null;
      });
  }
  return danmakuConverterPromise;
}

// 客户端加载时预热转换器（服务端 SSR 时 window 未定义，无副作用）
if (typeof window !== 'undefined') {
  void loadTraditionalToSimplifiedConverter();
}

export function convertDanmakuText(text: string): string {
  if (
    typeof window === 'undefined' ||
    localStorage.getItem('danmakuTraditionalToSimplified') !== 'true'
  ) {
    return text;
  }

  // 转换器尚未就绪时原样返回（预热后通常已加载完成）
  if (!danmakuConverter) return text;

  try {
    return danmakuConverter(text);
  } catch (error) {
    console.error('弹幕繁简转换失败:', error);
    return text;
  }
}
