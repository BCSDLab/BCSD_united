import { useEffect, useState } from 'react';

const NAVER_MAP_SCRIPT_ID = 'naver-map-script';

type MapScriptStatus = 'loading' | 'loaded' | 'error';

export default function useNaverMapScript(enabled = true) {
  const [status, setStatus] = useState<MapScriptStatus>(() =>
    typeof window !== 'undefined' && window.naver?.maps ? 'loaded' : 'loading',
  );

  useEffect(() => {
    if (!enabled) return;
    const clientId = process.env.NEXT_PUBLIC_NAVER_MAPS_CLIENT_ID;
    const mapWindow = window as Window & { navermap_authFailure?: () => void };
    const previousAuthFailure = mapWindow.navermap_authFailure;
    let isActive = true;
    let script = document.getElementById(NAVER_MAP_SCRIPT_ID) as HTMLScriptElement | null;

    const updateStatus = (nextStatus: MapScriptStatus) => {
      if (!isActive) return;
      if (script) script.dataset.mapLoadStatus = nextStatus;
      setStatus(nextStatus);
    };
    const handleLoad = () =>
      updateStatus(script?.dataset.mapLoadStatus !== 'error' && window.naver?.maps ? 'loaded' : 'error');
    const handleError = () => updateStatus('error');
    const handleAuthFailure = () => {
      previousAuthFailure?.();
      handleError();
    };
    mapWindow.navermap_authFailure = handleAuthFailure;

    if (script?.dataset.mapLoadStatus === 'error') {
      handleError();
    } else if (window.naver?.maps) {
      updateStatus('loaded');
    } else if (!clientId) {
      handleError();
    } else {
      const shouldAppend = !script;
      if (!script) {
        script = document.createElement('script');
        script.id = NAVER_MAP_SCRIPT_ID;
        script.src = `https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=${clientId}`;
        script.async = true;
        script.dataset.mapLoadStatus = 'loading';
      }
      script.addEventListener('load', handleLoad);
      script.addEventListener('error', handleError);
      if (shouldAppend) document.head.appendChild(script);
    }

    return () => {
      isActive = false;
      script?.removeEventListener('load', handleLoad);
      script?.removeEventListener('error', handleError);
      if (mapWindow.navermap_authFailure === handleAuthFailure) {
        mapWindow.navermap_authFailure = previousAuthFailure;
      }
    };
  }, [enabled]);

  return { isLoaded: enabled && status === 'loaded', hasError: enabled && status === 'error' };
}
