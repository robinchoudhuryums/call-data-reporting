/**
 * PART 2: TARGET CALCULATION SCRIPT
 * Location: Target SS (Report Sheet)
 * Job: Listens for updates to "Staging", calculates metrics, updates Report/History.
 */

// CONFIGURATION
const STAGING_SHEET = "Staging";
const OUTPUT_SHEET = "OBC Output";
const CONFIG_SHEET = "DO NOT EDIT!";

// HISTORY MAP
const HISTORY_MAP = {
  "Sales": "Sales Direct HD",
  "CSR": "CSR HD", 
  "Billing": "Billing HD",
  "Retention": "Retention HD" 
};

// --- TRIGGER ---
// Add an Installable Trigger: onChange -> runProcessing
function onChange(e) {
  // We only want to run if the change happened in "Staging"
  // Note: onChange events are broad, so we check if Staging has data.
  // Ideally, checking e.source.getActiveSheet().getName() helps, 
  // but in onChange it's safer to just check if Staging was modified recently 
  // or simply run the logic (it's fast enough).
  
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  if (sheet.getName() === STAGING_SHEET) {
    runProcessing();
  }
}

function runProcessing() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  console.time("Processing");

  try {
    const staging = ss.getSheetByName(STAGING_SHEET);
    const output = ss.getSheetByName(OUTPUT_SHEET);
    const config = ss.getSheetByName(CONFIG_SHEET);

    // 1. READ STAGING (Fast - Local Read)
    // We assume the Source Script has finished writing. 
    // Wait a brief moment or ensure data integrity? 
    // Usually fine, but ensure we read strictly.
    const rawData = staging.getDataRange().getDisplayValues();
    if (rawData.length < 2) return; // Empty staging, ignore.

    // 2. CALCULATE
    const results = calculateMetrics(rawData, output, config);

    // 3. UPDATE OUTPUT
    updateOutput(output, results);
    SpreadsheetApp.flush();

    // 4. UPDATE HISTORY
    processHistory(ss, output, results);
    
    console.timeEnd("Processing");
    // Optional: Log success cell to let user know it ran?
    
  } catch (e) {
    console.error("Processing Error: " + e.message);
  }
}

