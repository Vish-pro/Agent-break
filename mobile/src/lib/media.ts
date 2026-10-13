import { Directory, File, Paths } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

const MAX_IMAGE_EDGE = 1600;

function mediaDir(): Directory {
  const dir = new Directory(Paths.document, 'media');
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}

export const extFor = (mime: string): string =>
  ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'audio/mp4': 'm4a', 'audio/m4a': 'm4a', 'audio/aac': 'aac' })[mime] ??
  'bin';

/** Persist decrypted media in the app sandbox (excluded from other apps; app-locked UI). */
export function saveMedia(id: string, mime: string, bytes: Uint8Array): string {
  const file = new File(mediaDir(), `${id}.${extFor(mime)}`);
  if (file.exists) file.delete();
  file.create();
  file.write(bytes);
  return file.uri;
}

export function readBytes(uri: string): Promise<Uint8Array> {
  return new File(uri).bytes();
}

export function deleteFile(uri: string): void {
  try {
    const f = new File(uri);
    if (f.exists) f.delete();
  } catch {
    // best-effort cleanup
  }
}

/**
 * Re-encodes to JPEG and downsizes. Re-encoding drops EXIF metadata,
 * including GPS location, before the image ever leaves the phone.
 */
export async function prepareImage(
  uri: string,
  width: number,
  height: number,
): Promise<{ uri: string; width: number; height: number }> {
  const ctx = ImageManipulator.manipulate(uri);
  if (Math.max(width, height) > MAX_IMAGE_EDGE) {
    ctx.resize(width >= height ? { width: MAX_IMAGE_EDGE, height: null } : { width: null, height: MAX_IMAGE_EDGE });
  }
  const ref = await ctx.renderAsync();
  const out = await ref.saveAsync({ format: SaveFormat.JPEG, compress: 0.8 });
  return { uri: out.uri, width: out.width, height: out.height };
}

export function wipeMedia(): void {
  const dir = new Directory(Paths.document, 'media');
  if (dir.exists) dir.delete();
}
