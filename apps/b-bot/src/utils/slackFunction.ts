import type { WebClient, Block, KnownBlock, ChatPostMessageArguments } from '@slack/web-api';

// snake_case 옵션은 받지 않는다. 받아도 아래에서 넘기지 않아 조용히 사라진다.
interface SendSlackMessageBaseParams extends Omit<ChatPostMessageArguments, 'thread_ts' | 'unfurl_links'> {
  client: WebClient;
  threadTs?: string;
  unfurlLinks?: boolean;
}

interface SendSlackTextParams extends SendSlackMessageBaseParams {
  text: string;
}

export async function sendSlackText({
  client,
  channel,
  threadTs: thread_ts,
  text,
  unfurlLinks: unfurl_links,
}: SendSlackTextParams) {
  return client.chat.postMessage({
    channel,
    text,
    thread_ts,
    unfurl_links,
  });
}

interface SendSlackBlockParams extends SendSlackMessageBaseParams {
  blocks: (KnownBlock | Block)[];
}

export async function sendSlackBlock({
  client,
  channel,
  threadTs: thread_ts,
  blocks,
  unfurlLinks: unfurl_links,
}: SendSlackBlockParams) {
  return client.chat.postMessage({
    channel,
    blocks,
    thread_ts,
    unfurl_links,
  });
}
interface UpdateSlackBlockParams extends Omit<SendSlackBlockParams, 'thread_ts' | 'blocks'> {
  ts?: string;
  blocks?: (KnownBlock | Block)[];
  text?: string;
}

export async function updateSlack({ client, channel, ts, blocks, text }: UpdateSlackBlockParams) {
  return client.chat.update({
    channel,
    blocks,
    text,
    ts,
  });
}
