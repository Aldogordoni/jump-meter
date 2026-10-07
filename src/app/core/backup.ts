/**
 * Full backups: one .zip with the jump history, settings, and every video clip.
 *
 *   backup.json          { app, version: 2, exportedAt, settings, history }
 *   clips/<id>.mp4|webm  the saved clip for that jump
 *   posters/<id>.jpg     its thumbnail
 *
 * Videos are stored without compression (they're already compressed), so zipping is
 * fast and the archive can be streamed, keeping memory use low on phones.
 */
import { Unzip, UnzipInflate, Zip, ZipDeflate, ZipPassThrough, strToU8 } from 'fflate';
import type { JumpRecord } from './jump-math';
import type { Settings } from './store.service';
import { clipStore, type StoredClip } from './clip-store';

export interface BackupProgress {
  stage: 'collecting' | 'packing' | 'reading' | 'restoring';
  done: number;
  total: number;
}

export interface BackupContents {
  history: JumpRecord[];
  settings: Partial<Settings> | null;
  clips: Map<string, { video: Blob; poster: Blob | null; mime: string }>;
}

/** Build the archive. `getClip` may fetch clips that only exist in the cloud. */
export async function buildBackup(
  history: JumpRecord[],
  settings: Settings,
  getClip: ((r: JumpRecord) => Promise<StoredClip | undefined>) | null,
  onProgress: (p: BackupProgress) => void,
): Promise<{ blob: Blob; clipCount: number }> {
  const parts: Uint8Array[] = [];
  let failure: unknown = null;
  let finished!: () => void;
  const done = new Promise<void>((resolve) => (finished = resolve));
  const zip = new Zip((err, chunk, final) => {
    if (err) failure = err;
    else parts.push(chunk);
    if (final || err) finished();
  });

  const meta = {
    app: 'jump-meter',
    version: 2,
    exportedAt: new Date().toISOString(),
    settings,
    // Local bookkeeping isn't meaningful on another device.
    history: history.map(({ synced: _s, hasClip: _h, ...r }) => r),
  };
  const json = new ZipDeflate('backup.json', { level: 6 });
  zip.add(json);
  json.push(strToU8(JSON.stringify(meta, null, 2)), true);

  let clipCount = 0;
  if (getClip) {
    for (let i = 0; i < history.length; i++) {
      onProgress({ stage: 'collecting', done: i, total: history.length });
      const r = history[i];
      const clip = await getClip(r).catch(() => undefined);
      if (!clip) continue;
      const ext = clip.mime.includes('webm') ? 'webm' : 'mp4';
      await addBlob(zip, `clips/${r.id}.${ext}`, clip.video);
      if (clip.poster.size) await addBlob(zip, `posters/${r.id}.jpg`, clip.poster);
      clipCount++;
      if (failure) throw failure;
    }
  }
  onProgress({ stage: 'packing', done: 1, total: 1 });
  zip.end();
  await done;
  if (failure) throw failure;
  return { blob: new Blob(parts as BlobPart[], { type: 'application/zip' }), clipCount };
}

async function addBlob(zip: Zip, name: string, blob: Blob) {
  const entry = new ZipPassThrough(name);
  zip.add(entry);
  const reader = blob.stream().getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    entry.push(value);
  }
  entry.push(new Uint8Array(0), true);
}

/** Read a .zip backup (or an old .json one). */
export async function readBackup(file: File, onProgress: (p: BackupProgress) => void): Promise<BackupContents> {
  const isZip = /\.zip$/i.test(file.name) || file.type.includes('zip') || (await isZipFile(file));
  if (!isZip) return parseJson(await file.text(), new Map());

  const files = new Map<string, Blob>();
  const pending: Promise<void>[] = [];
  const unzip = new Unzip((entry) => {
    const chunks: Uint8Array[] = [];
    pending.push(
      new Promise((resolve, reject) => {
        entry.ondata = (err, chunk, final) => {
          if (err) return reject(err);
          chunks.push(chunk);
          if (final) {
            files.set(entry.name, new Blob(chunks as BlobPart[], { type: mimeFor(entry.name) }));
            resolve();
          }
        };
      }),
    );
    entry.start();
  });
  unzip.register(UnzipInflate);

  const reader = file.stream().getReader();
  let read = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      unzip.push(new Uint8Array(0), true);
      break;
    }
    unzip.push(value);
    read += value.length;
    onProgress({ stage: 'reading', done: read, total: file.size });
  }
  await Promise.all(pending);

  const meta = files.get('backup.json');
  if (!meta) throw new Error("That zip isn't a Jump Meter backup.");
  const clips: BackupContents['clips'] = new Map();
  for (const [name, blob] of files) {
    const m = name.match(/^clips\/([^/]+)\.(mp4|webm)$/);
    if (!m) continue;
    clips.set(m[1], { video: blob, poster: files.get(`posters/${m[1]}.jpg`) ?? null, mime: blob.type });
  }
  return parseJson(await meta.text(), clips);
}

function parseJson(text: string, clips: BackupContents['clips']): BackupContents {
  const data = JSON.parse(text);
  const history: JumpRecord[] = Array.isArray(data) ? data : data.history;
  if (!Array.isArray(history)) throw new Error('No jump history found in that file.');
  return { history, settings: Array.isArray(data) ? null : (data.settings ?? null), clips };
}

async function isZipFile(file: File) {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  return head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
}

function mimeFor(name: string) {
  if (name.endsWith('.mp4')) return 'video/mp4';
  if (name.endsWith('.webm')) return 'video/webm';
  if (name.endsWith('.jpg')) return 'image/jpeg';
  if (name.endsWith('.json')) return 'application/json';
  return 'application/octet-stream';
}

/** Store clips from a backup on this device (skipping ones already here). */
export async function restoreClips(
  clips: BackupContents['clips'],
  onProgress: (p: BackupProgress) => void,
): Promise<number> {
  const have = await clipStore.ids().catch(() => new Set<string>());
  let n = 0;
  let i = 0;
  for (const [id, c] of clips) {
    onProgress({ stage: 'restoring', done: i++, total: clips.size });
    if (have.has(id)) continue;
    await clipStore.put({
      id,
      video: c.video,
      poster: c.poster ?? new Blob([], { type: 'image/jpeg' }),
      mime: c.mime,
      createdAt: new Date().toISOString(),
    });
    n++;
  }
  return n;
}
