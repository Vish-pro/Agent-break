import { usePreventScreenCapture } from 'expo-screen-capture';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AppState, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Api } from './lib/api';
import { ChatClient } from './lib/chat';
import { closeAndDeleteDb } from './lib/db';
import { wipeMedia } from './lib/media';
import { registerPush } from './lib/notifications';
import {
  loadIdentity,
  loadPeer,
  loadSettings,
  saveSettings,
  wipeAll,
  type Identity,
  type Peer,
  type Settings,
} from './lib/secrets';
import { ChatScreen } from './screens/ChatScreen';
import { LockScreen, PrivacyCover } from './screens/LockScreen';
import { PairScreen } from './screens/PairScreen';
import { SetupScreen } from './screens/SetupScreen';
import { useTheme } from './theme';

/** Re-lock after this long in the background (short grace covers the photo picker). */
const RELOCK_AFTER_MS = 30_000;

type State =
  | { phase: 'loading' }
  | { phase: 'setup' }
  | { phase: 'pair'; me: Identity; peer: Peer | null }
  | { phase: 'chat'; me: Identity; peer: Peer };

export default function App() {
  return (
    <SafeAreaProvider>
      <Root />
    </SafeAreaProvider>
  );
}

function Root() {
  usePreventScreenCapture(); // Android: FLAG_SECURE; iOS: blanks screen recordings
  const t = useTheme();
  const [state, setState] = useState<State>({ phase: 'loading' });
  const [settings, setSettings] = useState<Settings>({ appLock: true, paired: false });
  const [locked, setLocked] = useState(true);
  const [covered, setCovered] = useState(false);
  const backgroundedAt = useRef<number | null>(null);

  useEffect(() => {
    void (async () => {
      const [me, peer, s] = await Promise.all([loadIdentity(), loadPeer(), loadSettings()]);
      setSettings(s);
      setLocked(s.appLock && !!me);
      if (!me) setState({ phase: 'setup' });
      else if (peer && s.paired) setState({ phase: 'chat', me, peer });
      else setState({ phase: 'pair', me, peer });
    })();
  }, []);

  // Privacy cover + re-lock on return from background.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      setCovered(s !== 'active');
      if (s === 'background') backgroundedAt.current = Date.now();
      if (s === 'active' && backgroundedAt.current !== null) {
        if (settings.appLock && Date.now() - backgroundedAt.current > RELOCK_AFTER_MS) setLocked(true);
        backgroundedAt.current = null;
      }
    });
    return () => sub.remove();
  }, [settings.appLock]);

  const me = state.phase === 'chat' ? state.me : null;
  const peer = state.phase === 'chat' ? state.peer : null;
  const client = useMemo(() => (me && peer ? new ChatClient(new Api(me), peer) : null), [me, peer]);

  useEffect(() => {
    if (!client) return;
    client.start();
    void registerPush(client.api).catch((e) => console.warn('push registration failed', e));
    return () => client.stop();
  }, [client]);

  const updateSettings = useCallback(async (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    await saveSettings(next);
  }, [settings]);

  const reset = useCallback(async () => {
    client?.stop();
    await closeAndDeleteDb();
    wipeMedia();
    await wipeAll();
    setSettings({ appLock: true, paired: false });
    setState({ phase: 'setup' });
  }, [client]);

  let content: React.ReactNode;
  switch (state.phase) {
    case 'loading':
      content = (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: t.bg }}>
          <ActivityIndicator color={t.primary} />
        </View>
      );
      break;
    case 'setup':
      content = <SetupScreen onDone={(me) => void loadPeer().then((peer) => setState({ phase: 'pair', me, peer }))} />;
      break;
    case 'pair':
      content = (
        <PairScreen
          me={state.me}
          peer={state.peer}
          onPeer={(me, peer) => setState({ phase: 'pair', me, peer })}
          onDone={() => {
            if (!state.peer) return;
            void updateSettings({ paired: true });
            setState({ phase: 'chat', me: state.me, peer: state.peer });
          }}
        />
      );
      break;
    case 'chat':
      content = client && (
        <ChatScreen
          client={client}
          me={state.me}
          peer={state.peer}
          appLock={settings.appLock}
          onToggleLock={() => void updateSettings({ appLock: !settings.appLock })}
          onReset={() => void reset()}
        />
      );
      break;
  }

  return (
    <>
      <StatusBar style="auto" />
      {locked && state.phase !== 'setup' && state.phase !== 'loading' ? (
        <LockScreen onUnlock={() => setLocked(false)} />
      ) : (
        content
      )}
      {covered && <PrivacyCover />}
    </>
  );
}
