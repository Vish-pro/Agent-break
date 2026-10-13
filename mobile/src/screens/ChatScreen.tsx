import { safetyNumber } from '@pvtchat/protocol';
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  Alert,
  AppState,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Bubble } from '../components/Bubble';
import type { ChatClient } from '../lib/chat';
import type { Message } from '../lib/db';
import type { Identity, Peer } from '../lib/secrets';
import { sodium } from '../lib/sodium';
import { useTheme } from '../theme';

const PAGE = 100;

export function ChatScreen({
  client,
  me,
  peer,
  appLock,
  onToggleLock,
  onReset,
}: {
  client: ChatClient;
  me: Identity;
  peer: Peer;
  appLock: boolean;
  onToggleLock: () => void;
  onReset: () => void;
}) {
  const t = useTheme();
  const snap = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [messages, setMessages] = useState<Message[]>([]);
  const [limit, setLimit] = useState(PAGE);
  const [text, setText] = useState('');
  const [viewer, setViewer] = useState<string | null>(null);

  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recState = useAudioRecorderState(recorder, 200);
  const recStartedAt = useRef(0);

  // Reload from the encrypted local DB whenever the client reports a change.
  useEffect(() => {
    let cancelled = false;
    void client.loadMessages(limit).then((m) => !cancelled && setMessages(m));
    if (AppState.currentState === 'active') void client.markRead();
    return () => {
      cancelled = true;
    };
  }, [client, snap.version, limit]);

  const send = useCallback(async () => {
    const body = text;
    setText('');
    try {
      await client.sendText(body);
    } catch (e) {
      setText(body);
      Alert.alert('Not sent', e instanceof Error ? e.message : String(e));
    }
  }, [client, text]);

  const attach = useCallback(() => {
    const pick = async (camera: boolean) => {
      const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 1, exif: false };
      if (camera) {
        const perm = await ImagePicker.requestCameraPermissionsAsync();
        if (!perm.granted) return;
      }
      const res = camera ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
      const asset = res.canceled ? null : res.assets[0];
      if (!asset) return;
      try {
        await client.sendImage({ uri: asset.uri, width: asset.width, height: asset.height });
      } catch (e) {
        Alert.alert('Photo not sent', e instanceof Error ? e.message : String(e));
      }
    };
    Alert.alert('Send a photo', undefined, [
      { text: 'Camera', onPress: () => void pick(true) },
      { text: 'Library', onPress: () => void pick(false) },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }, [client]);

  const startRec = useCallback(async () => {
    const perm = await AudioModule.requestRecordingPermissionsAsync();
    if (!perm.granted) return Alert.alert('Microphone access is needed for voice notes.');
    await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: true });
    await recorder.prepareToRecordAsync();
    recorder.record();
    recStartedAt.current = Date.now();
  }, [recorder]);

  const stopRec = useCallback(async () => {
    if (!recorder.isRecording) return;
    await recorder.stop();
    await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false });
    const duration = Date.now() - recStartedAt.current;
    const uri = recorder.uri;
    if (!uri || duration < 700) return; // accidental tap
    try {
      await client.sendAudio(uri, duration);
    } catch (e) {
      Alert.alert('Voice note not sent', e instanceof Error ? e.message : String(e));
    }
  }, [client, recorder]);

  const onBubblePress = useCallback(
    (m: Message) => {
      if (m.outgoing && m.status === 'failed') void client.retrySend(m);
      else if (!m.outgoing && m.media && !m.local_uri) client.retryDownload(m);
    },
    [client],
  );

  const menu = () =>
    Alert.alert('Settings', undefined, [
      { text: 'Show safety number', onPress: () => Alert.alert('Safety number', safetyNumber(sodium, me, peer)) },
      { text: `App lock: ${appLock ? 'ON' : 'OFF'}`, onPress: onToggleLock },
      {
        text: 'Reset this phone…',
        style: 'destructive',
        onPress: () =>
          Alert.alert(
            'Reset?',
            'Deletes all messages and keys on this phone. To re-enroll, free the slot on the server with `npm run cli -- remove-device`.',
            [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Reset', style: 'destructive', onPress: onReset },
            ],
          ),
      },
      { text: 'Close', style: 'cancel' },
    ]);

  const subtitle = snap.peerTyping
    ? 'typing…'
    : snap.conn === 'online'
      ? snap.peerOnline
        ? 'online'
        : 'end-to-end encrypted'
      : snap.conn === 'connecting'
        ? 'connecting…'
        : 'offline, will send when back';

  if (snap.revoked) {
    return (
      <SafeAreaView style={[styles.fill, styles.center, { backgroundColor: t.bg }]}>
        <Text style={{ color: t.text, marginBottom: 12 }}>This phone was removed from the server.</Text>
        <Pressable onPress={onReset}>
          <Text style={{ color: t.primary, fontWeight: '600' }}>Reset and set up again</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.fill, { backgroundColor: t.bg }]} edges={['top', 'bottom']}>
      <View style={[styles.header, { borderColor: t.border, backgroundColor: t.surface }]}>
        <View style={styles.fill}>
          <Text style={[styles.title, { color: t.text }]}>{peer.name}</Text>
          <Text style={{ color: snap.peerTyping ? t.primary : t.muted, fontSize: 12 }}>{subtitle}</Text>
        </View>
        <Pressable onPress={menu} hitSlop={12}>
          <Text style={{ fontSize: 22, color: t.text }}>⋯</Text>
        </Pressable>
      </View>

      <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <FlatList
          inverted
          data={messages}
          keyExtractor={(m) => m.id}
          renderItem={({ item }) => <Bubble m={item} onPress={onBubblePress} onOpenImage={setViewer} />}
          onEndReached={() => messages.length >= limit && setLimit((l) => l + PAGE)}
          onEndReachedThreshold={0.5}
          contentContainerStyle={{ paddingVertical: 8 }}
          keyboardDismissMode="interactive"
        />

        <View style={[styles.composer, { borderColor: t.border, backgroundColor: t.surface }]}>
          <Pressable onPress={attach} hitSlop={8} style={styles.iconBtn}>
            <Text style={styles.icon}>📷</Text>
          </Pressable>
          {recState.isRecording ? (
            <Text style={[styles.input, styles.recording, { color: t.danger }]}>
              ● Recording {Math.floor(recState.durationMillis / 1000)}s, release to send
            </Text>
          ) : (
            <TextInput
              style={[styles.input, { color: t.text, backgroundColor: t.bg }]}
              value={text}
              onChangeText={(v) => {
                setText(v);
                client.setTyping(v.length > 0);
              }}
              placeholder="Message"
              placeholderTextColor={t.muted}
              multiline
              maxLength={8000}
            />
          )}
          {text.trim() ? (
            <Pressable onPress={send} style={[styles.send, { backgroundColor: t.primary }]}>
              <Text style={{ color: t.primaryText, fontSize: 18 }}>➤</Text>
            </Pressable>
          ) : (
            <Pressable
              onPressIn={startRec}
              onPressOut={stopRec}
              style={[styles.send, { backgroundColor: recState.isRecording ? t.danger : t.primary }]}
            >
              <Text style={{ fontSize: 18 }}>🎙️</Text>
            </Pressable>
          )}
        </View>
      </KeyboardAvoidingView>

      <Modal visible={!!viewer} transparent animationType="fade" onRequestClose={() => setViewer(null)}>
        <Pressable style={styles.viewer} onPress={() => setViewer(null)}>
          {viewer && <Image source={{ uri: viewer }} style={styles.fill} contentFit="contain" />}
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  title: { fontSize: 17, fontWeight: '700' },
  composer: { flexDirection: 'row', alignItems: 'flex-end', padding: 8, borderTopWidth: StyleSheet.hairlineWidth },
  iconBtn: { padding: 8 },
  icon: { fontSize: 22 },
  input: { flex: 1, minHeight: 40, maxHeight: 120, borderRadius: 20, paddingHorizontal: 14, paddingTop: 10, paddingBottom: 10, fontSize: 16, marginHorizontal: 6 },
  recording: { textAlignVertical: 'center' },
  send: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  viewer: { flex: 1, backgroundColor: '#000' },
});
