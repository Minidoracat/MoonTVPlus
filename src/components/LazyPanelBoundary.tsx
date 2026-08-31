'use client';

import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

import LazyPanelFallback from './LazyPanelFallback';

interface LazyPanelBoundaryState {
  error: Error | null;
}

export default class LazyPanelBoundary extends Component<
  { children: ReactNode },
  LazyPanelBoundaryState
> {
  state: LazyPanelBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): LazyPanelBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('功能面板載入失敗:', error, info);
  }

  render() {
    if (this.state.error) {
      return <LazyPanelFallback error={this.state.error} />;
    }
    return this.props.children;
  }
}
