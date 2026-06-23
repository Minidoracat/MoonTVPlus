type IOSNavigator = Navigator & {
  standalone?: boolean;
};

type LegacyWindow = Window & {
  MSStream?: unknown;
};

export function isIOSDevice(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return false;
  }

  const ua = navigator.userAgent;

  if ((window as LegacyWindow).MSStream) {
    return false;
  }

  if (/iPad|iPhone|iPod/.test(ua)) {
    return true;
  }

  return (
    ua.includes('Mac OS X') &&
    'ontouchend' in document &&
    !ua.includes('Windows') &&
    !ua.includes('Linux')
  );
}

export function isStandaloneWebApp(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: fullscreen)').matches ||
    (window.navigator as IOSNavigator).standalone === true
  );
}

export function isIOSStandaloneWebApp(): boolean {
  return isIOSDevice() && isStandaloneWebApp();
}

export function supportsProgrammaticPictureInPicture(): boolean {
  return (
    typeof document !== 'undefined' &&
    typeof HTMLVideoElement !== 'undefined' &&
    'pictureInPictureEnabled' in document &&
    document.pictureInPictureEnabled === true &&
    'requestPictureInPicture' in HTMLVideoElement.prototype &&
    !isIOSStandaloneWebApp()
  );
}

export function toSafariOpenUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);

    if (url.protocol !== 'https:') {
      return null;
    }

    return `x-safari-${url.href}`;
  } catch {
    return null;
  }
}
