import { describe, expect, it } from 'vitest';
import { blockActions } from '~/services/slack/registry/blockActions';
import { commands } from '~/services/slack/registry/commands';
import { messageFunctionList } from '~/services/slack/registry/messages';
import { shortcuts } from '~/services/slack/registry/shortcuts';
import { viewActions } from '~/services/slack/registry/viewActions';

/**
 * 등록표의 내용과 **순서**를 고정한다.
 *
 * 메시지 핸들러는 맞는 것이 전부 순서대로 돈다. 예를 들어 `!수정`은 강의 핸들러가
 * 버스·생협보다 먼저 등록돼 있어야 스레드 주인을 가린다. 파일을 옮기거나 나누다
 * 순서가 바뀌어도 다른 테스트는 깨지지 않으니 여기서 잡는다.
 */
describe('Slack 핸들러 등록표', () => {
  it('메시지 핸들러 순서', () => {
    expect(messageFunctionList.map((setting) => String(setting.regex))).toMatchSnapshot();
  });

  it('버튼 action_id', () => {
    expect(blockActions.map((setting) => setting.actionId)).toMatchSnapshot();
  });

  it('슬래시 명령·숏컷·모달', () => {
    expect({
      commands: commands.map((setting) => setting.command),
      shortcuts: shortcuts.map((setting) => setting.key),
      viewActions: viewActions.map((setting) => setting.actionId),
    }).toMatchSnapshot();
  });
});
