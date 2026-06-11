import "react-native-gesture-handler";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator, NativeStackNavigationProp } from "@react-navigation/native-stack";
import * as Clipboard from "expo-clipboard";
import { StatusBar } from "expo-status-bar";
import { ArrowLeft, Check, ChevronRight, Copy, Lock, Plus, Settings, User, UserCheck, Users, WifiOff, X } from "lucide-react-native";
import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  StyleProp,
  TextStyle,
  useColorScheme,
  View,
  ViewStyle
} from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  Button as PaperButton,
  Chip as PaperChip,
  MD3DarkTheme,
  MD3LightTheme,
  Provider as PaperProvider,
  Snackbar,
  TextInput as PaperTextInput
} from "react-native-paper";
import {
  addExpense,
  addMember,
  ActivityLog,
  Balance,
  createGroup,
  deleteExpense,
  Expense,
  fetchActivityLogs,
  fetchGroup,
  GroupSlot,
  GroupState,
  JoinError,
  joinGroup,
  flushPendingLeaves,
  leaveGroup,
  Member,
  previewGroupMembers,
  removeMember,
  renameMember,
  setGroupPassword,
  subscribeToConnection,
  subscribeToGroup,
  updateExpense,
  updateGroupName,
  type ConnectionStatus
} from "./src/api";
import { splitActivitySummary, withoutLeadingActor } from "./src/activityText";
import {
  amountToCents,
  currencySymbol,
  formatDateTime,
  formatRelativeExpenseDate,
  getErrorMessage,
  money,
  paymentDescription,
  sanitizeAmountInput
} from "./src/format";
import {
  calculateSettlements,
  isSettlementPayment,
  Settlement,
  settlementKey
} from "./src/ledger";
import { isGroupPasswordValid, MIN_GROUP_PASSWORD_LENGTH } from "./src/groupPassword";
import { DEFAULT_MEMBER_NAME, DUPLICATE_MEMBER_NAME_ERROR, isMemberNameTaken } from "./src/memberNames";
import { AppColors, darkColors, lightColors, spacing, typography } from "./src/theme";

type RootStackParamList = {
  Groups: undefined;
  GroupView: undefined;
  Settings: undefined;
  NewGroup: undefined;
  JoinGroup: undefined;
  Expense: undefined;
  Settle: undefined;
  Activity: undefined;
};
type Navigation = NativeStackNavigationProp<RootStackParamList>;
type SettingsSaving = "groupName" | "password" | "members" | "exit" | null;

type ButtonIcon = (props: { color: string; size: number }) => React.ReactNode;
type ButtonVariant = "primary" | "secondary" | "danger";
type ValueTone = "default" | "positive" | "negative";

const Stack = createNativeStackNavigator<RootStackParamList>();

let colors: AppColors = lightColors;
let styles = createStyles(colors);
let offlineBannerSlot: React.ReactNode = null;

function createPaperTheme(activeColors: AppColors, isDark: boolean) {
  const baseTheme = isDark ? MD3DarkTheme : MD3LightTheme;

  return {
    ...baseTheme,
    roundness: 2,
    colors: {
      ...baseTheme.colors,
      primary: activeColors.primary,
      secondary: activeColors.secondary,
      background: activeColors.background,
      surface: activeColors.surface,
      surfaceVariant: activeColors.surfaceSelected,
      error: activeColors.danger,
      outline: activeColors.border,
      onSurface: activeColors.text,
      onSurfaceVariant: activeColors.muted
    }
  };
}

const storageKeys = {
  deviceId: "splitpay.deviceId",
  profileName: "splitpay.profileName",
  lastGroupCode: "splitpay.lastGroupCode",
  knownGroups: "splitpay.knownGroups",
  groupPassword: (code: string) => `splitpay.groupPassword.${code.toUpperCase()}`
};

function maskPassword(password: string) {
  return "•".repeat(password.length);
}

function displayGroupPassword(storedPassword: string | null, hasPassword: boolean) {
  if (storedPassword) return maskPassword(storedPassword);
  if (hasPassword) return "••••••••";
  return "Not set";
}

async function loadStoredGroupPassword(code: string) {
  return AsyncStorage.getItem(storageKeys.groupPassword(code));
}

async function rememberStoredGroupPassword(code: string, password: string | null) {
  const key = storageKeys.groupPassword(code);
  if (password) await AsyncStorage.setItem(key, password);
  else await AsyncStorage.removeItem(key);
}

