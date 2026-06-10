'use client';

import { useEffect } from 'react';

import { getS2TConverter, OpenCCConverter } from '@/lib/opencc-client';

export const TRADITIONAL_CHINESE_STORAGE_KEY = 'interfaceTraditionalChinese';
export const TRADITIONAL_CHINESE_CHANGE_EVENT =
  'interfaceTraditionalChineseChanged';

// 整棵子树跳过：不含用户可见文本或不应被修改
const SKIP_SUBTREE_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT']);

// 需要转换的元素属性（用户可见的提示文本）
const TEXT_ATTRIBUTES = ['title', 'placeholder', 'alt', 'aria-label'];

const CHINESE_CHAR_REGEX = /[一-鿿]/;

// 浏览器系统语系为繁体中文（台湾/香港/澳门或 zh-Hant 变体）
function detectTraditionalLocale(): boolean {
  if (typeof navigator === 'undefined') return false;
  const langs =
    navigator.languages && navigator.languages.length > 0
      ? navigator.languages
      : [navigator.language];
  return langs.some((lang) => {
    const lower = (lang || '').toLowerCase();
    return (
      lower.startsWith('zh-tw') ||
      lower.startsWith('zh-hk') ||
      lower.startsWith('zh-mo') ||
      lower.includes('hant')
    );
  });
}

/**
 * 是否启用繁体中文界面：
 * 用户手动设置过则以设置为准，否则按浏览器系统语系自动判断
 */
export function isTraditionalChineseEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  const saved = localStorage.getItem(TRADITIONAL_CHINESE_STORAGE_KEY);
  if (saved !== null) return saved === 'true';
  return detectTraditionalLocale();
}

/**
 * 切换繁体中文界面设置（UserMenu 开关与 LanguageToggle 快捷按钮共用）
 * 开启时联动开启「搜索繁体转简体」，繁体关键词才能搜到简体片源
 */
export function setTraditionalChineseEnabled(enabled: boolean) {
  if (typeof window === 'undefined') return;
  localStorage.setItem(TRADITIONAL_CHINESE_STORAGE_KEY, String(enabled));
  if (
    enabled &&
    localStorage.getItem('searchTraditionalToSimplified') !== 'true'
  ) {
    localStorage.setItem('searchTraditionalToSimplified', 'true');
  }
  window.dispatchEvent(new CustomEvent(TRADITIONAL_CHINESE_CHANGE_EVENT));
}

/**
 * 全站简体 → 繁体（台湾正体）界面转换
 *
 * 启用后对整个 DOM 做一次初始转换，并通过 MutationObserver
 * 持续转换后续动态插入/更新的内容（搜索结果、豆瓣数据、弹窗等）。
 * 不修改用户输入内容（input/textarea 值、contenteditable）。
 */
export function TraditionalChineseProvider() {
  useEffect(() => {
    if (typeof window === 'undefined') return;

    let observer: MutationObserver | null = null;
    let disposed = false;
    let convert: OpenCCConverter | null = null;
    // 记录我们刚写入的值，避免 observer 对自身写入再次触发造成循环
    const lastWritten = new WeakMap<Node, string>();

    const isEnabled = isTraditionalChineseEnabled;

    const convertTextNode = (node: Text) => {
      const original = node.nodeValue;
      if (!original || !CHINESE_CHAR_REGEX.test(original)) return;
      if (lastWritten.get(node) === original) return;
      const parent = node.parentElement;
      if (
        parent &&
        (SKIP_SUBTREE_TAGS.has(parent.tagName) ||
          parent.tagName === 'TEXTAREA' ||
          parent.isContentEditable)
      ) {
        return;
      }
      const converted = (convert as OpenCCConverter)(original);
      if (converted !== original) {
        lastWritten.set(node, converted);
        node.nodeValue = converted;
      }
    };

    const convertElementAttributes = (el: Element) => {
      for (const attr of TEXT_ATTRIBUTES) {
        const value = el.getAttribute(attr);
        if (!value || !CHINESE_CHAR_REGEX.test(value)) continue;
        const converted = (convert as OpenCCConverter)(value);
        if (converted !== value) {
          el.setAttribute(attr, converted);
        }
      }
    };

    const convertTree = (root: Node) => {
      if (root.nodeType === Node.TEXT_NODE) {
        convertTextNode(root as Text);
        return;
      }
      if (root.nodeType !== Node.ELEMENT_NODE) return;
      const rootEl = root as Element;
      if (SKIP_SUBTREE_TAGS.has(rootEl.tagName)) return;
      convertElementAttributes(rootEl);

      const walker = document.createTreeWalker(
        root,
        NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
        {
          acceptNode(node) {
            if (node.nodeType === Node.ELEMENT_NODE) {
              return SKIP_SUBTREE_TAGS.has((node as Element).tagName)
                ? NodeFilter.FILTER_REJECT
                : NodeFilter.FILTER_ACCEPT;
            }
            return NodeFilter.FILTER_ACCEPT;
          },
        }
      );
      let current = walker.nextNode();
      while (current) {
        if (current.nodeType === Node.TEXT_NODE) {
          convertTextNode(current as Text);
        } else {
          convertElementAttributes(current as Element);
        }
        current = walker.nextNode();
      }
    };

    const handleMutations = (mutations: MutationRecord[]) => {
      for (const mutation of mutations) {
        if (mutation.type === 'characterData') {
          if (mutation.target.nodeType === Node.TEXT_NODE) {
            convertTextNode(mutation.target as Text);
          }
        } else if (mutation.type === 'childList') {
          mutation.addedNodes.forEach((node) => convertTree(node));
        } else if (mutation.type === 'attributes') {
          if (mutation.target.nodeType === Node.ELEMENT_NODE) {
            convertElementAttributes(mutation.target as Element);
          }
        }
      }
    };

    const start = async () => {
      if (convert || disposed) return;
      const converter = await getS2TConverter();
      if (!converter || disposed) return;
      convert = converter;

      // 系统语系自动启用时也联动搜索繁转简（用户明确设置过则不动）
      if (localStorage.getItem('searchTraditionalToSimplified') === null) {
        localStorage.setItem('searchTraditionalToSimplified', 'true');
      }

      document.documentElement.lang = 'zh-TW';
      // 初始全页转换（含 <title>）
      convertTree(document.documentElement);

      observer = new MutationObserver(handleMutations);
      observer.observe(document.documentElement, {
        childList: true,
        characterData: true,
        subtree: true,
        attributes: true,
        attributeFilter: TEXT_ATTRIBUTES,
      });
    };

    // 设置变更：开启时即时生效，关闭时刷新页面还原简体
    const handleSettingChange = () => {
      if (isEnabled()) {
        start();
      } else if (convert) {
        window.location.reload();
      }
    };

    if (isEnabled()) {
      start();
    }
    window.addEventListener(TRADITIONAL_CHINESE_CHANGE_EVENT, handleSettingChange);

    return () => {
      disposed = true;
      observer?.disconnect();
      window.removeEventListener(
        TRADITIONAL_CHINESE_CHANGE_EVENT,
        handleSettingChange
      );
    };
  }, []);

  return null;
}
