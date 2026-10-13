import type { Sodium } from '@pvtchat/protocol';
import * as rnSodium from 'react-native-libsodium';

/** JSI-backed libsodium; synchronous on iOS/Android (no `ready` await needed). */
export const sodium: Sodium & typeof rnSodium = rnSodium;
