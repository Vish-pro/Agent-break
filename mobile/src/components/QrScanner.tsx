import { CameraView, useCameraPermissions } from 'expo-camera';
import { useRef } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../theme';

export function QrScanner({ visible, onScan, onClose }: { visible: boolean; onScan: (data: string) => void; onClose: () => void }) {
  const t = useTheme();
  const [perm, requestPerm] = useCameraPermissions();
  const handled = useRef(false);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} onShow={() => (handled.current = false)}>
      <View style={[styles.fill, { backgroundColor: '#000' }]}>
        {perm?.granted ? (
          <CameraView
            style={styles.fill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={({ data }) => {
              if (handled.current) return; // callback fires repeatedly while the code is in view
              handled.current = true;
              onScan(data);
            }}
          />
        ) : (
          <View style={[styles.fill, styles.center]}>
            <Text style={{ color: '#fff', marginBottom: 16, textAlign: 'center' }}>
              Camera access is needed to scan your partner's code.
            </Text>
            <Pressable onPress={requestPerm} style={[styles.btn, { backgroundColor: t.primary }]}>
              <Text style={{ color: t.primaryText, fontWeight: '600' }}>Allow camera</Text>
            </Pressable>
          </View>
        )}
        <Pressable onPress={onClose} style={[styles.btn, styles.close]}>
          <Text style={{ color: '#fff', fontWeight: '600' }}>Cancel</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center', padding: 24 },
  btn: { paddingHorizontal: 20, paddingVertical: 12, borderRadius: 24 },
  close: { position: 'absolute', bottom: 48, alignSelf: 'center', backgroundColor: 'rgba(0,0,0,0.6)' },
});
