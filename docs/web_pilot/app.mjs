import {VERSION, TIMING, parseCSV, validateSchedule, makePlan} from './core.mjs';
import {excelFile, archiveFile} from './results.mjs';

const $ = selector => document.querySelector(selector);
const app = $('#app');
const phase = document.body.dataset.phase;
const phaseNames = {learning:'学習', naming:'名前を答える', matching:'画像を選ぶ'};
const parameters = new URLSearchParams(location.search);
for (const [key, value] of new URLSearchParams(location.hash.slice(1))) parameters.set(key, value);
let db, ctx, stream, record, active, controller, running = false;
const buffers = new Map(), images = new Map(), sources = new Set();
const aborted = () => controller?.signal.aborted;
const check = () => { if (aborted()) throw controller.signal.reason; };
const escapeText = text => String(text).replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
const asset = (word, practice, type) => type === 'image'
  ? `../images/${practice ? 'practice/' : ''}230x230@2x/${word}.png`
  : `../wav/${practice ? 'practice/' : ''}${word}.wav`;
const imageSource = (word, practice) => images.get(asset(word, practice, 'image'));

function wait(ms) {
  check();
  return new Promise((resolve, reject) => {
    const signal = controller?.signal;
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, Math.max(0, ms));
    signal?.addEventListener('abort', abort, {once:true});
  });
}
const paint = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now()))));
function panel(title, text) {
  document.body.classList.remove('task');
  app.innerHTML = `<section class="panel"><h1>${escapeText(title)}</h1><p>${escapeText(text)}</p></section>`;
  return app.firstElementChild;
}
function button(parent, label, action, className = '') {
  const b = document.createElement('button'); b.textContent = label; b.className = className;
  b.addEventListener('click', action); parent.append(b); return b;
}
function waitChoice(buttons, limit = null) {
  check();
  return new Promise((resolve, reject) => {
    let timer;
    const signal = controller.signal;
    const clean = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel);
      buttons.forEach(([b]) => b.removeEventListener('click', select)); };
    const select = event => { const value = buttons.find(([b]) => b === event.currentTarget)[1];
      const handled = performance.now(); clean();
      buttons.forEach(([b]) => { b.disabled = true; });
      resolve({value, response_ms: handled, event_timestamp_ms: event.timeStamp}); };
    const cancel = () => { clean(); reject(signal.reason); };
    signal.addEventListener('abort', cancel, {once:true});
    buttons.forEach(([b]) => b.addEventListener('click', select));
    if (limit !== null) timer = setTimeout(() => {clean(); resolve({value:'timeout', response_ms:performance.now()});}, limit);
  });
}
async function gate(title, text, label = '開始する') {
  const p = panel(title, text); const b = button(p, label, () => {});
  await waitChoice([[b, 'continue']]); await ctx.resume();
}

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('ep-cssl-behavioral-pilot', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('sessions', {keyPath:'session.id'});
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}
function storage(mode, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('sessions', mode), store = tx.objectStore('sessions');
    const request = mode === 'readwrite' ? store.put(value) : store.getAll();
    let result; request.onsuccess = () => { result = request.result; };
    tx.oncomplete = () => resolve(result); tx.onabort = () => reject(tx.error || new Error('保存に失敗しました。'));
    tx.onerror = () => reject(tx.error || new Error('保存に失敗しました。'));
  });
}
async function save() {
  record.session.updated_at = new Date().toISOString();
  record.session.active_trial = active ? {...active} : null;
  try { await storage('readwrite', record); $('#save-status').textContent = `保存済み：${record.session.rows.length}試行`; }
  catch (error) { $('#save-status').textContent = '保存エラー：このページを閉じずにダウンロードしてください。'; throw error; }
}
async function exportRecord(saved, format = 'xlsx') {
  const blob = format === 'xlsx' ? await excelFile(saved.session) : await archiveFile(saved);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `${saved.session.id}.${format}`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
function downloadButton(parent, saved, format = 'xlsx') {
  button(parent, format === 'xlsx' ? '結果を保存' : '録音・記録を保存', async event => {
    const target = event.currentTarget; target.disabled = true;
    try { await exportRecord(saved, format); }
    catch (error) { const p = document.createElement('p'); p.className = 'error'; p.textContent = error.message; parent.append(p); }
    finally { target.disabled = false; }
  });
}
async function recovery(participant) {
  const saved = (await storage('readonly')).filter(data => data.session.participant === participant);
  $('#saved').replaceChildren();
  if (!saved.length) $('#saved').textContent = 'このブラウザに記録はありません。';
  for (const data of saved.sort((a,b) => b.session.started_at.localeCompare(a.session.started_at))) {
    const p = document.createElement('p'); p.textContent = `${phaseNames[data.session.phase] || '課題'} — ${new Date(data.session.started_at).toLocaleString('ja-JP')}`;
    $('#saved').append(p); downloadButton($('#saved'), data);
    if (Object.keys(data.recordings).length) downloadButton($('#saved'), data, 'zip');
  }
}
async function showResult(saved) {
  const s = saved.session, complete = s.status === 'complete';
  const p = panel(complete ? '課題は終了です' : '課題を中止しました',
    complete ? '結果ファイルが保存されます。保存されない場合は、下のボタンを押してください。' :
      s.status === 'aborted' ? 'ここまでの結果を保存してください。' :
        '課題を続けられませんでした。ここまでの結果を保存し、実施者にお知らせください。');
  downloadButton(p, saved);
  if (Object.keys(saved.recordings).length) downloadButton(p, saved, 'zip');
  const next = {learning:'naming', naming:'matching'}[s.phase];
  if (complete && next) {
    const link = document.createElement('a'); link.className = 'next'; link.textContent = '次の課題へ';
    const carry = new URLSearchParams({participant:s.participant, list:String(s.list), mode:s.mode,
      portuguese:s.portuguese, study:s.study_id, previous:s.id});
    link.href = `${next}.html#${carry}`; p.append(link);
  }
  if (s.rows.length) {
    try { await exportRecord(saved); }
    catch { const note = document.createElement('p'); note.textContent = '自動保存できませんでした。「結果を保存」を押してください。'; p.append(note); }
  }
}

async function loadFile(path) {
  let response;
  try { response = await fetch(new URL(path, import.meta.url), {cache:'no-store'}); }
  catch (error) { throw new Error(`通信に失敗しました：${path} (${error.message})`); }
  if (!response.ok) throw new Error(`ファイルを読み込めません：${path} (${response.status})`);
  const bytes = await response.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  record.session.file_hashes[path] = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2,'0')).join('');
  return bytes;
}
async function loadCSV(path) { return parseCSV(new TextDecoder().decode(await loadFile(path))); }
async function preload(settings) {
  const listFile = list => `../output/trial_lists/K10/list_${String(list).padStart(2,'0')}.csv`;
  const matchingList = ((settings.list - 1 + 12) % 24) + 1;
  const [items, learning, matching, practice] = await Promise.all([
    loadCSV('../config/stimuli_ep_12words.csv'), loadCSV(listFile(settings.list)),
    loadCSV(listFile(matchingList)), loadCSV('../config/practice_trials_learning.csv')]);
  const words = items.map(i => i.word);
  if (words.some(w => !/^[a-z]+$/.test(w))) throw new Error('刺激名が不正です。');
  validateSchedule(learning, words); validateSchedule(matching, words);
  if (practice.length !== 6 || practice.some(r =>
      [r.target_word,r.pos1_word,r.pos2_word,r.pos3_word].some(w => !['apple','book','car'].includes(w))))
    throw new Error('練習リストが不正です。');
  record.session.matching_list = matchingList;
  record.session.plan = makePlan(items, learning, matching, practice, settings.participant, settings.list, settings.mode === 'demo')
    .filter(trial => trial.phase === phase);
  const assets = [...new Set(record.session.plan.flatMap(trial => [trial.target,...trial.options]))]
    .map(word => ({word, practice:!words.includes(word)}));
  // A burst of 30 requests can reset connections on a simple local HTTP server.
  for (const {word, practice} of assets) {
    check();
    const audioPath = asset(word, practice, 'audio'), imagePath = asset(word, practice, 'image');
    const imageBytes = await loadFile(imagePath);
    if (phase !== 'naming') buffers.set(audioPath, await ctx.decodeAudioData(await loadFile(audioPath)));
    const url = URL.createObjectURL(new Blob([imageBytes], {type:'image/png'}));
    images.set(imagePath, url);
    const image = new Image(); image.src = url;
    try { await image.decode(); } catch (error) { throw new Error(`画像の内容を復号できません：${imagePath} (${error.message})`); }
    // Display the exact bytes that were hashed and decoded, without a second fetch.
  }
}