// --- CALCULATION LOGIC (Same as before) ---
function calculateMetrics(data, outputSheet, configSheet) {
  const idx = {
    CALL_ID: 0, LEG_ID: 1, DIRECTION: 5, DURATION: 6,
    COL_I_EXT: 8, COL_J_NAME: 9, COL_K_REMOTE: 10, COL_L_NAME: 11,
    CONTEXT: 13, STATUS_MIS: 23, STATUS_ANS: 25
  };
  const TIME_20S = 20 / 86400;

  // Build Phonebook
  const extToAgent = {};
  const deptHeaders = configSheet.getRange(1, 6, 1, 13).getValues()[0];
  const configData = configSheet.getRange(2, 6, configSheet.getLastRow()-1, 13).getValues();
  configData.forEach(row => {
    row.forEach((cell, cIdx) => {
      const s = String(cell);
      if(s.includes(",")) {
        const p = s.split(",");
        if(p.length>=2) extToAgent[p[1].trim()] = { name: p[0].trim(), dept: deptHeaders[cIdx] };
      }
    });
  });

  // Exclusions
  const exclusions = new Set();
  configSheet.getRange(2, 1, configSheet.getLastRow()-1, 2).getValues().forEach(r => {
    if(r[0]) exclusions.add(String(r[0]).trim());
    if(r[1]) exclusions.add(String(r[1]).trim());
  });

  // Init Buckets
  const agentData = {};
  const names = outputSheet.getRange(2, 2, outputSheet.getLastRow()-1, 1).getValues().flat();
  names.forEach(n => {
    if(n) agentData[n] = {
      dept: "", c_set: new Set(), d_set: new Set(), e_set: new Set(),
      f: [], g: [], h: [], i_set: new Set(), j_set: new Set(), k_set: new Set(),
      l_set: new Set(), m_set: new Set(), n_int: [], n_ext: [], o_int: [], o_ext: [],
      p_int: [], p_ext: [], u: [], v: [], w: [], q: 0, r: 0, s_total: 0, t_cnt: 0
    };
  });

  const qRegex = /CallQueue/i; const naRegex = /N\/A/i;

  // Process Data
  for(let i=1; i<data.length; i++) {
    const r = data[i];
    const ctx = String(r[idx.CONTEXT]);
    if(exclusions.has(ctx)) continue;

    const extI = String(r[idx.COL_I_EXT]).trim();
    const remK = String(r[idx.COL_K_REMOTE]).trim();
    const statZ = String(r[idx.STATUS_ANS]);
    const statX = String(r[idx.STATUS_MIS]);
    const dir = String(r[idx.DIRECTION]);
    const cid = String(r[idx.CALL_ID]).trim();
    const dur = timeToDec(r[idx.DURATION]);

    const isNumK = remK !== "" && !isNaN(Number(remK));
    const isNumI = isValidPhone(extI);

    // Agent in I
    if(extToAgent[extI]) {
      const ag = extToAgent[extI];
      const b = agentData[ag.name];
      if(b) {
        b.dept = ag.dept;
        if(!qRegex.test(ctx)) {
          if(isNumK && extI!=="**********") {
             const callee = clean(r[idx.COL_L_NAME]);
             b.c_set.add(cid);
             if(statX==="Missed") b.d_set.add(cid);
             if(statZ==="Answered") b.e_set.add(cid);
             if(callee && !naRegex.test(callee)) {
               b.f.push(callee);
               if(statZ==="Answered") b.g.push(callee);
               if(statX==="Missed") b.h.push(callee);
             }
          }
        }
        if(naRegex.test(ctx) && r[idx.LEG_ID]=="1" && remK.includes("+")) {
           b.q++;
           if(dur >= TIME_20S) b.r++;
           const item = { p: remK, d: dur };
           b.u.push(item);
           if(dur > TIME_20S) b.v.push(item);
           if(dur < TIME_20S) b.w.push(item);
           b.s_total += dur;
           if(dur > 0) b.t_cnt++;
        }
      }
    }

    // Agent in K
    if(extToAgent[remK]) {
      const ag = extToAgent[remK];
      const b = agentData[ag.name];
      if(b && !qRegex.test(ctx)) {
        b.dept = ag.dept;
        if(isNumI && !exclusions.has(extI) && extI!=="**********") {
          const caller = clean(r[idx.COL_J_NAME]);
          b.i_set.add(cid);
          if(statX==="Missed") b.j_set.add(cid);
          if(statZ==="Answered") {
            b.k_set.add(cid);
            if(dir==="Internal") b.l_set.add(cid);
            if(dir==="Incoming") b.m_set.add(cid);
          }
          if(caller && !naRegex.test(caller)) {
            if(dir==="Internal") {
              b.n_int.push(caller);
              if(statZ==="Answered") b.o_int.push(caller);
              if(statX==="Missed") b.p_int.push(caller);
            } else if(dir==="Incoming") {
              b.n_ext.push(caller);
              if(statZ==="Answered") b.o_ext.push(caller);
              if(statX==="Missed") b.p_ext.push(caller);
            }
          }
        }
      }
    }
  }

  // Format
  const res = { CDE:[], FGH:[], IJK:[], LM:[], NOP:[], QR:[], ST:[], UVW:[], Names: names, Meta: agentData };
  names.forEach(n => {
    const b = agentData[n];
    const e3=["","",""], e2=["",""];
    if(!n || !b) {
      res.CDE.push(e3); res.FGH.push(e3); res.IJK.push(e3); res.LM.push(e2);
      res.NOP.push(e3); res.QR.push(e2); res.ST.push(e2); res.UVW.push(e3);
    } else {
      res.CDE.push([b.c_set.size||0, b.d_set.size||0, b.e_set.size||0]);
      res.FGH.push([agg(b.f), agg(b.g), agg(b.h)]);
      res.IJK.push([b.i_set.size||0, b.j_set.size||0, b.k_set.size||0]);
      res.LM.push([b.l_set.size||0, b.m_set.size||0]);
      res.NOP.push([join(agg(b.n_int), agg(b.n_ext)), join(agg(b.o_int), agg(b.o_ext)), join(agg(b.p_int), agg(b.p_ext))]);
      res.QR.push([b.q||"", (b.q>0&&b.r===0)?"0":b.r||""]);
      res.ST.push([b.q>0?fmt(b.s_total):"", b.q>0?(b.t_cnt>0?fmt(b.s_total/b.t_cnt):"0:00:00"):""]);
      res.UVW.push([aggC(b.u), aggC(b.v), aggC(b.w)]);
    }
  });
  return res;
}

