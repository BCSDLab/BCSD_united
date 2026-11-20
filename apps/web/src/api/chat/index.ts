import APIClient from 'utils/ts/apiClient';

import {
  DeleteChatPresence,
  GetChatMessages,
  GetChatRoom,
  GetChatRooms,
  PostChatMessage,
  PostChatPresence,
  PostChatRead,
} from './APIDetail';

export const getChatRooms = APIClient.of(GetChatRooms);
export const getChatRoom = APIClient.of(GetChatRoom);
export const getChatMessages = APIClient.of(GetChatMessages);
export const sendChatMessage = APIClient.of(PostChatMessage);
export const markChatRead = APIClient.of(PostChatRead);
export const touchChatPresence = APIClient.of(PostChatPresence);
export const leaveChatPresence = APIClient.of(DeleteChatPresence);