function playWord(word, practice) {
  if (ctx.state !== 'running') throw new Error('音声が停止しています。課題を中止します。');
  const source = ctx.createBufferSource(), buffer = buffers.get(asset(word, practice, 'audio'));
  source.buffer = buffer; source.connect(ctx.destination); sources.add(source);
  source.onended = () => { sources.delete(source); source.disconnect(); };
  const contextNow = ctx.currentTime, perfNow = performance.now(), scheduled = contextNow + .08;
  let fileOnset = perfNow + (scheduled - contextNow) * 1000, method = 'context_clock_estimate';
  const stamp = ctx.getOutputTimestamp?.();
  if (stamp?.performanceTime > 0 && stamp.contextTime > 0) {
    fileOnset = stamp.performanceTime + (scheduled - stamp.contextTime) * 1000;
    method = 'output_timestamp_estimate';
  }
  source.start(scheduled);
  return {audio_scheduled_context_s:scheduled, audio_schedule_perf_ms:perfNow,
    estimated_file_onset_ms:fileOnset, estimated_speech_onset_ms:fileOnset + TIMING.leadIn,
    audio_onset_method:method, audio_duration_ms:buffer.duration * 1000};
}

async function startRecording() {
  if (!stream?.getAudioTracks().some(t => t.readyState === 'live')) throw new Error('マイクが接続されていません。');
  const mime = ['audio/webm;codecs=opus','audio/ogg;codecs=opus','audio/mp4'].find(type => MediaRecorder.isTypeSupported(type));
  const recorder = new MediaRecorder(stream, mime ? {mimeType:mime} : {}), chunks = [];
  let recordingError;
  recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
  const finished = new Promise(resolve => { recorder.onstop = () => resolve(new Blob(chunks, {type:recorder.mimeType})); });
  const started = await new Promise((resolve, reject) => {
    recorder.onerror = event => { recordingError = event.error || new Error('録音エラー'); reject(recordingError); };
    recorder.onstart = () => resolve(performance.now()); recorder.start();
  });
  return {started, mime:recorder.mimeType, stop:async () => {
    if (recorder.state !== 'inactive') recorder.stop(); const blob = await finished;
    if (recordingError) throw recordingError;
    if (!blob.size) throw new Error('空の録音です。マイクを確認してください。'); return blob;
  }};
}

