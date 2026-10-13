import * as LocalAuthentication from 'expo-local-authentication';
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Button } from '../components/ui';
import { useTheme } from '../theme';

export function LockScreen({ onUnlock }: { onUnlock: () => void }) {
  const t = useTheme();
  const [error, setError] = useState<string | null>(null);

  const unlock = useCallback(async () => {
    setError(null);
    const level = await LocalAuthentication.getEnrolledLevelAsync();
    if (level === LocalAuthentication.SecurityLevel.NONE) {
      // No passcode/biometrics on the phone: the lock can't protect anything. Don't lock the user out.
      setError('Set a screen lock on this phone to protect the app.');
      return onUnlock();
    }
    const res = await LocalAuthentication.authenticateAsync({ promptMessage: 'Unlock' });
    if (res.success) onUnlock();
    else if (res.error !== 'user_cancel' && res.error !== 'system_cancel') setError('Authentication failed.');
  }, [onUnlock]);

  useEffect(() => {
    void unlock();
  }, [unlock]);

  return (
    <View style={[styles.fill, { backgroundColor: t.bg }]}>
      <Text style={styles.icon}>🔒</Text>
      {error && <Text style={{ color: t.danger, marginBottom: 8 }}>{error}</Text>}
      <View style={{ width: 200 }}>
        <Button title="Unlock" onPress={unlock} />
      </View>
    </View>
  );
}

/** Covers content while the app is inactive so the OS app switcher snapshot shows nothing. */
export function PrivacyCover() {
  const t = useTheme();
  return (
    <View style={[StyleSheet.absoluteFill, styles.fill, { backgroundColor: t.bg }]}>
      <Text style={styles.icon}>💌</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  icon: { fontSize: 56, marginBottom: 24 },
});
