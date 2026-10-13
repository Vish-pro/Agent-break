import { decodePairing, encodePairingText, PairingParseError, safetyNumber, type PairingCode } from '@pvtchat/protocol';
import { useMemo, useState } from 'react';
import { Alert, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { SafeAreaView } from 'react-native-safe-area-context';
import { PasteCodeModal } from '../components/PasteCodeModal';
import { QrScanner } from '../components/QrScanner';
import { Button, H1, P } from '../components/ui';
import { saveIdentity, savePeer, type Identity, type Peer } from '../lib/secrets';
import { sodium } from '../lib/sodium';
import { useTheme } from '../theme';

export function PairScreen({
  me,
  peer,
  onPeer,
  onDone,
}: {
  me: Identity;
  peer: Peer | null;
  onPeer: (me: Identity, peer: Peer) => void;
  onDone: () => void;
}) {
  const t = useTheme();
  const [scanning, setScanning] = useState(false);
  const [pasting, setPasting] = useState(false);
  const isInviter = !!me.registrationSecret;

  const code = useMemo((): PairingCode => ({
      v: 1,
      deviceId: me.deviceId,
      name: me.name,
      signPk: me.signPk,
      boxPk: me.boxPk,
      // Invite includes enrollment details until the partner is paired.
      ...(me.registrationSecret && !peer ? { server: me.server, registrationSecret: me.registrationSecret } : {}),
  }), [me, peer]);
  const qr = useMemo(() => JSON.stringify(code), [code]);

  async function shareAsText() {
    const doShare = () =>
      Share.share({
        message:
          `💌 My "Just Us" pairing code. In the app tap "Paste code" and paste this whole message:\n\n` +
          `${encodePairingText(code)}\n\nAfter pairing, call me and we compare the safety number.`,
      }).catch(() => {});
    if (code.registrationSecret) {
      Alert.alert(
        'Send only to your partner',
        'This code lets one phone join your server. Send it privately, then compare safety numbers on a call.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Share', onPress: () => void doShare() },
        ],
      );
    } else {
      await doShare();
    }
  }

  const safety = peer ? safetyNumber(sodium, me, peer) : null;

  async function onScanned(data: string) {
    setScanning(false);
    setPasting(false);
    let theirs: PairingCode;
    try {
      theirs = decodePairing(data);
    } catch (e) {
      return Alert.alert("That's not a pairing code.", e instanceof PairingParseError ? e.message : undefined);
    }
    if (theirs.deviceId === me.deviceId) return Alert.alert("That's your own code 🙂");
    const p: Peer = { deviceId: theirs.deviceId, name: theirs.name, signPk: theirs.signPk, boxPk: theirs.boxPk };
    await savePeer(p);
    // Partner is enrolled; stop carrying the registration secret around.
    const { registrationSecret: _drop, ...rest } = me;
    await saveIdentity(rest);
    onPeer(rest, p);
  }

  return (
    <SafeAreaView style={[styles.fill, { backgroundColor: t.bg }]}>
      <ScrollView contentContainerStyle={styles.body}>
        <H1>Pair your phones</H1>
        <P muted>
          {isInviter && !peer
            ? '1. Your partner scans this QR, or you tap "Share my code as text" and they paste it in "Join my partner".\n2. Then you scan or paste the code from their phone.'
            : peer && !isInviter
              ? 'Last step: let your partner scan this QR, or share it as text so they can paste it.'
              : 'Scan or paste each other’s codes.'}
        </P>

        <View style={[styles.qr, { backgroundColor: '#fff' }]}>
          <QRCode value={qr} size={240} ecl="M" />
        </View>

        <Button title="Share my code as text" variant="ghost" onPress={() => void shareAsText()} />

        {!peer || isInviter ? (
          <>
            <Button title="Scan partner's code" onPress={() => setScanning(true)} />
            <Button title="Paste partner's code" variant="ghost" onPress={() => setPasting(true)} />
          </>
        ) : null}

        {safety && peer && (
          <View style={[styles.card, { backgroundColor: t.surface, borderColor: t.border }]}>
            <Text style={{ color: t.muted, marginBottom: 6 }}>Paired with {peer.name}. Safety number:</Text>
            <Text style={[styles.safety, { color: t.text }]}>{safety}</Text>
            <Text style={{ color: t.muted, marginTop: 6, fontSize: 13 }}>
              Check that both phones show the same number, in person or by reading it aloud on a call. If they differ, someone swapped a code; reset and pair again.
            </Text>
          </View>
        )}

        {peer && <Button title="Numbers match. Start chatting 💬" onPress={onDone} />}
      </ScrollView>
      <QrScanner visible={scanning} onScan={onScanned} onClose={() => setScanning(false)} />
      <PasteCodeModal visible={pasting} onSubmit={(t) => void onScanned(t)} onClose={() => setPasting(false)} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  body: { padding: 24, paddingTop: 32 },
  qr: { alignSelf: 'center', padding: 16, borderRadius: 16, marginVertical: 16 },
  card: { borderWidth: 1, borderRadius: 16, padding: 16, marginTop: 20 },
  safety: { fontSize: 20, fontWeight: '600', letterSpacing: 1, fontVariant: ['tabular-nums'] },
});
