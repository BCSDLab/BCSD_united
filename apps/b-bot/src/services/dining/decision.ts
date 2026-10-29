import { approveReport, DiningApiError, getReport, rejectReport, type DiningApiAuth } from './diningApi';
import type { DecisionResponse, ReportActor } from './types';

export type Decision = 'approve' | 'reject';

const LABEL: Record<Decision, string> = { approve: '승인', reject: '반려' };

export async function decideReport(
  decision: Decision,
  reportId: number,
  actor: ReportActor,
  auth: DiningApiAuth,
): Promise<string> {
  const call = () => (decision === 'approve' ? approveReport : rejectReport)(reportId, actor, auth);

  let response: DecisionResponse;
  try {
    response = await call();
  } catch (error) {
    if (!isConflict(error, 'OPTIMISTIC_LOCKING_FAILURE')) {
      return handleFailure(error, decision);
    }
    const current = await getReport(reportId, auth);
    if (current.status !== 'PENDING') {
      return alreadyProcessed();
    }
    try {
      response = await call();
    } catch (retryError) {
      return handleFailure(retryError, decision);
    }
  }

  if (response.already_processed) {
    return `이미 ${LABEL[decision]}된 제보예요.`;
  }
  const others = response.affected_report_ids.length - 1;
  const together = decision === 'approve' && others > 0 ? ` 같은 코스의 대기 제보 ${others}건도 함께 승인됐어요.` : '';
  return `${decision === 'approve' ? ':white_check_mark:' : ':x:'} 제보를 ${LABEL[decision]}했어요.${together} 잠시 후 메시지에 반영돼요.`;
}

function handleFailure(error: unknown, decision: Decision): string {
  if (isConflict(error, 'DINING_REPORT_ALREADY_PROCESSED')) {
    return alreadyProcessed();
  }
  if (isConflict(error, 'OPTIMISTIC_LOCKING_FAILURE')) {
    return `다른 처리와 겹쳐 ${LABEL[decision]}하지 못했어요. 잠시 후 다시 눌러주세요.`;
  }
  throw error;
}

function alreadyProcessed(): string {
  return '이미 다른 결과로 처리된 제보예요. 잠시 후 메시지에 반영돼요.';
}

function isConflict(error: unknown, code: string): boolean {
  return error instanceof DiningApiError && error.status === 409 && error.code === code;
}
