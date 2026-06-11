import AsyncStorage from "@react-native-async-storage/async-storage";

function pendingLeaveKey(groupId: string) {
  return `splitpay.pendingLeave.${groupId}`;
}

export async function rememberPendingLeave(groupId: string) {
  await AsyncStorage.setItem(pendingLeaveKey(groupId), "1");
}

export async function clearPendingLeave(groupId: string) {
  await AsyncStorage.removeItem(pendingLeaveKey(groupId));
}

export async function listPendingLeaveGroupIds() {
  const keys = await AsyncStorage.getAllKeys();
  return keys
    .filter((key) => key.startsWith("splitpay.pendingLeave."))
    .map((key) => key.slice("splitpay.pendingLeave.".length));
}
