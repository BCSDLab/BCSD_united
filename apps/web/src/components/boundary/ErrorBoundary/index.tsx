import React from 'react';
import { captureError } from '@koin/telemetry/runtime';

import { isHttpError } from 'interfaces/APIError';
import showToast from 'utils/ts/showToast';

interface Props {
  fallbackClassName: string;
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  eventId?: string;
}

function getPayloadErrorMessage(data: unknown): string | undefined {
  if (data === null || typeof data !== 'object' || !('error' in data)) return undefined;
  const { error } = data;
  if (error === null || typeof error !== 'object' || !('message' in error)) return undefined;

  return typeof error.message === 'string' ? error.message : undefined;
}

export default class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    // 이후에 사용시 해제
    this.state = { hasError: false };
  }

  // 이후에 사용시 해제
  // static getDerivedStateFromError(_: Error) {
  static getDerivedStateFromError() {
    return { hasError: true };
  }

  // 이후에 사용시 해제
  // componentDidCatch(error: Error, __: ErrorInfo) {
  componentDidCatch(error: Error) {
    const errorMessage = isHttpError(error)
      ? (getPayloadErrorMessage(error.data) ?? '알 수 없는 오류가 발생했습니다.')
      : error.message;
    showToast('error', errorMessage);
    const eventId = captureError(error);
    this.setState({ eventId });
  }

  render() {
    const { children, fallbackClassName } = this.props;
    const { hasError, eventId } = this.state;
    if (hasError) {
      return (
        <div className={fallbackClassName} role="alert">
          Error
          {eventId && ` (참조 코드: ${eventId})`}
        </div>
      );
    }

    return children;
  }
}
