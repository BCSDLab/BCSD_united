import { useRef } from 'react';

import * as gtag from 'lib/gtag';
import type { LoggingTarget } from 'lib/gtag';

type ActionLoggerProps = LoggingTarget & {
  value: string;
  event_category?: string;
  previous_page?: string;
  current_page?: string;
  duration_time?: number;
};

type LoggerEventProps = ActionLoggerProps & {
  event_category: string;
};

const useLogger = () => {
  const prevEvent = useRef<LoggerEventProps | null>(null);

  const logEvent = (props: LoggerEventProps) => {
    gtag.event(props);
    prevEvent.current = props;
  };

  const actionEventClick = (props: ActionLoggerProps) => {
    logEvent({ ...props, event_category: props.event_category || 'click' });
  };

  const actionEventSwipe = (props: ActionLoggerProps) => {
    logEvent({ ...props, event_category: 'swipe' });
  };

  const actionEventLoad = (props: ActionLoggerProps) => {
    logEvent({ ...props, event_category: props.event_category || 'entry' });
  };

  return {
    actionEventClick,
    actionEventSwipe,
    actionEventLoad,
  };
};

export default useLogger;
