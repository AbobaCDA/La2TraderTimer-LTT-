const { app, safeStorage } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createClient } = require('@supabase/supabase-js');

// Publishable keys are designed for client applications. All table access is restricted by RLS.
const SUPABASE_URL = 'https://pomjfoknqoitmblprshz.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_vrCJstqfX2xz0sa-obskMQ_umbl1dkq';

const AUTH_FILE = () => path.join(app.getPath('userData'), 'cloud-auth.bin');
const PENDING_FILE = (userId) => path.join(app.getPath('userData'), `cloud-pending-sync-${String(userId).replace(/[^a-zA-Z0-9_-]/g, '')}.json`);
const SNAPSHOT_FILE = (userId) => path.join(app.getPath('userData'), `cloud-snapshot-${String(userId).replace(/[^a-zA-Z0-9_-]/g, '')}.json`);
let supabase = null;
let inMemoryAuth = {};
let cloudSnapshot = new Map();
let cloudSnapshotUserId = null;
let cloudSnapshotReady = false;
let syncQueue = Promise.resolve();
let cachedProfiles = new Map();
const pendingSyncByUser = new Map();

function cloneCharacter(record) {
  return {
    id: String(record.id),
    name: String(record.name).trim().slice(0, 32),
    license: Boolean(record.license),
    hidden: Boolean(record.hidden),
    startedAt: Number.isFinite(record.startedAt) ? record.startedAt : null,
    endAt: Number.isFinite(record.endAt) ? record.endAt : null,
    shiftHours: record.shiftHours === 12 || record.shiftHours === 24 ? record.shiftHours : null,
  };
}

function sameCharacter(left, right) {
  return Boolean(left && right) && left.id === right.id && left.name === right.name &&
    left.license === right.license && left.hidden === right.hidden && left.startedAt === right.startedAt &&
    left.endAt === right.endAt && left.shiftHours === right.shiftHours;
}

async function ensureCloudSnapshot(userId) {
  if (cloudSnapshotUserId === userId) return cloudSnapshotReady;
  cloudSnapshot = new Map();
  cloudSnapshotUserId = userId;
  cloudSnapshotReady = false;
  try {
    const parsed = JSON.parse(await fs.readFile(SNAPSHOT_FILE(userId), 'utf8'));
    if (parsed && parsed.version === 1 && parsed.userId === userId && Array.isArray(parsed.characters)) {
      cloudSnapshot = new Map(parsed.characters.map((raw) => {
        const record = cloneCharacter(raw);
        return [record.id, record];
      }));
      cloudSnapshotReady = true;
    }
  } catch (_) {}
  return cloudSnapshotReady;
}

async function writeCloudSnapshot(userId) {
  if (cloudSnapshotUserId !== userId) return;
  const file = SNAPSHOT_FILE(userId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tempFile = `${file}.${process.pid}.tmp`;
  const payload = { version: 1, userId, characters: [...cloudSnapshot.values()] };
  await fs.writeFile(tempFile, JSON.stringify(payload), 'utf8');
  await fs.rename(tempFile, file);
}

async function readEncryptedAuthStore() {
  try {
    const encrypted = await fs.readFile(AUTH_FILE());
    if (!safeStorage.isEncryptionAvailable()) return inMemoryAuth;
    const plain = safeStorage.decryptString(encrypted);
    const parsed = JSON.parse(plain);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return inMemoryAuth;
  }
}

async function writeEncryptedAuthStore(value) {
  const normalized = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  inMemoryAuth = normalized;
  if (!safeStorage.isEncryptionAvailable()) return;
  const file = AUTH_FILE();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tempFile = `${file}.${process.pid}.tmp`;
  const encrypted = safeStorage.encryptString(JSON.stringify(normalized));
  await fs.writeFile(tempFile, encrypted);
  await fs.rename(tempFile, file);
}

const secureAuthStorage = {
  async getItem(key) {
    const store = await readEncryptedAuthStore();
    return typeof store[key] === 'string' ? store[key] : null;
  },
  async setItem(key, value) {
    const store = await readEncryptedAuthStore();
    store[key] = value;
    await writeEncryptedAuthStore(store);
  },
  async removeItem(key) {
    const store = await readEncryptedAuthStore();
    delete store[key];
    await writeEncryptedAuthStore(store);
  },
};

async function getPendingSync(userId) {
  if (pendingSyncByUser.has(userId)) return pendingSyncByUser.get(userId);
  const blank = { version: 1, userId, upserts: {}, deletes: [] };
  try {
    const parsed = JSON.parse(await fs.readFile(PENDING_FILE(userId), 'utf8'));
    if (parsed && parsed.version === 1 && parsed.userId === userId && parsed.upserts && Array.isArray(parsed.deletes)) {
      pendingSyncByUser.set(userId, parsed);
      return parsed;
    }
  } catch (_) {}
  pendingSyncByUser.set(userId, blank);
  return blank;
}

async function writePendingSync(userId, queue) {
  queue.userId = userId;
  pendingSyncByUser.set(userId, queue);
  const file = PENDING_FILE(userId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tempFile = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tempFile, JSON.stringify(queue), 'utf8');
  await fs.rename(tempFile, file);
}

async function clearPendingSync(userId) {
  pendingSyncByUser.set(userId, { version: 1, userId, upserts: {}, deletes: [] });
  try { await fs.unlink(PENDING_FILE(userId)); } catch (_) {}
}

function ensureClient() {
  if (!supabase) {
    supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      auth: {
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false,
        storage: secureAuthStorage,
      },
    });
  }
  return supabase;
}