async function equipmentCheck() {
  if (phase !== 'naming') {
    const p = panel('音声の確認', 'ヘッドホンで音声を聞き、音量を調整してください。');
    const play = button(p, '音声を聞く', () => {});
    await waitChoice([[play, 'play']]); await ctx.resume(); playWord('apple', true);
    await wait(buffers.get(asset('apple',true,'audio')).duration * 1000 + 150);
    play.disabled = false; play.onclick = () => playWord('apple', true);
    const done = button(p, '聞こえました', () => {}); await waitChoice([[done,'ok']]); return;
  }
  const p = panel('マイクの確認', '3秒間「マイクのテストです」と話してください。録音を再生して、声が聞こえることを確認してください。');
  const start = button(p, '3秒間録音する', () => {}, 'quiet');
  await waitChoice([[start, 'record']]); start.disabled = true;
  const rec = await startRecording();
  try { await wait(3000); } finally {
    const blob = await rec.stop(); const player = document.createElement('audio');
    player.controls = true; player.src = URL.createObjectURL(blob); p.append(player);
    const continueButton = button(p, '聞こえました', () => {});
    await waitChoice([[continueButton, 'ok']]); URL.revokeObjectURL(player.src);
  }
}

async function choiceTrial(trial, row) {
  document.body.classList.add('task');
  app.innerHTML = `<div class="trial">${trial.options.map((word, i) =>
    `<button class="option" data-position="${i+1}" aria-label="選択肢${i+1}" disabled><img src="${imageSource(word, trial.practice)}" alt="選択肢${i+1}" draggable="false"></button>`).join('')}<span class="cross" hidden>+</span></div><p class="trial-hint"></p>`;
  await Promise.all([...app.querySelectorAll('img')].map(img => img.decode()));
  row.preview_onset_ms = await paint(); await wait(TIMING.preview);
  $('.cross').hidden = false; row.fixation_onset_ms = await paint(); await wait(TIMING.fixation);
  Object.assign(row, playWord(trial.target, trial.practice));
  const enableAt = row.estimated_speech_onset_ms + (trial.phase === 'learning' ? TIMING.learningDelay : 0);
  await wait(enableAt - performance.now());
  const options = [...app.querySelectorAll('.option')]; options.forEach(b => { b.disabled = false; });
  $('.cross').hidden = true; $('.trial-hint').textContent = '音声に合う画像を選んでください';
  row.response_enabled_ms = performance.now();
  const result = await waitChoice(options.map((b, i) => [b, i+1]));
  options.forEach(b => { b.disabled = true; });
  Object.assign(row, {response:result.value, response_ms:result.response_ms, event_timestamp_ms:result.event_timestamp_ms,
    chosen_word:trial.options[result.value-1], correct:Number(result.value === trial.target_position),
    rt_from_estimated_speech_ms:result.response_ms - row.estimated_speech_onset_ms,
    rt_from_response_enabled_ms:result.response_ms - row.response_enabled_ms});
}

