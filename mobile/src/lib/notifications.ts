import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import type { Api } from './api';

// While foregrounded we're on the live socket; suppress the banner.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: false,
    shouldSetBadge: false,
    shouldShowBanner: false,
    shouldShowList: false,
  }),
});

/**
 * Registers a content-free push token with our relay. Silently no-ops when
 * push isn't configured (no EAS projectId) or permission is denied —
 * the app still works, you just won't get background alerts.
 */
export async function registerPush(api: Api): Promise<'ok' | 'denied' | 'unavailable'> {
  if (!Device.isDevice) return 'unavailable';
  const projectId: string | undefined =
    Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
  if (!projectId) return 'unavailable';

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('messages', {
      name: 'Messages',
      importance: Notifications.AndroidImportance.HIGH,
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
    });
  }
  let { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted') ({ status } = await Notifications.requestPermissionsAsync());
  if (status !== 'granted') {
    await api.setPushToken(null).catch(() => {});
    return 'denied';
  }
  const { data } = await Notifications.getExpoPushTokenAsync({ projectId });
  await api.setPushToken(data);
  return 'ok';
}