async function getCurrentUser() {
  const { data, error } = await ensureClient().auth.getSession();
  if (error || !data.session?.user) return null;
  return data.session.user;
}

async function getProfileForUser(user) {
  if (!user) return null;
  const { data, error } = await ensureClient()
    .from('profiles')
    .select('id,display_name,role,access_status')
    .eq('id', user.id)
    .maybeSingle();
  if (error) return cachedProfiles.get(user.id) ?? null;
  if (data) cachedProfiles.set(user.id, data);
  return data ?? null;
}

function mapCloudCharacter(row) {
  return {
    id: String(row.id),
    name: String(row.name),
    license: Boolean(row.license),
    hidden: Boolean(row.hidden),
    startedAt: row.started_at ? Date.parse(row.started_at) : null,
    endAt: row.end_at ? Date.parse(row.end_at) : null,
    shiftHours: row.shift_hours === 12 || row.shift_hours === 24 ? row.shift_hours : null,
  };
}

function toCloudRow(userId, record) {
  const item = cloneCharacter(record);
  return {
    user_id: userId,
    id: item.id,
    name: item.name,
    license: item.license,
    hidden: item.hidden,
    started_at: item.startedAt === null ? null : new Date(item.startedAt).toISOString(),
    end_at: item.endAt === null ? null : new Date(item.endAt).toISOString(),
    shift_hours: item.shiftHours,
  };
}

async function ensureActiveProfile(user) {
  const profile = await getProfileForUser(user);
  if (!profile) return { ok: false, profile: null, error: 'profile_not_ready' };
  if (profile.access_status === 'suspended') return { ok: false, profile, error: 'account_suspended' };
  if (profile.access_status !== 'active') return { ok: false, profile, error: 'telegram_link_required' };
  return { ok: true, profile, error: null };
}

async function getState() {
  const client = ensureClient();
  const { data: sessionData, error: sessionError } = await client.auth.getSession();
  if (sessionError || !sessionData.session) {
    cloudSnapshot = new Map();
    cloudSnapshotUserId = null;
    cloudSnapshotReady = false;
    return { signedIn: false };
  }
  const user = sessionData.session.user;
  await ensureCloudSnapshot(user.id);
  const profile = await getProfileForUser(user);
  return {
    signedIn: true,
    email: user.email ?? '',
    userId: user.id,
    role: profile?.role ?? 'member',
    accessStatus: profile?.access_status ?? 'pending',
    profileReady: Boolean(profile),
  };
}

async function getLocalState() {
  const user = await getCurrentUser();
  if (!user) return { signedIn: false };
  await ensureCloudSnapshot(user.id);
  const profile = cachedProfiles.get(user.id) ?? null;
  return {
    signedIn: true,
    email: user.email ?? '',
    userId: user.id,
    role: profile?.role ?? 'member',
    accessStatus: profile?.access_status ?? 'pending',
    profileReady: Boolean(profile),
  };
}

async function signUp(email, password) {
  const { data, error } = await ensureClient().auth.signUp({ email: email.trim(), password });
  if (error) return { ok: false, error: error.message };
  const emailConfirmationRequired = !data.session;
  if (data.user && data.session) await getProfileForUser(data.user);
  return {
    ok: true,
    emailConfirmationRequired,
    email: data.user?.email ?? email.trim(),
  };
}

