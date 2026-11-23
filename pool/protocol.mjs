// Shared controller/node protocol. No Node APIs, credentials, or side effects.
// Single-row D1 limit is 2,000,000 bytes; reserve space for version and row overhead.
export const MAX_DICTIONARY_BYTES = 1_800_000;
export const MAX_MESSAGE_BYTES = 64 * 1024;
export const HEX_VERSION = /^[a-f0-9]{64}$/i;
export const MAX_FINGERPRINTS = 5000;
export const MAX_SAMPLES = 5000;
export const MAX_BLACKLIST = 10000;
export const MAX_SAMPLE_VARIANTS = 8;
export const MAX_SAMPLE_VARIANT_LENGTH = 200;
export const MAX_VECTOR_DIMENSIONS = 4096;

export class ProtocolError extends Error {
  constructor(status, error) {
    super(error);
    this.name = 'ProtocolError';
    this.status = status;
    this.error = error;
  }
}

export function json(status, object) {
  return new Response(JSON.stringify(object), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export async function readJson(request, maxBytes = MAX_MESSAGE_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_DICTIONARY_BYTES) {
    throw new ProtocolError(500, 'invalid_size_limit');
  }
  const length = request.headers.get('Content-Length');
  if (length && /^\d+$/.test(length) && Number(length) > maxBytes) {
    await request.body?.cancel().catch(() => {});
    throw new ProtocolError(413, 'payload_too_large');
  }
  const reader = request.body?.getReader();
  if (!reader) throw new ProtocolError(400, 'invalid_json');
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new ProtocolError(413, 'payload_too_large');
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    throw new ProtocolError(400, 'invalid_json');
  } finally {
    reader.releaseLock();
  }
}

export function constantEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  let difference = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    difference |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  }
  return difference === 0;
}

// Keep identical to Beta's normalizeAdText; dictionary hashes depend on it.
export function normalized(value) {
  let text = String(value || '').replace(/[\uFF01-\uFF5E]/g,
    ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)).toLowerCase();
  text = text.replace(/\p{Extended_Pictographic}/gu, ' ');
  text = text.replace(/[.·,、_\-]/g, '');
  text = text.replace(/\s+/g, '');
  text = text.replace(/[^\p{L}\p{N}@:+]+/gu, ' ');
  return text.replace(/\s+/g, ' ').trim();
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function keysAllowed(value, keys) {
  return record(value) && Object.keys(value).every(key => keys.includes(key));
}
function optionalString(value, length) {
  return value == null || (typeof value === 'string' && value.length <= length);
}
export function validUserId(value) {
  return typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value);
}
function positiveId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

// Accept either the message itself (controller use) or {version,message} (node use).
// Return the validated, copied message. No unknown fields are forwarded.
export function validateMessageInput(body, depth = 0) {
  let message = body;
  let version;
  if (record(body) && Object.hasOwn(body, 'message')) {
    if (!keysAllowed(body, ['version', 'message'])) return { ok: false, error: 'invalid_message' };
    if (typeof body.version !== 'string' || !HEX_VERSION.test(body.version)) {
      return { ok: false, error: 'invalid_version' };
    }
    version = body.version.toLowerCase();
    message = body.message;
  }
  const fields = ['chat_id', 'chat_title', 'user_id', 'message_id', 'text', 'quote', 'contact_name',
    'first_name', 'last_name', 'username', 'is_bot', ...(depth === 0 ? ['reply'] : [])];
  if (!keysAllowed(message, fields)
      || typeof message.chat_id !== 'string' || !/^-[1-9]\d{1,15}$/.test(message.chat_id)
      || !validUserId(message.user_id) || !positiveId(message.message_id)
      || ['text', 'quote', 'contact_name'].some(key => !optionalString(message[key], 4000))
      || ['chat_title', 'first_name', 'last_name'].some(key => !optionalString(message[key], 256))
      || !optionalString(message.username, 64)
      || (message.is_bot != null && typeof message.is_bot !== 'boolean')) {
    return { ok: false, error: 'invalid_message' };
  }
  const result = {
    chat_id: message.chat_id, user_id: message.user_id, message_id: message.message_id,
    text: message.text || '', quote: message.quote || '', contact_name: message.contact_name || '',
    first_name: message.first_name || '', last_name: message.last_name || '',
    username: message.username || '', is_bot: message.is_bot === true,
  };
  if (message.chat_title != null) result.chat_title = message.chat_title;
  if (message.reply != null) {
    if (depth !== 0) return { ok: false, error: 'invalid_reply' };
    const reply = validateMessageInput({ chat_id: message.chat_id, ...message.reply }, 1);
    if (!reply.ok || reply.message.chat_id !== message.chat_id) return { ok: false, error: 'invalid_reply' };
    result.reply = reply.message;
  }
  return version ? { ok: true, version, message: result } : { ok: true, message: result };
}

// Reject matrices, sparse/non-finite/extreme/zero vectors before cosine comparison.
export function validVector(value) {
  if (!Array.isArray(value) || !value.length || value.length > MAX_VECTOR_DIMENSIONS) return false;
  let square = 0;
  for (let i = 0; i < value.length; i++) {
    const component = value[i];
    if (typeof component !== 'number' || !Number.isFinite(component) || Math.abs(component) > 1e6) return false;
    square += component * component;
  }
  return Number.isFinite(square) && square > 0;
}

