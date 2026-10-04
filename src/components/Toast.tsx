'use client';

import { CheckCircle, Info, X,XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';

export interface ToastProps {
  message: string;
  type?: 'success' | 'error' | 'info';
  /** 自动消失的毫秒数，只作用于成功与提示；错误一律留到使用者自己关闭。 */
  duration?: number;
  onClose?: () => void;
}

export default function Toast({ message, type = 'info', duration = 3000, onClose }: ToastProps) {
  const [isVisible, setIsVisible] = useState(true);

  useEffect(() => {
    // 错误要留到使用者自己关：读屏念完、看漏的人回头都还找得到怎么处理
    if (type === 'error') return undefined;
    const timer = setTimeout(() => {
      setIsVisible(false);
      setTimeout(() => {
        onClose?.();
      }, 300); // 等待动画完成
    }, duration);

    return () => clearTimeout(timer);
  }, [duration, onClose, type]);

  const handleClose = () => {
    setIsVisible(false);
    setTimeout(() => {
      onClose?.();
    }, 300);
  };

  const icons = {
    success: <CheckCircle className="w-5 h-5" />,
    error: <XCircle className="w-5 h-5" />,
    info: <Info className="w-5 h-5" />,
  };

  const colors = {
    success: 'bg-green-500/90',
    error: 'bg-red-500/90',
    info: 'bg-blue-500/90',
  };

  return (
    <div
      role={type === 'error' ? 'alert' : 'status'}
      className={`fixed top-20 left-1/2 -translate-x-1/2 z-[9999] transition-all duration-300 ${
        isVisible ? 'opacity-100 translate-y-0' : 'pointer-events-none opacity-0 -translate-y-4'
      }`}
    >
      <div className={`${colors[type]} text-white px-6 py-3 rounded-lg shadow-lg flex items-start gap-3 min-w-[300px] max-w-[min(90vw,560px)]`}>
        <div className="flex-shrink-0">{icons[type]}</div>
        <div className="flex-1 text-sm font-medium whitespace-pre-wrap break-words">{message}</div>
        <button
          type="button"
          onClick={handleClose}
          aria-label="关闭通知"
          className="flex-shrink-0 hover:bg-white/20 rounded p-1 transition-colors"
        >
          <X className="w-4 h-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}