async function signIn(email, password) {
  const { data, error } = await ensureClient().auth.signInWithPassword({ email: email.trim(), password });
  if (error) return { ok: false, error: error.message };
  const profile = await getProfileForUser(data.user);
  cloudSnapshot = new Map();
  cloudSnapshotUserId = null;
  cloudSnapshotReady = false;
  await ensureCloudSnapshot(data.user.id);
  return {
    ok: true,
    email: data.user.email ?? email.trim(),
    userId: data.user.id,
    role: profile?.role ?? 'member',
    accessStatus: profile?.access_status ?? 'pending',
    profileReady: Boolean(profile),
  };
}

async function signOut() {
  await syncQueue.catch(() => {});
  const user = await getCurrentUser();
  const { error } = await ensureClient().auth.signOut();
  cloudSnapshot = new Map();
  cloudSnapshotUserId = null;
  cloudSnapshotReady = false;
  if (user) cachedProfiles.delete(user.id);
  return { ok: !error, error: error?.message ?? null };
}

async function flushPendingOperations(userId, queue) {
  const client = ensureClient();
  const upserts = Object.values(queue.upserts ?? {});
  for (const record of upserts) {
    const { error } = await client.from('characters')
      .upsert(toCloudRow(userId, record), { onConflict: 'user_id,id' });
    if (error) return { ok: false, error: error.message };
  }
  const deleteIds = [...new Set(queue.deletes ?? [])];
  for (let index = 0; index < deleteIds.length; index += 100) {
    const batch = deleteIds.slice(index, index + 100);
    if (!batch.length) continue;
    const { error } = await client.from('characters')
      .delete()
      .eq('user_id', userId)
      .in('id', batch);
    if (error) return { ok: false, error: error.message };
  }
  for (const record of upserts) cloudSnapshot.set(record.id, cloneCharacter(record));
  for (const id of deleteIds) cloudSnapshot.delete(id);
  cloudSnapshotUserId = userId;
  cloudSnapshotReady = true;
  await writeCloudSnapshot(userId);
  await clearPendingSync(userId);
  return { ok: true };
}

async function loadCloudCharactersInternal() {
  const user = await getCurrentUser();
  if (!user) return { ok: false, signedIn: false, active: false, characters: [] };
  const hadSnapshotBaseline = await ensureCloudSnapshot(user.id);
  const access = await ensureActiveProfile(user);
  if (!access.ok) {
    return { ok: true, signedIn: true, active: false, error: access.error, accessStatus: access.profile?.access_status ?? 'pending', characters: [] };
  }

  let queue = await getPendingSync(user.id);
  const hasPending = Object.keys(queue.upserts ?? {}).length > 0 || (queue.deletes ?? []).length > 0;
  if (hasPending && hadSnapshotBaseline) {
    const flushed = await flushPendingOperations(user.id, queue);
    if (!flushed.ok) return { ok: false, signedIn: true, active: true, error: 'pending_sync_failed', characters: [] };
    queue = await getPendingSync(user.id);
  }

  const { data, error } = await ensureClient()
    .from('characters')
    .select('id,name,license,hidden,started_at,end_at,shift_hours')
    .eq('user_id', user.id)
    .order('created_at', { ascending: true })
    .order('name', { ascending: true });
  if (error) return { ok: false, signedIn: true, active: true, error: error.message, characters: [] };
  const records = (data ?? []).map(mapCloudCharacter);
  cloudSnapshot = new Map(records.map((record) => [record.id, record]));
  cloudSnapshotUserId = user.id;
  cloudSnapshotReady = true;
  await writeCloudSnapshot(user.id);

  if (hasPending && !hadSnapshotBaseline) {
    const flushed = await flushPendingOperations(user.id, queue);
    if (!flushed.ok) return { ok: false, signedIn: true, active: true, error: 'pending_sync_failed', characters: [] };
    return { ok: true, signedIn: true, active: true, characters: [...cloudSnapshot.values()] };
  }
  return { ok: true, signedIn: true, active: true, characters: records };
}

