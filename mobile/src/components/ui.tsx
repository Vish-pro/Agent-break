import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, type TextInputProps } from 'react-native';
import { useTheme } from '../theme';

export function Button({
  title,
  onPress,
  busy,
  variant = 'primary',
  disabled,
}: {
  title: string;
  onPress: () => void;
  busy?: boolean;
  variant?: 'primary' | 'ghost' | 'danger';
  disabled?: boolean;
}) {
  const t = useTheme();
  const bg = variant === 'primary' ? t.primary : variant === 'danger' ? t.danger : 'transparent';
  const fg = variant === 'ghost' ? t.primary : t.primaryText;
  return (
    <Pressable
      onPress={onPress}
      disabled={busy || disabled}
      style={({ pressed }) => [
        styles.btn,
        { backgroundColor: bg, opacity: disabled ? 0.4 : pressed ? 0.8 : 1 },
        variant === 'ghost' && { borderWidth: 1, borderColor: t.primary },
      ]}
    >
      {busy ? <ActivityIndicator color={fg} /> : <Text style={[styles.btnText, { color: fg }]}>{title}</Text>}
    </Pressable>
  );
}

export function Field(props: TextInputProps & { label: string }) {
  const t = useTheme();
  const { label, style, ...rest } = props;
  return (
    <>
      <Text style={[styles.label, { color: t.muted }]}>{label}</Text>
      <TextInput
        placeholderTextColor={t.muted}
        autoCapitalize="none"
        autoCorrect={false}
        {...rest}
        style={[styles.input, { color: t.text, backgroundColor: t.surface, borderColor: t.border }, style]}
      />
    </>
  );
}

export function H1({ children }: { children: ReactNode }) {
  const t = useTheme();
  return <Text style={[styles.h1, { color: t.text }]}>{children}</Text>;
}

export function P({ children, muted }: { children: ReactNode; muted?: boolean }) {
  const t = useTheme();
  return <Text style={[styles.p, { color: muted ? t.muted : t.text }]}>{children}</Text>;
}

const styles = StyleSheet.create({
  btn: { height: 50, borderRadius: 25, alignItems: 'center', justifyContent: 'center', marginTop: 12, paddingHorizontal: 20 },
  btnText: { fontSize: 16, fontWeight: '600' },
  label: { fontSize: 13, marginTop: 16, marginBottom: 6 },
  input: { height: 48, borderRadius: 12, borderWidth: 1, paddingHorizontal: 14, fontSize: 16 },
  h1: { fontSize: 28, fontWeight: '700', marginBottom: 8 },
  p: { fontSize: 15, lineHeight: 22, marginBottom: 8 },
});
