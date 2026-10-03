/* eslint-disable no-console */

/**
 * 共享的 OpenCC 简繁转换器（客户端）
 * 单例缓存，全站共用同一个转换器实例，避免重复加载词典
 */

export type OpenCCConverter = (text: string) => string;

let s2tConverterPromise: Promise<OpenCCConverter | null> | null = null;

/**
 * 获取「简体 → 台湾正体（含台湾常用词汇）」转换器
 * 使用 twp 模式：除字形转换外还做台湾用语转换（如 软件→軟體、网络→網路）
 */
export function getS2TConverter(): Promise<OpenCCConverter | null> {
  if (typeof window === 'undefined') {
    return Promise.resolve(null);
  }
  if (!s2tConverterPromise) {
    s2tConverterPromise = import('opencc-js')
      .then((module) => {
        const OpenCC = module.default || module;
        const convert = OpenCC.Converter({ from: 'cn', to: 'twp' });
        // 台灣用語詞典有三條會把結果再包住原詞（算法→演算法、虛擬機→虛擬機器、
        // 實模式→真實模式）：原文已是台灣用語時會變成「演演算法」，每轉一次多一層
        return (text: string) =>
          convert(text)
            .replace(/演演算法/g, '演算法')
            .replace(/虛擬機器器/g, '虛擬機器')
            .replace(/真真實模式/g, '真實模式');
      })
      .catch((error) => {
        console.error('加载 opencc-js 简转繁转换器失败:', error);
        s2tConverterPromise = null; // 允许下次重试
        return null;
      });
  }
  return s2tConverterPromise;
}