async function saveCharactersInternal(records) {
  const user = await getCurrentUser();
  if (!user) return { savedLocally: true, synced: false, reason: 'signed_out' };
  const hasSnapshotBaseline = await ensureCloudSnapshot(user.id);
  const access = await ensureActiveProfile(user);

  const next = new Map((Array.isArray(records) ? records : []).map((raw) => {
    const record = cloneCharacter(raw);
    return [record.id, record];
  }));
  const queue = await getPendingSync(user.id);
  const hadPendingOperations = Object.keys(queue.upserts ?? {}).length > 0 || (queue.deletes ?? []).length > 0;
  queue.upserts = {};
  queue.deletes = [];

  if (hasSnapshotBaseline) {
    for (const [id, record] of next) {
      const baselineRecord = cloudSnapshot.get(id);
      if (!sameCharacter(baselineRecord, record)) queue.upserts[id] = record;
    }
    for (const id of cloudSnapshot.keys()) {
      if (!next.has(id)) queue.deletes.push(id);
    }
  } else {
    // Without a downloaded baseline, keep additions/updates but never guess at deletions.
    for (const [id, record] of next) queue.upserts[id] = record;
  }
  const hasQueuedOperations = Object.keys(queue.upserts).length > 0 || queue.deletes.length > 0;

  if (!access.ok) {
    if (hasQueuedOperations || hadPendingOperations) await writePendingSync(user.id, queue);
    return { savedLocally: true, synced: false, reason: access.error };
  }
  if (!hasSnapshotBaseline) {
    if (hasQueuedOperations || hadPendingOperations) await writePendingSync(user.id, queue);
    return { savedLocally: true, synced: false, reason: 'cloud_baseline_not_loaded' };
  }
  if (!hasQueuedOperations && !hadPendingOperations) return { savedLocally: true, synced: true };

  await writePendingSync(user.id, queue);
  const result = await flushPendingOperations(user.id, queue);
  return { savedLocally: true, synced: result.ok, error: result.error ?? null };
}

async function mergeLocalCharactersInternal(records) {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: 'signed_out' };
  const access = await ensureActiveProfile(user);
  if (!access.ok) return { ok: false, error: access.error };
  await ensureCloudSnapshot(user.id);
  if (cloudSnapshotUserId !== user.id || !cloudSnapshotReady) return { ok: false, error: 'cloud_baseline_not_loaded' };

  const queue = await getPendingSync(user.id);
  if (Object.keys(queue.upserts ?? {}).length || (queue.deletes ?? []).length) {
    const flushed = await flushPendingOperations(user.id, queue);
    if (!flushed.ok) return { ok: false, error: 'pending_sync_failed' };
  }

  const uniqueLocalRows = [];
  for (const raw of Array.isArray(records) ? records : []) {
    const record = cloneCharacter(raw);
    // The cloud copy wins on duplicate IDs; unique local rows are imported without deleting remote data.
    if (!cloudSnapshot.has(record.id)) uniqueLocalRows.push(record);
  }
  for (const record of uniqueLocalRows) {
    const { error } = await ensureClient().from('characters')
      .upsert(toCloudRow(user.id, record), { onConflict: 'user_id,id', ignoreDuplicates: true });
    if (error) return { ok: false, error: error.message };
    cloudSnapshot.set(record.id, record);
  }
  await writeCloudSnapshot(user.id);
  return { ok: true, imported: uniqueLocalRows.length };
}

function serializeSync(task) {
  const operation = syncQueue.then(task, task);
  syncQueue = operation.catch(() => {});
  return operation;
}

function loadCloudCharacters() {
  return serializeSync(loadCloudCharactersInternal);
}

function saveCharacters(records) {
  const snapshot = Array.isArray(records) ? records.map(cloneCharacter) : [];
  return serializeSync(() => saveCharactersInternal(snapshot));
}

function mergeLocalCharacters(records) {
  const snapshot = Array.isArray(records) ? records.map(cloneCharacter) : [];
  return serializeSync(() => mergeLocalCharactersInternal(snapshot));
}

async function linkTelegram(code) {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: 'sign_in_required' };
  const { data, error } = await ensureClient().functions.invoke('link-telegram', {
    body: { code: String(code ?? '').trim().toUpperCase() },
  });
  if (error) {
    let details = null;
    try { details = await error.context?.json(); } catch (_) {}
    return { ok: false, error: details?.error ?? error.message ?? 'pairing_failed' };
  }
  return { ok: true, telegramUsername: data?.telegram_username ?? null };
}

module.exports = {
  initialize: () => { ensureClient(); },
  getState,
  getLocalState,
  signUp,
  signIn,
  signOut,
  loadCloudCharacters,
  saveCharacters,
  mergeLocalCharacters,
  linkTelegram,
};
