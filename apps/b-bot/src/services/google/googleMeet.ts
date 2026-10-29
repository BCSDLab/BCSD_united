import { googleAccessToken } from '~/services/google/oauth';

export const GOOGLE_MEET_KEY = 'google-meet-refresh-token';

export interface GoogleMeetSpace {
  name: string;
  meetingUri: string;
  meetingCode: string;
}

async function meetRequest<T>(accessToken: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`https://meet.googleapis.com/v2/${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body ?? {}),
    });
  } catch {
    throw new Error('Google Meet API could not be reached');
  }
  if (!response.ok) {
    throw new Error(`Google Meet API request failed (HTTP ${response.status})`);
  }
  return (await response.json()) as T;
}

export async function createSpace(refreshToken: string): Promise<[GoogleMeetSpace]> {
  const accessToken = await googleAccessToken(refreshToken);
  const space = await meetRequest<GoogleMeetSpace>(accessToken, 'spaces', {
    config: { accessType: 'OPEN' },
  });
  return [space];
}

async function removeSpace(refreshToken: string, name: string): Promise<void> {
  const accessToken = await googleAccessToken(refreshToken);
  await meetRequest<Record<string, never>>(accessToken, `spaces/${encodeURIComponent(name)}:endActiveConference`);
}

type Meeting = {
  meeting: string;
  ts: string;
  timestamp: number;
};

export async function createMeeting() {
  const storage = useStorage('kvStorage');
  const refreshToken = await storage.get<string>(GOOGLE_MEET_KEY);
  const [response] = await createSpace(refreshToken);
  return response;
}

export async function saveMeeting(meeting: Omit<Meeting, 'timestamp'>) {
  const storage = useStorage('kvStorage');
  const meetings = await storage.get<Meeting[] | undefined>('current-meeting');

  await storage.set<Meeting[]>('current-meeting', [
    ...(meetings ?? []).filter((m) => m.timestamp + 1000 * 60 * 60 * 24 > Date.now()),
    {
      ...meeting,
      timestamp: Date.now(),
    },
  ]);
}

interface RemoveMeetingParams {
  ts?: string;
  text: string;
}

const MEET_NAME_REGEX = /\b[a-z0-9]{3}-[a-z0-9]{4}-[a-z0-9]{3}\b/i;

export async function removeMeeting({ text }: RemoveMeetingParams) {
  const meetName = text.match(MEET_NAME_REGEX)?.[0].toLowerCase();
  if (!meetName) {
    throw new Error('Google Meet meeting code missing; include the meeting link or code');
  }
  const storage = useStorage('kvStorage');
  const meetings = (await storage.get<Meeting[]>('current-meeting')) ?? [];
  const meetingInfo = meetings.find((m) => m.meeting === meetName);
  if (!meetingInfo) {
    throw new Error("Google Meet meeting was not found in the bot's current meetings");
  }
  const refreshToken = await storage.get<string>(GOOGLE_MEET_KEY);
  await removeSpace(refreshToken, meetName);
  await storage.set<Meeting[]>(
    'current-meeting',
    meetings.filter((m) => m.meeting !== meetName),
  );
  return meetingInfo;
}
