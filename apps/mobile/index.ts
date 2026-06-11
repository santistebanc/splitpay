import "@expo/metro-runtime";

import { registerRootComponent } from "expo";
import { LogBox, Platform } from "react-native";

import App from "./App";

if (Platform.OS === "web") {
  LogBox.ignoreLogs([
    "props.pointerEvents is deprecated",
    '"shadow*" style props are deprecated',
    "`useNativeDriver` is not supported"
  ]);
}

registerRootComponent(App);