async function namingTrial(trial, row) {
  document.body.classList.add('task');
  app.innerHTML = '<div class="naming"><span class="cross">+</span></div>';
  const rec = await startRecording(); row.recorder_start_event_ms = rec.started; row.recording_mime = rec.mime;
  try {
    await wait(TIMING.namingFixation);
    const image = new Image(); image.className = 'naming-image'; image.alt = '名前を答える画像';
    image.src = imageSource(trial.target, trial.practice); await image.decode();
    $('.naming').replaceChildren(image); row.image_onset_frame_ms = await paint();
    const actions = document.createElement('div'); actions.className = 'actions'; app.append(actions);
    const done = button(actions, '回答終了', () => {}), unknown = button(actions, 'わからない', () => {}, 'quiet');
    const hint = document.createElement('p'); hint.className = 'trial-hint';
    hint.textContent = '声に出して答えてください。10秒で次に進みます。'; app.append(hint);
    const result = await waitChoice([[done,'done'],[unknown,'unknown']], TIMING.namingLimit - (performance.now() - row.image_onset_frame_ms));
    done.disabled = true; unknown.disabled = true;
    Object.assign(row, {response:result.value, response_ms:result.response_ms,
      completion_button_latency_ms:result.response_ms - row.image_onset_frame_ms,
      correct:null, voice_onset_rt_ms:null});
  } finally {
    const blob = await rec.stop(); row.recorder_stop_completed_ms = performance.now();
    const extension = blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm';
    row.recording = `${trial.id}.${extension}`; row.recording_bytes = blob.size;
    record.recordings[row.recording] = blob;
  }
}

function quality(event) {
  if (!running || !record) return;
  const kind = event.type === 'visibilitychange' ? `visibility_${document.visibilityState}` : event.type;
  record.session.events.push({kind, at_ms:performance.now(), trial_id:active?.id || null});
  if (active && !active.quality_flags.includes(kind)) active.quality_flags.push(kind);
}
for (const type of ['blur','focus','resize']) window.addEventListener(type, quality);
document.addEventListener('visibilitychange', quality);
window.addEventListener('beforeunload', event => { if (running) { event.preventDefault(); event.returnValue = ''; } });
$('#stop').onclick = () => {
  if (running) { controller.abort(new DOMException('参加者または実施者が中止しました。', 'AbortError'));
    for (const source of sources) { try { source.stop(); } catch {} } }
};

