import React from 'react';
import { captureError } from '@koin/telemetry/runtime';

import { getErrorStatus } from 'utils/ts/httpError';
import showToast from 'utils/ts/showToast';

import styles from './StoreErrorBoundary.module.scss';

interface Props {
  onErrorClick: () => void;
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  status?: number;
  eventId?: string;
}

export default class StoreErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, status: getErrorStatus(error) };
  }

  componentDidCatch(error: Error) {
    showToast('error', error.message);
    const eventId = captureError(error);
    this.setState({ eventId });
  }

  render() {
    const { children, onErrorClick } = this.props;
    const { hasError, status, eventId } = this.state;

    if (hasError && status === 404) {
      return (
        <div className={styles.container} role="alert">
          <h1>존재하지 않는 상점입니다.</h1>
          <button className={styles.button} type="button" onClick={onErrorClick}>
            상점 목록
          </button>
        </div>
      );
    }

    if (hasError) {
      return (
        <div className={styles.container} role="alert">
          <p>오류가 발생했습니다.</p>
          {eventId && <p className={styles['event-id']}>문의 시 참조 코드: {eventId}</p>}
        </div>
      );
    }

    return children;
  }
}
