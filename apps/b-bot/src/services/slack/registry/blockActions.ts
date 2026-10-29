import { busApplyActions, busPatchActions } from '~/services/slack/features/bus/actions';
import { busDetectedActions } from '~/services/slack/features/bus/detectedActions';
import { coopApplyActions } from '~/services/slack/features/coop/applyActions';
import { coopDetectedActions } from '~/services/slack/features/coop/detectedActions';
import { coopPatchActions } from '~/services/slack/features/coop/patchActions';
import { diningActions } from '~/services/slack/features/dining';
import { lectureActions } from '~/services/slack/features/lecture/actions';
import { lectureDetectedActions } from '~/services/slack/features/lecture/detectedActions';
import { blockActions as supersetActions } from '~/services/slack/features/superset';
import type { BlockActionSetting } from '~/services/slack/types';

/**
 * 버튼·셀렉트 조작(block_actions) 핸들러 등록표.
 *
 * **여기에는 구현을 두지 않는다.** 어떤 버튼이 있는지 한눈에 보이는 게 이 파일의
 * 역할이고, 그래야 `action_id`가 겹치는 걸 눈으로 잡을 수 있다.
 *
 * 각 파일이 완성된 목록을 내보내고 여기서는 모으기만 한다. 예전에는 어떤 도메인은
 * action_id 배열만 주고 여기서 어댑터로 감쌌는데, 그러면 **배열과 핸들러 안의 분기가
 * 두 곳에서 따로 관리된다.** 배열에만 추가하면 버튼이 조용히 아무 일도 하지 않는다.
 *
 * 등록하지 않은 action_id는 라우터에서 무시된다. 모달 안의 select와 URL 링크 버튼도
 * block_actions로 들어오는데, 그것들은 여기서 처리할 대상이 아니기 때문이다.
 */
export const blockActions: BlockActionSetting[] = [
  ...busDetectedActions,
  ...busApplyActions,
  ...busPatchActions,
  ...coopDetectedActions,
  ...coopApplyActions,
  ...coopPatchActions,
  ...diningActions,
  ...lectureDetectedActions,
  ...lectureActions,
  ...supersetActions,
];
