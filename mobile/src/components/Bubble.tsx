import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { Image } from 'expo-image';
import { memo } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import type { Message } from '../lib/db';
import { useTheme, type Theme } from '../theme';

const time = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function Ticks({ m, t }: { m: Message; t: Theme }) {
  const map: Record<string, string> = { pending: '🕓', sent: '✓', delivered: '✓✓', read: '✓✓', failed: '⚠️ tap to retry' };
  const color = m.status === 'read' ? '#7CD3FF' : 'rgba(255,255,255,0.85)';
  return <Text style={[styles.meta, { color: m.status === 'failed' ? t.primaryText : color }]}> {map[m.status] ?? ''}</Text>;
}

function AudioBody({ uri, fg }: { uri: string; fg: string }) {
  const player = useAudioPlayer(uri);
  const status = useAudioPlayerStatus(player);
  const toggle = () => {
    if (status.playing) return player.pause();
    if (status.didJustFinish || (status.duration > 0 && status.currentTime >= status.duration - 0.05)) void player.seekTo(0);
    player.play();
  };
  const secs = Math.max(0, Math.round((status.playing ? status.currentTime : status.duration) || 0));
  return (
    <Pressable onPress={toggle} style={styles.audio} hitSlop={8}>
      <Text style={[styles.audioIcon, { color: fg }]}>{status.playing ? '⏸' : '▶️'}</Text>
      <View style={[styles.audioBar, { backgroundColor: fg, opacity: 0.35 }]}>
        <View
          style={{
            width: `${status.duration ? Math.min(100, (status.currentTime / status.duration) * 100) : 0}%`,
            height: '100%',
            backgroundColor: fg,
          }}
        />
      </View>
      <Text style={[styles.meta, { color: fg }]}>
        {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')}
      </Text>
    </Pressable>
  );
}

export const Bubble = memo(function Bubble({
  m,
  onPress,
  onOpenImage,
}: {
  m: Message;
  onPress: (m: Message) => void;
  onOpenImage: (uri: string) => void;
}) {
  const t = useTheme();
  const out = m.outgoing === 1;
  const bg = out ? t.primary : t.inBubble;
  const fg = out ? t.primaryText : t.inText;

  let body: React.ReactNode;
  if (m.kind === 'text') {
    body = <Text style={[styles.text, { color: fg }]}>{m.body}</Text>;
  } else if (!m.local_uri) {
    body = (
      <View style={styles.placeholder}>
        {m.status === 'expired' ? (
          <Text style={{ color: fg }}>Attachment expired</Text>
        ) : (
          <ActivityIndicator color={fg} />
        )}
      </View>
    );
  } else if (m.kind === 'image') {
    const ratio = m.media?.width && m.media.height ? m.media.width / m.media.height : 1;
    body = (
      <Pressable onPress={() => m.local_uri && onOpenImage(m.local_uri)}>
        <Image source={{ uri: m.local_uri }} style={[styles.image, { aspectRatio: ratio }]} contentFit="cover" />
        {m.body ? <Text style={[styles.text, { color: fg, marginTop: 6 }]}>{m.body}</Text> : null}
      </Pressable>
    );
  } else {
    body = <AudioBody uri={m.local_uri} fg={fg} />;
  }

  return (
    <Pressable
      onPress={() => onPress(m)}
      style={[styles.row, { justifyContent: out ? 'flex-end' : 'flex-start' }]}
    >
      <View
        style={[
          styles.bubble,
          { backgroundColor: bg, borderColor: t.border },
          out ? styles.out : styles.in,
          m.status === 'failed' && { backgroundColor: t.danger },
        ]}
      >
        {body}
        <View style={styles.footer}>
          <Text style={[styles.meta, { color: out ? 'rgba(255,255,255,0.85)' : t.muted }]}>{time(m.ts)}</Text>
          {out && <Ticks m={m} t={t} />}
        </View>
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  row: { flexDirection: 'row', paddingHorizontal: 10, marginVertical: 2 },
  bubble: { maxWidth: '78%', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 18 },
  out: { borderBottomRightRadius: 4 },
  in: { borderBottomLeftRadius: 4, borderWidth: StyleSheet.hairlineWidth },
  text: { fontSize: 16, lineHeight: 21 },
  footer: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 2 },
  meta: { fontSize: 11 },
  image: { width: 220, borderRadius: 12, maxHeight: 320 },
  placeholder: { width: 200, height: 60, alignItems: 'center', justifyContent: 'center' },
  audio: { flexDirection: 'row', alignItems: 'center', width: 200, paddingVertical: 4 },
  audioIcon: { fontSize: 20, marginRight: 8 },
  audioBar: { flex: 1, height: 4, borderRadius: 2, overflow: 'hidden', marginRight: 8 },
});
