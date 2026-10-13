import { fromB64, toB64 } from '@pvtchat/protocol';
import * as SecureStore from 'expo-secure-store';
import { z } from 'zod';
import { sodium } from './sodium';

// Keychain/Keystore only, never synced to iCloud/Google backups.
const OPTS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

const Identity = z.object({
  server: z.string(),
  deviceId: z.string(),
  name: z.string(),
  signPk: z.string(),
  signSk: z.string(),
  boxPk: z.string(),
  boxSk: z.string(),
  /** Kept only by the inviter until pairing completes, to embed in the invite QR. */
  registrationSecret: z.string().optional(),
});
export type Identity = z.infer<typeof Identity>;

const Peer = z.object({ deviceId: z.string(), name: z.string(), signPk: z.string(), boxPk: z.string() });
export type Peer = z.infer<typeof Peer>;

const K = { identity: 'pvtchat.identity', peer: 'pvtchat.peer', dbKey: 'pvtchat.dbkey', settings: 'pvtchat.settings' } as const;

async function getJson<T>(key: string, schema: z.ZodType<T>): Promise<T | null> {
  const raw = await SecureStore.getItemAsync(key, OPTS);
  if (!raw) return null;
  const r = schema.safeParse(JSON.parse(raw));
  return r.success ? r.data : null;
}

export const loadIdentity = () => getJson(K.identity, Identity);
export const saveIdentity = (id: Identity) => SecureStore.setItemAsync(K.identity, JSON.stringify(id), OPTS);
export const loadPeer = () => getJson(K.peer, Peer);
export const savePeer = (p: Peer) => SecureStore.setItemAsync(K.peer, JSON.stringify(p), OPTS);

const Settings = z.object({ appLock: z.boolean(), paired: z.boolean() });
export type Settings = z.infer<typeof Settings>;
export const loadSettings = async (): Promise<Settings> => (await getJson(K.settings, Settings)) ?? { appLock: true, paired: false };
export const saveSettings = (s: Settings) => SecureStore.setItemAsync(K.settings, JSON.stringify(s), OPTS);

/** 256-bit SQLCipher key, generated once per install. */
export async function getDbKeyHex(): Promise<string> {
  let key = await SecureStore.getItemAsync(K.dbKey, OPTS);
  if (!key) {
    key = Array.from(sodium.randombytes_buf(32), (b) => b.toString(16).padStart(2, '0')).join('');
    await SecureStore.setItemAsync(K.dbKey, key, OPTS);
  }
  if (!/^[0-9a-f]{64}$/.test(key)) throw new Error('corrupt db key');
  return key;
}

export function generateKeys(): Pick<Identity, 'signPk' | 'signSk' | 'boxPk' | 'boxSk'> {
  const sign = sodium.crypto_sign_keypair();
  const box = sodium.crypto_box_keypair();
  return {
    signPk: toB64(sign.publicKey),
    signSk: toB64(sign.privateKey),
    boxPk: toB64(box.publicKey),
    boxSk: toB64(box.privateKey),
  };
}

export const boxKeys = (me: Identity, peer: Peer) => ({ myBoxSk: fromB64(me.boxSk), peerBoxPk: fromB64(peer.boxPk) });

export async function wipeAll(): Promise<void> {
  await Promise.all(Object.values(K).map((k) => SecureStore.deleteItemAsync(k, OPTS)));
}
