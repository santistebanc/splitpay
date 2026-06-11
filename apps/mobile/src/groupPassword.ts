import AsyncStorage from "@react-native-async-storage/async-storage";

export const MIN_GROUP_PASSWORD_LENGTH = 4;

function pendingGroupPasswordKey(groupId: string) {
  return `splitpay.pendingGroupPassword.${groupId}`;
}

export function isGroupPasswordValid(password: string) {
  const trimmed = password.trim();
  return trimmed.length === 0 || trimmed.length >= MIN_GROUP_PASSWORD_LENGTH;
}

export async function rememberPendingGroupPassword(groupId: string, password: string) {
  await AsyncStorage.setItem(pendingGroupPasswordKey(groupId), password);
}

export async function peekPendingGroupPassword(groupId: string) {
  return AsyncStorage.getItem(pendingGroupPasswordKey(groupId));
}

export async function clearPendingGroupPassword(groupId: string) {
  await AsyncStorage.removeItem(pendingGroupPasswordKey(groupId));
}

export async function takePendingGroupPassword(groupId: string) {
  const key = pendingGroupPasswordKey(groupId);
  const value = await AsyncStorage.getItem(key);
  if (value) await AsyncStorage.removeItem(key);
  return value;
}
