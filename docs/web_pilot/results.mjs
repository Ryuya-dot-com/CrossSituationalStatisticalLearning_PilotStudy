import {zip, csv} from './core.mjs';

const xml = value => String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
  .replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const columns = rows => [...new Set(rows.flatMap(row => Object.keys(row)))];
function columnName(index) {
  let out = '';
  for (let n = index + 1; n; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + (n - 1) % 26) + out;
  return out;
}
function flatten(value, prefix = '', rows = []) {
  for (const [key, data] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (data && typeof data === 'object' && !Array.isArray(data)) flatten(data, path, rows);
    else rows.push({field:path, value:Array.isArray(data) ? JSON.stringify(data) : data});
  }
  return rows;
}
function trialRow(s, row) {
  const {options, quality_flags, ...values} = row;
  return {participant:s.participant, study_id:s.study_id || '', session_id:s.id,
    list:s.list, mode:s.mode, ...values,
    option_1:options?.[0] ?? '', option_2:options?.[1] ?? '', option_3:options?.[2] ?? '',
    quality_flags:quality_flags?.join(';') || ''};
}
export function resultTables(session) {
  const {rows, plan, events, ...settings} = session;
  const tables = [{name:'Trials', rows:rows.map(row => trialRow(session, row)), headers:[] }];
  tables[0].headers = columns(tables[0].rows);
  if (!tables[0].headers.length) tables[0].headers = ['participant','study_id','session_id','phase','id','status'];
  if (rows.some(r => r.phase === 'naming') || session.phase === 'naming') tables.push({name:'NamingScoring',
    rows:rows.filter(r => r.phase === 'naming').map(r => ({participant:session.participant,
      study_id:session.study_id || '', session_id:session.id, trial_id:r.id, practice:r.practice,
      target:r.target, recording:r.recording || '', response:r.response || '', transcription:null,
      form_recalled:null, pronunciation_score:null, voice_onset_in_recording_ms:null,
      validated_voice_rt_ms:null, rater:null, notes:null})),
    headers:['participant','study_id','session_id','trial_id','practice','target','recording','response',
      'transcription','form_recalled','pronunciation_score','voice_onset_in_recording_ms','validated_voice_rt_ms','rater','notes']});
  tables.push({name:'Session', rows:flatten(settings), headers:['field','value']});
  tables.push({name:'Plan', rows:plan.map(row => trialRow(session, row)), headers:[]});
  tables.at(-1).headers = columns(tables.at(-1).rows);
  if (!tables.at(-1).headers.length) tables.at(-1).headers = ['id','phase','target'];
  tables.push({name:'Events', rows:events, headers:['kind','at_ms','trial_id']});
  return tables;
}

// Browser-side SpreadsheetML export. No server, remote library, or formula evaluation.
// Strings are literal inline strings, so participant text cannot become an Excel formula.
export async function excelFile(session) {
  const tables = resultTables(session), files = {};
  files['[Content_Types].xml'] = declaration +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    tables.map((_,i) => `<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + '</Types>';
  files['_rels/.rels'] = declaration + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  files['xl/workbook.xml'] = declaration + `<workbook xmlns="${ns}" xmlns:r="${rel}"><sheets>` +
    tables.map((t,i) => `<sheet name="${t.name}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join('') + '</sheets></workbook>';
  files['xl/_rels/workbook.xml.rels'] = declaration + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    tables.map((_,i) => `<Relationship Id="rId${i+1}" Type="${rel}/worksheet" Target="worksheets/sheet${i+1}.xml"/>`).join('') +
    `<Relationship Id="styles" Type="${rel}/styles" Target="styles.xml"/></Relationships>`;
  files['xl/styles.xml'] = declaration + `<styleSheet xmlns="${ns}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  for (const [i, table] of tables.entries()) {
    const values = [table.headers, ...table.rows.map(row => table.headers.map(key => row[key]))];
    const last = `${columnName(table.headers.length-1)}${values.length}`;
    const data = values.map((cells, r) => `<row r="${r+1}"${r===0 ? ' ht="44" customHeight="1"' : ''}>` + cells.map((v,c) => {
      if (v === null || v === undefined || v === '') return '';
      const address = `${columnName(c)}${r+1}`, style = r===0 ? 1 : typeof v==='number' && !Number.isInteger(v) ? 2 : 0;
      if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${address}" s="${style}"><v>${v}</v></c>`;
      if (typeof v === 'boolean') return `<c r="${address}" t="b"><v>${Number(v)}</v></c>`;
      return `<c r="${address}" t="inlineStr" s="${style}"><is><t xml:space="preserve">${xml(typeof v === 'object' ? JSON.stringify(v) : v)}</t></is></c>`;
    }).join('') + '</row>').join('');
    files[`xl/worksheets/sheet${i+1}.xml`] = declaration + `<worksheet xmlns="${ns}"><dimension ref="A1:${last}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols>` +
      table.headers.map((key,c) => `<col min="${c+1}" max="${c+1}" width="${key==='session_id' ? 64 : key==='study_id' ? 40 : table.name==='Session' ? (c===0 ? 56 : 100) : Math.min(35, Math.max(16, key.length))}" customWidth="1"/>`).join('') +
      `</cols><sheetData>${data}</sheetData><autoFilter ref="A1:${last}"/></worksheet>`;
  }
  return new Blob([await zip(files)], {type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
}
export async function archiveFile(saved) {
  const files = {'results.xlsx':await excelFile(saved.session),
    'session.json':JSON.stringify(saved.session,null,2),
    'trials.csv':csv(resultTables(saved.session)[0].rows)};
  for (const [path, blob] of Object.entries(saved.recordings)) files[`audio/${path}`] = blob;
  return zip(files);
}
