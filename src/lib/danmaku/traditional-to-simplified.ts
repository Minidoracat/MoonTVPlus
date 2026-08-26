/* 繁简转换 —— 客户端弹幕路径。
 *
 * title-alias 服务端仍会动态载入 opencc-js，所以 Cloudflare Worker 仍可能含字典。
 * 这里只用动态 import，且仅在使用者开启弹幕繁简时才加载。
 * 不要在 isEdgeBuild 区块把 opencc-js alias 成 identity（会伤到 client 繁中）。
 */

type OpenCCConverter = (text: string) => string;

let danmakuConverter: OpenCCConverter | null = null;
let danmakuConverterPromise: Promise<OpenCCConverter | null> | null = null;

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

export function convertDanmakuText(
  text: string,
  converter: OpenCCConverter | null = danmakuConverter
): string {
  if (!converter) return text;
  try {
    return converter(text);
  } catch (error) {
    console.error('弹幕繁简转换失败:', error);
    return text;
  }
}
