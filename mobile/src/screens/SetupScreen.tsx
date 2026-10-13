import { decodePairing, PairingParseError, type PairingCode } from '@pvtchat/protocol';
import { useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { PasteCodeModal } from '../components/PasteCodeModal';
import { QrScanner } from '../components/QrScanner';
import { Button, Field, H1, P } from '../components/ui';
import { ApiError, normalizeServer, register } from '../lib/api';
import { generateKeys, saveIdentity, savePeer, type Identity } from '../lib/secrets';
import { useTheme } from '../theme';

const errorText = (e: unknown): string => {
  if (e instanceof ApiError) {
    return (
      {
        forbidden: 'Wrong registration secret.',
        registration_closed: 'This server already has two devices. Remove one with the server CLI first.',
        already_registered: 'This device is already registered.',
      }[e.code] ?? `Server error (${e.code}).`
    );
  }
  return e instanceof Error ? e.message : String(e);
};

export function SetupScreen({ onDone }: { onDone: (me: Identity) => void }) {
  const t = useTheme();
  const [mode, setMode] = useState<'choose' | 'host' | 'join'>('choose');
  const [server, setServer] = useState('https://');
  const [secret, setSecret] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [pasting, setPasting] = useState(false);

  async function enroll(serverUrl: string, registrationSecret: string, keepSecret: boolean): Promise<Identity> {
    const origin = normalizeServer(serverUrl);
    const health = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
    if (!health?.ok) throw new Error(`Can't reach ${origin}. Is the server running?`);
    const keys = generateKeys();
    const { deviceId } = await register(origin, registrationSecret, keys.signPk, name.trim());
    const me: Identity = {
      server: origin,
      deviceId,
      name: name.trim(),
      ...keys,
      ...(keepSecret ? { registrationSecret } : {}),
    };
    await saveIdentity(me);
    return me;
  }

  async function host() {
    if (!name.trim() || !secret) return Alert.alert('Fill in your name and the registration secret.');
    setBusy(true);
    try {
      onDone(await enroll(server, secret, true));
    } catch (e) {
      Alert.alert('Setup failed', errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function onInviteScanned(data: string) {
    setScanning(false);
    setPasting(false);
    let code: PairingCode;
    try {
      code = decodePairing(data);
    } catch (e) {
      return Alert.alert("That's not a pairing code.", e instanceof PairingParseError ? e.message : undefined);
    }
    if (!code.server || !code.registrationSecret) {
      return Alert.alert('Not an invite', 'Ask your partner to open the pairing screen on their phone.');
    }
    setBusy(true);
    try {
      const me = await enroll(code.server, code.registrationSecret, false);
      await savePeer({ deviceId: code.deviceId, name: code.name, signPk: code.signPk, boxPk: code.boxPk });
      onDone(me);
    } catch (e) {
      Alert.alert('Joining failed', errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={[styles.fill, { backgroundColor: t.bg }]}>
      <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <H1>Just us 💌</H1>
          <P muted>
            A private chat for two. Messages are end-to-end encrypted on your phones; your own server only relays
            ciphertext it can't read.
          </P>

          {mode === 'choose' && (
            <>
              <Button title="I set up the server" onPress={() => setMode('host')} />
              <Button title="Join my partner (scan code)" variant="ghost" onPress={() => setMode('join')} />
            </>
          )}

          {mode !== 'choose' && <Field label="Your name" value={name} onChangeText={setName} autoCapitalize="words" maxLength={40} />}

          {mode === 'host' && (
            <>
              <Field label="Server URL" value={server} onChangeText={setServer} keyboardType="url" />
              <Field label="Registration secret" value={secret} onChangeText={setSecret} secureTextEntry />
              <Button title="Create my identity" onPress={host} busy={busy} />
            </>
          )}

          {mode === 'join' && (
            <>
              <Button
                title="Scan partner's code"
                onPress={() => (name.trim() ? setScanning(true) : Alert.alert('Enter your name first.'))}
                busy={busy}
              />
              <Button
                title="Paste code from a message"
                variant="ghost"
                onPress={() => (name.trim() ? setPasting(true) : Alert.alert('Enter your name first.'))}
                disabled={busy}
              />
            </>
          )}

          {mode !== 'choose' && <Button title="Back" variant="ghost" onPress={() => setMode('choose')} />}
        </ScrollView>
      </KeyboardAvoidingView>
      <QrScanner visible={scanning} onScan={onInviteScanned} onClose={() => setScanning(false)} />
      <PasteCodeModal visible={pasting} onSubmit={onInviteScanned} onClose={() => setPasting(false)} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  body: { padding: 24, paddingTop: 48 },
});