export default function App() {
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";
  colors = isDark ? darkColors : lightColors;
  styles = createStyles(colors);
  const paperTheme = createPaperTheme(colors, isDark);
  const statusBarStyle = isDark ? "light" : "dark";
  const [deviceId, setDeviceId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [groupName, setGroupName] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [groupState, setGroupState] = useState<GroupState | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState<SettingsSaving>(null);
  const [expenseAmount, setExpenseAmount] = useState("");
  const [expenseName, setExpenseName] = useState("");
  const [paidByMemberId, setPaidByMemberId] = useState("");
  const [editingExpenseId, setEditingExpenseId] = useState<string | null>(null);
  const [splitMemberIds, setSplitMemberIds] = useState<string[]>([]);
  const [knownGroups, setKnownGroups] = useState<KnownGroup[]>([]);
  const [activityLogs, setActivityLogs] = useState<ActivityLog[]>([]);
  const [isLoadingActivity, setIsLoadingActivity] = useState(false);
  const [loadingGroupCode, setLoadingGroupCode] = useState<string | null>(null);
  const [copyingCode, setCopyingCode] = useState<string | null>(null);
  const [settlingKey, setSettlingKey] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("connecting");
  const isOnline = connectionStatus === "online";
  const [joinPassword, setJoinPassword] = useState("");
  const [joinNeedsPassword, setJoinNeedsPassword] = useState(false);
  const [joinStep, setJoinStep] = useState<"code" | "pick">("code");
  const [joinSlots, setJoinSlots] = useState<GroupSlot[]>([]);
  const [joinSelectedMemberId, setJoinSelectedMemberId] = useState<string | null>(null);
  const [joinCustomName, setJoinCustomName] = useState("");
  const [storedGroupPassword, setStoredGroupPassword] = useState<string | null>(null);

  useEffect(() => {
    void boot();
  }, []);

  useEffect(() => {
    if (!groupState) {
      setStoredGroupPassword(null);
      return;
    }
    void loadStoredGroupPassword(groupState.group.code).then(setStoredGroupPassword);
  }, [groupState?.group.code, groupState?.group.hasPassword]);

  useEffect(() => subscribeToConnection((status) => {
    setConnectionStatus(status);
    if (status === "online") void flushPendingLeaves();
  }), []);

  useEffect(() => {
    if (!groupState) return;

    return subscribeToGroup(
      groupState.group.code,
      deviceId,
      (state) => setGroupState((current) => (current?.group.code === state.group.code ? state : current)),
      presentError
    );
  }, [deviceId, groupState?.group.code]);

  async function boot() {
    try {
      const storedDeviceId = await AsyncStorage.getItem(storageKeys.deviceId);
      const nextDeviceId = storedDeviceId ?? `device-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      if (!storedDeviceId) await AsyncStorage.setItem(storageKeys.deviceId, nextDeviceId);
      setDeviceId(nextDeviceId);

      const storedName = await AsyncStorage.getItem(storageKeys.profileName);
      if (storedName) {
        setDisplayName(storedName);
      }
      setKnownGroups(await loadKnownGroups());
      const lastGroupCode = await AsyncStorage.getItem(storageKeys.lastGroupCode);
      if (lastGroupCode) {
        try {
          const state = await withTimeout(fetchGroup(lastGroupCode, nextDeviceId), 8_000);
          await rememberKnownGroup(state);
          setGroupState(state);
        } catch (error) {
          await AsyncStorage.removeItem(storageKeys.lastGroupCode);
          setGroupState(null);
          presentError(error);
        }
      } else {
        setGroupState(null);
      }
    } catch (error) {
      presentError(error);
    } finally {
      setIsLoading(false);
    }
  }

  async function handleCreateGroup(
    navigation: Navigation,
    members: { name: string; isMe: boolean }[],
    password: string
  ) {
    await saveProfile();
    await runSaving(async () => {
      const trimmedPassword = password.trim();
      const state = await createGroup({
        name: groupName,
        members,
        deviceId,
        currency: "EUR",
        password: trimmedPassword || null
      });
      if (trimmedPassword) {
        await rememberStoredGroupPassword(state.group.code, trimmedPassword);
        setStoredGroupPassword(trimmedPassword);
      }
      await rememberKnownGroup(state);
      await rememberLastGroup(state.group.code);
      setGroupState(
        trimmedPassword
          ? { ...state, group: { ...state.group, hasPassword: true } }
          : state
      );
      navigation.replace("GroupView");
    });
  }

  function resetJoinFlow() {
    setJoinPassword("");
    setJoinNeedsPassword(false);
    setJoinStep("code");
    setJoinSlots([]);
    setJoinSelectedMemberId(null);
    setJoinCustomName("");
  }

  // Step 1: look up the group and reveal its member slots so the joiner can
  // pick who they are (or choose to add a new name).
  async function handleJoinContinue() {
    try {
      setIsSaving(true);
      const slots = await previewGroupMembers(joinCode, { password: joinPassword || undefined });
      const firstAvailable = slots.find((slot) => !slot.claimed);
      setJoinSlots(slots);
      setJoinSelectedMemberId(firstAvailable ? firstAvailable.id : null);
      setJoinCustomName(displayName.trim());
      setJoinNeedsPassword(false);
      setJoinStep("pick");
    } catch (error) {
      if (error instanceof JoinError && error.needsPassword) {
        setJoinNeedsPassword(true);
      }
      presentError(error);
    } finally {
      setIsSaving(false);
    }
  }

  // Step 2: claim the chosen slot (or create a new member) and enter the group.
  async function handleJoinClaim(navigation: Navigation) {
    const selectedSlot = joinSelectedMemberId
      ? joinSlots.find((slot) => slot.id === joinSelectedMemberId)
      : null;
    const name = (selectedSlot?.name ?? joinCustomName).trim() || displayName.trim() || DEFAULT_MEMBER_NAME;

    if (
      !joinSelectedMemberId &&
      isMemberNameTaken(
        joinSlots.map((slot) => slot.name),
        name
      )
    ) {
      presentError(DUPLICATE_MEMBER_NAME_ERROR);
      return;
    }

    try {
      setIsSaving(true);
      const state = await joinGroup(joinCode, {
        displayName: name,
        deviceId,
        password: joinPassword || undefined,
        memberId: joinSelectedMemberId ?? undefined
      });
      await AsyncStorage.setItem(storageKeys.profileName, name);
      setDisplayName(name);
      await rememberKnownGroup(state);
      await rememberLastGroup(state.group.code);
      if (joinPassword.trim() && state.group.hasPassword) {
        await rememberStoredGroupPassword(state.group.code, joinPassword.trim());
        setStoredGroupPassword(joinPassword.trim());
      }
      setGroupState(state);
      resetJoinFlow();
      navigation.replace("GroupView");
    } catch (error) {
      if (error instanceof JoinError && error.needsPassword) {
        setJoinNeedsPassword(true);
        setJoinStep("code");
      } else {
        // A slot may have just been taken by someone else — refresh the list.
        try {
          const slots = await previewGroupMembers(joinCode, { password: joinPassword || undefined });
          setJoinSlots(slots);
        } catch {
          // Keep the existing list if the refresh fails.
        }
      }
      presentError(error);
    } finally {
      setIsSaving(false);
    }
  }

  async function handleAddMember(name: string) {
    if (!groupState) return;
    if (!name.trim()) return;
    await runSettingsSaving("members", async () => {
      const state = await addMember(groupState.group.code, name, deviceId);
      setGroupState(state);
    });
  }

  async function handleRemoveMember(memberId: string) {
    if (!groupState) return;
    await runSettingsSaving("members", async () => {
      const state = await removeMember(groupState.group.code, memberId, deviceId);
      setGroupState(state);
    });
  }

  async function handleSaveGroupPassword(password: string | null) {
    if (!groupState || !isOnline) return;

    const hasPassword = groupState.group.hasPassword;
    const trimmed = password?.trim() ?? "";
    if (!trimmed && !hasPassword) return;

    await runSettingsSaving("password", async () => {
      await setGroupPassword(groupState.group.code, trimmed ? trimmed : null);
      await rememberStoredGroupPassword(groupState.group.code, trimmed ? trimmed : null);
      setStoredGroupPassword(trimmed ? trimmed : null);
      const state = await fetchGroup(groupState.group.code, deviceId);
      await rememberKnownGroup(state);
      setGroupState(state);
    });
  }

  async function handleSaveGroupName(nextGroupName: string) {
    if (!groupState) return;
    const trimmed = nextGroupName.trim();
    if (!trimmed || trimmed === groupState.group.name) return;

    await runSettingsSaving("groupName", async () => {
      const state = await updateGroupName(groupState.group.code, trimmed, deviceId);
      await rememberKnownGroup(state);
      setGroupState(state);
    });
  }

  async function handleRenameMember(memberId: string, nextName: string) {
    if (!groupState) return;
    const member = groupState.members.find((entry) => entry.id === memberId);
    if (!member) return;

    const trimmed = nextName.trim() || DEFAULT_MEMBER_NAME;
    if (trimmed === member.displayName) return;

    const isCurrent = memberId === groupState.currentMemberId;
    if (!isCurrent && member.claimed) return;

    await runSettingsSaving("members", async () => {
      const state = await renameMember(groupState.group.code, memberId, trimmed, deviceId);
      if (isCurrent) {
        await AsyncStorage.setItem(storageKeys.profileName, trimmed);
        setDisplayName(trimmed);
      }
      await rememberKnownGroup(state);
      setGroupState(state);
    });
  }

  function openSettings(navigation: Navigation) {
    if (!groupState) return;
    navigation.navigate("Settings");
  }

  async function openActivity(navigation: Navigation) {
    if (!groupState || isLoadingActivity) return;
    await refreshActivityLogs(groupState.group.code);
    navigation.navigate("Activity");
  }

  async function refreshActivityLogs(code = groupState?.group.code) {
    if (!code) return;
    try {
      setIsLoadingActivity(true);
      setActivityLogs(await fetchActivityLogs(code));
    } catch (error) {
      presentError(error);
    } finally {
      setIsLoadingActivity(false);
    }
  }

  function goBackOr(navigation: Navigation, fallback: keyof RootStackParamList) {
    if (navigation.canGoBack()) {
      navigation.goBack();
    } else {
      navigation.navigate(fallback);
    }
  }

  async function refreshActiveGroup(code: string) {
    try {
      const state = await fetchGroup(code, deviceId);
      await rememberKnownGroup(state);
      setGroupState((current) => (current?.group.code === code ? state : current));
    } catch {
      // Keep the current screen stable if a transient realtime refresh fails.
    }
  }

  async function handleSelectGroup(code: string, navigation: Navigation) {
    setLoadingGroupCode(code);
    try {
      const state = await fetchGroup(code, deviceId);
      await rememberKnownGroup(state);
      await rememberLastGroup(state.group.code);
      setGroupState(state);
      navigation.navigate("GroupView");
    } catch (error) {
      presentError(error);
    } finally {
      setLoadingGroupCode(null);
    }
  }

  async function handleExitGroup(code: string, navigation: Navigation) {
    await runSettingsSaving("exit", async () => {
      if (groupState?.group.code === code) {
        await leaveGroup(code, deviceId);
      }

      const nextGroups = knownGroups.filter((group) => group.code !== code);
      setKnownGroups(nextGroups);
      await AsyncStorage.setItem(storageKeys.knownGroups, JSON.stringify(nextGroups));

      if (groupState?.group.code !== code) return;
      await rememberStoredGroupPassword(code, null);

      if (nextGroups.length === 0) {
        setGroupState(null);
        await AsyncStorage.removeItem(storageKeys.lastGroupCode);
        navigation.replace("Groups");
        return;
      }

      const state = await fetchGroup(nextGroups[0].code, deviceId);
      await rememberLastGroup(state.group.code);
      setGroupState(state);
      navigation.replace("Groups");
    });
  }

  async function handleAddExpense(navigation: Navigation) {
    if (!groupState) return;
    const amountCents = amountToCents(expenseAmount);
    const payer = groupState.members.find((member) => member.id === paidByMemberId) ?? groupState.members[0];

    if (!payer) {
      presentError("Add a group member before adding entries.");
      return;
    }

    await runSaving(async () => {
      const isPayment = isSettlementPayment({
        paidByMemberId: payer.id,
        splitMemberIds
      });
      const paidForMember = isPayment
        ? groupState.members.find((member) => member.id === splitMemberIds[0])
        : null;
      const input = {
        description: isPayment ? expenseName.trim() || paymentDescription(paidForMember?.displayName) : expenseName,
        amountCents,
        paidByMemberId: payer.id,
        splitMemberIds
      };
      const state = editingExpenseId
        ? await updateExpense(groupState.group.code, editingExpenseId, input, deviceId)
        : await addExpense(groupState.group.code, input, deviceId);
      setGroupState(state);
      resetExpenseForm(state);
      navigation.replace("GroupView");
    });
  }

  async function handleDeleteExpense(navigation: Navigation) {
    if (!groupState || !editingExpenseId) return;

    await runSaving(async () => {
      const state = await deleteExpense(groupState.group.code, editingExpenseId, deviceId);
      setGroupState(state);
      resetExpenseForm(state);
      navigation.replace("GroupView");
    });
  }

  async function handleSettlePayment(settlement: Settlement) {
    if (!groupState || settlingKey) return;
    const key = settlementKey(settlement);
    setSettlingKey(key);

    try {
      const toName = groupState.members.find((member) => member.id === settlement.toMemberId)?.displayName;
      const state = await addExpense(
        groupState.group.code,
        {
          description: paymentDescription(toName),
          amountCents: settlement.amountCents,
          paidByMemberId: settlement.fromMemberId,
          splitMemberIds: [settlement.toMemberId]
        },
        deviceId
      );
      setGroupState(state);
    } catch (error) {
      presentError(error);
    } finally {
      setSettlingKey(null);
    }
  }

  function startNewExpense(navigation: Navigation) {
    if (!groupState) return;
    resetExpenseForm(groupState);
    navigation.navigate("Expense");
  }

  function startEditExpense(expense: Expense, navigation: Navigation) {
    setEditingExpenseId(expense.id);
    setExpenseAmount(String(expense.amountCents / 100));
    setExpenseName(expense.description === "Expense" ? "" : expense.description);
    setPaidByMemberId(expense.paidByMemberId);
    setSplitMemberIds(expense.splitMemberIds);
    navigation.navigate("Expense");
  }

  function resetExpenseForm(state: GroupState) {
    setEditingExpenseId(null);
    setExpenseAmount("");
    setExpenseName("");
    setPaidByMemberId(preferredPayerId(state));
    setSplitMemberIds(state.members.map((member) => member.id));
  }

  async function saveProfile() {
    const name = displayName.trim();
    if (name) {
      await AsyncStorage.setItem(storageKeys.profileName, name);
    }
  }

  async function rememberKnownGroup(state: GroupState) {
    const existing = await loadKnownGroups();
    const nextGroup = { code: state.group.code, name: state.group.name };
    const next = [nextGroup, ...existing.filter((group) => group.code !== nextGroup.code)];
    setKnownGroups(next);
    await AsyncStorage.setItem(storageKeys.knownGroups, JSON.stringify(next));
  }

  async function rememberLastGroup(code: string) {
    await AsyncStorage.setItem(storageKeys.lastGroupCode, code);
  }

  async function loadKnownGroups() {
    const raw = await AsyncStorage.getItem(storageKeys.knownGroups);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isKnownGroup);
    } catch {
      return [];
    }
  }

  async function runSaving(action: () => Promise<void>) {
    try {
      setIsSaving(true);
      await action();
    } catch (error) {
      presentError(error);
    } finally {
      setIsSaving(false);
    }
  }

  async function runSettingsSaving(scope: SettingsSaving, action: () => Promise<void>) {
    try {
      setSettingsSaving(scope);
      setIsSaving(true);
      await action();
    } catch (error) {
      presentError(error);
    } finally {
      setIsSaving(false);
      setSettingsSaving(null);
    }
  }

  function presentError(error: unknown) {
    setErrorMessage(getErrorMessage(error));
  }

  async function copyGroupCode(code: string) {
    if (copyingCode) return;
    setCopyingCode(code);
    try {
      await Clipboard.setStringAsync(code);
      Alert.alert("Code copied", code);
    } finally {
      setCopyingCode(null);
    }
  }

  function withTimeout<T>(promise: Promise<T>, ms: number) {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        setTimeout(() => reject(new Error("Loading took too long. Try again.")), ms);
      })
    ]);
  }

  offlineBannerSlot =
    connectionStatus === "connecting" ? (
      <ConnectingBanner />
    ) : connectionStatus === "offline" ? (
      <OfflineBanner />
    ) : null;

  if (isLoading) {
    return (
      <PaperProvider theme={paperTheme}>
        <SafeAreaView edges={["top", "bottom", "left", "right"]} style={styles.loadingScreen}>
          <ActivityIndicator color={colors.primary} />
          <StatusBar style={statusBarStyle} />
        </SafeAreaView>
      </PaperProvider>
    );
  }

  return (
    <GestureHandlerRootView style={styles.flex}>
      <PaperProvider theme={paperTheme}>
        <StatusBar style={statusBarStyle} />
        <NavigationContainer>
          <Stack.Navigator
            initialRouteName={groupState ? "GroupView" : "Groups"}
            screenOptions={{
              headerShown: false,
              animation: "slide_from_right",
              contentStyle: styles.screen
            }}
          >
          <Stack.Screen name="Groups">
            {({ navigation }) => (
              <GroupsScreen
                currentGroupCode={groupState?.group.code ?? ""}
                loadingGroupCode={loadingGroupCode}
                copyingCode={copyingCode}
                knownGroups={knownGroups}
                onNewGroup={() => navigation.navigate("NewGroup")}
                onJoinGroup={() => navigation.navigate("JoinGroup")}
                onSelectGroup={(code) => handleSelectGroup(code, navigation)}
                onCopyCode={copyGroupCode}
              />
            )}
          </Stack.Screen>
          <Stack.Screen name="NewGroup">
            {({ navigation }) => (
              <NewGroupScreen
                groupName={groupName}
                displayName={displayName}
                isSaving={isSaving}
                isOnline={isOnline}
                onGroupNameChange={setGroupName}
                onNameChange={setDisplayName}
                onCreate={(members, password) => handleCreateGroup(navigation, members, password)}
                onBack={() => goBackOr(navigation, "Groups")}
              />
            )}
          </Stack.Screen>
          <Stack.Screen name="JoinGroup">
            {({ navigation }) => (
              <JoinGroupScreen
                step={joinStep}
                joinCode={joinCode}
                displayName={displayName}
                isSaving={isSaving}
                isOnline={isOnline}
                password={joinPassword}
                needsPassword={joinNeedsPassword}
                slots={joinSlots}
                selectedMemberId={joinSelectedMemberId}
                customName={joinCustomName}
                onCodeChange={(value) => {
                  setJoinCode(value);
                  setJoinNeedsPassword(false);
                }}
                onPasswordChange={setJoinPassword}
                onNameChange={setDisplayName}
                onContinue={handleJoinContinue}
                onSelectSlot={setJoinSelectedMemberId}
                onCustomNameChange={setJoinCustomName}
                onClaim={() => handleJoinClaim(navigation)}
                onBack={() => {
                  if (joinStep === "pick") {
                    setJoinStep("code");
                  } else {
                    resetJoinFlow();
                    goBackOr(navigation, "Groups");
                  }
                }}
              />
            )}
          </Stack.Screen>
          <Stack.Screen name="GroupView">
            {({ navigation }) =>
              groupState ? (
                <GroupViewScreen
                  groupState={groupState}
                  copyingCode={copyingCode}
                  onShare={() => copyGroupCode(groupState.group.code)}
                  onExpense={() => startNewExpense(navigation)}
                  onSettle={() => navigation.navigate("Settle")}
                  onBack={() => goBackOr(navigation, "Groups")}
                  onSettings={() => openSettings(navigation)}
                  onEditExpense={(expense) => startEditExpense(expense, navigation)}
                />
              ) : (
                <GroupsScreen
                  currentGroupCode=""
                  loadingGroupCode={loadingGroupCode}
                  copyingCode={copyingCode}
                  knownGroups={knownGroups}
                  onNewGroup={() => navigation.navigate("NewGroup")}
                  onJoinGroup={() => navigation.navigate("JoinGroup")}
                  onSelectGroup={(code) => handleSelectGroup(code, navigation)}
                  onCopyCode={copyGroupCode}
                />
              )
            }
          </Stack.Screen>
          <Stack.Screen name="Settle">
            {({ navigation }) =>
              groupState ? (
                <SettleScreen
                  groupState={groupState}
                  settlingKey={settlingKey}
                  onSettlePayment={handleSettlePayment}
                  onBack={() => goBackOr(navigation, "GroupView")}
                />
              ) : null
            }
          </Stack.Screen>
          <Stack.Screen name="Settings">
            {({ navigation }) =>
              groupState ? (
                <SettingsScreen
                  groupState={groupState}
                  isSaving={isSaving}
                  settingsSaving={settingsSaving}
                  isOnline={isOnline}
                  isLoadingActivity={isLoadingActivity}
                  copyingCode={copyingCode}
                  onAddMember={handleAddMember}
                  onRemoveMember={handleRemoveMember}
                  onRenameMember={handleRenameMember}
                  onShare={() => copyGroupCode(groupState.group.code)}
                  onGroupNameSave={handleSaveGroupName}
                  onPasswordSave={handleSaveGroupPassword}
                  storedGroupPassword={storedGroupPassword}
                  onActivity={() => openActivity(navigation)}
                  onExit={() => handleExitGroup(groupState.group.code, navigation)}
                  onBack={() => goBackOr(navigation, "GroupView")}
                />
              ) : (
                <GroupsScreen
                  currentGroupCode=""
                  loadingGroupCode={loadingGroupCode}
                  copyingCode={copyingCode}
                  knownGroups={knownGroups}
                  onNewGroup={() => navigation.navigate("NewGroup")}
                  onJoinGroup={() => navigation.navigate("JoinGroup")}
                  onSelectGroup={(code) => handleSelectGroup(code, navigation)}
                  onCopyCode={copyGroupCode}
                />
              )
            }
          </Stack.Screen>
          <Stack.Screen name="Activity">
            {({ navigation }) =>
              groupState ? (
                <ActivityScreen
                  logs={activityLogs}
                  isLoading={isLoadingActivity}
                  onRefresh={() => refreshActivityLogs(groupState.group.code)}
                  onBack={() => goBackOr(navigation, "Settings")}
                />
              ) : null
            }
          </Stack.Screen>
          <Stack.Screen name="Expense">
            {({ navigation }) =>
              groupState ? (
                <ExpenseScreen
                  groupState={groupState}
                  amount={expenseAmount}
                  name={expenseName}
                  paidByMemberId={paidByMemberId}
                  isEditing={!!editingExpenseId}
                  splitMemberIds={splitMemberIds}
                  isSaving={isSaving}
                  onAmountChange={(value) => setExpenseAmount(sanitizeAmountInput(value))}
                  onNameChange={setExpenseName}
                  onSelectPayer={setPaidByMemberId}
                  onToggleMember={(memberId) =>
                    setSplitMemberIds((current) =>
                      current.includes(memberId)
                        ? current.filter((id) => id !== memberId)
                        : [...current, memberId]
                    )
                  }
                  onSubmit={() => handleAddExpense(navigation)}
                  onDelete={() => handleDeleteExpense(navigation)}
                  onBack={() => {
                    if (groupState) resetExpenseForm(groupState);
                    goBackOr(navigation, "GroupView");
                  }}
                />
              ) : null
            }
          </Stack.Screen>
          </Stack.Navigator>
        </NavigationContainer>
        <Snackbar
          visible={!!errorMessage}
          onDismiss={() => setErrorMessage("")}
          duration={4500}
          style={styles.errorSnackbar}
          action={{
            label: "Dismiss",
            onPress: () => setErrorMessage("")
          }}
        >
          {errorMessage}
        </Snackbar>
      </PaperProvider>
    </GestureHandlerRootView>
  );
}

function NewGroupScreen(props: {
  groupName: string;
  displayName: string;
  isSaving: boolean;
  isOnline: boolean;
  onGroupNameChange: (value: string) => void;
  onNameChange: (value: string) => void;
  onCreate: (members: { name: string; isMe: boolean }[], password: string) => void;
  onBack: () => void;
}) {
  const creatorIdRef = useRef(`draft_creator_${Date.now().toString(36)}`);
  const [password, setPassword] = useState("");
  const [members, setMembers] = useState<MemberListEntry[]>(() => [
    {
      id: creatorIdRef.current,
      displayName: props.displayName.trim() || DEFAULT_MEMBER_NAME,
      isCurrent: true,
      claimed: true
    }
  ]);

  useEffect(() => {
    if (!props.displayName.trim()) {
      props.onNameChange(DEFAULT_MEMBER_NAME);
    }
  }, []);

  useEffect(() => {
    setMembers((current) =>
      current.map((member) =>
        member.isCurrent ? { ...member, displayName: props.displayName.trim() || DEFAULT_MEMBER_NAME } : member
      )
    );
  }, [props.displayName]);

  async function handleAddMember(name: string) {
    setMembers((current) => [
      ...current,
      {
        id: draftMemberId(),
        displayName: name,
        isCurrent: false,
        claimed: false
      }
    ]);
  }

  function handleRemoveMember(memberId: string) {
    setMembers((current) => current.filter((member) => member.id !== memberId));
  }

  async function handleRenameMember(memberId: string, name: string) {
    if (memberId === creatorIdRef.current) {
      props.onNameChange(name);
    }
    setMembers((current) =>
      current.map((entry) => (entry.id === memberId ? { ...entry, displayName: name } : entry))
    );
  }

  const create = () => {
    const payload = members
      .map((member) => ({
        name: member.displayName.trim() || DEFAULT_MEMBER_NAME,
        isMe: member.isCurrent
      }))
      .filter((member) => member.isMe || member.name.length > 0);
    props.onCreate(payload, password);
  };

  const passwordInvalid = password.trim().length > 0 && !isGroupPasswordValid(password);
  const canCreate = !passwordInvalid;

  return (
    <Page title="New group" onBack={props.onBack}>
      <LabeledInput
        autoFocus
        label="Name of group"
        value={props.groupName}
        placeholder="Lisbon trip"
        onChangeText={props.onGroupNameChange}
      />
      <MembersSection
        members={members}
        isSaving={props.isSaving}
        membersSaving={false}
        onAddMember={handleAddMember}
        onRemoveMember={handleRemoveMember}
        onRenameMember={handleRenameMember}
      />
      <View style={styles.panel}>
        <LabeledInput
          label="Group password (optional)"
          value={password}
          placeholder={`At least ${MIN_GROUP_PASSWORD_LENGTH} characters`}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={setPassword}
        />
      </View>
      {passwordInvalid ? (
        <Text style={styles.fieldError}>
          Password must be at least {MIN_GROUP_PASSWORD_LENGTH} characters
        </Text>
      ) : null}
      {password.trim() && !props.isOnline ? (
        <OfflineNotice action="Setting a group password" />
      ) : null}
      <ActionButton
        icon={({ color, size }) => <Users color={color} size={size} />}
        label="Create"
        loading={props.isSaving}
        disabled={!canCreate}
        onPress={create}
      />
    </Page>
  );
}

function JoinGroupScreen(props: {
  step: "code" | "pick";
  joinCode: string;
  displayName: string;
  isSaving: boolean;
  isOnline: boolean;
  password: string;
  needsPassword: boolean;
  slots: GroupSlot[];
  selectedMemberId: string | null;
  customName: string;
  onCodeChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onNameChange: (value: string) => void;
  onContinue: () => void;
  onSelectSlot: (memberId: string | null) => void;
  onCustomNameChange: (value: string) => void;
  onClaim: () => void;
  onBack: () => void;
}) {
  if (props.step === "pick") {
    const usingCustom = props.selectedMemberId === null;
    const orderedSlots = sortJoinSlotsForDisplay(props.slots);
    const customNameDuplicate =
      usingCustom &&
      isMemberNameTaken(
        props.slots.map((slot) => slot.name),
        props.customName
      );
    const canJoin =
      props.isOnline &&
      (!usingCustom || (props.customName.trim().length > 0 && !customNameDuplicate));
    return (
      <Page title="Who are you?" onBack={props.onBack}>
        <Text style={styles.sectionLabel}>Pick your name</Text>
        <View style={styles.panel}>
          {orderedSlots.map((slot) => (
            <TactilePressable
              key={slot.id}
              disabled={slot.claimed || props.isSaving}
              style={[
                styles.pickRow,
                slot.claimed && styles.pickRowTaken,
                !slot.claimed && props.selectedMemberId === slot.id && styles.listItemSelected
              ]}
              onPress={() => props.onSelectSlot(slot.id)}
            >
              <MemberIdentityBadge name={slot.name} isCurrent={false} claimed={slot.claimed} />
              <Text style={[styles.pickName, slot.claimed && styles.pickNameTaken]} numberOfLines={1}>
                {slot.name}
              </Text>
              {slot.claimed ? (
                <Lock color={colors.iconMuted} size={17} strokeWidth={2.2} />
              ) : props.selectedMemberId === slot.id ? (
                <Check color={colors.primary} size={20} />
              ) : null}
            </TactilePressable>
          ))}
          <View style={[styles.pickRow, usingCustom && styles.listItemSelected]}>
            {usingCustom ? (
              <TextInput
                value={props.customName}
                onChangeText={props.onCustomNameChange}
                autoFocus
                editable={!props.isSaving}
                placeholder="Alex"
                placeholderTextColor={colors.iconMuted}
                returnKeyType="done"
                onSubmitEditing={canJoin ? props.onClaim : undefined}
                style={[styles.joinCustomNameInput, customNameDuplicate && styles.joinCustomNameInputError]}
                selectionColor={colors.primary}
              />
            ) : (
              <TactilePressable style={styles.pickRowPressable} onPress={() => props.onSelectSlot(null)}>
                <Text style={styles.pickName}>Someone else</Text>
              </TactilePressable>
            )}
            {usingCustom ? <Check color={colors.primary} size={20} /> : null}
          </View>
        </View>
        {customNameDuplicate ? <Text style={styles.fieldError}>{DUPLICATE_MEMBER_NAME_ERROR}</Text> : null}
        <ActionButton
          icon={({ color, size }) => <Check color={color} size={size} />}
          label="Join"
          loading={props.isSaving}
          disabled={!canJoin}
          onPress={props.onClaim}
        />
      </Page>
    );
  }

  return (
    <Page title="Join group" onBack={props.onBack}>
      <LabeledInput
        autoFocus
        label="Code"
        value={props.joinCode}
        placeholder="A7K9Q"
        maxLength={5}
        autoCapitalize="characters"
        onChangeText={(value) => props.onCodeChange(value.toUpperCase())}
      />
      {props.needsPassword ? (
        <LabeledInput
          label="Group password"
          value={props.password}
          placeholder="Enter password"
          secureTextEntry
          autoCapitalize="none"
          onChangeText={props.onPasswordChange}
        />
      ) : null}
      {props.isOnline ? null : <OfflineNotice action="Joining a group" />}
      <ActionButton
        icon={({ color, size }) => <ChevronRight color={color} size={size} />}
        label="Continue"
        loading={props.isSaving}
        disabled={!props.isOnline || props.joinCode.trim().length === 0}
        onPress={props.onContinue}
      />
    </Page>
  );
}

function OfflineNotice({ action }: { action: string }) {
  return <Text style={styles.offlineNotice}>{action} needs you to be online.</Text>;
}

function ConnectingBanner() {
  return (
    <View style={styles.offlineBanner} accessibilityRole="text" accessibilityLabel="Connecting">
      <View style={styles.offlineBannerRow}>
        <ActivityIndicator color={colors.warning} size="small" />
        <Text style={styles.offlineBannerText}>Connecting…</Text>
      </View>
    </View>
  );
}

function OfflineBanner() {
  return (
    <View style={styles.offlineBanner} accessibilityRole="text" accessibilityLabel="You're offline. Changes sync when you're back online">
      <View style={styles.offlineBannerRow}>
        <WifiOff color={colors.warning} size={14} />
        <Text style={styles.offlineBannerText}>You're offline</Text>
      </View>
      <Text style={styles.offlineBannerHint}>Changes sync when you're back online</Text>
    </View>
  );
}

function GroupViewScreen({
  groupState,
  copyingCode,
  onShare,
  onExpense,
  onSettle,
  onBack,
  onSettings,
  onEditExpense
}: {
  groupState: GroupState;
  copyingCode: string | null;
  onShare: () => void;
  onExpense: () => void;
  onSettle: () => void;
  onBack: () => void;
  onSettings: () => void;
  onEditExpense: (expense: Expense) => void;
}) {
  const hasSettlements = calculateSettlements(groupState.balances).length > 0;

  return (
    <Page
      onBack={onBack}
      centerAction={
        <CodeHeaderButton
          code={groupState.group.code}
          loading={copyingCode === groupState.group.code}
          onPress={onShare}
        />
      }
      rightAction={<SettingsButton onPress={onSettings} />}
    >
      <ActiveGroupDetails groupState={groupState} />
      <View style={styles.buttonRow}>
        <ActionButton icon={({ color, size }) => <Plus color={color} size={size} />} label="Add" onPress={onExpense} />
        {hasSettlements ? <ActionButton compact variant="secondary" label="Settle" onPress={onSettle} /> : null}
      </View>
      <Balances
        balances={groupState.balances}
        currency={groupState.group.currency}
        currentMemberId={groupState.currentMemberId}
      />
      <Expenses
        expenses={groupState.expenses}
        members={groupState.members}
        currency={groupState.group.currency}
        onEditExpense={onEditExpense}
      />
    </Page>
  );
}

function GroupsScreen(props: {
  currentGroupCode: string;
  loadingGroupCode: string | null;
  copyingCode: string | null;
  knownGroups: KnownGroup[];
  onNewGroup: () => void;
  onJoinGroup: () => void;
  onSelectGroup: (code: string) => void;
  onCopyCode: (code: string) => void;
}) {
  return (
    <Page contentStyle={styles.centeredPageContent}>
      <View style={styles.groupsCenterBlock}>
        <AppLogo />
        {props.knownGroups.length > 0 ? (
          <View style={styles.panel}>
            {props.knownGroups.map((knownGroup) => (
              <GroupListItem
                key={knownGroup.code}
                group={knownGroup}
                isCurrent={knownGroup.code === props.currentGroupCode}
                isLoading={knownGroup.code === props.loadingGroupCode}
                isCopying={knownGroup.code === props.copyingCode}
                onPress={() => props.onSelectGroup(knownGroup.code)}
                onCopyCode={() => props.onCopyCode(knownGroup.code)}
              />
            ))}
          </View>
        ) : null}

        <View style={styles.buttonRow}>
          <ActionButton icon={({ color, size }) => <Users color={color} size={size} />} label="New Group" onPress={props.onNewGroup} />
          <ActionButton variant="secondary" label="Join Group" onPress={props.onJoinGroup} />
        </View>
      </View>
    </Page>
  );
}

function GroupListItem({
  group,
  isCurrent,
  isLoading,
  isCopying,
  onPress,
  onCopyCode
}: {
  group: KnownGroup;
  isCurrent: boolean;
  isLoading: boolean;
  isCopying: boolean;
  onPress: () => void;
  onCopyCode: () => void;
}) {
  return (
    <TactilePressable
      style={[
        styles.listItem,
        isCurrent && styles.listItemSelected,
        isLoading && styles.listItemLoading
      ]}
      onPress={isLoading ? undefined : onPress}
      disabled={isLoading}
    >
      <View style={styles.listTextBlock}>
        <Text style={styles.listTitle} numberOfLines={2}>
          {group.name}
        </Text>
        <TactilePressable
          accessibilityLabel="Copy group code"
          style={styles.groupCodePressable}
          onPress={isCopying ? undefined : onCopyCode}
          disabled={isCopying}
        >
          {isCopying ? (
            <ActivityIndicator color={colors.primary} size="small" />
          ) : (
            <Text style={styles.meta} numberOfLines={1}>
              {group.code}
            </Text>
          )}
        </TactilePressable>
      </View>
      <View style={styles.rowAccessory}>
        {
        isLoading ? (
          <View style={styles.rowSpinner}>
            <ActivityIndicator color={colors.primary} size="small" />
          </View>
        ) : isCurrent ? (
          <RowValue value="Current" tone="positive" />
        ) : null
        }
      </View>
    </TactilePressable>
  );
}

function ActiveGroupDetails(props: {
  groupState: GroupState;
}) {
  const { group } = props.groupState;

  return (
    <>
      <View style={styles.groupHeader}>
        <View style={styles.headerLine}>
          <Text style={styles.groupTitle} numberOfLines={2}>{group.name}</Text>
        </View>
      </View>

    </>
  );
}

function CodeHeaderButton({
  code,
  loading = false,
  onPress
}: {
  code: string;
  loading?: boolean;
  onPress: () => void;
}) {
  return (
    <TactilePressable
      accessibilityLabel="Copy group code"
      style={styles.headerCodeButton}
      onPress={loading ? undefined : onPress}
      disabled={loading}
    >
      {loading ? (
        <ActivityIndicator color={colors.primary} size="small" />
      ) : (
        <Text style={styles.headerCode}>{code}</Text>
      )}
    </TactilePressable>
  );
}

function AppLogo() {
  return (
    <View style={styles.logoWrap}>
      <View style={styles.logoMark}>
        <View style={styles.logoLine} />
        <View style={styles.logoLine} />
        <View style={[styles.logoLine, styles.logoLineShort]} />
        <View style={styles.logoDot} />
      </View>
      <Text style={styles.logoText}>SplitPay</Text>
    </View>
  );
}

function MemberIdentityBadge(props: { name: string; isCurrent: boolean; claimed: boolean }) {
  if (props.isCurrent) {
    return (
      <View style={[styles.memberAvatar, styles.memberAvatarYou]}>
        <Text style={styles.memberAvatarInitial}>{props.name.slice(0, 1).toUpperCase()}</Text>
      </View>
    );
  }

  if (props.claimed) {
    return (
      <View style={[styles.memberAvatar, styles.memberAvatarClaimed]}>
        <UserCheck color={colors.primary} size={15} strokeWidth={2.4} />
      </View>
    );
  }

  return (
    <View style={[styles.memberAvatar, styles.memberAvatarOpen]}>
      <User color={colors.iconMuted} size={15} strokeWidth={2} />
    </View>
  );
}

function MemberListName(props: {
  value: string;
  placeholder: string;
  editable: boolean;
  saving: boolean;
  deleteOnEmpty?: boolean;
  textStyle?: StyleProp<TextStyle>;
  youSuffix?: boolean;
  onSave: (nextValue: string) => void | Promise<void>;
  onDelete?: () => void | Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(props.value);
  const committingRef = useRef(false);

  useEffect(() => {
    if (!editing) setDraft(props.value);
  }, [props.value, editing]);

  async function commit() {
    if (committingRef.current || props.saving || !props.editable) return;
    committingRef.current = true;
    const trimmed = draft.trim();
    setEditing(false);
    try {
      if (props.deleteOnEmpty && !trimmed) {
        await props.onDelete?.();
        setDraft(props.value);
        return;
      }
      const next = props.deleteOnEmpty ? trimmed : trimmed || props.placeholder;
      if (next !== props.value.trim()) {
        await props.onSave(next);
      } else {
        setDraft(props.value);
      }
    } finally {
      committingRef.current = false;
    }
  }

  function startEditing() {
    if (!props.editable || props.saving || editing) return;
    setDraft(props.value);
    setEditing(true);
  }

  if (!props.editable) {
    return (
      <Text style={props.textStyle} numberOfLines={1}>
        {props.value}
      </Text>
    );
  }

  if (editing) {
    return (
      <TextInput
        value={draft}
        onChangeText={setDraft}
        autoFocus
        placeholder={props.deleteOnEmpty ? undefined : props.placeholder}
        placeholderTextColor={props.deleteOnEmpty ? undefined : colors.iconMuted}
        returnKeyType="done"
        onSubmitEditing={() => void commit()}
        onBlur={() => void commit()}
        style={styles.memberListNameInput}
        selectionColor={colors.primary}
      />
    );
  }

  return (
    <Pressable style={styles.memberListNamePressable} onPress={startEditing} disabled={props.saving}>
      <Text style={[props.textStyle, styles.memberListNameText]} numberOfLines={1}>
        {props.value}
        {props.youSuffix ? <Text style={styles.currentUserYouSuffix}>{"  (you)"}</Text> : null}
      </Text>
      {props.saving ? (
        <ActivityIndicator color={colors.primary} size="small" style={styles.memberListNameSpinner} />
      ) : null}
    </Pressable>
  );
}

type MemberListEntry = {
  id: string;
  displayName: string;
  isCurrent: boolean;
  claimed: boolean;
};

function MembersSection(props: {
  members: MemberListEntry[];
  isSaving: boolean;
  membersSaving: boolean;
  onAddMember: (name: string) => void | Promise<void>;
  onRemoveMember: (memberId: string) => void;
  onRenameMember: (memberId: string, name: string) => void | Promise<void>;
}) {
  const [isAdding, setIsAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [addError, setAddError] = useState("");
  const [isCommittingAdd, setIsCommittingAdd] = useState(false);
  const committingRef = useRef(false);
  const cancelRef = useRef(false);

  async function commit(keepOpen: boolean) {
    if (cancelRef.current) {
      cancelRef.current = false;
      return;
    }
    if (committingRef.current || props.isSaving) return;
    committingRef.current = true;
    const name = draft.trim();
    try {
      if (!name) {
        setIsAdding(false);
        setDraft("");
        setAddError("");
        return;
      }
      if (isMemberNameTaken(props.members.map((member) => member.displayName), name)) {
        setAddError(DUPLICATE_MEMBER_NAME_ERROR);
        return;
      }
      setAddError("");
      setIsCommittingAdd(true);
      await props.onAddMember(name);
      setDraft("");
      if (!keepOpen) setIsAdding(false);
    } finally {
      committingRef.current = false;
      setIsCommittingAdd(false);
    }
  }

  function startAdding() {
    if (props.isSaving) return;
    setIsAdding(true);
    setDraft("");
    setAddError("");
  }

  function cancelAdding() {
    cancelRef.current = true;
    setIsAdding(false);
    setDraft("");
    setAddError("");
  }

  const orderedMembers = sortMemberListForDisplay(props.members);

  return (
    <>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionLabelInline}>Members</Text>
        {props.membersSaving ? (
          <ActivityIndicator color={colors.primary} size="small" style={styles.sectionHeaderSpinner} />
        ) : isAdding ? null : (
          <TactilePressable
            accessibilityLabel="Add member"
            style={styles.sectionAddButton}
            onPress={startAdding}
            disabled={props.isSaving}
          >
            <Plus color={colors.primary} size={18} strokeWidth={2.5} />
            <Text style={styles.sectionAddLabel}>Add</Text>
          </TactilePressable>
        )}
      </View>
      <View style={styles.panel}>
        {orderedMembers.map((member) => {
          const canRename = member.isCurrent || !member.claimed;
          return (
            <View key={member.id} style={[styles.pickRow, member.isCurrent && styles.listItemSelected]}>
              <MemberIdentityBadge
                name={member.displayName}
                isCurrent={member.isCurrent}
                claimed={member.claimed}
              />
              <MemberListName
                value={member.displayName}
                placeholder={DEFAULT_MEMBER_NAME}
                editable={canRename}
                saving={props.membersSaving}
                deleteOnEmpty={!member.isCurrent && !member.claimed}
                youSuffix={member.isCurrent}
                textStyle={[
                  styles.pickName,
                  member.isCurrent && styles.currentUserName,
                  !member.isCurrent && !member.claimed && styles.memberNameUnclaimed
                ]}
                onSave={(name) => props.onRenameMember(member.id, name)}
                onDelete={() => props.onRemoveMember(member.id)}
              />
            </View>
          );
        })}
        {isAdding ? (
          <View style={styles.memberAddBlock}>
            <View style={styles.memberAddRow}>
              <TextInput
                value={draft}
                onChangeText={(value) => {
                  setDraft(value);
                  if (addError) setAddError("");
                }}
                autoFocus
                editable={!props.isSaving && !isCommittingAdd}
                placeholder={DEFAULT_MEMBER_NAME}
                placeholderTextColor={colors.iconMuted}
                returnKeyType="done"
                onSubmitEditing={() => void commit(true)}
                onBlur={() => void commit(false)}
                style={[styles.memberAddInput, addError ? styles.memberAddInputError : null]}
                selectionColor={colors.primary}
              />
              {isCommittingAdd || props.membersSaving ? (
                <ActivityIndicator color={colors.primary} size="small" />
              ) : (
                <BareIconButton label="Cancel adding member" onPress={cancelAdding}>
                  <X color={colors.muted} size={20} />
                </BareIconButton>
              )}
            </View>
            {addError ? <Text style={styles.fieldError}>{addError}</Text> : null}
          </View>
        ) : null}
      </View>
    </>
  );
}

function SettingsScreen(props: {
  groupState: GroupState;
  isSaving: boolean;
  settingsSaving: SettingsSaving;
  isOnline: boolean;
  isLoadingActivity: boolean;
  copyingCode: string | null;
  onAddMember: (name: string) => void | Promise<void>;
  onRemoveMember: (memberId: string) => void;
  onRenameMember: (memberId: string, name: string) => void | Promise<void>;
  onShare: () => void;
  onGroupNameSave: (value: string) => void | Promise<void>;
  onPasswordSave: (password: string | null) => void | Promise<void>;
  storedGroupPassword: string | null;
  onActivity: () => void;
  onExit: () => void;
  onBack: () => void;
}) {
  const hasPassword = props.groupState.group.hasPassword;
  const currentMemberId = props.groupState.currentMemberId;

  return (
    <Page title="Settings" onBack={props.onBack}>
      <View style={styles.panel}>
        <InlineEditableField
          label="Group name"
          value={props.groupState.group.name}
          placeholder="Lisbon trip"
          saving={props.settingsSaving === "groupName"}
          onSave={props.onGroupNameSave}
        />
      </View>

      <MembersSection
        members={props.groupState.members.map((member) => ({
          id: member.id,
          displayName: member.displayName,
          isCurrent: member.id === currentMemberId,
          claimed: member.claimed
        }))}
        isSaving={props.isSaving}
        membersSaving={props.settingsSaving === "members"}
        onAddMember={props.onAddMember}
        onRemoveMember={props.onRemoveMember}
        onRenameMember={props.onRenameMember}
      />

      <View style={styles.panel}>
        <SettingRow
          label="Group code"
          value={props.groupState.group.code}
          onPress={props.onShare}
          accessory="copy"
          loading={props.copyingCode === props.groupState.group.code}
        />
        <InlineEditablePassword
          hasPassword={hasPassword}
          storedPassword={props.storedGroupPassword}
          isOnline={props.isOnline}
          saving={props.settingsSaving === "password"}
          disabled={props.isSaving}
          onSave={props.onPasswordSave}
        />
        <SettingRow
          label="Activity log"
          value="View"
          loading={props.isLoadingActivity}
          onPress={props.onActivity}
        />
      </View>
      {props.isOnline ? null : <OfflineNotice action="Changing the group password" />}

      <ActionButton
        variant="danger"
        label="Exit group"
        loading={props.settingsSaving === "exit"}
        disabled={props.isSaving && props.settingsSaving !== "exit"}
        onPress={props.onExit}
      />
    </Page>
  );
}

function ActivityScreen(props: {
  logs: ActivityLog[];
  isLoading: boolean;
  onRefresh: () => void;
  onBack: () => void;
}) {
  return (
    <Page title="Activity" onBack={props.onBack}>
      <View style={styles.panel}>
        {props.isLoading && props.logs.length === 0 ? (
          <View style={styles.loadingPanel}>
            <ActivityIndicator color={colors.primary} />
          </View>
        ) : props.logs.length === 0 ? (
          <Text style={styles.emptyText}>No activity yet.</Text>
        ) : (
          props.logs.map((log) => (
            <View key={log.id} style={styles.activityItem}>
              <ActivitySummary log={log} />
              <Text style={styles.activityMeta}>{formatDateTime(log.createdAt)}</Text>
            </View>
          ))
        )}
      </View>
      <ActionButton variant="secondary" label="Refresh" loading={props.isLoading} onPress={props.onRefresh} />
    </Page>
  );
}

function ActivitySummary({ log }: { log: ActivityLog }) {
  const expenseName = typeof log.metadata.description === "string" ? log.metadata.description : "";
  const userName = log.actorName ?? "";
  const actorLabel = userName || "Someone";
  const summary = withoutLeadingActor(log.summary, userName);
  const highlights = [
    ...(userName ? [{ value: userName, style: styles.activityUserName }] : []),
    ...(expenseName ? [{ value: expenseName, style: styles.activityExpenseName }] : [])
  ];

  const parts = splitActivitySummary(summary, highlights);

  return (
    <Text style={styles.activityTitle}>
      <Text style={styles.activityBy}>by </Text>
      <Text style={styles.activityUserName}>{actorLabel}</Text>
      <Text style={styles.activityBy}> · </Text>
      {parts.map((part, index) =>
        part.style ? (
          <Text key={`${part.text}-${index}`} style={part.style}>
            {part.text}
          </Text>
        ) : (
          part.text
        )
      )}
    </Text>
  );
}

function SettleScreen(props: {
  groupState: GroupState;
  settlingKey: string | null;
  onSettlePayment: (settlement: Settlement) => void;
  onBack: () => void;
}) {
  const settlements = calculateSettlements(props.groupState.balances);
  const nameByMemberId = new Map(props.groupState.members.map((member) => [member.id, member.displayName]));

  return (
    <Page title="Settle" onBack={props.onBack}>
      <View style={styles.panel}>
        {settlements.length === 0 ? (
          <Text style={styles.emptyText}>Everyone is settled.</Text>
        ) : (
          settlements.map((settlement) => {
            const key = settlementKey(settlement);
            const isSettling = props.settlingKey === key;
            const isBusy = props.settlingKey !== null;
            return (
            <View
              key={key}
              style={styles.settleItem}
            >
              <View style={styles.settleTextBlock}>
                <SettleSummary
                  fromName={nameByMemberId.get(settlement.fromMemberId) ?? "Someone"}
                  toName={nameByMemberId.get(settlement.toMemberId) ?? "Someone"}
                />
              </View>
              <RowValue value={money(settlement.amountCents, props.groupState.group.currency)} dedicated />
              <SmallButton
                label="Settle"
                loading={isSettling}
                disabled={isBusy && !isSettling}
                onPress={() => props.onSettlePayment(settlement)}
              />
            </View>
            );
          })
        )}
      </View>
    </Page>
  );
}

function SettleSummary({ fromName, toName }: { fromName: string; toName: string }) {
  return (
    <Text style={styles.settleTitle}>
      <Text style={styles.settleUserName}>{fromName}</Text>
      {" pays "}
      <Text style={styles.settleUserName}>{toName}</Text>
    </Text>
  );
}

function InlineEditableField({
  label,
  value,
  placeholder,
  saving = false,
  onSave
}: {
  label: string;
  value: string;
  placeholder: string;
  saving?: boolean;
  onSave: (nextValue: string) => void | Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const committingRef = useRef(false);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  async function commit() {
    if (committingRef.current || saving) return;
    committingRef.current = true;
    const next = draft.trim() || placeholder;
    setEditing(false);
    try {
      if (next !== value.trim()) {
        await onSave(next);
      } else {
        setDraft(value);
      }
    } finally {
      committingRef.current = false;
    }
  }

  function startEditing() {
    if (saving || editing) return;
    setDraft(value);
    setEditing(true);
  }

  return (
    <Pressable
      style={[styles.inlineEditableRow, editing && styles.inlineEditableRowActive]}
      onPress={startEditing}
      disabled={editing || saving}
    >
      <Text style={styles.inlineEditableLabel}>{label}</Text>
      {editing ? (
        <TextInput
          value={draft}
          onChangeText={setDraft}
          autoFocus
          placeholder={placeholder}
          placeholderTextColor={colors.iconMuted}
          returnKeyType="done"
          onSubmitEditing={() => void commit()}
          onBlur={() => void commit()}
          style={styles.inlineEditableInput}
          selectionColor={colors.primary}
        />
      ) : (
        <View style={styles.inlineEditableValueRow}>
          <Text
            style={[styles.inlineEditableValue, !value && styles.inlineEditablePlaceholder]}
            numberOfLines={2}
          >
            {value || placeholder}
          </Text>
          {saving ? <ActivityIndicator color={colors.primary} size="small" /> : null}
        </View>
      )}
    </Pressable>
  );
}

function InlineEditablePassword(props: {
  hasPassword: boolean;
  storedPassword: string | null;
  isOnline: boolean;
  saving: boolean;
  disabled: boolean;
  onSave: (password: string | null) => void | Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const committingRef = useRef(false);

  async function commit() {
    if (committingRef.current || props.disabled) return;
    committingRef.current = true;
    const trimmed = draft.trim();
    try {
      if (!trimmed) {
        if (props.hasPassword) await props.onSave(null);
        setEditing(false);
        setDraft("");
        return;
      }
      if (trimmed === (props.storedPassword ?? "") && props.hasPassword) {
        setEditing(false);
        setDraft(props.storedPassword ?? "");
        return;
      }
      await props.onSave(trimmed);
      setEditing(false);
      setDraft("");
    } finally {
      committingRef.current = false;
    }
  }

  function startEditing() {
    if (!props.isOnline || props.disabled || editing || props.saving) return;
    setDraft(props.storedPassword ?? "");
    setEditing(true);
  }

  const maskedValue = displayGroupPassword(props.storedPassword, props.hasPassword);

  if (editing || props.saving) {
    return (
      <View style={[styles.settingRow, styles.settingRowEditing]}>
        <Text style={styles.settingLabel}>Group password</Text>
        <View style={styles.inlinePasswordEditingWrap}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            autoFocus={!props.saving}
            editable={!props.saving}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="done"
            onSubmitEditing={() => void commit()}
            onBlur={() => {
              if (!props.saving) void commit();
            }}
            style={styles.inlinePasswordInput}
            selectionColor={colors.primary}
          />
          {props.saving ? (
            <ActivityIndicator color={colors.primary} size="small" />
          ) : null}
        </View>
      </View>
    );
  }

  return (
    <TactilePressable
      style={styles.settingRow}
      onPress={startEditing}
      disabled={!props.isOnline || props.disabled}
    >
      <Text style={styles.settingLabel}>Group password</Text>
      <View style={styles.settingValueWrap}>
        <Text
          style={[styles.settingValue, !props.hasPassword && styles.settingValueMuted]}
          numberOfLines={1}
        >
          {maskedValue}
        </Text>
      </View>
    </TactilePressable>
  );
}

function SettingRow({
  label,
  value,
  accessory = "chevron",
  loading = false,
  onPress
}: {
  label: string;
  value: string;
  accessory?: "chevron" | "copy" | "none";
  loading?: boolean;
  onPress?: () => void;
}) {
  return (
    <TactilePressable
      onPress={loading ? undefined : onPress}
      disabled={!onPress || loading}
      style={styles.settingRow}
    >
      <Text style={styles.settingLabel}>{label}</Text>
      <View style={styles.settingValueWrap}>
        <Text style={styles.settingValue} numberOfLines={1}>
          {value || "Not set"}
        </Text>
        {loading ? (
          <ActivityIndicator color={colors.primary} size="small" />
        ) : accessory === "none" ? null : accessory === "copy" ? (
          <Copy color={colors.iconMuted} size={19} strokeWidth={2.7} />
        ) : (
          <ChevronRight color={colors.iconMuted} size={21} strokeWidth={3} />
        )}
      </View>
    </TactilePressable>
  );
}

function SettingsButton({ onPress }: { onPress: () => void }) {
  return (
    <BareIconButton label="Settings" onPress={onPress}>
      <Settings color={colors.secondary} size={23} />
    </BareIconButton>
  );
}

function ExpenseScreen(props: {
  groupState: GroupState;
  amount: string;
  name: string;
  paidByMemberId: string;
  isEditing: boolean;
  splitMemberIds: string[];
  isSaving: boolean;
  onAmountChange: (value: string) => void;
  onNameChange: (value: string) => void;
  onSelectPayer: (memberId: string) => void;
  onToggleMember: (memberId: string) => void;
  onSubmit: () => void;
  onDelete: () => void;
  onBack: () => void;
}) {
  const orderedMembers = sortMembersForDisplay(
    props.groupState.members,
    props.groupState.currentMemberId
  );
  const selectedPayerId = props.paidByMemberId || preferredPayerId(props.groupState);

  return (
    <Page title={props.isEditing ? "Edit" : "Add"} onBack={props.onBack}>
      <MoneyInput amount={props.amount} currency={props.groupState.group.currency} onAmountChange={props.onAmountChange} />
      <LabeledInput
        label="Name"
        value={props.name}
        placeholder="Dinner"
        editable={!props.isSaving}
        onChangeText={props.onNameChange}
      />
      <View style={styles.panel}>
        <View style={styles.selectorBlock}>
          <Text style={styles.label}>Paid for</Text>
          <View style={styles.chipWrap}>
            {orderedMembers.map((member) => (
              <Chip
                key={member.id}
                label={member.displayName}
                selected={props.splitMemberIds.includes(member.id)}
                isCurrent={member.id === props.groupState.currentMemberId}
                disabled={props.isSaving}
                onPress={() => props.onToggleMember(member.id)}
              />
            ))}
          </View>
        </View>
        <View style={styles.selectorDivider} />
        <View style={styles.selectorBlock}>
          <Text style={styles.label}>Paid by</Text>
          <View style={styles.chipWrap}>
            {orderedMembers.map((member) => (
              <Chip
                key={member.id}
                label={member.displayName}
                selected={selectedPayerId === member.id}
                isCurrent={member.id === props.groupState.currentMemberId}
                disabled={props.isSaving}
                onPress={() => props.onSelectPayer(member.id)}
              />
            ))}
          </View>
        </View>
      </View>
      <ActionButton icon={({ color, size }) => <Check color={color} size={size} />} label={props.isEditing ? "Save" : "Add"} loading={props.isSaving} onPress={props.onSubmit} />
      {props.isEditing ? (
        <ActionButton variant="danger" label="Delete" loading={props.isSaving} onPress={props.onDelete} />
      ) : null}
    </Page>
  );
}

function Page({
  title,
  children,
  onBack,
  centerAction,
  rightAction,
  contentStyle
}: {
  title?: string;
  children: React.ReactNode;
  onBack?: () => void;
  centerAction?: React.ReactNode;
  rightAction?: React.ReactNode;
  contentStyle?: StyleProp<ViewStyle>;
}) {
  return (
    <SafeAreaView edges={["top", "left", "right"]} style={styles.safeArea}>
      {offlineBannerSlot}
      <ScrollView
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.content, contentStyle]}
      >
        <View style={styles.pageHeader}>
          <View style={styles.headerSide}>
            {onBack ? (
              <BareIconButton label="Back" onPress={onBack}>
                <ArrowLeft color={colors.secondary} size={23} />
              </BareIconButton>
            ) : null}
          </View>
          <View style={styles.headerCenter}>
            {centerAction ?? (title ? <Text style={styles.headerTitle} numberOfLines={1}>{title}</Text> : null)}
          </View>
          <View style={[styles.headerSide, styles.headerRight]}>{rightAction}</View>
        </View>
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}

function Balances({
  balances,
  currency,
  currentMemberId
}: {
  balances: Balance[];
  currency: string;
  currentMemberId: string | null;
}) {
  return (
    <View style={styles.panel}>
      {balances.length === 0 ? (
        <Text style={styles.emptyText}>No balances yet.</Text>
      ) : (
        balances.map((balance) => {
          const isCurrent = balance.memberId === currentMemberId;
          return (
            <View key={balance.memberId} style={[styles.balanceItem, isCurrent && styles.listItemSelected]}>
              <Text style={[styles.balanceTitle, isCurrent && styles.currentUserName]} numberOfLines={2}>
                {balance.displayName}
                {isCurrent ? <Text style={styles.currentUserYouSuffix}>{"  (you)"}</Text> : null}
              </Text>
              <RowValue
                value={`${balance.balanceCents >= 0 ? "+" : ""}${money(balance.balanceCents, currency)}`}
                tone={balance.balanceCents < 0 ? "negative" : "positive"}
              />
            </View>
          );
        })
      )}
    </View>
  );
}

function Expenses({
  expenses,
  members,
  currency,
  onEditExpense
}: {
  expenses: Expense[];
  members: Member[];
  currency: string;
  onEditExpense: (expense: Expense) => void;
}) {
  const memberName = (memberId: string) => members.find((member) => member.id === memberId)?.displayName ?? "Someone";

  return (
    <View style={styles.panel}>
      {expenses.length === 0 ? (
        <Text style={styles.emptyText}>No entries yet.</Text>
      ) : (
        expenses.map((expense) => {
          const isPayment = isSettlementPayment(expense);
          const paidByName = memberName(expense.paidByMemberId);
          const paidForName = expense.splitMemberIds[0] ? memberName(expense.splitMemberIds[0]) : "Someone";
          const title = expense.description;
          const meta = isPayment ? `${paidByName} paid ${paidForName}` : `by ${paidByName}`;

          return (
            <TactilePressable
              key={expense.id}
              style={styles.expenseItem}
              onPress={() => onEditExpense(expense)}
            >
              <View style={styles.expenseTextBlock}>
                <Text style={styles.expenseTitle} numberOfLines={2}>
                  {title}
                </Text>
                <Text style={styles.expenseMeta} numberOfLines={1}>
                  {formatRelativeExpenseDate(expense.createdAt)} · {meta}
                </Text>
              </View>
              <RowValue value={money(expense.amountCents, currency)} dedicated />
            </TactilePressable>
          );
        })
      )}
    </View>
  );
}

function RowValue({ value, tone = "default", dedicated = false }: { value: string; tone?: ValueTone; dedicated?: boolean }) {
  return (
    <Text
      style={[
        styles.rowValue,
        dedicated && styles.dedicatedRowValue,
        tone === "positive" && styles.positive,
        tone === "negative" && styles.negative
      ]}
      numberOfLines={1}
      ellipsizeMode="clip"
      adjustsFontSizeToFit
      minimumFontScale={0.72}
    >
      {value}
    </Text>
  );
}

function MoneyInput({
  amount,
  currency,
  onAmountChange
}: {
  amount: string;
  currency: string;
  onAmountChange: (value: string) => void;
}) {
  const symbol = currencySymbol(currency);

  return (
    <View style={[styles.panel, styles.moneyPanel]}>
      <PaperTextInput
        autoFocus
        mode="outlined"
        label="Amount"
        value={amount}
        placeholder="0.00"
        keyboardType="decimal-pad"
        inputMode="decimal"
        left={<PaperTextInput.Affix text={symbol} textStyle={styles.moneyAffix} />}
        onChangeText={onAmountChange}
        style={styles.moneyInput}
        contentStyle={styles.moneyInputContent}
        outlineStyle={styles.moneyInputOutline}
        activeOutlineColor={colors.primary}
        textColor={colors.text}
      />
    </View>
  );
}

function LabeledInput(props: React.ComponentProps<typeof PaperTextInput> & { label: string }) {
  return (
    <View style={styles.formField}>
      <PaperTextInput
        {...props}
        mode="outlined"
        style={styles.input}
        outlineStyle={styles.inputOutline}
        activeOutlineColor={colors.primary}
        textColor={colors.text}
      />
    </View>
  );
}

function ActionButton({
  icon,
  label,
  loading = false,
  variant = "primary",
  compact = false,
  disabled = false,
  onPress
}: {
  icon?: ButtonIcon;
  label: string;
  loading?: boolean;
  variant?: ButtonVariant;
  compact?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  const isPrimary = variant === "primary";
  const isDanger = variant === "danger";

  return (
    <PaperButton
      mode={isPrimary ? "contained" : "outlined"}
      icon={loading || !isPrimary ? undefined : icon}
      loading={loading}
      disabled={loading || disabled}
      onPress={onPress}
      style={[
        styles.actionButton,
        compact ? styles.compactActionButton : styles.growingActionButton,
        isPrimary && styles.primaryButton,
        variant === "secondary" && styles.secondaryButton,
        isDanger && styles.dangerButton
      ]}
      contentStyle={styles.buttonContent}
      labelStyle={[
        styles.actionButtonLabel,
        isPrimary && styles.primaryButtonLabel,
        variant === "secondary" && styles.secondaryButtonLabel,
        isDanger && styles.dangerButtonLabel
      ]}
      textColor={isPrimary ? colors.surface : isDanger ? colors.danger : colors.secondary}
    >
      {label}
    </PaperButton>
  );
}

function SmallButton({
  label,
  loading = false,
  disabled = false,
  onPress
}: {
  label: string;
  loading?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <PaperButton
      compact
      mode="contained"
      loading={loading}
      disabled={loading || disabled}
      onPress={onPress}
      style={styles.smallButton}
      contentStyle={styles.smallButtonContent}
      labelStyle={styles.smallButtonLabel}
      textColor={colors.surface}
    >
      {label}
    </PaperButton>
  );
}

function BareIconButton({ children, label, onPress }: { children: React.ReactNode; label: string; onPress: () => void }) {
  return (
    <TactilePressable accessibilityLabel={label} style={styles.bareIconButton} onPress={onPress}>
      {children}
    </TactilePressable>
  );
}

function Chip({
  label,
  selected,
  isCurrent = false,
  disabled = false,
  onPress
}: {
  label: string;
  selected: boolean;
  isCurrent?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <PaperChip
      compact
      selected={selected}
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      showSelectedOverlay={false}
      style={[styles.chip, selected && styles.chipSelected]}
      textStyle={[styles.chipText, selected && !isCurrent && styles.chipTextSelected]}
    >
      {isCurrent ? (
        <Text style={[styles.chipText, styles.currentUserName]}>{label}</Text>
      ) : (
        label
      )}
    </PaperChip>
  );
}

function TactilePressable({ style, disabled, ...props }: React.ComponentProps<typeof Pressable>) {
  return (
    <Pressable
      {...props}
      disabled={disabled}
      style={(state) => [
        typeof style === "function" ? style(state) : style,
        {
          opacity: disabled ? 0.55 : state.pressed ? 0.72 : 1
        }
      ]}
    />
  );
}

function preferredPayerId(state: GroupState) {
  return state.currentMemberId && state.members.some((member) => member.id === state.currentMemberId)
    ? state.currentMemberId
    : state.members[0]?.id ?? "";
}

function sortJoinSlotsForDisplay(slots: GroupSlot[]) {
  const order = new Map(slots.map((slot, index) => [slot.id, index]));
  return [...slots].sort((a, b) => {
    if (a.claimed !== b.claimed) return a.claimed ? 1 : -1;
    return (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0);
  });
}

function draftMemberId() {
  return `draft_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

function sortMemberListForDisplay(members: MemberListEntry[]) {
  const order = new Map(members.map((member, index) => [member.id, index]));
  const rank = (member: MemberListEntry) => {
    if (member.isCurrent) return 0;
    if (member.claimed) return 1;
    return 2;
  };
  return [...members].sort((a, b) => {
    const rankDiff = rank(a) - rank(b);
    if (rankDiff !== 0) return rankDiff;
    return (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0);
  });
}

function sortMembersForDisplay(members: Member[], currentMemberId: string | null) {
  return sortMemberListForDisplay(
    members.map((member) => ({
      id: member.id,
      displayName: member.displayName,
      isCurrent: member.id === currentMemberId,
      claimed: member.claimed
    }))
  );
}

function isKnownGroup(value: unknown): value is KnownGroup {
  return (
    !!value &&
    typeof value === "object" &&
    "code" in value &&
    "name" in value &&
    typeof value.code === "string" &&
    typeof value.name === "string"
  );
}

function createStyles(colors: AppColors) {
  return StyleSheet.create({
  flex: {
    flex: 1
  },
  screen: {
    flex: 1,
    backgroundColor: colors.background
  },
  safeArea: {
    flex: 1,
    backgroundColor: colors.background
  },
  loadingScreen: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.background
  },
  content: {
    width: "100%",
    paddingBottom: 28,
    gap: spacing.rowGap
  },
  centeredPageContent: {
    flexGrow: 1
  },
  groupsCenterBlock: {
    flexGrow: 1,
    justifyContent: "center",
    gap: 20
  },
  pageHeader: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.headerX,
    marginBottom: 2
  },
  headerSide: {
    width: 48,
    minHeight: 48,
    alignItems: "flex-start",
    justifyContent: "center"
  },
  headerCenter: {
    flex: 1,
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center"
  },
  headerRight: {
    alignItems: "flex-end",
    justifyContent: "center"
  },
  headerTitle: {
    color: colors.heading,
    ...typography.header,
    letterSpacing: 0,
    textAlign: "center"
  },
  logoWrap: {
    minHeight: 64,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.rowGap
  },
  logoMark: {
    width: 44,
    height: 44,
    borderRadius: 10,
    backgroundColor: colors.primary,
    justifyContent: "center",
    paddingHorizontal: 9,
    gap: 5
  },
  logoLine: {
    height: 4,
    borderRadius: 999,
    backgroundColor: colors.surface
  },
  logoLineShort: {
    width: 18
  },
  logoDot: {
    position: "absolute",
    right: 8,
    bottom: 8,
    width: 8,
    height: 8,
    borderRadius: 999,
    backgroundColor: colors.warning
  },
  logoText: {
    color: colors.heading,
    ...typography.logo,
    letterSpacing: 0
  },
  panel: {
    backgroundColor: colors.surface,
    overflow: "hidden",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border
  },
  selectorBlock: {
    paddingHorizontal: spacing.pageX,
    paddingVertical: 10,
    gap: 8
  },
  selectorDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginLeft: 16
  },
  moneyPanel: {
    paddingHorizontal: spacing.pageX,
    paddingTop: 14,
    paddingBottom: 16
  },
  moneyInput: {
    minHeight: 78,
    backgroundColor: colors.surface
  },
  moneyInputContent: {
    ...typography.money,
    letterSpacing: 0
  },
  moneyInputOutline: {
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth
  },
  moneyAffix: {
    color: colors.muted,
    fontSize: 24,
    fontWeight: "800"
  },
  formField: {
    gap: 7,
    paddingHorizontal: spacing.pageX,
    paddingVertical: 2
  },
  label: {
    color: colors.label,
    ...typography.label
  },
  sectionLabel: {
    color: colors.label,
    paddingHorizontal: spacing.pageX,
    paddingTop: spacing.rowGap,
    ...typography.label
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.pageX,
    paddingTop: spacing.rowGap,
    paddingBottom: 4
  },
  sectionLabelInline: {
    color: colors.label,
    ...typography.label
  },
  sectionHeaderSpinner: {
    marginRight: spacing.pageX
  },
  sectionAddButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    minHeight: 44,
    paddingHorizontal: 8,
    borderRadius: 8
  },
  sectionAddLabel: {
    color: colors.primary,
    ...typography.label,
    fontWeight: "700"
  },
  memberAddRow: {
    minHeight: 52,
    paddingHorizontal: spacing.pageX,
    paddingVertical: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.rowGap,
    backgroundColor: colors.surfaceSelected
  },
  memberAddInput: {
    flex: 1,
    minHeight: 36,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.primary,
    backgroundColor: colors.surface,
    color: colors.text,
    ...typography.rowTitle
  },
  pickRow: {
    minHeight: 52,
    paddingHorizontal: spacing.pageX,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.rowGap,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle
  },
  pickRowTaken: {
    opacity: 0.72
  },
  pickRowPressable: {
    flex: 1,
    minWidth: 0,
    justifyContent: "center"
  },
  joinCustomNameInput: {
    flex: 1,
    minWidth: 0,
    minHeight: 36,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.primary,
    backgroundColor: colors.surface,
    color: colors.text,
    ...typography.rowTitle
  },
  joinCustomNameInputError: {
    borderColor: colors.danger
  },
  memberAddBlock: {
    backgroundColor: colors.surfaceSelected
  },
  memberAddInputError: {
    borderColor: colors.danger
  },
  fieldError: {
    color: colors.danger,
    paddingHorizontal: spacing.pageX,
    paddingTop: 6,
    paddingBottom: 2,
    ...typography.meta
  },
  memberAvatar: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center"
  },
  memberAvatarYou: {
    backgroundColor: colors.chipSelected,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.primary
  },
  memberAvatarClaimed: {
    backgroundColor: colors.chipSelected
  },
  memberAvatarOpen: {
    backgroundColor: colors.background,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderControl
  },
  memberAvatarInitial: {
    color: colors.primary,
    fontSize: 13,
    fontWeight: "800"
  },
  memberNameUnclaimed: {
    color: colors.muted
  },
  memberListNamePressable: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 8
  },
  memberListNameText: {
    flex: 1,
    minWidth: 0
  },
  memberListNameSpinner: {
    flexShrink: 0
  },
  memberListNameInput: {
    flex: 1,
    minWidth: 0,
    minHeight: 36,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.primary,
    backgroundColor: colors.surface,
    color: colors.text,
    ...typography.rowTitle
  },
  pickName: {
    flex: 1,
    color: colors.text,
    ...typography.body
  },
  pickNameTaken: {
    color: colors.muted
  },
  input: {
    minHeight: 54,
    backgroundColor: colors.background,
    fontSize: typography.body.fontSize
  },
  inputOutline: {
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth
  },
  settingRow: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.rowGap,
    paddingHorizontal: spacing.pageX,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle
  },
  settingRowEditing: {
    backgroundColor: colors.surfaceSelected
  },
  inlinePasswordInput: {
    flex: 1,
    minWidth: 0,
    minHeight: 36,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.primary,
    backgroundColor: colors.surface,
    color: colors.text,
    ...typography.rowTitle
  },
  inlinePasswordEditingWrap: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.rowGap
  },
  settingLabel: {
    color: colors.text,
    ...typography.body,
    fontWeight: "700"
  },
  settingValueWrap: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 8,
    minHeight: 24
  },
  settingValue: {
    flexShrink: 1,
    color: colors.muted,
    ...typography.rowTitle,
    fontWeight: "600"
  },
  settingValueMuted: {
    color: colors.iconMuted,
    fontWeight: "500"
  },
  inlineEditableRow: {
    paddingHorizontal: spacing.pageX,
    paddingVertical: 12,
    gap: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle
  },
  inlineEditableRowActive: {
    backgroundColor: colors.surfaceSelected
  },
  inlineEditableLabel: {
    color: colors.label,
    ...typography.meta,
    fontWeight: "600"
  },
  inlineEditableValueRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.rowGap,
    minHeight: 28
  },
  inlineEditableValue: {
    flex: 1,
    color: colors.text,
    ...typography.rowTitle
  },
  inlineEditablePlaceholder: {
    color: colors.muted
  },
  inlineEditableInput: {
    minHeight: 36,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.primary,
    backgroundColor: colors.surface,
    color: colors.text,
    ...typography.rowTitle
  },
  buttonRow: {
    flexDirection: "row",
    gap: StyleSheet.hairlineWidth,
    marginTop: 2
  },
  actionButton: {
    borderRadius: 0
  },
  growingActionButton: {
    flex: 1
  },
  compactActionButton: {
    flexGrow: 0,
    flexShrink: 0,
    minWidth: 104
  },
  buttonContent: {
    minHeight: 54
  },
  actionButtonLabel: {
    ...typography.button
  },
  primaryButton: {
    backgroundColor: colors.primary
  },
  primaryButtonLabel: {
    color: colors.surface
  },
  secondaryButton: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderControl
  },
  smallButton: {
    alignSelf: "center",
    borderRadius: 8,
    backgroundColor: colors.primary
  },
  smallButtonContent: {
    minHeight: 34,
    paddingHorizontal: 4
  },
  smallButtonLabel: {
    marginHorizontal: 8,
    ...typography.smallButton,
    color: colors.surface
  },
  secondaryButtonLabel: {
    color: colors.secondary
  },
  dangerButton: {
    backgroundColor: colors.dangerSurface,
    borderWidth: 1,
    borderColor: colors.dangerBorder
  },
  dangerButtonLabel: {
    color: colors.danger
  },
  groupHeader: {
    gap: 2,
    marginBottom: 2,
    paddingHorizontal: spacing.pageX
  },
  headerLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    flexWrap: "wrap"
  },
  groupTitle: {
    flexShrink: 1,
    color: colors.text,
    ...typography.display,
    letterSpacing: 0
  },
  headerCode: {
    color: colors.label,
    ...typography.title,
    letterSpacing: 0
  },
  headerCodeButton: {
    minHeight: 36,
    borderRadius: 8,
    paddingHorizontal: 10,
    alignItems: "center",
    justifyContent: "center"
  },
  bareIconButton: {
    width: 44,
    height: 44,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center"
  },
  listItem: {
    minHeight: 60,
    paddingHorizontal: spacing.pageX,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.rowGap,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle
  },
  listTextBlock: {
    flex: 1,
    minWidth: 0
  },
  groupCodePressable: {
    alignSelf: "flex-start",
    marginTop: 2,
    borderRadius: 6,
    paddingVertical: 2,
    paddingHorizontal: 2,
    marginHorizontal: -2
  },
  rowAccessory: {
    minWidth: 72,
    alignItems: "flex-end",
    justifyContent: "center"
  },
  balanceItem: {
    minHeight: 48,
    paddingHorizontal: spacing.pageX,
    paddingVertical: 5,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.rowGap,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle
  },
  expenseItem: {
    minHeight: 52,
    paddingHorizontal: spacing.pageX,
    paddingVertical: 6,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.rowGap,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle
  },
  activityItem: {
    paddingHorizontal: spacing.pageX,
    paddingVertical: 8,
    gap: 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle
  },
  settleItem: {
    minHeight: 52,
    paddingHorizontal: spacing.pageX,
    paddingVertical: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.rowGap,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle
  },
  listItemSelected: {
    backgroundColor: colors.surfaceSelected
  },
  listItemLoading: {
    backgroundColor: colors.surfaceLoading
  },
  rowSpinner: {
    width: 72,
    minHeight: 28,
    alignItems: "flex-end",
    justifyContent: "center",
    alignSelf: "center"
  },
  listTitle: {
    color: colors.text,
    ...typography.title
  },
  balanceTitle: {
    flex: 1,
    color: colors.text,
    ...typography.rowTitle
  },
  currentUserName: {
    color: colors.userName,
    fontWeight: "700"
  },
  currentUserYouSuffix: {
    color: colors.userName,
    fontWeight: "400"
  },
  expenseTextBlock: {
    flex: 1,
    minWidth: 0
  },
  settleTextBlock: {
    flex: 1,
    minWidth: 0
  },
  expenseTitle: {
    color: colors.text,
    ...typography.rowTitle
  },
  meta: {
    color: colors.muted,
    ...typography.meta
  },
  expenseMeta: {
    color: colors.muted,
    ...typography.meta
  },
  activityTitle: {
    color: colors.text,
    ...typography.rowTitle
  },
  activityBy: {
    color: colors.muted,
    fontWeight: "600"
  },
  activityExpenseName: {
    color: colors.expenseName,
    fontWeight: "800",
    textDecorationLine: "underline"
  },
  activityUserName: {
    color: colors.userName,
    fontWeight: "800"
  },
  settleTitle: {
    color: colors.text,
    ...typography.rowTitle
  },
  settleUserName: {
    color: colors.userName,
    fontWeight: "800"
  },
  activityMeta: {
    color: colors.muted,
    ...typography.meta
  },
  rowValue: {
    color: colors.text,
    ...typography.value,
    alignSelf: "center",
    maxWidth: 112
  },
  dedicatedRowValue: {
    width: 108,
    maxWidth: 108,
    textAlign: "right"
  },
  positive: {
    color: colors.positive
  },
  negative: {
    color: colors.negative
  },
  emptyText: {
    color: colors.muted,
    ...typography.body,
    fontWeight: "500",
    padding: spacing.pageX
  },
  offlineNotice: {
    color: colors.muted,
    ...typography.meta,
    paddingHorizontal: spacing.pageX
  },
  offlineBanner: {
    alignItems: "center",
    backgroundColor: colors.surfaceSelected,
    paddingVertical: 8,
    paddingHorizontal: spacing.pageX,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border
  },
  offlineBannerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6
  },
  offlineBannerText: {
    color: colors.warning,
    ...typography.meta,
    fontWeight: "800"
  },
  offlineBannerHint: {
    color: colors.muted,
    ...typography.meta,
    fontWeight: "600"
  },
  loadingPanel: {
    minHeight: 96,
    alignItems: "center",
    justifyContent: "center"
  },
  errorSnackbar: {
    backgroundColor: colors.danger
  },
  chipWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6
  },
  chip: {
    minHeight: 30,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.chipBorder,
    paddingHorizontal: 8,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface
  },
  chipSelected: {
    backgroundColor: colors.chipSelected,
    borderColor: colors.primary
  },
  chipText: {
    color: colors.label,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "600",
    marginVertical: 0,
    marginHorizontal: 0
  },
  chipTextSelected: {
    color: colors.expenseName
  }
});
}
