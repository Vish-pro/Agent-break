import { useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, StyleSheet, TextInput, View } from 'react-native';
import { useTheme } from '../theme';
import { Button, H1, P } from './ui';

export function PasteCodeModal({
  visible,
  onSubmit,
  onClose,
}: {
  visible: boolean;
  onSubmit: (text: string) => void;
  onClose: () => void;
}) {
  const t = useTheme();
  const [text, setText] = useState('');
  const close = () => {
    setText('');
    onClose();
  };
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={close}>
      <KeyboardAvoidingView
        style={[styles.fill, { backgroundColor: t.bg }]}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.body}>
          <H1>Paste code</H1>
          <P muted>Paste the whole message your partner sent. It starts with “justus1:”.</P>
          <TextInput
            value={text}
            onChangeText={setText}
            multiline
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="justus1:…"
            placeholderTextColor={t.muted}
            style={[styles.input, { color: t.text, backgroundColor: t.surface, borderColor: t.border }]}
          />
          <Button
            title="Use this code"
            disabled={!text.includes('justus1:')}
            onPress={() => {
              const v = text;
              setText('');
              onSubmit(v);
            }}
          />
          <Button title="Cancel" variant="ghost" onPress={close} />
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  body: { padding: 24, paddingTop: 56 },
  input: { minHeight: 140, borderWidth: 1, borderRadius: 12, padding: 12, fontSize: 14, textAlignVertical: 'top' },
});
