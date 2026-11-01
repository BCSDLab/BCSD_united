import { cn } from '@bcsdlab/utils';
import { useQuery } from '@tanstack/react-query';

import { weatherQueries } from 'api/weather/queries';
import Image from 'components/ui/Image';
import { useUser } from 'utils/hooks/state/useUser';
import { useServerNow } from 'utils/ssr/useServerNow';

import styles from './HomeGreeting.module.scss';

const dateFormatter = new Intl.DateTimeFormat('ko-KR', {
  month: 'long',
  day: 'numeric',
  weekday: 'long',
  timeZone: 'Asia/Seoul',
});

interface HomeGreetingProps {
  variant?: 'desktop';
}

export default function HomeGreeting({ variant }: HomeGreetingProps) {
  const serverNow = useServerNow();
  const { data: userInfo } = useUser();
  const weatherQuery = useQuery(weatherQueries.info());
  const displayName = userInfo?.nickname?.trim() || userInfo?.name?.trim() || '코리';
  const todayLabel = dateFormatter.format(serverNow);

  return (
    <section
      className={cn({ [styles.hero]: true, [styles['hero--desktop']]: variant === 'desktop' })}
      aria-labelledby="home-greeting-title"
    >
      <div className={styles.hero__meta}>
        <span className={styles.hero__date}>{todayLabel}</span>
        <span className={styles.weather}>
          {weatherQuery.data ? (
            <>
              <Image src={weatherQuery.data.weather_icon_url} alt="" width={16} height={16} aria-hidden />
              <span className={styles.weather__text}>
                {weatherQuery.data.weather} {weatherQuery.data.temperature}°
              </span>
            </>
          ) : (
            <span className={styles.weather__text}>
              {weatherQuery.isPending ? '날씨 확인 중' : '날씨 정보 제공 불가'}
            </span>
          )}
        </span>
      </div>
      <h1 id="home-greeting-title" className={styles.hero__title}>
        <span className={styles.hero__name}>{displayName}님,</span>
        <span>오늘도 잘 챙겨먹어요</span>
      </h1>
    </section>
  );
}