function updateOutput(sheet, res) {
  sheet.getRange(2,3,res.CDE.length,3).setValues(res.CDE);
  sheet.getRange(2,6,res.FGH.length,3).setValues(res.FGH);
  sheet.getRange(2,9,res.IJK.length,3).setValues(res.IJK);
  sheet.getRange(2,12,res.LM.length,2).setValues(res.LM);
  sheet.getRange(2,14,res.NOP.length,3).setValues(res.NOP);
  sheet.getRange(2,17,res.QR.length,2).setValues(res.QR);
  sheet.getRange(2,19,res.ST.length,2).setValues(res.ST);
  sheet.getRange(2,21,res.UVW.length,3).setValues(res.UVW);
}

function processHistory(ss, outputSheet, res) {
  const ts = new Date();
  
  // 1. Dept History
  const bySheet = {};
  res.Names.forEach((name, i) => {
    if(name && res.Meta[name].dept && HISTORY_MAP[res.Meta[name].dept]) {
      const sName = HISTORY_MAP[res.Meta[name].dept];
      if(!bySheet[sName]) bySheet[sName] = [];
      bySheet[sName].push([
        ts, name, 
        (res.CDE[i][0] + res.IJK[i][0]), // Total IB
        res.QR[i][0],                    // Total OB
        res.ST[i][0]                     // Dur
      ]);
    }
  });
  for(const [sName, rows] of Object.entries(bySheet)) {
    const s = ss.getSheetByName(sName);
    if(s) s.getRange(s.getLastRow()+1,1,rows.length,rows[0].length).setValues(rows);
  }

  // 2. OBC Historical Data (Range Based Job)
  // Grabs B2:X from Output Sheet
  const histSheet = ss.getSheetByName("Historical Data");
  if(histSheet) {
    const lastRow = outputSheet.getLastRow();
    if(lastRow >= 2) {
      // B=2, X=24 -> 23 cols
      const rangeData = outputSheet.getRange(2, 2, lastRow-1, 23).getDisplayValues();
      const valid = rangeData.filter(r => r[0]); // Filter empty names
      if(valid.length) {
        const next = histSheet.getLastRow()+1;
        // Write Dates (Col C = 3)
        const dates = valid.map(() => [ts]);
        histSheet.getRange(next, 3, valid.length, 1).setValues(dates);
        // Write Data (Col E = 5)
        histSheet.getRange(next, 5, valid.length, valid[0].length).setValues(valid);
      }
    }
  }
}

// HELPERS
function clean(n){return String(n).trim();}
function agg(l){if(!l.length)return"";const c={};l.forEach(n=>{if(n)c[n]=(c[n]||0)+1});return Object.entries(c).sort((a,b)=>b[1]-a[1]).map(([n,k])=>k>1?`${n} (${k})`:n).join(", ");}
function join(a,b){const r=[];if(a)r.push(a);if(b)r.push(b);return r.join("\n|\n");}
function fmt(d){if(!d)return"0:00:00";const t=Math.round(d*86400);const h=Math.floor(t/3600),m=Math.floor((t%3600)/60),s=t%60;return`${h}:${m<10?'0'+m:m}:${s<10?'0'+s:s}`;}
function aggC(l){if(!l.length)return"";const m={};l.forEach(i=>{const k=i.p;if(!m[k])m[k]={c:0,d:0};m[k].c++;m[k].d+=i.d});return Object.entries(m).sort((a,b)=>b[1].c-a[1].c).map(([p,d])=>`${p} ${fmt(d.d)}${d.c>1?` (${d.c})`:""}`).join(", ");}
function timeToDec(v){if(typeof v==='number')return v;const s=String(v||"").trim().split(":");if(s.length<2)return 0;let h=0,m=0,x=0;if(s.length===3){h=+s[0];m=+s[1];x=+s[2];}else{m=+s[0];x=+s[1];}return(h*3600+m*60+x)/86400;}
function isValidPhone(v){if(typeof v==='number')return true;const s=String(v).replace("+","").trim();return s!==""&&!isNaN(Number(s));}