export function validateDictionaryInput(body) {
  const fail = () => ({ ok: false, error: 'invalid_dictionary' });
  if (!keysAllowed(body, ['version', 'data']) || typeof body.version !== 'string'
      || !HEX_VERSION.test(body.version)
      || !keysAllowed(body.data, ['fingerprints', 'samples', 'whitelist', 'owners', 'allowlist', 'blacklist'])) return fail();
  const data = body.data;
  const hasBlacklist = Object.hasOwn(data, 'blacklist');
  if (hasBlacklist && (!Array.isArray(data.blacklist) || data.blacklist.length > MAX_BLACKLIST
      || data.blacklist.some(value => !validUserId(value)) || new Set(data.blacklist).size !== data.blacklist.length)) return fail();
  const caps = { fingerprints: MAX_FINGERPRINTS, samples: MAX_SAMPLES, whitelist: 10000, owners: 10000, allowlist: 10000 };
  for (const [key, cap] of Object.entries(caps)) {
    if (!Array.isArray(data[key]) || data[key].length > cap) return fail();
  }
  const fingerprintIds = new Set();
  const sampleIds = new Set();
  const fingerprints = [];
  const samples = [];
  const allowlist = [];
  for (const item of data.fingerprints) {
    if (!keysAllowed(item, ['id', 'type', 'value', 'norm_value', 'status', 'source'])
        || !positiveId(item.id) || fingerprintIds.has(item.id)
        || !['keyword', 'ad_phrase', 'card_name', 'name', 'username', 'bio'].includes(item.type)
        || typeof item.value !== 'string' || item.value.length < 1 || item.value.length > 200
        || typeof item.norm_value !== 'string' || item.norm_value.length > 200
        || item.norm_value !== normalized(item.value).slice(0, 200)
        || !['confirmed', 'pending', 'retired'].includes(item.status)
        || !optionalString(item.source, 128)) return fail();
    fingerprintIds.add(item.id);
    fingerprints.push({ id: item.id, type: item.type, value: item.value,
      norm_value: item.norm_value, status: item.status, source: item.source || '' });
  }
  for (const item of data.samples) {
    if (!keysAllowed(item, ['id', 'norm_hash', 'sample_text', 'kind', 'embedding', 'count', 'variants'])
        || !positiveId(item.id) || sampleIds.has(item.id)
        || typeof item.norm_hash !== 'string' || !HEX_VERSION.test(item.norm_hash)
        || typeof item.sample_text !== 'string' || item.sample_text.length < 1 || item.sample_text.length > 4000
        || (item.kind != null && !['text', 'quote', 'card_name', 'name', 'bio', 'username'].includes(item.kind))
        || !Number.isSafeInteger(item.count) || item.count < 0
        || (item.embedding !== null && !validVector(item.embedding))) return fail();
    const hasVariants = Object.hasOwn(item, 'variants');
    if (hasVariants && (!Array.isArray(item.variants) || item.variants.length > MAX_SAMPLE_VARIANTS
        || item.variants.some(value => typeof value !== 'string' || value.length < 1 || value.length > MAX_SAMPLE_VARIANT_LENGTH)
        || new Set(item.variants).size !== item.variants.length)) return fail();
    sampleIds.add(item.id);
    samples.push({ id: item.id, norm_hash: item.norm_hash.toLowerCase(), sample_text: item.sample_text,
      kind: item.kind || 'text', embedding: item.embedding === null ? null : [...item.embedding], count: item.count,
      ...(hasVariants ? { variants: [...item.variants] } : {}) });
  }
  for (const key of ['whitelist', 'owners']) if (data[key].some(value => !validUserId(value))) return fail();
  for (const item of data.allowlist) {
    if (!keysAllowed(item, ['dimension', 'value'])
        || !['text', 'quote', 'card_name', 'name', 'username', 'bio'].includes(item.dimension)
        || typeof item.value !== 'string' || item.value.length < 1 || item.value.length > 4000) return fail();
    allowlist.push({ dimension: item.dimension, value: item.value });
  }
  // Absent optional fields remain absent in the serialized validation result,
  // preserving already-generated legacy snapshot versions and payload bytes.
  return { ok: true, version: body.version.toLowerCase(), data: { fingerprints, samples,
    whitelist: [...new Set(data.whitelist)], owners: [...new Set(data.owners)], allowlist,
    ...(hasBlacklist ? { blacklist: [...data.blacklist] } : {}) } };
}

function labelValue(value) {
  if (typeof value === 'string') {
    value = value.trim();
    const fence = value.match(/^```(?:text|json)?\s*\n([\s\S]*?)\n```$/i);
    if (fence) value = fence[1].trim();
    if (value.startsWith('{') || value.startsWith('"')) {
      try { value = JSON.parse(value); } catch { return null; }
    }
  }
  if (record(value)) {
    if (Object.keys(value).length !== 1 || !Object.hasOwn(value, 'verdict')) return null;
    value = value.verdict;
  }
  if (typeof value !== 'string') return null;
  const label = value.trim().toLowerCase();
  return label === 'ad' || label === 'ok' ? label : null;
}

export function parseSingleLabel(response) {
  if (typeof response === 'string') return labelValue(response);
  if (!record(response)) return null;
  const root = record(response.result) ? response.result : response;
  if (root.finish_reason != null && root.finish_reason !== 'stop') return null;
  if (Array.isArray(root.choices)) {
    if (root.choices.length !== 1) return null;
    const choice = root.choices[0];
    if (!record(choice) || choice.finish_reason !== 'stop' || !record(choice.message)
        || choice.message.refusal || typeof choice.message.content !== 'string') return null;
    return labelValue(choice.message.content);
  }
  const value = root.response ?? (typeof response.result === 'string' ? response.result : null);
  return labelValue(value);
}
