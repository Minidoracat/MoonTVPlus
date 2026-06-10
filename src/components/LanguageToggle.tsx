'use client';

import { useEffect, useState } from 'react';

import {
  isTraditionalChineseEnabled,
  setTraditionalChineseEnabled,
  TRADITIONAL_CHINESE_CHANGE_EVENT,
} from './TraditionalChineseProvider';

export function LanguageToggle() {
  const [mounted, setMounted] = useState(false);
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    setMounted(true);
    const sync = () => {
      setEnabled(isTraditionalChineseEnabled());
    };
    sync();
    window.addEventListener(TRADITIONAL_CHINESE_CHANGE_EVENT, sync);
    return () =>
      window.removeEventListener(TRADITIONAL_CHINESE_CHANGE_EVENT, sync);
  }, []);

  if (!mounted) {
    // 渲染一个占位符以避免布局偏移
    return <div className='w-10 h-10' />;
  }

  return (
    <button
      onClick={() => setTraditionalChineseEnabled(!enabled)}
      className='w-10 h-10 p-2 rounded-full flex items-center justify-center text-gray-600 hover:bg-gray-200/50 dark:text-gray-300 dark:hover:bg-gray-700/50 transition-colors'
      aria-label='简繁切换'
      title={enabled ? '切换为简体中文' : '切换为繁体中文'}
    >
      <span className='text-base font-semibold leading-none select-none'>
        {enabled ? '繁' : '简'}
      </span>
    </button>
  );
}
