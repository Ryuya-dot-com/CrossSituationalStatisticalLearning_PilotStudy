export const VERSION = '0.2.0';
export const TIMING = Object.freeze({preview: 800, fixation: 300, leadIn: 25,
  learningDelay: 1500, iti: 500, namingFixation: 500, namingLimit: 10000});

export function parseCSV(text) {
  const rows = []; let row = [], field = '', quoted = false;
  text = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && (c === ',' || c === '\n')) {
      row.push(field); field = '';
      if (c === '\n') { if (row.some(Boolean)) rows.push(row); row = []; }
    } else field += c;
  }
  if (quoted) throw new Error('CSVの引用符が閉じていません。');
  if (field || row.length) { row.push(field); rows.push(row); }
  const headers = rows.shift();
  if (!headers) throw new Error('空のCSVです。');
  return rows.map(values => {
    if (values.length !== headers.length) throw new Error('CSVの列数が一致しません。');
    return Object.fromEntries(headers.map((h, i) => [h, values[i]]));
  });
}

export function csv(rows, columns = [...new Set(rows.flatMap(row => Object.keys(row)))]) {
  const field = value => '"' + String(value ?? '').replaceAll('"', '""') + '"';
  return '\uFEFF' + [columns, ...rows.map(r => columns.map(k =>
    typeof r[k] === 'object' && r[k] !== null ? JSON.stringify(r[k]) : r[k]))]
    .map(row => row.map(field).join(',')).join('\r\n');
}

export function seededRandom(label) {
  let state = 2166136261;
  for (const char of label) state = Math.imul(state ^ char.charCodeAt(0), 16777619);
  return () => { state += 0x6D2B79F5; let t = state;
    t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
export function shuffle(items, random) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1)); [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function validateSchedule(rows, words, blocks = 10) {
  if (words.length !== 12 || new Set(words).size !== 12 || rows.length !== blocks * 12)
    throw new Error('12語×指定ブロック数のリストが必要です。');
  const ids = new Set();
  for (let b = 1; b <= blocks; b++) {
    const part = rows.filter(r => Number(r.block) === b);
    if (part.length !== 12) throw new Error(`ブロック${b}の試行数が不正です。`);
    for (const r of part) {
      const options = [r.pos1_word, r.pos2_word, r.pos3_word];
      if (ids.has(r.trial_id) || new Set(options).size !== 3 || options.some(w => !words.includes(w)) ||
          options[Number(r.target_pos) - 1] !== r.target_word ||
          !options.includes(r.d1_word) || !options.includes(r.d2_word) ||
          new Set([r.target_word, r.d1_word, r.d2_word]).size !== 3)
        throw new Error('試行ID・標的・選択肢に不整合があります。');
      ids.add(r.trial_id);
    }
    for (const word of words) {
      if (part.filter(r => r.target_word === word).length !== 1 ||
          part.filter(r => r.d1_word === word || r.d2_word === word).length !== 2)
        throw new Error('ブロック内の標的・妨害刺激の出現数が不正です。');
    }
    for (let position = 1; position <= 3; position++)
      if (part.filter(r => Number(r.target_pos) === position).length !== 4)
        throw new Error('標的位置が均衡していません。');
  }
}

export function makePlan(items, learning, matching, practice, participant, list, demo) {
  // Keep trial order stable when only the interface/export version changes.
  const random = seededRandom(`${participant}|${list}|0.1.0`);
  const choice = (r, phase, isPractice) => ({phase, practice: isPractice,
    source_trial_id: r.trial_id, block: Number(r.block), target: r.target_word,
    options: [r.pos1_word, r.pos2_word, r.pos3_word], target_position: Number(r.target_pos)});
  const naming = (word, isPractice) => ({phase: 'naming', practice: isPractice,
    block: 0, target: word, options: [], target_position: null});
  const plan = [
    ...practice.map(r => choice(r, 'learning', true)),
    ...learning.filter(r => !demo || Number(r.block) === 1).map(r => choice(r, 'learning', false)),
    naming('apple', true), ...shuffle(items.map(i => i.word), random).map(w => naming(w, false)),
    ...practice.slice(0, 3).map(r => choice(r, 'matching', true)),
    ...shuffle(matching.filter(r => Number(r.block) === 1), random).map(r => choice(r, 'matching', false))
  ];
  return plan.map((r, i) => ({...r, id: `${String(i + 1).padStart(3, '0')}_${r.phase}`}));
}

// STORE-only ZIP: no dependency or compression, sufficient for 13 short recordings.
export async function zip(files) {
  const encoder = new TextEncoder(), locals = [], central = []; let offset = 0;
  const crc32 = data => { let c = 0xFFFFFFFF;
    for (const byte of data) { c ^= byte;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); }
    return (c ^ 0xFFFFFFFF) >>> 0; };
  for (const [path, content] of Object.entries(files)) {
    const name = encoder.encode(path);
    const data = content instanceof Blob ? new Uint8Array(await content.arrayBuffer()) : encoder.encode(content);
    const crc = crc32(data), local = new Uint8Array(30 + name.length), lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x800, true);
    lv.setUint16(12, 33, true); // 1980-01-01, valid minimum DOS date.
    lv.setUint32(14, crc, true); lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true); local.set(name, 30);
    const entry = new Uint8Array(46 + name.length), ev = new DataView(entry.buffer);
    ev.setUint32(0, 0x02014b50, true); ev.setUint16(4, 20, true); ev.setUint16(6, 20, true);
    ev.setUint16(14, 33, true);
    ev.setUint16(8, 0x800, true); ev.setUint32(16, crc, true); ev.setUint32(20, data.length, true);
    ev.setUint32(24, data.length, true); ev.setUint16(28, name.length, true); ev.setUint32(42, offset, true);
    entry.set(name, 46); locals.push(local, data); central.push(entry); offset += local.length + data.length;
  }
  const end = new Uint8Array(22), view = new DataView(end.buffer), count = central.length;
  view.setUint32(0, 0x06054b50, true); view.setUint16(8, count, true); view.setUint16(10, count, true);
  view.setUint32(12, central.reduce((sum, e) => sum + e.length, 0), true); view.setUint32(16, offset, true);
  return new Blob([...locals, ...central, end], {type: 'application/zip'});
}
