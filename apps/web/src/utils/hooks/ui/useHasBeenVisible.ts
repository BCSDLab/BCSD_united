import { useEffect, useState } from 'react';

/**
 * 요소가 한 번이라도 화면에 보였는지 돌려준다. 한 번 `true`가 되면 화면 밖으로 나가도 `true`로 남는다.
 * 돌려준 첫 값을 지켜볼 요소의 `ref`에 넘긴다. 요소가 나중에 그려지거나 바뀌어도 새 요소를 지켜본다.
 * `IntersectionObserver`가 없는 브라우저는 처음부터 보인 것으로 본다.
 */
export default function useHasBeenVisible<T extends Element>() {
  const [element, setElement] = useState<T | null>(null);
  const [hasBeenVisible, setHasBeenVisible] = useState(
    () => typeof window !== 'undefined' && typeof IntersectionObserver === 'undefined',
  );

  useEffect(() => {
    if (hasBeenVisible || !element) return undefined;

    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setHasBeenVisible(true);
      observer.disconnect();
    });
    observer.observe(element);

    return () => observer.disconnect();
  }, [element, hasBeenVisible]);

  return [setElement, hasBeenVisible] as const;
}