async function run(settings) {
  controller = new AbortController(); running = true; $('#stop').hidden = false;
  const started = new Date().toISOString();
  record = {session:{id:`${settings.participant}_${phase}_${started.replace(/[:.]/g,'-')}_${crypto.randomUUID().slice(0,8)}`,
    version:VERSION, phase, ...settings, started_at:started, status:'initializing', time_origin_ms:performance.timeOrigin,
    timing:TIMING, environment:{user_agent:navigator.userAgent, language:navigator.language,
      viewport:[innerWidth,innerHeight], pixel_ratio:devicePixelRatio, screen:[screen.width,screen.height]},
    file_hashes:{}, rows:[], events:[], plan:[]}, recordings:{}};
  try {
    if (innerWidth < 960 || innerHeight < 760) throw new Error('PCでブラウザを幅960・高さ760 CSS px以上に広げてください。');
    if (!isSecureContext) throw new Error('HTTPSまたはlocalhostで開いてください。');
    if (phase === 'naming' && (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder))
      throw new Error('録音に対応するブラウザを使ってください。');
    ctx = new AudioContext(); await ctx.resume();
    record.session.environment.audio = {sample_rate:ctx.sampleRate, base_latency_s:ctx.baseLatency, output_latency_s:ctx.outputLatency};
    panel('準備しています', 'そのままお待ちください。');
    await preload(settings); check();
    record.session.preload_completed_ms = performance.now();
    if (phase === 'naming') {
      panel('マイクの確認', 'マイクの使用を許可してください。');
      stream = await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false, noiseSuppression:false, autoGainControl:false}});
      check(); const track = stream.getAudioTracks()[0]; const input = track.getSettings();
      record.session.environment.microphone = Object.fromEntries(['sampleRate','channelCount','latency','echoCancellation','noiseSuppression','autoGainControl'].filter(k => k in input).map(k => [k,input[k]]));
      track.onended = () => { if (running) controller.abort(new Error('マイクが切断されました。')); };
      track.onmute = () => { if (active) active.quality_flags.push('microphone_muted'); };
    }
    record.session.status = 'equipment_check'; await save(); await equipmentCheck();
    record.session.status = 'running'; record.session.task_started_ms = performance.now(); await save();
    let previous;
    for (const trial of record.session.plan) {
      check();
      const transition = !previous || previous.phase !== trial.phase || previous.practice !== trial.practice;
      if (transition) {
        const explanation = trial.phase === 'learning'
          ? '3つの画像を見て、聞こえた音声に合うと思う画像を選んでください。最初はわからなくてもかまいません。繰り返し聞いて、対応を覚えてください。選べるようになるまで少し待ちます。正解は表示されません。'
          : trial.phase === 'naming'
            ? `画像の${trial.practice ? '英語' : '学習した外国語'}の名前を声に出してください。話し終えたら「回答終了」を押してください。思い出せないときは「わからない」を押してください。10秒後に録音を終了します。`
            : '音声に合う画像を、できるだけ速く正確にクリックしてください。正解は表示されません。';
        await gate(trial.practice ? '練習' : phaseNames[phase], explanation);
      } else if (trial.phase === 'learning' && !trial.practice && trial.block !== previous.block) {
        await gate('休憩', `${previous.block}ブロックが終わりました。準備ができたら続けてください。`, '学習を続ける');
      }
      const section = record.session.plan.filter(t => t.phase === trial.phase && t.practice === trial.practice);
      $('#status').textContent = `${trial.practice ? '練習' : '本課題'} ${section.findIndex(t => t.id === trial.id)+1} / ${section.length}`;
      active = {...trial, trial_start_ms:performance.now(), quality_flags:[], status:'in_progress'};
      if (document.hidden) active.quality_flags.push('started_hidden');
      if (!document.hasFocus()) active.quality_flags.push('started_unfocused');
      await save();
      if (trial.phase === 'naming') await namingTrial(trial, active); else await choiceTrial(trial, active);
      active.status = 'complete'; active.trial_end_ms = performance.now();
      record.session.rows.push(active); active = null; await save();
      app.replaceChildren(); await wait(TIMING.iti); previous = trial;
    }
    record.session.status = 'complete'; record.session.task_ended_ms = performance.now(); await save();
  } catch (error) {
    if (active) { active.status = 'interrupted'; active.interruption_reason = error.message;
      active.trial_end_ms = performance.now(); record.session.rows.push(active); active = null; }
    record.session.status = error.name === 'AbortError' ? 'aborted' : 'error';
    record.session.error = error.message; record.session.task_ended_ms = performance.now();
    try { await save(); } catch (failure) { record.session.storage_error = failure.message; }
  } finally {
    running = false; $('#stop').hidden = true; $('#status').textContent = '';
    for (const source of sources) { try { source.stop(); } catch {} }
    stream?.getTracks().forEach(t => t.stop()); if (ctx && ctx.state !== 'closed') await ctx.close();
    images.forEach(url => URL.revokeObjectURL(url)); images.clear(); buffers.clear();
  }
  await showResult(record);
}

if ($('#settings')) $('#settings').onsubmit = async event => {
  event.preventDefault(); const data = Object.fromEntries(new FormData(event.currentTarget));
  data.list = Number(parameters.get('list') || 1); data.mode = parameters.get('mode') || 'pilot';
  data.portuguese ||= parameters.get('portuguese') || 'unknown';
  data.study_id = parameters.get('study') || crypto.randomUUID();
  data.previous_session_id = parameters.get('previous') || null;
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(data.participant) || !Number.isInteger(data.list) || data.list < 1 || data.list > 24 ||
      !['pilot','demo'].includes(data.mode) || !['none','some','unknown'].includes(data.portuguese) ||
      !/^[A-Za-z0-9_-]{1,80}$/.test(data.study_id)) {
    panel('開始できません', '参加者番号と、実施者から指定されたURLを確認してください。'); return;
  }
  if (running) return; await run(data);
};

try {
  db = await openDB();
  const input = $('[name=participant]');
  if (input && parameters.has('participant')) input.value = parameters.get('participant');
  if ($('#settings button')) $('#settings button').disabled = false;
  if ($('#lookup')) $('#lookup').onsubmit = async event => {event.preventDefault(); await recovery(input.value);};
} catch { panel('ブラウザに保存できません', '通常のブラウザウィンドウで開き直してください。'); }
